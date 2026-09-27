import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { ContentBlock, RequestPermissionRequest, RequestPermissionResponse, SessionNotification, SessionUpdate, StopReason, Stream } from "@agentclientprotocol/sdk";
import { HarnessCapabilityUnsupportedError } from "@ai-sdk/harness";
import type { HarnessV1, HarnessV1ContinueTurnOptions, HarnessV1Prompt, HarnessV1PromptControl, HarnessV1PromptTurnOptions, HarnessV1ResumeSessionState, HarnessV1Session, HarnessV1StreamPart } from "@ai-sdk/harness";
import type { Experimental_SandboxSession } from "ai";
import { z } from "zod";
import { HARNESS_METHODS } from "@harness/protocol";

const HARNESS_ID = "harness-daemon";

/** An ACP connection to a running harness daemon (its socket, its stdio, an in-process pipe). */
export interface DaemonLink {
  readonly stream: Stream;
  close(): void | PromiseLike<void>;
}

/** What a parked harness session keeps: the daemon session it drives. */
const ParkedSchema = z.object({ daemonSessionId: z.string() });

const zero = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };
const FINISH: Record<StopReason, "stop" | "length" | "content-filter" | "other"> = { end_turn: "stop", max_tokens: "length", max_turn_requests: "length", refusal: "content-filter", cancelled: "other" };

const unsupported = (what: string) => Promise.reject(new HarnessCapabilityUnsupportedError({ message: `the harness daemon does not ${what}: it keeps its own sessions`, harnessId: HARNESS_ID }));

function contentOf(prompt: HarnessV1Prompt, instructions: string | undefined): ContentBlock[] {
  const blocks: ContentBlock[] = instructions === undefined ? [] : [{ type: "text", text: instructions }];
  if (typeof prompt === "string") return [...blocks, { type: "text", text: prompt }];
  if (typeof prompt.content === "string") return [...blocks, { type: "text", text: prompt.content }];
  for (const part of prompt.content) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text });
    else if (part.type === "file" && part.mediaType.startsWith("image/") && part.data instanceof Uint8Array) blocks.push({ type: "image", mimeType: part.mediaType, data: base64(part.data) });
  }
  return blocks;
}

function base64(data: Uint8Array): string {
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return btoa(s);
}

/** One turn in flight: its stream parts go to whoever is listening now (a continued turn re-attaches). */
class Turn {
  #emit: (part: HarnessV1StreamPart) => void;
  #open: { kind: "text" | "reasoning"; id: string } | undefined;
  #blocks = 0;
  readonly #calls = new Set<string>();
  readonly approvals = new Map<string, (approved: boolean) => void>();
  constructor(emit: (part: HarnessV1StreamPart) => void) {
    this.#emit = emit;
  }
  listen(emit: (part: HarnessV1StreamPart) => void): void {
    this.#emit = emit;
  }
  emit(part: HarnessV1StreamPart): void {
    this.#emit(part);
  }
  #close(): void {
    if (this.#open) this.#emit({ type: this.#open.kind === "text" ? "text-end" : "reasoning-end", id: this.#open.id });
    this.#open = undefined;
  }
  #chunk(kind: "text" | "reasoning", delta: string): void {
    if (this.#open?.kind !== kind) {
      this.#close();
      this.#open = { kind, id: `${kind}-${++this.#blocks}` };
      this.#emit({ type: kind === "text" ? "text-start" : "reasoning-start", id: this.#open.id });
    }
    this.#emit({ type: kind === "text" ? "text-delta" : "reasoning-delta", id: this.#open.id, delta });
  }
  /** A tool the daemon's worker runs: the AI SDK sees it as provider executed. */
  call(toolCallId: string, toolName: string, input: unknown): void {
    if (this.#calls.has(toolCallId)) return;
    this.#close();
    this.#calls.add(toolCallId);
    this.#emit({ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input ?? {}), providerExecuted: true, dynamic: true });
  }
  update(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
        if (update.content.type === "text") this.#chunk(update.sessionUpdate === "agent_message_chunk" ? "text" : "reasoning", update.content.text);
        return;
      case "tool_call":
        this.call(update.toolCallId, update.title, update.rawInput);
        return;
      case "tool_call_update":
        if (update.status === "completed" || update.status === "failed") {
          this.call(update.toolCallId, update.title ?? update.toolCallId, update.rawInput);
          this.#emit({ type: "tool-result", toolCallId: update.toolCallId, toolName: update.title ?? update.toolCallId, result: (update.rawOutput ?? null) as never, ...(update.status === "failed" ? { isError: true } : {}) });
        }
        return;
      default:
        this.#emit({ type: "raw", rawValue: update });
    }
  }
  finish(stopReason: StopReason): void {
    this.#close();
    const finishReason = { unified: FINISH[stopReason], raw: stopReason };
    this.#emit({ type: "finish-step", finishReason, usage: zero });
    this.#emit({ type: "finish", finishReason, totalUsage: zero });
  }
}

/**
 * The harness daemon as an AI SDK harness (`HarnessV1`), so any `HarnessAgent` can drive
 * it: each harness session is a daemon session, reached over ACP through `connect`. The
 * daemon's worker runs the turn; its tool calls are provider executed, and its
 * permission requests are tool approvals the agent's caller answers. Daemon sessions
 * outlive connections, so a detached session resumes on the same daemon session.
 */
export function daemonHarness(options: { readonly connect: () => DaemonLink | PromiseLike<DaemonLink> }): HarnessV1 {
  return {
    specificationVersion: "harness-v1",
    harnessId: HARNESS_ID,
    builtinTools: {},
    supportsBuiltinToolApprovals: true,
    lifecycleStateSchema: ParkedSchema,
    async doStart({ sessionId, resumeFrom, sessionWorkDir }) {
      const link = await options.connect();
      let turn: Turn | undefined;
      const client = {
        sessionUpdate: async (n: SessionNotification) => turn?.update(n.update),
        requestPermission: async (p: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
          const current = turn;
          if (!current) return { outcome: { outcome: "cancelled" } };
          const approvalId = `${p.toolCall.toolCallId}:approval`;
          current.call(p.toolCall.toolCallId, p.toolCall.title ?? p.toolCall.toolCallId, p.toolCall.rawInput);
          const approved = await new Promise<boolean>((resolve) => {
            current.approvals.set(approvalId, resolve);
            current.emit({ type: "tool-approval-request", approvalId, toolCallId: p.toolCall.toolCallId });
          });
          const choice = p.options.find((o) => (approved ? o.kind.startsWith("allow") : o.kind.startsWith("reject")));
          return choice ? { outcome: { outcome: "selected", optionId: choice.optionId } } : { outcome: { outcome: "cancelled" } };
        },
      };
      const acp = new ClientSideConnection(() => client, link.stream);
      await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      const parked = resumeFrom === undefined ? undefined : ParkedSchema.parse(resumeFrom.data);
      const daemonSessionId = parked ? parked.daemonSessionId : (await acp.newSession({ cwd: sessionWorkDir, mcpServers: [] })).sessionId;
      if (parked) await acp.loadSession({ sessionId: daemonSessionId, cwd: sessionWorkDir, mcpServers: [] });
      let instructed = parked !== undefined;
      let live: HarnessV1PromptControl | undefined;
      const state = (): HarnessV1ResumeSessionState => ({ type: "resume-session", specificationVersion: "harness-v1", harnessId: HARNESS_ID, data: { daemonSessionId } });
      // Detach first, so the daemon releases this connection's input lease and subscription
      // before a resumed session asks for them on a new connection.
      const end = async () => {
        await acp.extMethod(HARNESS_METHODS.sessionDetach, { sessionId: daemonSessionId }).catch(() => undefined);
        await link.close();
      };
      const listen = (current: Turn, signal: AbortSignal | undefined) => signal?.addEventListener("abort", () => void acp.cancel({ sessionId: daemonSessionId }), { once: true });
      const session: HarnessV1Session = {
        sessionId,
        isResume: parked !== undefined,
        async doPromptTurn(o: HarnessV1PromptTurnOptions) {
          const current = new Turn(o.emit);
          turn = current;
          listen(current, o.abortSignal);
          const prompt = contentOf(o.prompt, instructed ? undefined : o.instructions);
          instructed = true;
          current.emit({ type: "stream-start" });
          const done = acp.prompt({ sessionId: daemonSessionId, prompt }).then(({ stopReason }) => {
            current.finish(stopReason);
            if (turn === current) turn = undefined;
          });
          done.catch(() => undefined);
          live = {
            done,
            submitToolResult: async () => {},
            submitToolApproval: async ({ approvalId, approved }) => current.approvals.get(approvalId)?.(approved),
          };
          return live;
        },
        async doContinueTurn(o: HarnessV1ContinueTurnOptions) {
          if (!turn || !live) throw new Error("no turn to continue");
          turn.listen(o.emit);
          listen(turn, o.abortSignal);
          return live;
        },
        doCompact: () => unsupported("compact on request"),
        doSuspendTurn: () => unsupported("suspend turns"),
        async doDetach() {
          await end();
          return state();
        },
        async doStop() {
          await end();
          return state();
        },
        doDestroy: end,
      };
      return session;
    },
  };
}

/**
 * A sandbox session for harnesses that need none. The AI SDK asks every harness session
 * for a sandbox; the daemon runs its workers where it runs, so this one runs nothing.
 */
export function noSandbox(): Experimental_SandboxSession {
  return {
    description: "no sandbox: the harness daemon runs its workers itself",
    readFile: async () => null,
    readBinaryFile: async () => null,
    readTextFile: async () => null,
    writeFile: async () => {},
    writeBinaryFile: async () => {},
    writeTextFile: async () => {},
    spawn: async () => {
      throw new Error("no sandbox: it runs no processes");
    },
    run: async ({ command }) => ({ exitCode: 0, stdout: command === "pwd" ? "/\n" : "", stderr: "" }),
  };
}
