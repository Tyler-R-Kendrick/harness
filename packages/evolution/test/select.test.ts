import { describe, expect, it } from "vitest";
import { calibratedDecision, choose, paperDecision } from "@harness/evolution";
import type { CalibratedRule, Measured, PaperRule } from "@harness/evolution";

// The paper's three instances (domains/*/rrsi.json of the reference implementation).
type Calibrated = PaperRule & { readonly delta: number };
const CODING: Calibrated = { rule: "paper", delta: 0.017, beta0: 0.1, beta1: 44.5, ws: 0, wc: 15, wn: 0.5, prune: 4 };
const WORKSPACE: Calibrated = { rule: "paper", delta: 0.004, beta0: 0.1, beta1: 35.4, ws: 1414, wc: 15, wn: 0.5, prune: 4 };
const ENGINEERING: Calibrated = { rule: "paper", delta: 0.02, beta0: 0.15, beta1: 24.4, ws: 244, wc: 2, wn: 0.5, prune: 5 };

const RULE: CalibratedRule = { rule: "calibrated", alpha: 0.1, resamples: 1000, margin: 0.01, saving: 0.05, beta0: 0.1, beta1: 40 };

/** A measured candidate with a paired gain, its bounds, and a relative cost change. */
const cand = (label: string, gain: number, lower: number, upper: number, costChange: number | undefined, extra: Partial<Measured> = {}): Measured => ({
  label,
  kind: "change",
  score: 0.5 + gain,
  gain,
  lower,
  upper,
  ...(costChange === undefined ? {} : { costChange }),
  components: ["prompt"],
  guards: [],
  ...extra,
});

describe("the paper's selection rule (Algorithm 2), as published", () => {
  const ctx = { best: 0.5, accepted: new Set<string>(), structural: ["skill", "memory", "client_tool", "subagent"] };

  it("RS8.1 it keeps the floor S* - delta, the gain-dependent cost rule, the within-band rule, guards, and the argmax of S'", () => {
    const rule: Calibrated = { ...CODING, delta: 0.05, beta1: 40, ws: 100 };
    expect(paperDecision(cand("C", -0.2, 0, 0, 0), rule, ctx)).toMatchObject({ admissible: false, reason: expect.stringMatching(/below the noise-adjusted floor/) });
    expect(paperDecision(cand("A", 0.2, 0, 0, 0.1 + 40 * 0.2 - 0.01), rule, ctx).admissible).toBe(true);
    expect(paperDecision(cand("E", 0.2, 0, 0, 0.1 + 40 * 0.2 + 0.01), rule, ctx)).toMatchObject({ admissible: false, reason: expect.stringMatching(/cost rule/) });
    expect(paperDecision(cand("N", 0, 0, 0, -0.1), rule, ctx).admissible).toBe(true);
    expect(paperDecision(cand("N", 0, 0, 0, 0.1), rule, ctx).admissible).toBe(false);
    expect(paperDecision(cand("S", 0, 0, 0, undefined, { components: ["skill"] }), rule, ctx)).toMatchObject({ admissible: true, novelty: 1 });
    expect(paperDecision(cand("S", 0, 0, 0, undefined, { components: ["skill"] }), rule, { ...ctx, accepted: new Set(["skill"]) })).toMatchObject({ admissible: false, novelty: 0 });
    expect(paperDecision(cand("G", 0.2, 0, 0, 0, { guards: ["valid rate fell"] }), rule, ctx)).toMatchObject({ admissible: false, reason: "domain guard violated: valid rate fell" });
    const decisions = [cand("A", 0.2, 0, 0, 0), cand("B", 0.1, 0, 0, 0)].map((c) => ({ candidate: c, decision: paperDecision(c, rule, ctx) }));
    expect(choose(decisions, "score")?.label).toBe("A");
    expect(choose([], "score")).toBeUndefined();
  });

  it("RS8.2 its acceptance region is not monotone in the gain: just inside delta a candidate may add far more cost than one just outside", () => {
    // Engineering: dS = 0.019 (inside delta 0.02) is admitted at +200% tokens; dS = 0.021 is refused at +100%.
    expect(paperDecision(cand("in", 0.019, 0, 0, 2.0), ENGINEERING, ctx).admissible).toBe(true);
    expect(paperDecision(cand("out", 0.021, 0, 0, 1.0), ENGINEERING, ctx).admissible).toBe(false);
    // Workspace: dS = 0.0039 is admitted at +30% tokens; dS = 0.0041 is capped at +24.5%.
    expect(paperDecision(cand("in", 0.0039, 0, 0, 0.3), WORKSPACE, ctx).admissible).toBe(true);
    expect(paperDecision(cand("out", 0.0041, 0, 0, 0.3), WORKSPACE, ctx).admissible).toBe(false);
  });

  it("RS8.3 inside the band it admits any positive point gain at no added cost, and a new structural component slightly worse than the incumbent", () => {
    expect(paperDecision(cand("noise", 0.0001, 0, 0, 0), WORKSPACE, ctx).admissible).toBe(true);
    expect(paperDecision(cand("noise", 0.0001, 0, 0, 0), ENGINEERING, ctx).admissible).toBe(true);
    const worse = cand("worse", -0.01, 0, 0, 0, { components: ["memory"] });
    expect(paperDecision(worse, CODING, ctx).admissible).toBe(true);
  });
});

describe("the calibrated rule", () => {
  const ctx = { drift: 0, anchor: { score: 0.4, cost: 1000 } };

  it("RS8.4 a change is a gain only when its lower bound is above zero, and its cost is paid for by that lower bound, not by the point estimate", () => {
    expect(calibratedDecision(cand("A", 0.03, 0.01, 0.05, 0.2), RULE, ctx)).toMatchObject({ admissible: true, reason: expect.stringMatching(/^supported gain/) });
    // 0.1 + 40 * 0.03 = 1.3 would pay for +60% tokens; 0.1 + 40 * 0.01 = 0.5 does not.
    expect(calibratedDecision(cand("B", 0.03, 0.01, 0.05, 0.6), RULE, ctx)).toMatchObject({ admissible: false, reason: expect.stringMatching(/^costs \+60\.0% tokens/) });
    expect(calibratedDecision(cand("C", 0.03, 0.01, 0.05, undefined), RULE, ctx).admissible).toBe(true);
  });

  it("RS8.5 without a supported gain, only a saving of at least `saving` that is non-inferior (lower bound above -margin) is admissible", () => {
    expect(calibratedDecision(cand("big", 0.05, -0.001, 0.1, 0), RULE, ctx)).toMatchObject({ admissible: false, reason: expect.stringMatching(/no supported gain .* and saves no more than 5\.0%/) });
    expect(calibratedDecision(cand("cheap", -0.002, -0.008, 0.004, -0.2), RULE, ctx)).toMatchObject({ admissible: true, reason: expect.stringMatching(/^non-inferior .* saves 20\.0%/) });
    expect(calibratedDecision(cand("cheap", -0.002, -0.008, 0.004, undefined), RULE, ctx).admissible).toBe(false);
    expect(calibratedDecision(cand("risky", -0.002, -0.02, 0.01, -0.2), RULE, ctx)).toMatchObject({ admissible: false, reason: expect.stringMatching(/may be worse than the incumbent by more than the margin/) });
    expect(calibratedDecision(cand("edge", -0.002, -0.01, 0.01, -0.05), RULE, ctx).admissible).toBe(true);
  });

  it("RS8.6 removing a mechanism is admissible when non-inferior and not costlier than beta0; accepted losses accumulate against the margin", () => {
    const prune = (gain: number, lower: number, cost?: number) => cand("P", gain, lower, gain + 0.01, cost, { kind: "prune" });
    expect(calibratedDecision(prune(-0.004, -0.009), RULE, ctx)).toMatchObject({ admissible: true, reason: expect.stringMatching(/^non-inferior .* removes a mechanism/) });
    expect(calibratedDecision(prune(-0.004, -0.009, 0.5), RULE, ctx)).toMatchObject({ admissible: false, reason: expect.stringMatching(/removing it costs \+50\.0% tokens/) });
    expect(calibratedDecision(prune(-0.004, -0.009, 0.1), RULE, ctx).admissible).toBe(true);
    expect(calibratedDecision(prune(-0.004, -0.009), RULE, { ...ctx, drift: 0.007 })).toMatchObject({ admissible: false, reason: expect.stringMatching(/accumulated losses 0\.0110 would exceed the margin 0\.0100/) });
    expect(calibratedDecision(prune(0.004, -0.009), RULE, { ...ctx, drift: 0.009 }).admissible).toBe(true);
    expect(calibratedDecision(prune(-0.001, -0.009), RULE, { ...ctx, drift: 0.0085 }).admissible).toBe(true);
  });

  it("RS8.7 cost is also capped against the base harness, so allowances do not compound round after round", () => {
    // +20% on the incumbent is paid for, but the harness would be 2.2x the base's cost for a total gain of 0.13 (0.1 + 40 * 0.13 = 5.3: allowed).
    expect(calibratedDecision(cand("A", 0.03, 0.01, 0.05, 0.2, { cost: 2200 }), RULE, ctx).admissible).toBe(true);
    // Against a base scoring what the candidate does, the whole +120% is unpaid.
    expect(calibratedDecision(cand("A", 0.03, 0.01, 0.05, 0.2, { cost: 2200 }), RULE, { ...ctx, anchor: { score: 0.53, cost: 1000 } })).toMatchObject({ admissible: false, reason: expect.stringMatching(/\+120\.0% tokens over the base harness/) });
    expect(calibratedDecision(cand("A", 0.03, 0.01, 0.05, 0.2, { cost: 2200 }), RULE, { ...ctx, anchor: { score: 0.53 } }).admissible).toBe(true);
    // A saving that is non-inferior is still held to the cap.
    expect(calibratedDecision(cand("S", 0, -0.005, 0.005, -0.1, { cost: 2200 }), RULE, { ...ctx, anchor: { score: 0.5, cost: 1000 } }).admissible).toBe(false);
  });

  it("RS8.8 domain guards are non-compensatory", () => {
    expect(calibratedDecision(cand("A", 0.1, 0.05, 0.15, 0, { guards: ["no-submission rate rose"] }), RULE, ctx)).toMatchObject({ admissible: false, reason: "domain guard violated: no-submission rate rose" });
  });

  it("RS8.9 among admissible candidates the winner has the highest lower bound, not the highest point estimate (the winner's curse)", () => {
    const a = cand("A", 0.05, 0.001, 0.1, 0);
    const b = cand("B", 0.03, 0.02, 0.04, 0);
    const c = cand("C", 0.03, 0.02, 0.04, -0.1);
    const d = cand("D", 0.2, -0.1, 0.3, 0);
    const decisions = [a, b, c, d].map((x) => ({ candidate: x, decision: calibratedDecision(x, RULE, ctx) }));
    expect(choose(decisions, "lower")?.label).toBe("C");
    expect(choose(decisions.slice(0, 2), "lower")?.label).toBe("B");
    expect(choose([b, { ...b, label: "A" }].map((x) => ({ candidate: x, decision: calibratedDecision(x, RULE, ctx) })), "lower")?.label).toBe("A");
    expect(choose(decisions.slice(3), "lower")).toBeUndefined();
  });
});
