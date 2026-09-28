import { describe, expect, it } from "vitest";
import { Evolution, parseSettings, roundLevel, SpendingSchema, testLevel } from "@harness/evolution";
import type { EvolutionPorts } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { campaign, scripted, settings, toggle, world } from "./world.ts";

const CALIBRATED = { rule: "calibrated", alpha: 0.1, resamples: 400, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 };

describe("alpha-spending across the rounds of a run", () => {
  it("RS14.1 uniform spending is the equal share alpha / (T (m + 1)), exactly what testLevel gives, in every round", () => {
    for (const [alpha, rounds, perRound] of [
      [0.1, 20, 3],
      [0.05, 1, 1],
      [0.3, 7, 4],
    ] as const) {
      for (let t = 0; t < rounds; t++) {
        expect(roundLevel(alpha, t, rounds, perRound, { kind: "uniform" })).toBe(testLevel(alpha, rounds, perRound));
        expect(roundLevel(alpha, t, rounds, perRound)).toBe(alpha / (rounds * perRound));
      }
    }
  });

  it("RS14.2 geometric spending gives round t the share ratio^t / sum_s ratio^s of alpha, split equally among the round's tests", () => {
    // ratio 1/2 over 3 rounds: weights 1, 1/2, 1/4 (sum 7/4); two tests a round.
    const level = (t: number) => roundLevel(0.14, t, 3, 2, { kind: "geometric", ratio: 0.5 });
    expect(level(0)).toBeCloseTo((0.14 * (4 / 7)) / 2, 15); // 0.04
    expect(level(1)).toBeCloseTo((0.14 * (2 / 7)) / 2, 15); // 0.02
    expect(level(2)).toBeCloseTo((0.14 * (1 / 7)) / 2, 15); // 0.01
    expect(level(0)).toBeCloseTo(0.04, 15);
    expect(level(1)).toBeCloseTo(0.02, 15);
    expect(level(2)).toBeCloseTo(0.01, 15);
    // One round: the whole alpha, whatever the ratio.
    expect(roundLevel(0.1, 0, 1, 1, { kind: "geometric", ratio: 0.3 })).toBeCloseTo(0.1, 15);
    // The ratio matters: a slower decay leaves more for late rounds.
    expect(roundLevel(0.14, 2, 3, 2, { kind: "geometric", ratio: 0.9 })).toBeGreaterThan(level(2));
  });

  it("RS14.3 a round's tests together spend the round's share, and the shares of all rounds add up to alpha", () => {
    const spending = { kind: "geometric", ratio: 0.8 } as const;
    let total = 0;
    for (let t = 0; t < 10; t++) total += 3 * roundLevel(0.1, t, 10, 3, spending);
    expect(total).toBeCloseTo(0.1, 15);
    const weights = Array.from({ length: 10 }, (_, t) => 0.8 ** t);
    const sum = weights.reduce((s, w) => s + w, 0);
    expect(3 * roundLevel(0.1, 4, 10, 3, spending)).toBeCloseTo((0.1 * weights[4]!) / sum, 15);
  });

  it("RS14.4 a round outside the run, or a run of no rounds or tests, is refused", () => {
    const geo = { kind: "geometric", ratio: 0.5 } as const;
    for (const spending of [{ kind: "uniform" } as const, geo]) {
      expect(() => roundLevel(0.1, -1, 5, 3, spending)).toThrow(/round -1 is outside a run of 5 rounds/);
      expect(() => roundLevel(0.1, 5, 5, 3, spending)).toThrow(/round 5 is outside a run of 5 rounds/);
      expect(() => roundLevel(0.1, 1.5, 5, 3, spending)).toThrow(RangeError);
      expect(() => roundLevel(0.1, 0, 0, 3, spending)).toThrow(/a run needs rounds, not 0/);
      expect(() => roundLevel(0.1, 0, 5, 0, spending)).toThrow(/a round makes tests, not 0/);
      expect(roundLevel(0.1, 4, 5, 3, spending)).toBeGreaterThan(0);
      expect(roundLevel(0.1, 0, 5, 1, spending)).toBeGreaterThan(0);
    }
  });

  it("RS14.5 the setting is either uniform or geometric with a ratio strictly between 0 and 1", () => {
    expect(SpendingSchema.parse({ kind: "uniform" })).toEqual({ kind: "uniform" });
    expect(SpendingSchema.parse({ kind: "geometric", ratio: 0.9 })).toEqual({ kind: "geometric", ratio: 0.9 });
    for (const bad of [{ kind: "geometric", ratio: 0 }, { kind: "geometric", ratio: 1 }, { kind: "geometric", ratio: 1.2 }, { kind: "geometric" }, { kind: "uniform", ratio: 0.5 }, { kind: "harmonic" }, {}]) expect(SpendingSchema.safeParse(bad).success).toBe(false);
  });

  it("RS14.6 the calibrated rule defaults to uniform spending; the paper's rule has no spending", () => {
    const s = parseSettings(settings({ select: CALIBRATED }));
    expect(s.select).toMatchObject({ rule: "calibrated", spending: { kind: "uniform" } });
    const g = parseSettings(settings({ select: { ...CALIBRATED, spending: { kind: "geometric", ratio: 0.9 } } }));
    expect(g.select).toMatchObject({ spending: { kind: "geometric", ratio: 0.9 } });
    const paper = { rule: "paper", delta: 0.01, beta0: 0.1, beta1: 35, ws: 1, wc: 1, wn: 0, prune: 4 };
    expect(() => settings({ select: { ...paper, spending: { kind: "uniform" } } })).toThrow(/select/);
  });

  it("RS14.7 a bound needs enough resamples: settings whose latest round's level cannot be certified are refused, naming where", () => {
    // alpha 0.1 over 6 rounds of 3 tests, ratio 0.6: the last round's level is 0.1 * 0.6^5 / (sum of 0.6^s) / 3 = 0.001087, and 1 / level = 919.5, so 920 resamples.
    const spend = { kind: "geometric", ratio: 0.6 };
    expect(() => settings({ select: { ...CALIBRATED, resamples: 919, spending: spend } })).toThrow(/select\.resamples.*920/s);
    expect(() => settings({ select: { ...CALIBRATED, resamples: 920, spending: spend } })).not.toThrow();
    // Uniform: 0.1 / 18 needs 180.
    expect(() => settings({ select: { ...CALIBRATED, resamples: 179 } })).toThrow(/select\.resamples/);
    expect(() => settings({ select: { ...CALIBRATED, resamples: 180 } })).not.toThrow();
  });

  it("RS14.8 the report's level and every record's alpha are the round's level under the spending schedule", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    const select = { ...CALIBRATED, resamples: 2000, spending: { kind: "geometric", ratio: 0.5 } };
    const s = settings({ rounds: 3, select });
    const e = await Evolution.start({ surface: w.surface, settings: s, split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } });
    const { propose } = scripted((r) => toggle(`noop${r.round}${r.candidate}`));
    const ports: EvolutionPorts = { evaluate: w.evaluate, propose, entropy: new SeededEntropy(2) };
    const levels: number[] = [];
    while (!e.done) {
      const report = await e.round(ports);
      levels.push(report.level!);
      expect(report.level).toBe(roundLevel(0.1, report.round, 3, 3, { kind: "geometric", ratio: 0.5 }));
      for (const r of report.records.filter((x) => x.measured)) expect(r.measured!.alpha).toBe(report.level);
      expect(report.records.filter((x) => x.measured).length).toBeGreaterThan(0);
    }
    expect(levels[0]).toBeCloseTo((0.1 * (4 / 7)) / 3, 15);
    expect(levels[0]! / levels[1]!).toBeCloseTo(2, 12);
    expect(levels[1]! / levels[2]!).toBeCloseTo(2, 12);
    expect(levels.reduce((a, b) => a + b, 0) * 3).toBeCloseTo(0.1, 15);
  });
});

describe("alpha-spending reaches the acceptance tests", () => {
  it("RS14.9 the interval of a candidate is taken at its round's level: looser than uniform in an early round, tighter in a late one, on the same data", async () => {
    const lowerAt = async (at: number, spending: object) => {
      const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 12 ? 1 : 0) } });
      const s = settings({ rounds: 2, select: { ...CALIBRATED, resamples: 2000, spending } });
      const e = await Evolution.start({ surface: w.surface, settings: s, split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } });
      const { propose } = scripted((r) => (r.candidate === "A" && r.round === at ? toggle("verify") : toggle(`noop${r.round}${r.candidate}`)));
      let a;
      for (let t = 0; t <= at; t++) a = (await e.round({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(2 + t) })).records.find((r) => r.candidate === "A")!.measured!;
      return a!;
    };
    const geometric = { kind: "geometric", ratio: 0.5 };
    const early = { uniform: await lowerAt(0, { kind: "uniform" }), geometric: await lowerAt(0, geometric) };
    const late = { uniform: await lowerAt(1, { kind: "uniform" }), geometric: await lowerAt(1, geometric) };
    for (const m of [early.uniform, early.geometric, late.uniform, late.geometric]) expect(m.gain).toBeCloseTo(0.3, 12);
    expect(early.uniform.alpha).toBeCloseTo(0.1 / 6, 12);
    expect(early.geometric.alpha).toBeCloseTo((0.1 * (2 / 3)) / 3, 12);
    expect(early.geometric.lower).toBeGreaterThan(early.uniform.lower);
    expect(late.geometric.alpha).toBeCloseTo((0.1 * (1 / 3)) / 3, 12);
    expect(late.geometric.lower).toBeLessThan(late.uniform.lower);
    expect(early.geometric.upper).toBeLessThan(early.uniform.upper);
    expect(late.geometric.upper).toBeGreaterThan(late.uniform.upper);
  });
});

/**
 * Spending trades power between rounds, and keeps the run-wide error rate. Measured
 * (n = 240 tasks, a true gain of +0.05, 20 rounds, alpha 0.1; the gain is proposed in one
 * round and accepted or not there): in round 0, 229 of 600 runs accepted it under uniform
 * spending and 291 under geometric spending with ratio 0.9 (level 0.0038 against 0.0017);
 * in round 15 (150 runs, 4000 resamples) 57 accepted it under uniform and 45 under
 * geometric (level 0.0005 against 0.0017). Ratio 0.8 would need 10289 resamples for the
 * last round's level, and settings refuse it below that.
 */
describe("alpha-spending: Monte Carlo over whole runs", () => {
  it("RS14.70 under the null, runs that spend alpha geometrically accept a change in at most alpha of 40 runs of 10 rounds", async () => {
    let accepting = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = await campaign({ n: 60, seed, rounds: 10, select: { ...CALIBRATED, margin: 0.01, resamples: 600, spending: { kind: "geometric", ratio: 0.9 } }, propose: (q) => toggle(`null${q.round}${q.candidate}`) });
      if (r.accepted > 0) accepting++;
    }
    expect(accepting).toBeLessThanOrEqual(4); // alpha = 0.1 of 40 runs; observed 0
  }, 60_000);

  it("RS14.71 a gain proposed in the first round is found more often when early rounds are given more of alpha", async () => {
    const study = async (spending: object) => {
      let found = 0;
      for (let seed = 1; seed <= 100; seed++) {
        const r = await campaign({ n: 240, seed, rounds: 20, select: { ...CALIBRATED, resamples: 2000, spending }, through: 0, effects: { real: (i) => (i % 5 < 2 ? 0.125 : 0) }, propose: (q) => (q.candidate === "A" ? toggle("real") : toggle(`null${q.round}`)) });
        if (r.last === "A") found++;
      }
      return found;
    };
    const uniform = await study({ kind: "uniform" });
    const geometric = await study({ kind: "geometric", ratio: 0.9 });
    expect(uniform).toBeGreaterThanOrEqual(35); // observed 43
    expect(geometric).toBeGreaterThanOrEqual(uniform + 5); // observed 51
  }, 120_000);
});
