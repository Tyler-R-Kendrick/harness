import type { HarnessV1, HarnessV1ContinueTurnOptions, HarnessV1PromptControl, HarnessV1PromptTurnOptions, HarnessV1ResumeSessionState, HarnessV1Session, HarnessV1StreamPart } from "@ai-sdk/harness";
import type { JSONValue } from "@ai-sdk/provider";
import type { Experimental_SandboxSession } from "ai";

/** What a scripted harness does in one turn: reply with text, first calling a host tool if asked. */
export interface ScriptedTurn {
  readonly text: string;
  /** A host-executed tool to call before replying; its result is appended to the reply. */
  readonly tool?: { readonly name: string; readonly input: Readonly<Record<string, unknown>> };
}

/** What the harness saw: sessions started and ended, and each turn's prompt and settings. */
export interface HarnessLog {
  readonly started: string[];
  readonly ended: string[];
  readonly turns: { readonly sessionId: string; readonly prompt: unknown; readonly instructions: string | undefined }[];
}

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const stop = { unified: "stop" as const, raw: undefined };

function promptOf(prompt: HarnessV1PromptTurnOptions["prompt"]): string {
  if (typeof prompt === "string") return prompt;
  return typeof prompt.content === "string" ? prompt.content : prompt.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * A deterministic `HarnessV1` adapter (the AI SDK harness spec) for tests: each turn's
 * reply comes from `reply(prompt)`. A turn that calls a host tool waits for the host's
 * result before replying (a continued turn attaches to it); an aborted turn fails. Everything it sees is in `log`.
 */
export function scriptedHarness(reply: (prompt: string) => ScriptedTurn | string): HarnessV1 & { readonly log: HarnessLog } {
  const log: HarnessLog = { started: [], ended: [], turns: [] };
  return {
    specificationVersion: "harness-v1",
    harnessId: "scripted",
    builtinTools: {},
    log,
    async doStart({ sessionId }) {
      log.started.push(sessionId);
      const end = async () => void log.ended.push(sessionId);
      let live: ((options: HarnessV1ContinueTurnOptions) => HarnessV1PromptControl) | undefined;
      const parked: HarnessV1ResumeSessionState = { type: "resume-session", specificationVersion: "harness-v1", harnessId: "scripted", data: {} };
      const session: HarnessV1Session = {
        sessionId,
        isResume: false,
        async doPromptTurn(options) {
          log.turns.push({ sessionId, prompt: options.prompt, instructions: options.instructions });
          const turn = reply(promptOf(options.prompt));
          const { text, tool } = typeof turn === "string" ? { text: turn, tool: undefined } : turn;
          // A continued turn attaches to the same run, so events go to whoever is listening now.
          let listener = options.emit;
          const emit = (part: HarnessV1StreamPart) => listener(part);
          let toolResult: ((output: unknown) => void) | undefined;
          let abort: (reason: Error) => void = () => {};
          const aborted = new Promise<never>((_, reject) => (abort = reject));
          const listen = (signal: HarnessV1PromptTurnOptions["abortSignal"]) => signal?.addEventListener("abort", () => abort(new Error("aborted")), { once: true });
          listen(options.abortSignal);
          const run = async () => {
            emit({ type: "stream-start" });
            let suffix = "";
            if (tool) {
              const output = new Promise<unknown>((resolve) => (toolResult = resolve));
              emit({ type: "tool-call", toolCallId: "call-1", toolName: tool.name, input: JSON.stringify(tool.input) });
              emit({ type: "finish-step", finishReason: { unified: "tool-calls", raw: undefined }, usage });
              // Like real adapters, the harness reports the host's result back as a tool result.
              const result = await output;
              emit({ type: "tool-result", toolCallId: "call-1", toolName: tool.name, result: result as NonNullable<JSONValue> });
              suffix = ` ${JSON.stringify(result)}`;
            }
            emit({ type: "text-start", id: "t" });
            emit({ type: "text-delta", id: "t", delta: text + suffix });
            emit({ type: "text-end", id: "t" });
            emit({ type: "finish-step", finishReason: stop, usage });
            emit({ type: "finish", finishReason: stop, totalUsage: usage });
          };
          const done = Promise.race([run(), aborted]);
          done.catch(() => undefined);
          const control = {
            done,
            async submitToolResult({ output }: { output: unknown }) {
              toolResult?.(output);
            },
          };
          live = (continued) => {
            listener = continued.emit;
            listen(continued.abortSignal);
            return control;
          };
          return control;
        },
        async doCompact() {},
        async doContinueTurn(options) {
          if (!live) throw new Error("no turn to continue");
          return live(options);
        },
        async doSuspendTurn() {
          throw new Error("the scripted harness does not suspend turns");
        },
        async doDetach() {
          await end();
          return parked;
        },
        async doStop() {
          await end();
          return parked;
        },
        doDestroy: end,
      };
      return session;
    },
  };
}

/** A sandbox session that runs nothing and stores nothing, for harnesses that need none. */
export function nullSandbox(): Experimental_SandboxSession {
  return {
    description: "a sandbox that runs nothing",
    readFile: async () => null,
    readBinaryFile: async () => null,
    readTextFile: async () => null,
    writeFile: async () => {},
    writeBinaryFile: async () => {},
    writeTextFile: async () => {},
    spawn: async () => {
      throw new Error("the null sandbox runs no processes");
    },
    run: async ({ command }) => ({ exitCode: 0, stdout: command === "pwd" ? "/sandbox\n" : "", stderr: "" }),
  };
}
