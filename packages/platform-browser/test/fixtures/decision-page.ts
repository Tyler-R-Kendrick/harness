// The decision layer's smoke test page: the browser host, the layer on real IndexedDB, and a tab that answers a permission request.
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { bytes, commitSha, Ensemble, sha256 } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import type { CallbackOutcome } from "@harness/core";
import { parseLayerSettings, parsePermissionAuthority, parsePolicy } from "@harness/decision";
import { BrowserHost, browserDecision, portStream } from "@harness/platform-browser";
import type { Emit, PermissionCommand, PromptCommand, Worker } from "@harness/workers";
import { textChunk } from "@harness/workers";
import attention from "../../../decision/data/attention.json" with { type: "json" };
import authority from "../../../decision/data/permission.json" with { type: "json" };
import dispatch from "../../../decision/data/dispatch.json" with { type: "json" };
import evolve from "../../../decision/data/evolve.json" with { type: "json" };
import lifecycle from "../../../decision/data/lifecycle.json" with { type: "json" };
import permissionQuestions from "../../../decision/data/permission-questions.json" with { type: "json" };
import policy from "../../../decision/data/policy.json" with { type: "json" };
import stuck from "../../../decision/data/stuck.json" with { type: "json" };

const ME = { principal: "profile", kind: "human" } as const;

/** A judgment model that is sure of everything it is asked, and calls the work the most serious it can. */
const judge = new Experimental_EvaluationMockModelV4({
  doEvaluate: async (options) => ({
    warnings: [],
    answers: Object.fromEntries(
      Object.entries(options.questions).map(([id, question]) => {
        if (question.type === "boolean") return [id, { type: "boolean" as const, probability: 0.95 }];
        if (question.type === "choice") {
          const keys = Object.keys(question.criteria);
          return [id, { type: "choice" as const, choice: keys[0]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.95 : 0.05 / (keys.length - 1)])) }];
        }
        const n = question.criteria.length;
        const probabilities = Object.fromEntries(question.criteria.map((_, i) => [String(i), i === n - 1 ? 0.95 : 0.05 / (n - 1)]));
        return [id, { type: "score" as const, score: Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0), probabilities }];
      }),
    ),
  }),
});

const descriptor = {
  id: "scripted-judge",
  name: "scripted judge",
  publisher: "t",
  tasks: ["judgment"],
  ports: ["judge"],
  locality: "local",
  runtime: "transformers.js",
  run: { dtype: "q4" },
  platforms: ["browser"],
  license: "MIT",
  downloadBytes: bytes(1),
  artifact: { repo: "t/scripted", revision: commitSha("a".repeat(40)), files: [{ path: "m.onnx", bytes: bytes(1), sha256: sha256("b".repeat(64)) }] },
  benchmarks: [{ benchmark: "b", task: "judgment", metric: "m", score: 50, higherIsBetter: true }],
} as ModelDescriptor;

/** Asks permission for a shell command (the prompt's text) and waits for the host to route the answer. */
class AskingWorker implements Worker {
  readonly #open = new Map<string, (outcome: CallbackOutcome) => void>();
  async run(command: PromptCommand, emit: Emit): Promise<void> {
    const base = { sessionId: command.sessionId, turnId: command.turnId };
    const text = command.prompt.map((b) => (b as { text?: string }).text ?? "").join("\n");
    const answered = new Promise<CallbackOutcome>((resolve) => this.#open.set(`${command.sessionId}/${command.turnId}`, resolve));
    emit({
      type: "permission",
      ...base,
      requestId: `${command.turnId}:permission`,
      toolCall: { toolCallId: `${command.turnId}:tool`, title: "Bash", kind: "execute", status: "pending", rawInput: { command: text } },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    const outcome = await answered;
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

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 500 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
  if (!(await check())) throw new Error(`timed out waiting for ${what}`);
};

/** The layer in a tab of this origin: a permission request is annotated, the person denies it, and the denial is the decision's outcome. */
async function permissionFlow(name: string) {
  const ensemble = new Ensemble({ platform: "browser" });
  ensemble.register(descriptor, async () => ({ judge }));
  const host = await BrowserHost.start({ worker: new AskingWorker(), identity: ME, cognitive: ensemble });
  const decision = await browserDecision({
    ensemble,
    runtime: host.runtime,
    name,
    tickMs: 20,
    policy: parsePolicy(policy),
    authority: parsePermissionAuthority(authority),
    settings: parseLayerSettings({ attention, stuck, dispatch, lifecycle, evolve, permission: permissionQuestions }),
  });
  const { port1, port2 } = new MessageChannel();
  host.accept(port2);
  const stream = portStream(port1);
  const asked: string[] = [];
  let choose!: (optionId: string) => void;
  const chosen = new Promise<string>((resolve) => (choose = resolve));
  const acp = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async (p) => {
        asked.push(p.toolCall.toolCallId);
        return { outcome: { outcome: "selected", optionId: await chosen } };
      },
    }),
    stream,
  );
  await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  const { sessionId } = await acp.newSession({ cwd: "/work", mcpServers: [] });
  const turn = acp.prompt({ sessionId, prompt: [{ type: "text", text: "rm -rf build" }] });
  await until(() => decision.layer.inbox.list().some((i) => i.text?.includes("(risk:") === true), "the annotation");
  const annotated = decision.layer.inbox.list()[0]!.text;
  const openWhileAnnotated = host.daemon.pendingPermissions().length;
  choose("deny");
  const stopReason = (await turn).stopReason;
  const [made] = await decision.layer.records({ fork: "permission.risk" as never });
  await until(async () => (await decision.layer.record(made!.id))?.outcome !== undefined, "the outcome");
  const outcome = (await decision.layer.record(made!.id))!.outcome;
  stream.hangUp();
  await decision.close();
  await host.close();
  return { annotated, openWhileAnnotated, asked: asked.length, stopReason, id: made!.id, rung: made!.rung, outcome };
}

/** The records of the layer in this origin's IndexedDB, read by a layer that starts afresh. */
async function reopen(name: string) {
  const ensemble = new Ensemble({ platform: "browser" });
  ensemble.register(descriptor, async () => ({ judge }));
  const host = await BrowserHost.start({ worker: new AskingWorker(), identity: ME, cognitive: ensemble });
  const decision = await browserDecision({
    ensemble,
    runtime: host.runtime,
    name,
    tickMs: 20,
    policy: parsePolicy(policy),
    settings: parseLayerSettings({ attention, stuck, dispatch, lifecycle, evolve }),
  });
  const records = await decision.layer.records();
  const next = await decision.layer.decideNamed("stuck", { goal: "g", steps: [] });
  const status = (await ensemble.operation("decision.status")!({})) as { decisions: number };
  await decision.close();
  await host.close();
  return { ids: records.map((r) => r.id), outcomes: records.map((r) => r.outcome?.kind), next: next.id, status: status.decisions };
}

(globalThis as unknown as { smoke: unknown }).smoke = { permissionFlow, reopen };
void (async () => {
  document.title = "ready";
})();
