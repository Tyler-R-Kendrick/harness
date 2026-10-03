import { describe, expect, it } from "vitest";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { bytes, commitSha, Ensemble, MODEL_HEADER, sha256 } from "@harness/cognitive";
import type { EvaluationModelV4, ModelDescriptor, Ports } from "@harness/cognitive";
import { ensembleMember } from "../src/ensemble-member.ts";
import { chooseOne } from "../src/fork.ts";
import { DecisionError } from "../src/types.ts";
import { policyJson, rig } from "./fork-fixtures.ts";
import type { Asked } from "../src/types.ts";

const SHA = commitSha("a".repeat(40));
const FILE_SHA = sha256("b".repeat(64));

/** A local judge with a pinned artifact (its commit is the version) or a hosted one without. */
function judge(id: string, extra: Partial<ModelDescriptor> = {}, benchmark = 50): ModelDescriptor {
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
    ...extra,
  } as ModelDescriptor;
}
const hosted = (id: string, benchmark: number): ModelDescriptor => {
  const { artifact: _artifact, ...rest } = judge(id, {}, benchmark);
  return { ...rest, locality: "hosted", runtime: "ai-gateway", run: { model: "x/y" }, downloadBytes: bytes(0) } as ModelDescriptor;
};

const ASKED: Asked = {
  state: "the thing",
  questions: {
    ok: { type: "boolean", instructions: "ok?" },
    which: { type: "choice", instructions: "which?", criteria: { a: "first", b: "second" } },
    how: { type: "score", instructions: "how?", criteria: ["bad", "fine", "good"] },
  },
};

const scripted = (p: number, calls: unknown[] = []): EvaluationModelV4 =>
  new Experimental_EvaluationMockModelV4({
    doEvaluate: async (options) => {
      calls.push(options);
      return {
        answers: {
          ok: { type: "boolean", probability: p },
          which: { type: "choice", choice: "b", probabilities: { a: 0.25, b: 0.75 } },
          how: { type: "score", score: 1.4, probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 } },
        },
        warnings: [],
      };
    },
  });
const unavailable = (): EvaluationModelV4 =>
  new Experimental_EvaluationMockModelV4({
    doEvaluate: async () => {
      throw Object.assign(new Error("out of budget"), { statusCode: 503 });
    },
  });

function ensembleOf(...members: [ModelDescriptor, EvaluationModelV4][]): Ensemble {
  const ensemble = new Ensemble({ platform: "native" });
  for (const [descriptor, model] of members) ensemble.register(descriptor, async (): Promise<Ports> => ({ judge: model }));
  return ensemble;
}

describe("ensembleMember", () => {
  it("EMB1.1 a member named by the caller (or `ensemble`) has a version that is never `latest`, and nothing is served before the first call", () => {
    const ensemble = ensembleOf([judge("j1"), scripted(0.9)]);
    expect(ensembleMember(ensemble).id).toBe("ensemble");
    expect(ensembleMember(ensemble, { id: "panel" }).id).toBe("panel");
    const member = ensembleMember(ensemble);
    expect(member.version).not.toBe("latest");
    expect(member.version.length).toBeGreaterThan(0);
    expect(member.served?.()).toBeUndefined();
  });

  it("EMB1.2 all the questions go to the ensemble's judge in one call, and the answers come back over each question's own options", async () => {
    const calls: unknown[] = [];
    const member = ensembleMember(ensembleOf([judge("j1"), scripted(0.9, calls)]));
    const answers = await member.ask(ASKED);
    expect(calls).toHaveLength(1);
    expect(Object.keys((calls[0] as { questions: object }).questions)).toEqual(["ok", "which", "how"]);
    expect((calls[0] as { state: unknown }).state).toBe("the thing");
    expect(answers["ok"]).toMatchObject({ type: "boolean", top: "true", distribution: { true: 0.9 } });
    expect(answers["ok"]!.distribution["false"]).toBeCloseTo(0.1, 12);
    expect(answers["which"]).toMatchObject({ type: "choice", top: "b", distribution: { a: 0.25, b: 0.75 } });
    expect(answers["how"]).toMatchObject({ type: "score", top: "2", distribution: { "0": 0.1, "1": 0.4, "2": 0.5 } });
  });

  it("EMB1.3 after a call, the model that answered is served at the commit its weights are pinned to", async () => {
    const member = ensembleMember(ensembleOf([judge("j1"), scripted(0.9)]));
    await member.ask(ASKED);
    expect(member.served?.()).toEqual({ id: "j1", version: SHA });
  });

  it("EMB1.4 a hosted model, which pins no artifact, is served at its catalog id", async () => {
    const member = ensembleMember(ensembleOf([hosted("h1", 50), scripted(0.9)]));
    await member.ask(ASKED);
    expect(member.served?.()).toEqual({ id: "h1", version: "h1" });
  });

  it("EMB1.5 when the best judge is unavailable the next answers and is the one served", async () => {
    const member = ensembleMember(ensembleOf([judge("best", {}, 90), unavailable()], [judge("next", { artifact: { repo: "t/next", revision: commitSha("c".repeat(40)), files: [{ path: "m.onnx", bytes: bytes(1), sha256: FILE_SHA }] } }, 10), scripted(0.8)]));
    const answers = await member.ask(ASKED);
    expect(answers["ok"]!.distribution["true"]).toBe(0.8);
    expect(member.served?.()).toEqual({ id: "next", version: "c".repeat(40) });
  });

  it("EMB1.6 served names the model of the latest call: it moves when the ensemble's choice does", async () => {
    const ensemble = ensembleOf([judge("a", {}, 90), scripted(0.9)], [hosted("b", 10), scripted(0.6)]);
    const member = ensembleMember(ensemble);
    await member.ask(ASKED);
    expect(member.served?.()?.id).toBe("a");
    ensemble.revoke("a", "gone");
    await member.ask(ASKED);
    expect(member.served?.()).toEqual({ id: "b", version: "b" });
  });

  it("EMB1.7 a call that fails leaves nothing served, not the model of an earlier call", async () => {
    const ensemble = ensembleOf([judge("a"), scripted(0.9)]);
    const member = ensembleMember(ensemble);
    await member.ask(ASKED);
    expect(member.served?.()).toBeDefined();
    ensemble.revoke("a", "gone");
    await expect(member.ask(ASKED)).rejects.toThrow();
    expect(member.served?.()).toBeUndefined();
  });

  it("EMB1.8 an answer that cannot be a distribution over the question's options is refused, naming the member and the question", async () => {
    const only: Asked = { state: "s", questions: { q: { type: "choice", instructions: "only one?", criteria: { only: "x" } } } };
    const single = new Experimental_EvaluationMockModelV4({ doEvaluate: async () => ({ answers: { q: { type: "choice", choice: "only" } }, warnings: [] }) });
    const member = ensembleMember(ensembleOf([judge("a"), single]), { id: "panel" });
    const failure = await member.ask(only).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DecisionError);
    expect((failure as DecisionError).code).toBe("invalid");
    expect((failure as DecisionError).message).toMatch(/panel.*"q"/);
  });

  it("EMB1.9 a response that does not name its model serves nothing, and a model the catalog no longer has is served at its id", async () => {
    let header: string | undefined;
    const fake = {
      members: () => [{ id: "known", state: "ready" as const, descriptor: judge("known") }],
      evaluationModel: (): EvaluationModelV4 => ({
        specificationVersion: "v4",
        provider: "t",
        modelId: "t",
        supportedQuestionTypes: ["boolean", "choice", "score"],
        doEvaluate: async () => ({ answers: { ok: { type: "boolean", probability: 0.7 }, which: { type: "choice", choice: "a" }, how: { type: "score", score: 0 } }, warnings: [], response: { headers: header === undefined ? {} : { [MODEL_HEADER]: header } } }),
      }),
    };
    const member = ensembleMember(fake);
    await member.ask(ASKED);
    expect(member.served?.()).toBeUndefined();
    header = "known";
    await member.ask(ASKED);
    expect(member.served?.()).toEqual({ id: "known", version: SHA });
    header = "removed";
    await member.ask(ASKED);
    expect(member.served?.()).toEqual({ id: "removed", version: "removed" });
  });

  it("EMB1.10 a response with no headers, or none at all, serves nothing", async () => {
    const sent: { response?: { headers?: Record<string, string> } } = {};
    const fake = {
      members: () => [],
      evaluationModel: (): EvaluationModelV4 => ({
        specificationVersion: "v4",
        provider: "t",
        modelId: "t",
        supportedQuestionTypes: ["boolean", "choice", "score"],
        doEvaluate: async () => ({ answers: { ok: { type: "boolean", probability: 0.7 }, which: { type: "choice", choice: "a" }, how: { type: "score", score: 0 } }, warnings: [], ...(sent.response === undefined ? {} : { response: sent.response }) }),
      }),
    };
    const member = ensembleMember(fake);
    await member.ask(ASKED);
    expect(member.served?.()).toBeUndefined();
    sent.response = {};
    await member.ask(ASKED);
    expect(member.served?.()).toBeUndefined();
  });

  it("EMB1.11 askWithIdentity gives the answers with the id and version of the model that gave them", async () => {
    const member = ensembleMember(ensembleOf([judge("j1"), scripted(0.9)]));
    const { answers, served } = await member.askWithIdentity!(ASKED);
    expect(served).toEqual({ id: "j1", version: SHA });
    expect(answers["ok"]).toMatchObject({ type: "boolean", top: "true" });
    expect(member.served?.()).toEqual(served);
  });

  it("EMB1.12 each ask says its own model: when the ensemble fails over between two asks, the first still names the first model", async () => {
    let calls = 0;
    const flaky = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => {
        if (calls++ > 0) throw Object.assign(new Error("out of budget"), { statusCode: 503 });
        return { answers: { ok: { type: "boolean", probability: 0.99 }, which: { type: "choice", choice: "a" }, how: { type: "score", score: 0 } }, warnings: [] };
      },
    });
    const member = ensembleMember(ensembleOf([judge("a", {}, 90), flaky], [hosted("b", 10), scripted(0.6)]));
    const first = await member.askWithIdentity!(ASKED);
    const second = await member.askWithIdentity!(ASKED);
    expect(first.served?.id).toBe("a");
    expect(second.served).toEqual({ id: "b", version: "b" });
    expect(first.answers["ok"]!.distribution["true"]).toBe(0.99);
    expect(second.answers["ok"]!.distribution["true"]).toBe(0.6);
  });

  it("EMB1.13 asks made at once on one member each get the model that answered them, whichever finishes last", async () => {
    const slow = new Experimental_EvaluationMockModelV4({
      doEvaluate: async (options) => {
        if (options.state === "second") throw Object.assign(new Error("out of budget"), { statusCode: 503 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { answers: { ok: { type: "boolean", probability: 0.9 }, which: { type: "choice", choice: "a" }, how: { type: "score", score: 0 } }, warnings: [] };
      },
    });
    const member = ensembleMember(ensembleOf([judge("a", {}, 90), slow], [hosted("b", 10), scripted(0.6)]));
    const [first, second] = await Promise.all([member.askWithIdentity!({ ...ASKED, state: "first" }), member.askWithIdentity!({ ...ASKED, state: "second" })]);
    expect(first.served?.id).toBe("a");
    expect(second.served?.id).toBe("b");
  });

  it("EMB1.14 a decision that rotates its questions and meets a failover between the rounds is not made of two models' answers recorded as one", async () => {
    let calls = 0;
    const flaky = new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => {
        if (calls++ > 0) throw Object.assign(new Error("out of budget"), { statusCode: 503 });
        return { answers: { choice: { type: "choice", choice: "x", probabilities: { x: 0.99, y: 0.01 } } }, warnings: [] };
      },
    });
    const backup = new Experimental_EvaluationMockModelV4({ doEvaluate: async () => ({ answers: { choice: { type: "choice", choice: "x", probabilities: { x: 0.6, y: 0.4 } } }, warnings: [] }) });
    const member = ensembleMember(ensembleOf([judge("a", {}, 90), flaky], [hosted("b", 10), backup]));
    const pick = chooseOne({ id: "test.pick", version: "p1", instructions: "which?", options: { x: "first", y: "second" }, describe: () => ({}), text: () => "s", fallback: () => "x" });
    const { decider } = rig({ members: [member], policy: policyJson({ default: { act: 0.4, verify: 0.4, rotate: 2 } }) });
    const d = await decider.decide(pick, { text: "s" });
    expect(d.rung).toBe("human");
    expect(d.record.member).toBeUndefined();
    expect(d.record.trace[0]!.outcome).toMatch(/^failed: the member changed models within a rotation round: a@a{40}, then b@b$/);
  });
});
