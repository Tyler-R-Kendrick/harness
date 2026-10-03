import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { parseCalibration } from "../src/calibration.ts";
import { holdoutSplit } from "../src/distill.ts";
import { DecisionError, forkId } from "../src/types.ts";
import type { DecisionRecord, TraceStep } from "../src/types.ts";
import { yes } from "./loops-fixtures.ts";
import { humanOutcome, put, rig } from "./compose-fixtures.ts";
import { gate, sure } from "./fork-fixtures.ts";

const GATE = forkId("test.gate");
const OTHER = forkId("other.fork");
const p = probability;
const right = humanOutcome("correct", { correct: true });
const wrong = humanOutcome("incorrect", { correct: false });

describe("report", () => {
  async function filled() {
    const r = rig();
    const rows: Partial<Omit<DecisionRecord, "id">>[] = [
      { confidence: p(0.9), outcome: right },
      { confidence: p(0.9), outcome: wrong },
      { rung: "judge", confidence: p(0.7), outcome: right },
      { rung: "rule", confidence: p(1), outcome: right },
      { rung: "human", confidence: p(0) },
      { explored: true, mode: "shadow", propensity: p(0.2), confidence: p(0.6), outcome: wrong },
      { confidence: p(0.3), outcome: humanOutcome("approved") },
      { confidence: p(0.8) },
    ];
    for (const row of rows) await put(r.log, row);
    await put(r.log, { fork: OTHER, confidence: p(0.8), outcome: right });
    return r;
  }

  it("DCO5.1 a fork's report counts its decisions by rung, by mode, explored, and with an outcome, adding up to all of them", async () => {
    const { layer } = await filled();
    const [report] = await layer.report(GATE);
    expect(report).toMatchObject({ fork: GATE, decisions: 8, explored: 1, withOutcome: 6 });
    expect(report!.byRung).toEqual({ rule: 1, model: 5, judge: 1, generator: 0, human: 1 });
    expect(report!.byMode).toEqual({ active: 7, shadow: 1 });
  });

  it("DCO5.2 accuracy is the share right among the decisions whose outcome says right or wrong, and the mean confidence is over every decision", async () => {
    const { layer } = await filled();
    const [report] = await layer.report(GATE);
    expect(report!.judged).toBe(5);
    expect(report!.accuracy).toBeCloseTo(3 / 5, 12);
    expect(report!.meanConfidence).toBeCloseTo(5.2 / 8, 12);
  });

  it("DCO5.3 calibration is measured on judged, non-exploring decisions of a model or the judge: bins, error, and the risk of acting from the most confident down", async () => {
    const { layer } = await filled();
    const [report] = await layer.report(GATE);
    expect(report!.calibrated).toBe(3);
    expect(report!.reliability).toHaveLength(10);
    expect(report!.reliability.reduce((sum, bin) => sum + bin.n, 0)).toBe(3);
    expect(report!.reliability[9]).toMatchObject({ lo: 0.9, hi: 1, n: 2, confidence: 0.9, accuracy: 0.5 });
    expect(report!.reliability[7]).toMatchObject({ lo: 0.7, n: 1, confidence: 0.7, accuracy: 1 });
    expect(report!.reliability[0]).toMatchObject({ lo: 0, hi: 0.1, n: 0, confidence: 0, accuracy: 0 });
    expect(report!.ece).toBeCloseTo((2 * 0.4 + 0.3) / 3, 12);
    expect(report!.riskCoverage).toEqual([
      { threshold: 0.9, coverage: 2 / 3, risk: 0.5 },
      { threshold: 0.7, coverage: 1, risk: 1 / 3 },
    ]);
  });

  it("DCO5.7 a decision whose floor raised the action, or that explored, is not a confidence claim: its outcome is about another action than the confidence", async () => {
    const r = rig();
    await put(r.log, { confidence: p(0.9), action: "allow", verdict: "allow", outcome: right });
    await put(r.log, { confidence: p(0.9), action: "deny", verdict: "allow", greedy: "deny", outcome: wrong });
    await put(r.log, { confidence: p(0.9), action: "deny", verdict: "allow", greedy: "allow", explored: true, outcome: right });
    await put(r.log, { confidence: p(0.9), action: "allow", verdict: "allow", greedy: "allow", explored: true, outcome: right });
    const [report] = await r.layer.report(GATE);
    expect(report).toMatchObject({ decisions: 4, judged: 4, calibrated: 1, ece: expect.closeTo(0.1, 12) });
    expect(report!.riskCoverage.map((row) => row.coverage)).toEqual([1]);
    const thresholds = await r.layer.thresholds({ fork: GATE, targetRisk: 0.5, delta: 0.1, bound: "hoeffding" });
    expect(thresholds.samples).toBe(1);
  });

  it("DCO5.4 without a fork, every fork has its own report in the order they first appear; a fork or a filter narrows it", async () => {
    const { layer } = await filled();
    const all = await layer.report();
    expect(all.map((r) => [r.fork, r.decisions])).toEqual([[GATE, 8], [OTHER, 1]]);
    expect((await layer.report(OTHER)).map((r) => r.decisions)).toEqual([1]);
    const shadow = await layer.report(undefined, { mode: "shadow" });
    expect(shadow.map((r) => [r.fork, r.decisions])).toEqual([[GATE, 1]]);
    expect((await layer.report(GATE, { hasOutcome: false }))[0]!.decisions).toBe(2);
    expect(await layer.report(forkId("none.such"))).toEqual([]);
  });

  it("DCO5.5 a fork with nothing judged has no accuracy and no error, and no risk curve", async () => {
    const r = rig();
    await put(r.log, { rung: "human", confidence: p(0) });
    const [report] = await r.layer.report(GATE);
    expect(report).toMatchObject({ decisions: 1, judged: 0, accuracy: null, calibrated: 0, ece: null, riskCoverage: [], meanConfidence: 0 });
    expect(report!.reliability.every((bin) => bin.n === 0)).toBe(true);
  });

  it("DCO5.6 a confidence of exactly 1 falls in the last bin", async () => {
    const r = rig();
    await put(r.log, { confidence: p(1), outcome: right });
    const [report] = await r.layer.report(GATE);
    expect(report!.reliability[9]).toMatchObject({ n: 1, confidence: 1, accuracy: 1 });
    expect(report!.ece).toBe(0);
  });
});

describe("calibrate", () => {
  /** A member that is sure (0.95) and right half the time, over `n` decisions with outcomes. */
  async function overconfident(r: ReturnType<typeof rig>, n = 20, version = "v1") {
    for (let i = 0; i < n; i++) await put(r.log, { member: "m", memberVersion: version, answers: { q: yes(0.95) }, outcome: i % 2 === 0 ? right : wrong });
  }

  it("DCO6.1 a book is fitted from the outcomes in the log, with the standard labels, and installed", async () => {
    const r = rig();
    await overconfident(r);
    const fitted = await r.layer.calibrate({ at: 12_345, minSamples: 10 });
    expect(fitted).toHaveLength(1);
    expect(fitted[0]).toMatchObject({ fork: GATE, member: "m", version: "v1", question: "q", fitted: { n: 20, at: 12_345 } });
    expect(fitted[0]!.calibrator.kind).not.toBe("identity");
    expect(fitted[0]!.fitted.eceAfter).toBeLessThan(fitted[0]!.fitted.eceBefore);
    expect(r.layer.calibration().entries).toEqual(fitted);
  });

  it("DCO6.2 the book is used by the next decision at once", async () => {
    const r = rig({ members: [sure("m", 0.97)] });
    await overconfident(r);
    const before = await r.layer.decide(gate(), { text: "x" });
    expect(before.rung).toBe("model");
    expect(before.record.raw).toBeUndefined();
    await r.layer.calibrate({ minSamples: 10 });
    const after = await r.layer.decide(gate(), { text: "y" });
    expect(after.rung).not.toBe("model");
    // calibrated to about the member's real accuracy (one half), the verdict is no longer taken as confident
    const modelStep = after.record.trace.find((step) => step.rung === "model")!;
    expect(modelStep.confidence!).toBeLessThan(0.7);
  });

  it("DCO6.3 the time defaults to the clock, and a book is not fitted on fewer samples than asked (30 when not said)", async () => {
    const r = rig();
    await overconfident(r, 20);
    expect(await r.layer.calibrate()).toEqual([]);
    expect(r.layer.calibration().entries).toEqual([]);
    r.clock.advance(5);
    const fitted = await r.layer.calibrate({ minSamples: 20 });
    expect(fitted.map((e) => e.fitted.at)).toEqual([10_005]);
  });

  it("DCO6.4 onCalibration is told the book after every install, fitted or not, and install replaces the book", async () => {
    const told: number[] = [];
    const r = rig({ onCalibration: (book) => void told.push(book.entries.length) });
    await overconfident(r);
    await r.layer.calibrate({ minSamples: 100 });
    await r.layer.calibrate({ minSamples: 10 });
    expect(told).toEqual([0, 1]);
    await r.layer.install(parseCalibration({ entries: [] }));
    expect(told).toEqual([0, 1, 0]);
    expect(r.layer.calibration().entries).toEqual([]);
  });

  it("DCO6.5 an async onCalibration is waited for", async () => {
    let done = false;
    const r = rig({ onCalibration: async () => (await Promise.resolve(), void (done = true)) });
    await r.layer.install(parseCalibration({ entries: [] }));
    expect(done).toBe(true);
  });

  it("DCO6.6 entries fitted earlier stay in the book, and only those fitted now are returned; a member's other version is another entry", async () => {
    const old = parseCalibration({
      entries: [{ fork: "test.gate", member: "m", version: "v0", question: "q", calibrator: { kind: "identity" }, fitted: { n: 40, at: 5, eceBefore: 0.1, eceAfter: 0.1, brierBefore: 0.1, brierAfter: 0.1 } }],
    });
    const r = rig({ calibration: old });
    await overconfident(r, 20, "v1");
    const fitted = await r.layer.calibrate({ at: 99, minSamples: 10 });
    expect(fitted.map((e) => e.version)).toEqual(["v1"]);
    expect(r.layer.calibration().entries.map((e) => [e.version, e.fitted.at])).toEqual([["v0", 5], ["v1", 99]]);
  });

  it("DCO6.7 decisions with no outcome, and outcomes that name no right option, are not used", async () => {
    const r = rig();
    for (let i = 0; i < 20; i++) await put(r.log, { member: "m", memberVersion: "v1", answers: { q: yes(0.95) } });
    for (let i = 0; i < 20; i++) await put(r.log, { member: "m", memberVersion: "v1", answers: { q: yes(0.95) }, outcome: humanOutcome("approved") });
    expect(await r.layer.calibrate({ minSamples: 1 })).toEqual([]);
  });
});

describe("thresholds", () => {
  async function seeded() {
    const r = rig();
    for (let i = 0; i < 200; i++) await put(r.log, { confidence: p(0.95), outcome: right });
    for (let i = 0; i < 50; i++) await put(r.log, { confidence: p(0.6), outcome: i < 25 ? right : wrong });
    // none of these is a model's confidence about its verdict
    await put(r.log, { confidence: p(0.99), explored: true, outcome: wrong });
    await put(r.log, { rung: "rule", confidence: p(1), outcome: wrong });
    await put(r.log, { rung: "human", confidence: p(0), outcome: wrong });
    await put(r.log, { rung: "generator", confidence: p(0), outcome: wrong });
    await put(r.log, { confidence: p(0.99) });
    await put(r.log, { confidence: p(0.99), outcome: humanOutcome("approved") });
    await put(r.log, { fork: OTHER, confidence: p(0.99), outcome: wrong });
    return r;
  }

  it("DCO7.1 the recommended act threshold is the lowest confidence down to which the risk of acting stays bounded", async () => {
    const { layer } = await seeded();
    const result = await layer.thresholds({ fork: GATE, targetRisk: 0.1, delta: 0.1, bound: "hoeffding" });
    expect(result).toMatchObject({ fork: GATE, threshold: 0.95, n: 200, coverage: 200 / 250, risk: 0, samples: 250, currentAct: 0.9 });
    expect(result.upperBound).toBeLessThan(0.1);
  });

  it("DCO7.2 a looser bound reaches lower, and Clopper-Pearson is accepted", async () => {
    const { layer } = await seeded();
    const loose = await layer.thresholds({ fork: GATE, targetRisk: 0.6, delta: 0.1, bound: "clopper-pearson" });
    expect(loose.threshold).toBe(0.6);
    expect(loose.n).toBe(250);
  });

  it("DCO7.3 with nothing judged there is no threshold, not an error", async () => {
    const r = rig();
    const result = await r.layer.thresholds({ fork: GATE, targetRisk: 0.1, delta: 0.1, bound: "hoeffding" });
    expect(result).toMatchObject({ threshold: undefined, samples: 0, coverage: 0, n: 0 });
  });

  it("DCO7.4 a bad target is refused by the bound's own check", async () => {
    const r = rig();
    await expect(r.layer.thresholds({ fork: GATE, targetRisk: 2, delta: 0.1, bound: "hoeffding" })).rejects.toThrow(RangeError);
  });

  it("DCO7.5 the fork's own policy gives the current threshold", async () => {
    const r = rig({ policyPatch: { forks: { "test.gate": { act: 0.8 } } } });
    expect((await r.layer.thresholds({ fork: GATE, targetRisk: 0.1, delta: 0.1, bound: "hoeffding" })).currentAct).toBe(0.8);
  });
});

describe("estimate", () => {
  const step = (confidence: number): TraceStep => ({ rung: "model", member: "m", outcome: "to be verified", confidence: p(confidence) });

  async function seeded() {
    const r = rig();
    for (let i = 0; i < 4; i++) await put(r.log, { confidence: p(0.95), outcome: right });
    for (let i = 0; i < 4; i++) await put(r.log, { confidence: p(0.7), outcome: i === 0 ? right : wrong });
    for (let i = 0; i < 2; i++) await put(r.log, { rung: "judge", confidence: p(0.85), trace: [step(0.4), step(0.6)], outcome: right });
    await put(r.log, { rung: "human", confidence: p(0), outcome: right });
    await put(r.log, { rung: "judge", confidence: p(0.9), outcome: right });
    await put(r.log, { confidence: p(0.99), outcome: humanOutcome("approved") });
    // none of these has a model's verdict and its confidence in the record
    await put(r.log, { rung: "human", confidence: p(0), trace: [step(0.99)], outcome: wrong });
    await put(r.log, { rung: "generator", confidence: p(0), trace: [step(0.99)], outcome: wrong });
    await put(r.log, { rung: "judge", confidence: p(0.9), trace: [], outcome: wrong });
    await put(r.log, { rung: "judge", confidence: p(0.9), trace: [{ ...step(0.99), outcome: "below verify" }], outcome: wrong });
    await put(r.log, { rung: "judge", confidence: p(0.9), trace: [{ ...step(0.99), rung: "generator" }], outcome: wrong });
    await put(r.log, { rung: "judge", confidence: p(0.9), trace: [{ rung: "model", outcome: "to be verified" }], outcome: wrong });
    await put(r.log, { fork: OTHER, confidence: p(0.99), outcome: wrong });
    // not yet judged
    await put(r.log, { confidence: p(0.99) });
    return r;
  }

  it("DCO8.1 acting on a lower threshold is valued by the accuracy of the decisions it would have acted on, with the current one beside it", async () => {
    const { layer } = await seeded();
    const result = await layer.estimate({ fork: GATE, target: { act: p(0.5) } });
    expect(result.fork).toBe(GATE);
    expect(result.samples).toBe(10);
    expect(result.target.act).toBe(0.5);
    expect(result.target.estimate).toBeCloseTo(7 / 10, 12);
    expect(result.target.coverage).toBe(1);
    expect(result.target.n).toBe(10);
    expect(Number.isFinite(result.target.standardError)).toBe(true);
    expect(result.target.effectiveSampleSize).toBeCloseTo(10, 9);
    expect(result.current.act).toBe(0.9);
    expect(result.current.estimate).toBe(1);
    expect(result.current.coverage).toBeCloseTo(0.4, 12);
  });

  it("DCO8.2 a higher threshold acts on fewer, and one nothing reaches has no evidence", async () => {
    const { layer } = await seeded();
    const high = await layer.estimate({ fork: GATE, target: { act: p(0.65) } });
    expect(high.target.coverage).toBeCloseTo(0.8, 12);
    expect(high.target.estimate).toBeCloseTo((4 + 1) / 8, 12);
    // a confidence exactly at the threshold is acted on
    const exact = await layer.estimate({ fork: GATE, target: { act: p(0.7) } });
    expect(exact.target.coverage).toBeCloseTo(0.8, 12);
    const none = await layer.estimate({ fork: GATE, target: { act: p(1) } });
    expect(none.target).toMatchObject({ coverage: 0, estimate: 0, effectiveSampleSize: 0 });
    expect(none.target.standardError).toBe(Number.POSITIVE_INFINITY);
  });

  it("DCO8.3 a logged decision is weighted by the inverse of its propensity", async () => {
    const r = rig();
    await put(r.log, { confidence: p(0.95), propensity: p(0.5), outcome: right });
    await put(r.log, { confidence: p(0.95), propensity: p(0.5), outcome: right });
    await put(r.log, { confidence: p(0.95), propensity: p(1), outcome: wrong });
    const result = await r.layer.estimate({ fork: GATE, target: { act: p(0.9) } });
    expect(result.target.estimate).toBeCloseTo((2 + 2) / (2 + 2 + 1), 12);
  });

  it("DCO8.4 a decision that explored counts when its random draw landed on the action the policy would have taken, whatever its propensity, and not when it chose another", async () => {
    const r = rig();
    await put(r.log, { confidence: p(0.95), outcome: right });
    // an explored draw on another option, however likely
    await put(r.log, { confidence: p(0.95), explored: true, action: "deny", verdict: "allow", greedy: "allow", propensity: p(0.05), outcome: wrong });
    await put(r.log, { confidence: p(0.95), explored: true, action: "deny", verdict: "allow", greedy: "allow", propensity: p(0.9), outcome: wrong });
    // a record that does not say what the policy would have taken is not taken to have been it
    await put(r.log, { confidence: p(0.95), explored: true, propensity: p(0.9), outcome: wrong });
    const other = await r.layer.estimate({ fork: GATE, target: { act: p(0.5) } });
    expect(other.target.estimate).toBe(1);
    expect(other.target.coverage).toBeCloseTo(1 / 4, 12);
    await put(r.log, { confidence: p(0.95), explored: true, action: "allow", verdict: "allow", greedy: "allow", propensity: p(0.55), outcome: wrong });
    const landed = await r.layer.estimate({ fork: GATE, target: { act: p(0.5) } });
    expect(landed.target.estimate).toBeCloseTo(1 / (1 + 1 / 0.55), 9);
    expect(landed.target.coverage).toBeCloseTo(2 / 5, 12);
  });

  it("DCO8.7 a draw that landed on the greedy action counts whatever the propensity: it is not read from its size, which falls to a half and below for a wide exploration", async () => {
    const r = rig();
    // three options and exploration at 0.9: the greedy action has propensity 0.4, the others 0.3
    await put(r.log, { confidence: p(0.95), explored: true, action: "allow", verdict: "allow", greedy: "allow", propensity: p(0.4), outcome: right });
    await put(r.log, { confidence: p(0.95), explored: true, action: "deny", verdict: "allow", greedy: "allow", propensity: p(0.3), outcome: right });
    const result = await r.layer.estimate({ fork: GATE, target: { act: p(0.5) } });
    expect(result.target.coverage).toBe(0.5);
    expect(result.target.estimate).toBe(1);
  });

  it("DCO8.8 a decision the floor raised, and that did not explore, took the policy's action: it counts at its raised action", async () => {
    const r = rig();
    await put(r.log, { confidence: p(0.95), action: "deny", verdict: "allow", greedy: "deny", outcome: right });
    await put(r.log, { confidence: p(0.95), action: "deny", verdict: "allow", greedy: "deny", outcome: wrong });
    const result = await r.layer.estimate({ fork: GATE, target: { act: p(0.5) } });
    expect(result.target.coverage).toBe(1);
    expect(result.target.estimate).toBe(0.5);
  });

  it("DCO8.5 without a target threshold, or with nothing to estimate from, it is refused as invalid", async () => {
    const r = rig();
    await expect(r.layer.estimate({ fork: GATE, target: { verify: p(0.4) } })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("target.act") });
    await expect(r.layer.estimate({ fork: GATE, target: { act: p(0.5) } })).rejects.toBeInstanceOf(DecisionError);
    await expect(r.layer.estimate({ fork: GATE, target: { act: p(0.5) } })).rejects.toMatchObject({ code: "invalid" });
    await expect(r.layer.estimate({ fork: GATE, target: { act: p(0.5) } })).rejects.toThrow("no judged decisions of test.gate");
  });

  it("DCO8.6 the current threshold is the fork's own policy", async () => {
    const r = rig({ policyPatch: { forks: { "test.gate": { act: 0.65 } } } });
    await put(r.log, { confidence: p(0.7), outcome: right });
    expect((await r.layer.estimate({ fork: GATE, target: { act: p(0.5) } })).current.act).toBe(0.65);
  });

  it("DCO8.9 an estimate for a threshold below the current one is not identified when verdicts that were put to the judge and dropped are missing from the log", async () => {
    const r = rig();
    await put(r.log, { confidence: p(0.95), outcome: right });
    await put(r.log, { rung: "judge", confidence: p(0.85), trace: [step(0.6)], outcome: right });
    const complete = await r.layer.estimate({ fork: GATE, target: { act: p(0.5) } });
    expect(complete.identifiable).toBe(true);
    // a candidate the judge rejected ends at another rung, and is not a sample
    await put(r.log, { rung: "generator", confidence: p(0), trace: [step(0.6), { rung: "judge", outcome: "rejected", confidence: p(0.1) }], outcome: right });
    expect((await r.layer.estimate({ fork: GATE, target: { act: p(0.5) } })).identifiable).toBe(false);
    // at the current threshold or above, the verdicts that are missing are not ones the target would have acted on
    expect((await r.layer.estimate({ fork: GATE, target: { act: p(0.9) } })).identifiable).toBe(true);
    expect((await r.layer.estimate({ fork: GATE, target: { act: p(0.95) } })).identifiable).toBe(true);
    expect((await r.layer.estimate({ fork: GATE, target: { act: p(0.89) } })).identifiable).toBe(false);
  });

  it("DCO8.10 a candidate no judge could verify, or that a person was asked about, is as missing as a rejected one; a judge's acceptance is not", async () => {
    const dropped = async (patch: Partial<Omit<DecisionRecord, "id">>) => {
      const r = rig();
      await put(r.log, { confidence: p(0.95), outcome: right });
      await put(r.log, patch);
      return (await r.layer.estimate({ fork: GATE, target: { act: p(0.5) } })).identifiable;
    };
    expect(await dropped({ rung: "human", confidence: p(0), trace: [step(0.6), { rung: "judge", outcome: "no judge available" }], outcome: right })).toBe(false);
    expect(await dropped({ rung: "generator", confidence: p(0), trace: [step(0.6)], outcome: right })).toBe(false);
    expect(await dropped({ rung: "judge", confidence: p(0.85), trace: [step(0.6), { rung: "judge", outcome: "accepted", confidence: p(0.85) }], outcome: right })).toBe(true);
    expect(await dropped({ rung: "human", confidence: p(0), trace: [{ ...step(0.3), outcome: "below verify" }], outcome: right })).toBe(true);
  });

  it("DCO8.11 only a model's verdict put to the judge is a dropped candidate: another rung's step with that outcome is not", async () => {
    const r = rig();
    await put(r.log, { confidence: p(0.95), outcome: right });
    await put(r.log, { rung: "human", confidence: p(0), trace: [{ rung: "judge", outcome: "to be verified", confidence: p(0.6) }], outcome: right });
    expect((await r.layer.estimate({ fork: GATE, target: { act: p(0.5) } })).identifiable).toBe(true);
  });
});

describe("distill", () => {
  async function seeded() {
    const r = rig();
    for (let i = 0; i < 40; i++) await put(r.log, { member: "m", memberVersion: "v1", answers: { q: yes(0.9) }, outcome: i % 4 === 3 ? wrong : right });
    await put(r.log, { answers: { q: yes(0.9) } });
    await put(r.log, { fork: OTHER, answers: { q: yes(0.9) }, outcome: right });
    return r;
  }

  it("DCO9.1 examples are made from the outcomes with the standard labels, with provenance, for the fork asked", async () => {
    const { layer } = await seeded();
    const examples = await layer.distill({ fork: GATE, holdout: 0 });
    expect(examples).toHaveLength(40);
    expect(examples[0]).toMatchObject({ id: "dec-0:q", fork: GATE, question: "q", label: "true", source: "outcome", split: "train", provenance: { decision: "dec-0", member: "m", memberVersion: "v1", policy: "policy-t" } });
    expect(examples.filter((e) => e.label === "false")).toHaveLength(10);
    expect((await layer.distill({ holdout: 0 })).map((e) => e.fork)).toContain(OTHER);
  });

  it("DCO9.2 the holdout is a stable split of the decisions by their ids, under the layer's salt unless one is given", async () => {
    const { layer } = await seeded();
    const examples = await layer.distill({ fork: GATE, holdout: 0.5 });
    expect(examples.every((e) => e.split === holdoutSplit(e.provenance.decision, 0.5, "harness"))).toBe(true);
    expect(new Set(examples.map((e) => e.split)).size).toBe(2);
    const salted = await layer.distill({ fork: GATE, holdout: 0.5, salt: "other" });
    expect(salted.every((e) => e.split === holdoutSplit(e.provenance.decision, 0.5, "other"))).toBe(true);
    expect(salted.map((e) => e.split)).not.toEqual(examples.map((e) => e.split));
    const custom = rig({ holdoutSalt: "mine" });
    await put(custom.log, { answers: { q: yes(0.9) }, outcome: right });
    expect((await custom.layer.distill({ holdout: 0.5 }))[0]!.split).toBe(holdoutSplit("dec-0", 0.5, "mine"));
  });

  it("DCO9.3 a share outside 0 to 1 is refused", async () => {
    const { layer } = await seeded();
    await expect(layer.distill({ holdout: 2 })).rejects.toThrow(RangeError);
  });
});
