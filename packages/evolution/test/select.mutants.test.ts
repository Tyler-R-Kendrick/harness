import { describe, expect, it } from "vitest";
import { CalibratedRuleSchema, PaperRuleSchema, RuleSchema, calibratedDecision, choose, paperDecision } from "@harness/evolution";
import type { CalibratedContext, CalibratedRule, Decision, Measured, PaperContext, PaperRule } from "@harness/evolution";

type Paper = PaperRule & { readonly delta: number };

// Dyadic fractions throughout, so that the boundaries below are exact in floating point.
const PAPER: Paper = { rule: "paper", delta: 0.25, beta0: 0.25, beta1: 1, ws: 1, wc: 0, wn: 0, prune: 4 };
const PAPER_CTX: PaperContext = { best: 0.5, accepted: new Set<string>(), structural: ["skill"] };

const measuredOf = (extra: Partial<Measured> = {}): Measured => ({
  label: "C",
  kind: "change",
  score: 0.5,
  gain: 0,
  lower: 0,
  upper: 0,
  components: ["prompt"],
  guards: [],
  ...extra,
});

describe("the paper's rule: exact boundaries and reasons", () => {
  it("RS22.20 a score exactly at the floor S* - delta is not below it", () => {
    // Floor 0.5 - 0.25 = 0.25; the candidate scores exactly that and gains nothing, but is new machinery (nu = 1).
    const rule: Paper = { ...PAPER, ws: 1, wc: 0, wn: 1 };
    const d = paperDecision(measuredOf({ score: 0.25, components: ["skill"] }), rule, PAPER_CTX);
    expect(d).toEqual({ admissible: true, reason: "admissible: gain 0.0000 within delta; shaped 1.0000 (nu = 1)", novelty: 1 });
    expect(paperDecision(measuredOf({ score: 0.2499, components: ["skill"] }), rule, PAPER_CTX).admissible).toBe(false);
  });

  it("RS22.21 the floor's reason names the score, the best and delta to four places", () => {
    expect(paperDecision(measuredOf({ score: 0.125 }), PAPER, PAPER_CTX)).toEqual({
      admissible: false,
      reason: "below the noise-adjusted floor: S' 0.1250 < S* 0.5000 - delta 0.2500",
      novelty: 0,
    });
  });

  it("RS22.22 a gain exactly delta is within the band, not above it", () => {
    const d = paperDecision(measuredOf({ score: 0.75, gain: 0.25 }), PAPER, PAPER_CTX);
    expect(d.reason).toBe("admissible: gain 0.2500 within delta; shaped 0.2500 (nu = 0)");
    expect(paperDecision(measuredOf({ score: 0.75, gain: 0.2501 }), PAPER, PAPER_CTX).reason).toMatch(/> delta/);
  });

  it("RS22.23 a cost change exactly at the budget beta0 + beta1 gain is within it", () => {
    // gain 0.5 > delta: budget 0.25 + 1 * 0.5 = 0.75.
    const exact = paperDecision(measuredOf({ score: 1, gain: 0.5, costChange: 0.75 }), PAPER, PAPER_CTX);
    expect(exact).toEqual({ admissible: true, reason: "admissible: gain 0.5000 > delta; cost +75.0% against a budget of +75.0%", novelty: 0 });
    const over = paperDecision(measuredOf({ score: 1, gain: 0.5, costChange: 0.8 }), PAPER, PAPER_CTX);
    expect(over).toEqual({ admissible: false, reason: "cost rule failed: gain 0.5000 > delta; cost +80.0% against a budget of +75.0%", novelty: 0 });
  });

  it("RS22.24 a percentage shows its sign: zero and positive are +, negative is -", () => {
    const zero = paperDecision(measuredOf({ score: 1, gain: 0.5, costChange: 0 }), PAPER, PAPER_CTX);
    expect(zero.reason).toBe("admissible: gain 0.5000 > delta; cost +0.0% against a budget of +75.0%");
    const negative = paperDecision(measuredOf({ score: 1, gain: 0.5, costChange: -0.5 }), PAPER, PAPER_CTX);
    expect(negative.reason).toBe("admissible: gain 0.5000 > delta; cost -50.0% against a budget of +75.0%");
  });

  it("RS22.25 a shaped value of zero is refused, with the reason naming the gain, the shaped value and nu", () => {
    const rule: Paper = { ...PAPER, ws: 1, wc: 1, wn: 1 };
    expect(paperDecision(measuredOf({ gain: 0 }), rule, PAPER_CTX)).toEqual({
      admissible: false,
      reason: "cost rule failed: gain 0.0000 within delta; shaped 0.0000 (nu = 0)",
      novelty: 0,
    });
  });

  it("RS22.26 several violated guards are listed separated by a semicolon and a space", () => {
    const d = paperDecision(measuredOf({ gain: 0.125, guards: ["valid rate fell", "latency rose"] }), PAPER, PAPER_CTX);
    expect(d).toEqual({ admissible: false, reason: "domain guard violated: valid rate fell; latency rose", novelty: 0 });
  });
});

const RULE: CalibratedRule = { rule: "calibrated", alpha: 0.1, resamples: 1000, margin: 0.01, saving: 0.05, beta0: 0.1, beta1: 40 };
const CTX: CalibratedContext = { drift: 0, certified: 0, anchor: {} };
const decide = (c: Partial<Measured>, rule: Partial<CalibratedRule> = {}, ctx: Partial<CalibratedContext> = {}): Decision => calibratedDecision(measuredOf(c), { ...RULE, ...rule }, { ...CTX, ...ctx });

describe("the calibrated rule: guards and the cost cap", () => {
  it("RS22.70 several violated guards are listed separated by a semicolon and a space", () => {
    expect(decide({ guards: ["valid rate fell", "latency rose"] })).toMatchObject({ admissible: false, reason: "domain guard violated: valid rate fell; latency rose" });
  });

  it("RS22.71 a base harness whose cost is zero sets no cap", () => {
    // Against a zero anchor every candidate would be infinitely over; a cost of 0 is no base to be relative to.
    const d = decide({ kind: "prune", cost: 100 }, {}, { anchor: { cost: 0 } });
    expect(d).toMatchObject({ admissible: true, reason: "non-inferior (lower bound 0.0000 > -0.0100), and removes a mechanism" });
  });

  it("RS22.72 a base harness with no cost sets no cap either", () => {
    expect(decide({ kind: "prune", cost: 100 }, {}, { anchor: {} }).admissible).toBe(true);
  });

  it("RS22.73 a candidate that reports no cost is not capped even when the base harness has one", () => {
    expect(decide({ kind: "prune" }, { beta0: 0 }, { anchor: { cost: 100 } }).admissible).toBe(true);
  });

  it("RS22.74 a total cost exactly at the allowance beta0 + beta1 max(0, certified + lower) is within it", () => {
    // Anchor 100, cost 125: 25% over; the allowance is beta0 = 25% (the lower bound and the certified total are 0).
    const rule = { beta0: 0.25 };
    expect(decide({ kind: "prune", cost: 125 }, rule, { anchor: { cost: 100 } }).admissible).toBe(true);
    expect(decide({ kind: "prune", cost: 126 }, rule, { anchor: { cost: 100 } })).toMatchObject({
      admissible: false,
      reason: "the harness would spend +26.0% tokens over the base harness, more than the +25.0% its certified gain pays for",
    });
  });

  it("RS22.75 with an upper bound and a cost change the cap uses the upper bound, and says up to", () => {
    // Cost 200 against an incumbent that cost 100 (change +100%), upper bound +150%: up to 200 * 2.5 / 2 / 100 - 1 = +150%.
    const d = decide({ kind: "prune", cost: 200, costChange: 1, costUpper: 1.5, costLower: 0.5 }, { beta0: 0.25 }, { anchor: { cost: 100 } });
    expect(d).toMatchObject({
      admissible: false,
      reason: "the harness would spend up to +150.0% tokens over the base harness, more than the +25.0% its certified gain pays for",
    });
  });

  it("RS22.76 with a cost change but no upper bound the cap uses the point cost, not an up to", () => {
    const d = decide({ kind: "prune", cost: 200, costChange: 1 }, { beta0: 0.25 }, { anchor: { cost: 100 } });
    expect(d).toMatchObject({
      admissible: false,
      reason: "the harness would spend +100.0% tokens over the base harness, more than the +25.0% its certified gain pays for",
    });
  });

  it("RS22.77 with an upper bound but no cost change the cap uses the point cost, not an up to", () => {
    const d = decide({ kind: "prune", cost: 200, costUpper: 1.5 }, { beta0: 0.25 }, { anchor: { cost: 100 } });
    expect(d).toMatchObject({
      admissible: false,
      reason: "the harness would spend +100.0% tokens over the base harness, more than the +25.0% its certified gain pays for",
    });
  });
});

describe("the calibrated rule: the cost cap when the incumbent's cost is all that remains", () => {
  it("RS26.1 a cost change of exactly -100% leaves nothing to scale the upper bound by, so the point cost is used", () => {
    // 1 + costChange = 0: the upper bound would be divided by zero (an infinite total); the point cost 50 against the base 100 is -50%, within the allowance.
    const d = decide({ kind: "prune", cost: 50, costChange: -1, costLower: -1, costUpper: 0 }, { beta0: 0.25 }, { anchor: { cost: 100 } });
    expect(d).toMatchObject({ admissible: true, reason: "non-inferior (lower bound 0.0000 > -0.0100), and removes a mechanism" });
  });

  it("RS26.2 a cost change below -100% is not scaled by either", () => {
    const d = decide({ kind: "prune", cost: 50, costChange: -2, costLower: -2, costUpper: 0 }, { beta0: 0.25 }, { anchor: { cost: 100 } });
    expect(d.admissible).toBe(true);
  });
});

describe("the calibrated rule: which claim a candidate makes", () => {
  it("RS22.78 a removal with a positive lower bound is judged as a removal, not as a gain", () => {
    expect(decide({ kind: "prune", lower: 0.05, upper: 0.1, gain: 0.07 })).toMatchObject({
      admissible: true,
      reason: "non-inferior (lower bound 0.0500 > -0.0100), and removes a mechanism",
    });
  });

  it("RS22.79 a change with a positive lower bound is a supported gain, and its reason names the gain, its bound, the cost and the budget", () => {
    const d = decide({ lower: 0.25, upper: 0.5, gain: 0.375, costChange: 0.5, costLower: 0.25, costUpper: 0.75 });
    expect(d).toMatchObject({ admissible: true, verdict: "supported", reason: "supported gain: 0.3750, at least 0.2500; cost +50.0% within +1010.0%" });
  });

  it("RS22.80 a gain whose cost bound is above its budget is refused, but one without a cost bound is not", () => {
    // Budget 0.1 + 40 * 0.25 = 10.1; with 20 as the lower bound of the cost change the gain does not pay for it.
    const refused = decide({ lower: 0.25, upper: 0.5, gain: 0.375, costChange: 30, costLower: 20, costUpper: 40 });
    expect(refused).toMatchObject({
      admissible: false,
      reason: "costs +3000.0% tokens (at least +2000.0% at the test's level); a gain of at least 0.2500 pays for +1010.0%",
    });
    expect(decide({ lower: 0.25, upper: 0.5, gain: 0.375, costChange: 30 }).admissible).toBe(true);
  });

  it("RS22.81 a gain's cost lower bound exactly at its budget is within it", () => {
    // Budget 0.25 + 1 * 0.5 = 0.75.
    const rule = { beta0: 0.25, beta1: 1 };
    expect(decide({ lower: 0.5, upper: 1, gain: 0.75, costChange: 0.75, costLower: 0.75, costUpper: 0.75 }, rule).admissible).toBe(true);
    expect(decide({ lower: 0.5, upper: 1, gain: 0.75, costChange: 0.8, costLower: 0.8, costUpper: 0.8 }, rule).admissible).toBe(false);
  });
});

describe("the calibrated rule: reasons of the non-inferiority claims", () => {
  it("RS22.82 a change whose lower bound is at or below the margin is refused for having no supported gain, saying so", () => {
    expect(decide({ lower: -0.0123 })).toEqual({
      admissible: false,
      reason: "no supported gain (lower bound -0.0123 <= 0), and it may be worse than the incumbent by the margin or more: lower bound -0.0123 <= -0.0100",
      verdict: "inconclusive",
    });
  });

  it("RS22.83 a removal whose lower bound is at or below the margin is refused without saying it sought a gain", () => {
    expect(decide({ kind: "prune", lower: -0.0123 })).toEqual({
      admissible: false,
      reason: "it may be worse than the incumbent by the margin or more: lower bound -0.0123 <= -0.0100",
      verdict: "inconclusive",
    });
  });

  it("RS22.84 a removal that costs more than beta0 is refused, naming its cost change and upper bound", () => {
    expect(decide({ kind: "prune", costChange: 0.3, costLower: 0.2, costUpper: 0.5 })).toMatchObject({
      admissible: false,
      reason: "non-inferior (lower bound 0.0000 > -0.0100), but removing it costs +30.0% tokens (up to +50.0% at the test's level), more than +10.0%",
    });
  });

  it("RS22.85 a removal that reports a cost change without bounds is refused as an unknown share", () => {
    expect(decide({ kind: "prune", costChange: 0.3 })).toMatchObject({
      admissible: false,
      reason: "non-inferior (lower bound 0.0000 > -0.0100), but removing it costs +30.0% tokens (up to an unknown share at the test's level), more than +10.0%",
    });
  });

  it("RS22.86 a removal with an upper bound of exactly beta0 is allowed; one with no cost at all is allowed", () => {
    expect(decide({ kind: "prune", costChange: 0.1, costLower: 0, costUpper: 0.1 }).admissible).toBe(true);
    expect(decide({ kind: "prune", costChange: 0.1, costLower: 0, costUpper: 0.1000001 }).admissible).toBe(false);
    expect(decide({ kind: "prune" }).admissible).toBe(true);
  });

  it("RS22.87 a saving that is not certified is refused, with the cost change and an unknown upper bound said so", () => {
    expect(decide({ costChange: 0.125 })).toMatchObject({
      admissible: false,
      reason: "no supported gain (lower bound 0.0000 <= 0) and saves no more than 5.0% tokens with confidence (change +12.5%, at most unknown)",
    });
  });

  it("RS22.88 a saving whose upper bound is above -saving is refused, with the bound shown", () => {
    expect(decide({ costChange: -0.0625, costLower: -0.5, costUpper: -0.025 })).toMatchObject({
      admissible: false,
      reason: "no supported gain (lower bound 0.0000 <= 0) and saves no more than 5.0% tokens with confidence (change -6.3%, at most -2.5%)",
    });
  });

  it("RS22.89 a saving whose upper bound is exactly -saving is certified", () => {
    const d = decide({ costChange: -0.125, costLower: -0.5, costUpper: -0.0625 }, { saving: 0.0625 });
    expect(d).toMatchObject({
      admissible: true,
      reason: "non-inferior (lower bound 0.0000 > -0.0100), and saves 12.5% tokens, at least 6.3% at the test's level",
    });
  });
});

describe("choose: the winner among admissible candidates", () => {
  const ok = { admissible: true, reason: "" };
  const lucky = measuredOf({ label: "lucky", score: 0.9, lower: 0.125, upper: 0.5, gain: 0.4 });
  const evidenced = measuredOf({ label: "evidenced", score: 0.6, lower: 0.25, upper: 0.375, gain: 0.1 });
  const decided = [lucky, evidenced].map((candidate) => ({ candidate, decision: ok }));

  it("RS22.90 by score, the highest point score wins even with the lower bound behind", () => {
    expect(choose(decided, "score")?.label).toBe("lucky");
  });

  it("RS22.91 by lower, the highest lower bound wins even with the score behind", () => {
    expect(choose(decided, "lower")?.label).toBe("evidenced");
  });

  it("RS22.92 an inadmissible candidate never wins", () => {
    const refused = [{ candidate: lucky, decision: { admissible: false, reason: "no" } }, { candidate: evidenced, decision: ok }];
    expect(choose(refused, "score")?.label).toBe("evidenced");
  });
});

describe("the rule schemas", () => {
  const paper = { rule: "paper", beta0: 0.25, beta1: 1, ws: 1, wc: 0, wn: 0, prune: 4 };
  const calibrated = { rule: "calibrated", alpha: 0.1, resamples: 1000, margin: 0.01, saving: 0.05, beta0: 0.1, beta1: 40 };

  it("RS26.3 a paper rule parses, with z defaulting to 2, and an unknown key is refused", () => {
    expect(PaperRuleSchema.parse(paper)).toMatchObject({ rule: "paper", z: 2, prune: 4 });
    expect(PaperRuleSchema.safeParse({ ...paper, extra: 1 }).success).toBe(false);
  });

  it("RS26.4 a calibrated rule parses, with a uniform spending default, and an unknown key is refused", () => {
    expect(CalibratedRuleSchema.parse(calibrated)).toMatchObject({ rule: "calibrated", alpha: 0.1, spending: { kind: "uniform" } });
    expect(CalibratedRuleSchema.safeParse({ ...calibrated, extra: 1 }).success).toBe(false);
  });

  it("RS26.5 the union picks the schema by its rule field", () => {
    expect(RuleSchema.parse(paper).rule).toBe("paper");
    expect(RuleSchema.parse(calibrated).rule).toBe("calibrated");
    expect(RuleSchema.safeParse({ ...calibrated, rule: "other" }).success).toBe(false);
  });
});
