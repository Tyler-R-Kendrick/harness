/**
 * Doubles for the browser decision layer's tests: the shipped data files parsed, judgment
 * models that answer whatever they are asked, an ensemble of them, a worker that raises a
 * permission request for a shell command, and an ACP client in a "tab".
 */
import { readFileSync } from "node:fs";
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { bytes, commitSha, Ensemble, sha256 } from "@harness/cognitive";
import type { EvaluationModelV4, ModelDescriptor } from "@harness/cognitive";
import type { CallbackOutcome, PermissionOptionSpec } from "@harness/core";
import { parsePermissionAuthority, parseLayerSettings, parsePolicy } from "@harness/decision";
import type { AcpPort, BrowserHost } from "@harness/platform-browser";
import { portStream } from "@harness/platform-browser";
import type { Emit, PermissionCommand, PromptCommand, Worker } from "@harness/workers";
import { textChunk } from "@harness/workers";

const data = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../decision/data/${name}.json`, import.meta.url), "utf8"));

/** The data files the product ships, parsed, as a page would hand them to `browserDecision`. */
export const shipped = () => ({
  policy: parsePolicy(data("policy")),
  authority: parsePermissionAuthority(data("permission")),
  settings: parseLayerSettings({
    attention: data("attention"),
    stuck: data("stuck"),
    dispatch: data("dispatch"),
    lifecycle: data("lifecycle"),
    evolve: data("evolve"),
    permission: data("permission-questions"),
  }),
});

export function judgeDescriptor(id: string): ModelDescriptor {
  return {
    id,
    name: id,
    publisher: "t",
    tasks: ["judgment"],
    ports: ["judge"],
    locality: "local",
    runtime: "transformers.js",
    run: { dtype: "q4" },
    platforms: ["native", "browser"],
    license: "MIT",
    downloadBytes: bytes(1),
    artifact: { repo: `t/${id}`, revision: commitSha("a".repeat(40)), files: [{ path: "m.onnx", bytes: bytes(1), sha256: sha256("b".repeat(64)) }] },
    benchmarks: [{ benchmark: "b", task: "judgment", metric: "m", score: 50, higherIsBetter: true }],
  } as ModelDescriptor;
}

/** A judgment model that answers every question by its type, nearly all weight on the last level of a score and the first option of a choice. */
export function answering(boolean = 0.95): EvaluationModelV4 {
  return new Experimental_EvaluationMockModelV4({
    doEvaluate: async (options) => {
      const answers = Object.fromEntries(
        Object.entries(options.questions).map(([id, question]) => {
          if (question.type === "boolean") return [id, { type: "boolean" as const, probability: boolean }];
          if (question.type === "choice") {
            const keys = Object.keys(question.criteria);
            return [id, { type: "choice" as const, choice: keys[0]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.95 : 0.05 / (keys.length - 1)])) }];
          }
          const n = question.criteria.length;
          const probabilities = Object.fromEntries(question.criteria.map((_, i) => [String(i), i === n - 1 ? 0.95 : 0.05 / (n - 1)]));
          return [id, { type: "score" as const, score: Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0), probabilities }];
        }),
      );
      return { answers, warnings: [] };
    },
  });
}

/** An ensemble with these judgment models registered (by id), or none. */
export function ensembleOf(judges: Readonly<Record<string, EvaluationModelV4>> = {}): Ensemble {
  const ensemble = new Ensemble({ platform: "browser" });
  for (const [id, judge] of Object.entries(judges)) ensemble.register(judgeDescriptor(id), async () => ({ judge }));
  return ensemble;
}

const OPTIONS: PermissionOptionSpec[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

/** A worker that asks permission for a shell command (the prompt's text), waits, and says what the answer was. */
export class PermissionWorker implements Worker {
  readonly #open = new Map<string, (outcome: CallbackOutcome) => void>();

  async run(command: PromptCommand, emit: Emit): Promise<void> {
    const base = { sessionId: command.sessionId, turnId: command.turnId };
    const text = command.prompt.map((b) => (b as { text?: string }).text ?? "").join("\n");
    const key = `${command.sessionId}/${command.turnId}`;
    const answered = new Promise<CallbackOutcome>((resolve) => this.#open.set(key, resolve));
    emit({
      type: "permission",
      ...base,
      requestId: `${command.turnId}:permission`,
      toolCall: { toolCallId: `${command.turnId}:tool`, title: "Bash", kind: "execute", status: "pending", rawInput: { command: text } },
      options: OPTIONS,
    });
    const outcome = await answered;
    this.#open.delete(key);
    emit({ type: "update", ...base, update: textChunk(outcome.outcome === "selected" ? `answered: ${outcome.optionId}` : "cancelled") });
    emit({ type: "end", ...base, stopReason: outcome.outcome === "selected" ? "end_turn" : "cancelled" });
  }

  cancel(sessionId: string, turnId: string): void {
    this.#open.get(`${sessionId}/${turnId}`)?.({ outcome: "cancelled" });
  }

  permission(command: PermissionCommand): void {
    this.#open.get(`${command.sessionId}/${command.turnId}`)?.(command.outcome);
  }
}

export interface TabClient {
  readonly connection: ClientSideConnection;
  readonly permissions: RequestPermissionRequest[];
  /** Answers the permission requests that arrive: set before prompting. */
  answer: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  sessionId: string;
  hangUp(): void;
}

/** An ACP client in a "tab" of this host, with a session open. */
export async function tabOf(host: BrowserHost): Promise<TabClient> {
  const { port1, port2 } = new MessageChannel();
  host.accept(port2 as unknown as AcpPort);
  const stream = portStream(port1 as unknown as AcpPort);
  const permissions: RequestPermissionRequest[] = [];
  const tab = {
    permissions,
    answer: async (): Promise<RequestPermissionResponse> => ({ outcome: { outcome: "cancelled" } }),
    sessionId: "",
    hangUp: () => stream.hangUp(),
  } as unknown as TabClient;
  (tab as { connection: ClientSideConnection }).connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async (p) => {
        permissions.push(p);
        return tab.answer(p);
      },
    }),
    stream,
  );
  await tab.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  tab.sessionId = (await tab.connection.newSession({ cwd: "/work", mcpServers: [] })).sessionId;
  return tab;
}

/** Waits until `check` holds (polling), or fails with `what` after `timeoutMs`. */
export async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
