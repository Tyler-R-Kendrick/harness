import { describe, expect, it } from "vitest";
import { BlockedError, JevJudge, resolveGatewayCredential, runEvals } from "@harness/evals";
import type { EvalCase } from "@harness/evals";
import { FakeEvaluationModel } from "../../models/test/fake-evaluation-model.ts";

const yesCase = (id: string, reply: string): EvalCase => ({
  id,
  description: `reply ${reply}`,
  subject: async () => ({ question: "2+2?", reply }),
  questions: { correct: { type: "boolean", instructions: "Does the reply correctly answer the question?" } },
  expect: { correct: { type: "boolean", expect: true } },
});

const judgeFrom = (p: (state: unknown) => number) =>
  new JevJudge({ model: new FakeEvaluationModel((o) => ({ correct: { type: "boolean", probability: p(o.state) } })) });

describe("runEvals", () => {
  it("EV3.1 without a gateway credential every case is blocked and the judge is never called", async () => {
    const model = new FakeEvaluationModel(() => ({}));
    const report = await runEvals([yesCase("a", "4")], new JevJudge({ model }), { credential: undefined });
    expect(report.results).toEqual([expect.objectContaining({ id: "a", verdict: "blocked", reason: expect.stringMatching(/AI_GATEWAY_API_KEY/) })]);
    expect(model.calls).toEqual([]);
    expect(report.summary).toMatchObject({ total: 1, blocked: 1, passed: 0 });
  });

  it("EV3.2 verdicts come from the judge's typed answers", async () => {
    const judge = judgeFrom((s) => ((s as { reply: string }).reply === "4" ? 0.95 : (s as { reply: string }).reply === "5" ? 0.05 : 0.6));
    const report = await runEvals([yesCase("good", "4"), yesCase("bad", "5"), yesCase("unsure", "four-ish")], judge, { credential: "api-key" });
    expect(report.results.map((r) => [r.id, r.verdict])).toEqual([
      ["good", "passed"],
      ["bad", "failed"],
      ["unsure", "inconclusive"],
    ]);
    expect(report.results[0]!.answers).toEqual({ correct: { type: "boolean", probability: 0.95 } });
    expect(report.summary).toMatchObject({ total: 3, passed: 1, failed: 1, inconclusive: 1, blocked: 0 });
  });

  it("EV3.3 the pass rate carries a Wilson interval over decided cases only", async () => {
    const judge = judgeFrom(() => 0.95);
    const report = await runEvals([yesCase("a", "4"), yesCase("b", "4")], judge, { credential: "api-key" });
    expect(report.summary.passRate).toMatchObject({ successes: 2, trials: 2, interval: [expect.any(Number), 1] });
    expect(report.summary.passRate.interval[0]).toBeLessThan(0.5);
  });

  it("EV3.4 a subject that needs unavailable access is blocked; a subject that crashes fails", async () => {
    const judge = judgeFrom(() => 0.95);
    const blocked: EvalCase = { ...yesCase("b", "4"), subject: async () => { throw new BlockedError("model worker needs gateway access"); } };
    const crashed: EvalCase = { ...yesCase("c", "4"), subject: async () => { throw new Error("daemon exploded"); } };
    const report = await runEvals([blocked, crashed], judge, { credential: "api-key" });
    expect(report.results).toEqual([
      expect.objectContaining({ id: "b", verdict: "blocked", reason: "model worker needs gateway access" }),
      expect.objectContaining({ id: "c", verdict: "failed", reason: expect.stringMatching(/daemon exploded/) }),
    ]);
  });

  it("EV3.5 a judge authentication failure is blocked; other judge failures are inconclusive", async () => {
    const authFail = new JevJudge({ model: new FakeEvaluationModel(() => { throw Object.assign(new Error("unauthorized"), { statusCode: 401 }); }) });
    const flaky = new JevJudge({ model: new FakeEvaluationModel(() => { throw new Error("socket hang up"); }) });
    expect((await runEvals([yesCase("a", "4")], authFail, { credential: "api-key" })).results[0]).toMatchObject({ verdict: "blocked" });
    expect((await runEvals([yesCase("a", "4")], flaky, { credential: "api-key" })).results[0]).toMatchObject({ verdict: "inconclusive", reason: expect.stringMatching(/socket hang up/) });
  });

  it("EV3.6 wrapped access errors (e.g. inside a retry error) are still recognised", async () => {
    const wrapped = new JevJudge({
      model: new FakeEvaluationModel(() => {
        throw Object.assign(new Error("retries exhausted"), { errors: [Object.assign(new Error("forbidden"), { name: "GatewayForbiddenError" })] });
      }),
    });
    expect((await runEvals([yesCase("a", "4")], wrapped, { credential: "oidc" })).results[0]).toMatchObject({ verdict: "blocked" });
  });

  it("EV3.7 the report identifies the judge and the source revision", async () => {
    const report = await runEvals([yesCase("a", "4")], judgeFrom(() => 0.9), { credential: "api-key", sourceRevision: "abc123" });
    expect(report).toMatchObject({ schemaVersion: "harness.eval/v1", sourceRevision: "abc123", judge: { provider: "fake", modelId: "fake-jev" } });
    await expect(runEvals([], judgeFrom(() => 1), { credential: undefined, sourceRevision: "resolved-by-runner" })).rejects.toThrow(/placeholder/);
  });
});

describe("resolveGatewayCredential", () => {
  it("EV4.1 prefers an API key, accepts an OIDC token, and reports absence", () => {
    expect(resolveGatewayCredential({ AI_GATEWAY_API_KEY: "k", VERCEL_OIDC_TOKEN: "t" })).toBe("api-key");
    expect(resolveGatewayCredential({ VERCEL_OIDC_TOKEN: "t" })).toBe("oidc");
    expect(resolveGatewayCredential({ AI_GATEWAY_API_KEY: "" })).toBeUndefined();
    expect(resolveGatewayCredential({})).toBeUndefined();
  });
});
