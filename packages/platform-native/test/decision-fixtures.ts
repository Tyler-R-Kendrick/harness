/**
 * Doubles for the decision host's tests: judgment models that answer whatever they are asked
 * (so the layer's real fork questions get answers), an ensemble of them, a worker that raises
 * a permission request for a tool call, and an in-process ACP client for a host.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { bytes, commitSha, Ensemble, sha256 } from "@harness/cognitive";
import type { EvaluationModelV4, ModelDescriptor } from "@harness/cognitive";
import type { Emit, PermissionCommand, PromptCommand, Worker } from "@harness/workers";
import { textChunk } from "@harness/workers";
import type { CallbackOutcome, PermissionOptionSpec } from "@harness/core";
import { ensembleMember } from "@harness/decision";
import { openDecision } from "@harness/platform-native";
import type { NodeHost } from "@harness/platform-native";

const SHA = commitSha("a".repeat(40));
const FILE_SHA = sha256("b".repeat(64));

/** A local judgment model of the catalog's shape (a pinned artifact), by id. */
export function judgeDescriptor(id: string, benchmark = 50): ModelDescriptor {
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
    artifact: { repo: `t/${id}`, revision: SHA, files: [{ path: "m.onnx", bytes: bytes(1), sha256: FILE_SHA }] },
    benchmarks: [{ benchmark: "b", task: "judgment", metric: "m", score: benchmark, higherIsBetter: true }],
  } as ModelDescriptor;
}

export interface Say {
  /** P(true) of every boolean question. */
  readonly boolean?: number;
  /** The level that carries the weight of every score question: from the top (`0`) or `"last"`. */
  readonly level?: "first" | "last";
}

/** A judgment model that answers every question by its type: booleans with `say.boolean`, scores with nearly all weight on one end, choices on their first option. */
export function answering(say: Say = {}, calls: string[][] = []): EvaluationModelV4 {
  return new Experimental_EvaluationMockModelV4({
    doEvaluate: async (options) => {
      calls.push(Object.keys(options.questions));
      const answers = Object.fromEntries(
        Object.entries(options.questions).map(([id, question]) => {
          if (question.type === "boolean") return [id, { type: "boolean" as const, probability: say.boolean ?? 0.5 }];
          if (question.type === "choice") {
            const keys = Object.keys(question.criteria);
            return [id, { type: "choice" as const, choice: keys[0]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.95 : 0.05 / (keys.length - 1)])) }];
          }
          const n = question.criteria.length;
          const heavy = say.level === "first" ? 0 : n - 1;
          const probabilities = Object.fromEntries(question.criteria.map((_, i) => [String(i), i === heavy ? 0.95 : 0.05 / (n - 1)]));
          // a score is the probability-weighted mean of its levels
          const score = Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
          return [id, { type: "score" as const, score, probabilities }];
        }),
      );
      return { answers, warnings: [] };
    },
  });
}

/** A judgment model that is down: every call fails the way an unreachable service does. */
export const unreachable = (): EvaluationModelV4 =>
  new Experimental_EvaluationMockModelV4({
    doEvaluate: async () => {
      throw Object.assign(new Error("service unavailable"), { statusCode: 503, isRetryable: true });
    },
  });

/** An ensemble with these judgment models registered (by id), or none. */
export function ensembleOf(judges: Readonly<Record<string, EvaluationModelV4>> = {}): Ensemble {
  const ensemble = new Ensemble({ platform: "native" });
  Object.entries(judges).forEach(([id, judge], i) => ensemble.register(judgeDescriptor(id, 50 + i), async () => ({ judge })));
  return ensemble;
}

const OPTIONS: PermissionOptionSpec[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

/**
 * A worker that, for a prompt, asks permission for a shell command (the prompt's text) and
 * then says what the answer was. The permission is the host's to route; the worker waits.
 */
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

export interface InProcessClient {
  readonly connection: ClientSideConnection;
  readonly updates: SessionNotification[];
  readonly permissions: RequestPermissionRequest[];
  /** Answers the permission requests that arrive: set before prompting. */
  answer: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  initialize(): Promise<void>;
}

/** An ACP client of the official SDK, connected to a host in this process over a pair of streams. */
export function clientOf(host: NodeHost): InProcessClient {
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  host.attach(toHost, fromHost, () => fromHost.end());
  const updates: SessionNotification[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const client: InProcessClient = {
    updates,
    permissions,
    answer: async () => ({ outcome: { outcome: "cancelled" } }),
    connection: undefined as unknown as ClientSideConnection,
    async initialize() {
      await client.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    },
  };
  const stream = ndJsonStream(
    new WritableStream<Uint8Array>({ write: (chunk) => void toHost.write(chunk) }),
    new ReadableStream<Uint8Array>({
      start(controller) {
        fromHost.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        fromHost.on("end", () => controller.close());
      },
    }),
  );
  (client as { connection: ClientSideConnection }).connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async (n) => void updates.push(n),
      requestPermission: async (p) => {
        permissions.push(p);
        return client.answer(p);
      },
    }),
    stream,
  );
  return client;
}

const dirs: string[] = [];
/** A directory that is removed after the test (call `cleanDirs` in `afterEach`). */
export async function tempDir(prefix = "harness-decision-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
export async function cleanDirs(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** Waits until `check` holds (polling), or fails with `what` after `timeoutMs`. */
export async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * A decision directory with a history, as a daemon that had been running would leave it: 40
 * `permission.risk` decisions made by a judgment model (a boolean question it was sure of and
 * a score), 30 of them judged right by a person and 10 wrong; and 16 `attention` decisions
 * (no model: they ended at a person) that a person labelled, by kind.
 */
export async function seedDecisionDir(dir: string): Promise<void> {
  const ensemble = ensembleOf({ judge: answering({ boolean: 0.95, level: "last" }) });
  const opened = await openDecision({ dir, members: [ensembleMember(ensemble)], clock: { now: () => 5_000 } });
  for (let i = 0; i < 40; i++) {
    const decision = await opened.layer.decideNamed("permission.risk", { tool: "Bash", command: `rm -rf build-${i}`, session: `s${i % 4}` }, { session: `s${i % 4}` });
    await opened.layer.outcome(decision.id, { at: 6_000, source: "human", kind: i % 4 === 0 ? "approved" : "denied", correct: i % 4 !== 0 });
  }
  const bare = await openDecision({ dir, clock: { now: () => 7_000 } });
  for (let i = 0; i < 16; i++) {
    const kind = i % 2 === 0 ? "permission" : "review";
    const decision = await bare.layer.decideNamed("attention", { id: `h${i}`, session: "s", kind, since: 1_000, blocked: kind === "permission" }, { session: `train-${i}` });
    await bare.layer.outcome(decision.id, { at: 8_000, source: "human", kind: "overridden", label: kind === "permission" ? "urgent" : "low" });
  }
  await Promise.all([opened.settled(), bare.settled()]);
}
