import { describe, expect, it } from "vitest";
import { bytes, Ensemble, probability } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { BlockedError, chooseJudge, runEvals } from "@harness/evals";
import type { EvalCase } from "@harness/evals";
import { scriptedJudge } from "@harness/testkit";

const yesCase = (id: string, reply: string): EvalCase => ({
  id,
  description: `reply ${reply}`,
  subject: async () => ({ question: "2+2?", reply }),
  questions: { correct: { type: "boolean", instructions: "Does the reply correctly answer the question?" } },
  expect: { correct: { type: "boolean", expect: true } },
});

/** A judge the runner reports as the fake judge, on an evaluation model that answers from `answer`. */
const judgeOn = (answer: Parameters<typeof scriptedJudge>[0]) => ({ judge: { identity: { provider: "fake", modelId: "fake-judge" }, model: scriptedJudge(answer) } });
const judgeFrom = (p: (state: unknown) => number) => judgeOn((_id, _q, state) => ({ type: "boolean", probability: p(state) }));
const failing = (error: () => Error) =>
  judgeOn(() => {
    throw error();
  });

describe("runEvals", () => {
  it("EV3.1 without a judge every case is blocked, with the reason, and the report names no judge", async () => {
    let ran = false;
    const report = await runEvals([{ ...yesCase("a", "4"), subject: async () => ((ran = true), {}) }], { unavailable: "No judge could be reached: j: down" });
    expect(report.results).toEqual([expect.objectContaining({ id: "a", verdict: "blocked", reason: "No judge could be reached: j: down" })]);
    expect(ran).toBe(false);
    expect(report.judge).toEqual({ provider: "none", modelId: "none" });
    expect(report.summary).toMatchObject({ total: 1, blocked: 1, passed: 0 });
  });

  it("EV3.2 verdicts come from the judge's typed answers", async () => {
    const judge = judgeFrom((s) => ((s as { reply: string }).reply === "4" ? 0.95 : (s as { reply: string }).reply === "5" ? 0.05 : 0.6));
    const report = await runEvals([yesCase("good", "4"), yesCase("bad", "5"), yesCase("unsure", "four-ish")], judge);
    expect(report.results.map((r) => [r.id, r.verdict])).toEqual([
      ["good", "passed"],
      ["bad", "failed"],
      ["unsure", "inconclusive"],
    ]);
    expect(report.results[0]!.answers).toEqual({ correct: { type: "boolean", probability: probability(0.95) } });
    expect(report.summary).toMatchObject({ total: 3, passed: 1, failed: 1, inconclusive: 1, blocked: 0 });
  });

  it("EV3.3 the pass rate carries a Wilson interval over decided cases only", async () => {
    const judge = judgeFrom(() => 0.95);
    const report = await runEvals([yesCase("a", "4"), yesCase("b", "4")], judge);
    expect(report.summary.passRate).toMatchObject({ successes: 2, trials: 2, interval: [expect.any(Number), 1] });
    expect(report.summary.passRate.interval[0]).toBeLessThan(0.5);
  });

  it("EV3.4 a subject that needs unavailable access is blocked; a subject that crashes fails", async () => {
    const judge = judgeFrom(() => 0.95);
    const blocked: EvalCase = { ...yesCase("b", "4"), subject: async () => { throw new BlockedError("model worker needs gateway access"); } };
    const crashed: EvalCase = { ...yesCase("c", "4"), subject: async () => { throw new Error("daemon exploded"); } };
    const report = await runEvals([blocked, crashed], judge);
    expect(report.results).toEqual([
      expect.objectContaining({ id: "b", verdict: "blocked", reason: "model worker needs gateway access" }),
      expect.objectContaining({ id: "c", verdict: "failed", reason: expect.stringMatching(/daemon exploded/) }),
    ]);
  });

  it("EV3.5 a judge authentication failure is blocked; other judge failures are inconclusive", async () => {
    const authFail = failing(() => Object.assign(new Error("unauthorized"), { statusCode: 401 }));
    const flaky = failing(() => new Error("socket hang up"));
    expect((await runEvals([yesCase("a", "4")], authFail)).results[0]).toMatchObject({ verdict: "blocked" });
    expect((await runEvals([yesCase("a", "4")], flaky)).results[0]).toMatchObject({ verdict: "inconclusive", reason: expect.stringMatching(/socket hang up/) });
  });

  it("EV3.6 wrapped access errors (e.g. inside a retry error) are still recognised", async () => {
    const wrapped = failing(() => Object.assign(new Error("retries exhausted"), { errors: [Object.assign(new Error("forbidden"), { name: "GatewayForbiddenError" })] }));
    expect((await runEvals([yesCase("a", "4")], wrapped)).results[0]).toMatchObject({ verdict: "blocked" });
  });

  it("EV3.7 the report identifies the judge and the source revision", async () => {
    const report = await runEvals([yesCase("a", "4")], judgeFrom(() => 0.9), { sourceRevision: "abc123" });
    expect(report).toMatchObject({ schemaVersion: "harness.eval/v1", sourceRevision: "abc123", judge: { provider: "fake", modelId: "fake-judge" } });
    await expect(runEvals([], judgeFrom(() => 1), { sourceRevision: "resolved-by-runner" })).rejects.toThrow(/placeholder/);
  });
});

describe("chooseJudge", () => {
  const judgeModel = (id: string, locality: "hosted" | "local"): ModelDescriptor =>
    ({ id, name: id, publisher: "p", tasks: ["judgment"], ports: ["judge"], locality, platforms: ["native"], license: "x", downloadBytes: bytes(0), runtime: "ai-gateway", run: { model: id }, benchmarks: [] }) as ModelDescriptor;

  it("EV3.8 the judge is the preferred judgment model that loads; failures are reasons, and none left blocks every case", async () => {
    const ensemble = new Ensemble({ platform: "native", preferences: { judgment: ["hosted-judge", "local-judge"] } });
    ensemble.register(judgeModel("hosted-judge", "hosted"), async () => {
      throw new Error("no credential");
    });
    ensemble.register(judgeModel("local-judge", "local"), async () => ({ judge: judgeFrom(() => 0.9).judge.model }));
    const choice = await chooseJudge(ensemble);
    expect(choice.judge?.identity).toEqual({ provider: "ai-gateway", modelId: "local-judge" });
    expect((await runEvals([yesCase("a", "4")], choice)).results[0]).toMatchObject({ verdict: "passed" });

    ensemble.revoke("local-judge", "revoked");
    const none = await chooseJudge(ensemble);
    expect(none).toEqual({ unavailable: "No judge could be reached: hosted-judge: no credential; local-judge: revoked" });
    expect(await chooseJudge(new Ensemble({ platform: "native" }))).toEqual({ unavailable: "No judge could be reached" });
  });

  it("EV3.9 errors other than having no judge are not hidden", async () => {
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.register(judgeModel("j", "local"), async () => ({ judge: judgeFrom(() => 1).judge.model }));
    const broken = Object.assign(ensemble, { resolve: async () => Promise.reject(new TypeError("bug")) });
    await expect(chooseJudge(broken)).rejects.toThrow("bug");
  });
});
