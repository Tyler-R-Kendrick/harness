import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { SeededEntropy } from "@harness/testkit";
import {
  applyCalibrator,
  brier,
  CalibrationIndex,
  calibrationJsonSchema,
  ece,
  fitBook,
  fitEntry,
  fitPlatt,
  fitTemperature,
  parseCalibration,
  plattObjective,
  reliability,
} from "../src/calibration.ts";
import type { CalibrationSample } from "../src/calibration.ts";
import { answerOfDistribution, booleanDistribution, distributionFromWeights, softmaxWithTemperature, temperatureTransform } from "../src/distribution.ts";
import { uniform } from "../src/explore.ts";
import { forkId, temperature } from "../src/types.ts";
import type { Answer, Answers, CalibrationEntry, DecisionRecord, Distribution } from "../src/types.ts";

const FORK = forkId("permission.risk");
const dist = (weights: Record<string, number>) => distributionFromWeights(weights);
const choice = (weights: Record<string, number>): Answer => answerOfDistribution("choice", dist(weights));
const s = (weights: Record<string, number>, label: string): CalibrationSample => ({ distribution: dist(weights), label });
const many = <T = CalibrationSample>(count: number, make: (i: number) => T): T[] => Array.from({ length: count }, (_, i) => make(i));
const label = (d: Distribution, u: number): string => {
  let cumulative = 0;
  for (const [option, p] of Object.entries(d)) {
    cumulative += p;
    if (u < cumulative) return option;
  }
  return Object.keys(d).at(-1)!;
};

/** A world where a member reports q^(1/t0) for the true distribution q, and the labels come from q. */
function overconfident(n: number, seed: number, t0: number): CalibrationSample[] {
  const rng = uniform(new SeededEntropy(seed));
  return many(n, () => {
    const q = softmaxWithTemperature({ a: (rng() - 0.5) * 6, b: (rng() - 0.5) * 6, c: (rng() - 0.5) * 6 });
    return { distribution: temperatureTransform(q, t0), label: label(q, rng()) };
  });
}
/** Boolean member whose probabilities are off by a logit shift. */
function shifted(n: number, seed: number, shift: number): CalibrationSample[] {
  const rng = uniform(new SeededEntropy(seed));
  return many(n, () => {
    const p = 0.05 + 0.9 * rng();
    const truth = 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) + shift)));
    return { distribution: booleanDistribution(p), label: rng() < truth ? "true" : "false" };
  });
}
const perfect = many(50, (i) => s({ a: 0.8, b: 0.2 }, Math.floor(i / 5) % 5 === 4 ? "b" : "a"));

const entryOf = (over: Partial<CalibrationEntry> = {}): CalibrationEntry => ({
  fork: FORK,
  member: "m",
  version: "1",
  question: "risk",
  calibrator: { kind: "temperature", temperature: temperature(2) },
  fitted: { n: 40, at: 5, eceBefore: 0.2, eceAfter: 0.1, brierBefore: 0.3, brierAfter: 0.2 },
  ...over,
});

describe("applyCalibrator", () => {
  it("CAL1.1 an identity calibrator returns the answer itself", () => {
    const a = choice({ x: 3, y: 1 });
    expect(applyCalibrator({ kind: "identity" }, a)).toBe(a);
  });

  it("CAL1.2 a temperature calibrator rescales any question type, and recomputes the top option and a score's expected level", () => {
    const c = choice({ x: 3, y: 1 });
    const out = applyCalibrator({ kind: "temperature", temperature: temperature(2) }, c);
    expect(out.distribution).toEqual(temperatureTransform(c.distribution, 2));
    expect(out.top).toBe("x");
    expect(out.type).toBe("choice");
    expect(out).not.toHaveProperty("score");
    const score = answerOfDistribution("score", dist({ "0": 0.1, "1": 0.2, "2": 0.7 }));
    expect(score.score).toBeCloseTo(1.6, 12);
    const soft = applyCalibrator({ kind: "temperature", temperature: temperature(1000) }, score);
    expect(soft.score).toBeCloseTo(1, 2);
    expect(soft.score).not.toBeCloseTo(1.6, 2);
    expect(soft.top).toBe("2");
    const bool = applyCalibrator({ kind: "temperature", temperature: temperature(0.5) }, answerOfDistribution("boolean", booleanDistribution(0.75)));
    expect(bool.type).toBe("boolean");
    expect(bool.distribution["true"]).toBeCloseTo(0.9, 12);
  });

  it("CAL1.3 a Platt calibrator moves a boolean's logit: slope sharpens, intercept shifts, a negative slope flips", () => {
    const yes = (p: number) => answerOfDistribution("boolean", booleanDistribution(p));
    expect(applyCalibrator({ kind: "platt", a: 1, b: 0 }, yes(0.75)).distribution["true"]).toBeCloseTo(0.75, 12);
    expect(applyCalibrator({ kind: "platt", a: 2, b: 0 }, yes(0.75)).distribution["true"]).toBeCloseTo(0.9, 12);
    expect(applyCalibrator({ kind: "platt", a: 1, b: Math.log(3) }, yes(0.5)).distribution["true"]).toBeCloseTo(0.75, 12);
    const flipped = applyCalibrator({ kind: "platt", a: -1, b: 0 }, yes(0.6));
    expect(flipped.distribution["true"]).toBeCloseTo(0.4, 12);
    expect(flipped.distribution["false"]).toBeCloseTo(0.6, 12);
    expect(flipped.top).toBe("false");
    expect(flipped.type).toBe("boolean");
  });

  it("CAL1.4 a Platt calibrator keeps the order of the answer's options", () => {
    const reversed = answerOfDistribution("boolean", dist({ false: 0.3, true: 0.7 }));
    const out = applyCalibrator({ kind: "platt", a: 1, b: 0 }, reversed);
    expect(Object.keys(out.distribution)).toEqual(["false", "true"]);
    expect(out.distribution["true"]).toBeCloseTo(0.7, 12);
  });

  it("CAL1.5 a Platt calibrator on anything but a boolean answer is refused", () => {
    expect(() => applyCalibrator({ kind: "platt", a: 1, b: 0 }, choice({ x: 1, y: 1 }))).toThrow(RangeError);
    expect(() => applyCalibrator({ kind: "platt", a: 1, b: 0 }, choice({ x: 1, y: 1 }))).toThrow(/platt.*boolean answers only, not choice/);
    expect(() => applyCalibrator({ kind: "platt", a: 1, b: 0 }, answerOfDistribution("boolean", dist({ yes: 1, no: 1 })))).toThrow(/options "true" and "false", got yes, no/);
    expect(() => applyCalibrator({ kind: "platt", a: 1, b: 0 }, answerOfDistribution("boolean", dist({ true: 1, false: 1, maybe: 1 })))).toThrow(/options "true" and "false"/);
  });
});

describe("fitting", () => {
  it("CAL1.6 fitTemperature finds the temperature that minimizes the negative log likelihood", () => {
    const samples = many(10, (i) => s({ a: 0.9, b: 0.1 }, i < 8 ? "a" : "b"));
    const fit = fitTemperature(samples);
    // p(a) after scaling should be 0.8: (0.9/0.1)^(1/T) = 4
    expect(fit.temperature).toBeCloseTo(Math.log(9) / Math.log(4), 4);
    expect(fit.nll).toBeCloseTo(-(0.8 * Math.log(0.8) + 0.2 * Math.log(0.2)), 6);
  });

  it("CAL1.7 fitTemperature stays within 0.05 and 20", () => {
    const sharp = fitTemperature(many(10, () => s({ a: 0.9, b: 0.1 }, "a")));
    expect(sharp.temperature).toBeGreaterThanOrEqual(0.05);
    expect(sharp.temperature).toBeLessThan(0.1);
    // the likelihood is flat below the temperature where it reaches zero: the softer end of the plateau is taken
    expect(sharp.temperature).toBeGreaterThan(0.055);
    expect(sharp.nll).toBeLessThan(1e-9);
    expect(fitTemperature(many(10, () => s({ a: 0.9, b: 0.1 }, "b"))).temperature).toBeCloseTo(20, 3);
  });

  it("CAL1.8 fitting needs samples whose labels are among their options", () => {
    expect(() => fitTemperature([])).toThrow(/at least one sample/);
    expect(() => fitTemperature([s({ a: 1, b: 1 }, "z")])).toThrow(/sample 0: the label "z" is not among the options \(a, b\)/);
    expect(() => fitPlatt([])).toThrow(/at least one sample/);
    expect(() => ece([], 10)).toThrow(/at least one sample/);
    expect(() => brier([])).toThrow(/at least one sample/);
  });

  it("CAL1.9 fitPlatt puts a boolean member's probabilities on the frequencies it saw, staying near the identity when it can", () => {
    const samples = many(100, (i) => ({ distribution: booleanDistribution(0.9), label: i < 80 ? "true" : "false" }));
    const fit = fitPlatt(samples);
    const p = 1 / (1 + Math.exp(-(fit.a * Math.log(9) + fit.b)));
    expect(p).toBeCloseTo(0.8, 2);
    expect(fit.nll).toBeCloseTo(-(0.8 * Math.log(0.8) + 0.2 * Math.log(0.2)), 3);
    const already = many(100, (i) => ({ distribution: booleanDistribution(0.75), label: i < 75 ? "true" : "false" }));
    const same = fitPlatt(already);
    expect(same.a).toBeCloseTo(1, 1);
    expect(same.b).toBeCloseTo(0, 1);
    expect(same.iterations).toBe(1);
  });

  it("CAL1.10 fitPlatt stays finite on perfectly separable data", () => {
    const samples = many(100, (i) => ({ distribution: booleanDistribution(i % 2 === 0 ? 0.9 : 0.1), label: i % 2 === 0 ? "true" : "false" }));
    const fit = fitPlatt(samples);
    expect(Number.isFinite(fit.a)).toBe(true);
    expect(Number.isFinite(fit.b)).toBe(true);
    expect(fit.a).toBeGreaterThan(1);
    expect(Math.abs(fit.a)).toBeLessThan(50);
    expect(fit.nll).toBeLessThan(0.1);
  });

  it("CAL1.11 fitPlatt recovers a slope and an intercept from data that has both", () => {
    const rng = uniform(new SeededEntropy(21));
    const samples = many(3000, () => {
      const p = 0.02 + 0.96 * rng();
      const truth = 1 / (1 + Math.exp(-(0.5 * Math.log(p / (1 - p)) - 0.7)));
      return { distribution: booleanDistribution(p), label: rng() < truth ? "true" : "false" };
    });
    const fit = fitPlatt(samples);
    expect(fit.a).toBeGreaterThan(0.4);
    expect(fit.a).toBeLessThan(0.6);
    expect(fit.b).toBeGreaterThan(-0.9);
    expect(fit.b).toBeLessThan(-0.5);
  });

  it("CAL1.45 the Platt objective is the summed negative log likelihood plus a ridge toward the identity", () => {
    const one = [{ distribution: booleanDistribution(0.75), label: "true" }];
    expect(plattObjective(one, 1, 0)).toBeCloseTo(Math.log(4 / 3), 12);
    const z = 2 * Math.log(3) + 1;
    expect(plattObjective(one, 2, 1)).toBeCloseTo(Math.log(1 + Math.exp(z)) - z + 0.005 * 2, 12);
    const wrong = [{ distribution: booleanDistribution(0.75), label: "false" }];
    expect(plattObjective(wrong, 1, 0)).toBeCloseTo(Math.log(4), 12);
    expect(plattObjective([...one, ...wrong], 3, -2)).toBeCloseTo(plattObjective(one, 3, -2) + plattObjective(wrong, 3, -2) - 0.005 * (4 + 4), 12);
    expect(() => plattObjective([s({ a: 1, b: 1 }, "a")], 1, 0)).toThrow(/options "true" and "false"/);
  });

  it("CAL1.46 the fitted Platt parameters are the minimum of the objective: its slope is zero there and it rises in every direction", () => {
    const rng = uniform(new SeededEntropy(51));
    const datasets: Record<string, CalibrationSample[]> = {
      mixed: shifted(200, 52, -1),
      separable: many(100, (i) => ({ distribution: booleanDistribution(i % 2 === 0 ? 0.9 : 0.1), label: i % 2 === 0 ? "true" : "false" })),
      "confidently wrong": [
        ...many(10, () => ({ distribution: booleanDistribution(1e-12), label: "true" })),
        ...many(10, () => ({ distribution: booleanDistribution(1 - 1e-12), label: "false" })),
        ...many(20, (i) => ({ distribution: booleanDistribution(0.5), label: i % 2 === 0 ? "true" : "false" })),
      ],
      "one label": many(50, () => ({ distribution: booleanDistribution(0.9), label: "true" })),
      "spread": many(300, () => {
        const p = 0.01 + 0.98 * rng();
        return { distribution: booleanDistribution(p), label: rng() < p * p ? "true" : "false" };
      }),
    };
    // Newton converges quadratically: a handful of steps, however hard the data (a wrong direction takes twice as many)
    const steps: Record<string, number> = { mixed: 9, separable: 14, "confidently wrong": 16, "one label": 13, spread: 10 };
    for (const [name, samples] of Object.entries(datasets)) {
      const { a, b, iterations } = fitPlatt(samples);
      expect(iterations, `${name} steps`).toBeLessThanOrEqual(steps[name]!);
      const f = (da: number, db: number) => plattObjective(samples, a + da, b + db);
      const h = 1e-5;
      expect(Number.isFinite(a) && Number.isFinite(b), name).toBe(true);
      expect(Math.abs((f(h, 0) - f(-h, 0)) / (2 * h)), `${name} da`).toBeLessThan(1e-5);
      expect(Math.abs((f(0, h) - f(0, -h)) / (2 * h)), `${name} db`).toBeLessThan(1e-5);
      for (const [da, db] of [[0.01, 0], [-0.01, 0], [0, 0.01], [0, -0.01], [0.01, 0.01], [-0.01, -0.01], [0.01, -0.01], [-0.01, 0.01]] as const) {
        expect(f(da, db), `${name} ${da},${db}`).toBeGreaterThanOrEqual(f(0, 0));
      }
    }
  });

  it("CAL1.12 fitPlatt refuses samples that are not booleans", () => {
    expect(() => fitPlatt([s({ a: 1, b: 1 }, "a")])).toThrow(/sample 0: .*options "true" and "false", got a, b/);
    expect(() => fitPlatt([{ distribution: booleanDistribution(0.5), label: "maybe" }])).toThrow(/sample 0: the label "maybe" is not among the options/);
  });
});

describe("measures", () => {
  it("CAL1.13 ece is the weighted gap between confidence and accuracy over equal-width bins", () => {
    expect(ece(many(5, (i) => s({ a: 0.9, b: 0.1 }, i < 3 ? "a" : "b")))).toBeCloseTo(0.3, 12);
    const mixed = [s({ a: 0.6, b: 0.4 }, "a"), s({ a: 0.8, b: 0.2 }, "b"), s({ a: 0.6, b: 0.4 }, "b")];
    expect(ece(mixed)).toBeCloseTo(1 / 3, 12);
    expect(ece(mixed, 4)).toBeCloseTo(1 / 3, 12);
    expect(ece(mixed, 1)).toBeCloseTo(Math.abs(1 / 3 - (0.6 + 0.8 + 0.6) / 3), 12);
    expect(ece(perfect)).toBeCloseTo(0, 12);
  });

  it("CAL1.14 a confidence on a bin's lower edge belongs to that bin, and a confidence of one to the last", () => {
    const edge = reliability([s({ a: 0.5, b: 0.5 }, "a")], 10);
    expect(edge.map((r) => r.n)).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const top = reliability([s({ a: 1, b: 0 }, "a")], 10);
    expect(top.map((r) => r.n)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ece([s({ a: 1, b: 0 }, "b")])).toBe(1);
  });

  it("CAL1.15 ece uses the top label's confidence and whether the top label was right, for any number of options", () => {
    const samples = [s({ a: 0.5, b: 0.3, c: 0.2 }, "b"), s({ a: 0.5, b: 0.3, c: 0.2 }, "a")];
    expect(ece(samples)).toBeCloseTo(0, 12);
    expect(ece([s({ a: 0.5, b: 0.3, c: 0.2 }, "c")])).toBeCloseTo(0.5, 12);
  });

  it("CAL1.44 the top label is the first of equals, and can be any option", () => {
    const tie = reliability([s({ a: 0.5, b: 0.5 }, "a"), s({ a: 0.5, b: 0.5 }, "b")], 10)[5]!;
    expect(tie).toEqual({ lo: 0.5, hi: 0.6, n: 2, confidence: 0.5, accuracy: 0.5 });
    expect(reliability([s({ a: 0.5, b: 0.5 }, "a")], 10)[5]!.accuracy).toBe(1);
    expect(reliability([s({ a: 0.5, b: 0.5 }, "b")], 10)[5]!.accuracy).toBe(0);
    expect(reliability([s({ a: 0.2, b: 0.5, c: 0.3 }, "b")], 10)[5]!.accuracy).toBe(1);
    expect(reliability([s({ a: 0.2, b: 0.3, c: 0.5 }, "c")], 10)[5]!.accuracy).toBe(1);
    expect(reliability([s({ a: 0.2, b: 0.3, c: 0.5 }, "a")], 10)[5]!.accuracy).toBe(0);
  });

  it("CAL1.16 the bins of ece are a positive whole number", () => {
    for (const bins of [0, -1, 2.5, Number.NaN]) expect(() => ece(perfect, bins)).toThrow(/bins/);
    for (const bins of [0, 1.5]) expect(() => reliability(perfect, bins)).toThrow(/bins/);
  });

  it("CAL1.17 brier is the mean over samples of the summed squared errors across options", () => {
    expect(brier(many(5, (i) => s({ a: 0.9, b: 0.1 }, i < 3 ? "a" : "b")))).toBeCloseTo((3 * 0.02 + 2 * 1.62) / 5, 12);
    expect(brier([s({ a: 1, b: 0 }, "a")])).toBe(0);
    expect(brier([s({ a: 1, b: 0 }, "b")])).toBe(2);
    expect(brier([s({ a: 0.5, b: 0.3, c: 0.2 }, "c")])).toBeCloseTo(0.25 + 0.09 + 0.64, 12);
  });

  it("CAL1.18 reliability lists every bin with its edges, size, mean confidence and accuracy", () => {
    const rows = reliability([s({ a: 0.6, b: 0.4 }, "a"), s({ a: 0.8, b: 0.2 }, "b"), s({ a: 0.6, b: 0.4 }, "b")], 4);
    expect(rows).toEqual([
      { lo: 0, hi: 0.25, n: 0, confidence: 0, accuracy: 0 },
      { lo: 0.25, hi: 0.5, n: 0, confidence: 0, accuracy: 0 },
      { lo: 0.5, hi: 0.75, n: 2, confidence: 0.6, accuracy: 0.5 },
      { lo: 0.75, hi: 1, n: 1, confidence: 0.8, accuracy: 0 },
    ]);
    expect(reliability(perfect).length).toBe(10);
  });
});

describe("fitEntry", () => {
  const base = { fork: FORK, member: "m", version: "1", question: "risk", type: "choice", at: 9 } as const;

  it("CAL1.19 there is no entry below the minimum number of samples (30 unless said)", () => {
    expect(fitEntry({ ...base, samples: overconfident(29, 1, 0.5) })).toBeUndefined();
    expect(fitEntry({ ...base, samples: overconfident(30, 1, 0.5) })).toBeDefined();
    expect(fitEntry({ ...base, samples: overconfident(10, 1, 0.5), minSamples: 11 })).toBeUndefined();
    expect(fitEntry({ ...base, samples: overconfident(10, 1, 0.5), minSamples: 10 })).toBeDefined();
    expect(fitEntry({ ...base, samples: [], minSamples: 0 })).toBeUndefined();
  });

  it("CAL1.20 an overconfident member gets a temperature above one, and the entry says how much better calibrated it is", () => {
    const entry = fitEntry({ ...base, samples: overconfident(600, 5, 0.5) })!;
    expect(entry.calibrator.kind).toBe("temperature");
    if (entry.calibrator.kind !== "temperature") return;
    expect(entry.calibrator.temperature).toBeGreaterThan(1.6);
    expect(entry.calibrator.temperature).toBeLessThan(2.5);
    expect(entry).toMatchObject({ fork: FORK, member: "m", version: "1", question: "risk" });
    expect(entry.fitted.n).toBe(600);
    expect(entry.fitted.at).toBe(9);
    expect(entry.fitted.eceAfter).toBeLessThan(entry.fitted.eceBefore);
    expect(entry.fitted.brierAfter).toBeLessThan(entry.fitted.brierBefore);
    const samples = overconfident(600, 5, 0.5);
    expect(entry.fitted.eceBefore).toBeCloseTo(ece(samples), 12);
    expect(entry.fitted.brierBefore).toBeCloseTo(brier(samples), 12);
    const after = samples.map((x) => ({ ...x, distribution: applyCalibrator(entry.calibrator, answerOfDistribution("choice", x.distribution)).distribution }));
    expect(entry.fitted.eceAfter).toBeCloseTo(ece(after), 12);
    expect(entry.fitted.brierAfter).toBeCloseTo(brier(after), 12);
  });

  it("CAL1.21 an underconfident member gets a temperature below one", () => {
    const entry = fitEntry({ ...base, samples: overconfident(600, 6, 2) })!;
    expect(entry.calibrator.kind).toBe("temperature");
    if (entry.calibrator.kind === "temperature") expect(entry.calibrator.temperature).toBeLessThan(0.8);
  });

  it("CAL1.22 a member that is already calibrated keeps the identity, unchanged", () => {
    const entry = fitEntry({ ...base, samples: perfect })!;
    expect(entry.calibrator).toEqual({ kind: "identity" });
    expect(entry.fitted.eceAfter).toBe(entry.fitted.eceBefore);
    expect(entry.fitted.brierAfter).toBe(entry.fitted.brierBefore);
    expect(entry.fitted.n).toBe(50);
  });

  it("CAL1.23 a boolean member whose probabilities are shifted gets Platt scaling, which a temperature cannot do", () => {
    const entry = fitEntry({ ...base, type: "boolean", samples: shifted(600, 8, 1.5) })!;
    expect(entry.calibrator.kind).toBe("platt");
    if (entry.calibrator.kind !== "platt") return;
    expect(entry.calibrator.b).toBeGreaterThan(1);
    expect(entry.calibrator.b).toBeLessThan(2);
    expect(entry.fitted.eceAfter).toBeLessThan(entry.fitted.eceBefore / 2);
  });

  it("CAL1.24 a boolean member that is only overconfident is calibrated too, and never by Platt when the type is not boolean", () => {
    const samples = many(600, () => ({ distribution: booleanDistribution(0.5), label: "true" as const }));
    const rng = uniform(new SeededEntropy(31));
    const over = samples.map(() => {
      const q = 0.1 + 0.8 * rng();
      const p = temperatureTransform(booleanDistribution(q), 0.4);
      return { distribution: p, label: rng() < q ? "true" : "false" };
    });
    const entry = fitEntry({ ...base, type: "boolean", samples: over })!;
    expect(entry.calibrator.kind).not.toBe("identity");
    expect(entry.fitted.eceAfter).toBeLessThan(entry.fitted.eceBefore);
    const asChoice = fitEntry({ ...base, type: "choice", samples: shifted(600, 8, 1.5) })!;
    expect(asChoice.calibrator.kind).not.toBe("platt");
  });

  it("CAL1.48 of two candidates that both improve calibration the one with the lower cross-validated Brier is kept: a temperature beats Platt's second parameter on a small sample of pure overconfidence", () => {
    const rng = uniform(new SeededEntropy(1));
    const samples = many(40, () => {
      const q = 0.1 + 0.8 * rng();
      return { distribution: temperatureTransform(booleanDistribution(q), 0.4), label: rng() < q ? "true" : "false" };
    });
    const entry = fitEntry({ ...base, type: "boolean", samples })!;
    expect(entry.calibrator.kind).toBe("temperature");
    expect(entry.fitted.eceAfter).toBeLessThan(entry.fitted.eceBefore);
  });

  it("CAL1.25 with a single sample there is nothing to cross-validate on, so the identity stands", () => {
    const entry = fitEntry({ ...base, samples: [s({ a: 0.9, b: 0.1 }, "b")], minSamples: 1 })!;
    expect(entry.calibrator).toEqual({ kind: "identity" });
    expect(entry.fitted.n).toBe(1);
  });

  it("CAL1.26 an entry that cannot be right is refused", () => {
    expect(() => fitEntry({ ...base, member: "", samples: overconfident(30, 1, 0.5) })).toThrow(RangeError);
    expect(() => fitEntry({ ...base, member: "", samples: overconfident(30, 1, 0.5) })).toThrow(/not a calibration entry/);
  });

  it("CAL1.27 samples are folded by index, so the same samples always give the same entry", () => {
    const a = fitEntry({ ...base, samples: overconfident(100, 12, 0.6) });
    const b = fitEntry({ ...base, samples: overconfident(100, 12, 0.6) });
    expect(a).toEqual(b);
  });
});

describe("CalibrationIndex", () => {
  const key = { fork: FORK, member: "m", version: "1", question: "risk" };

  it("CAL1.28 an index holds a validated book and finds an entry by fork, member, version and question", () => {
    const e = entryOf();
    const index = new CalibrationIndex({ entries: [e] });
    expect(index.book).toEqual({ entries: [e] });
    expect(index.entry(key)).toEqual(e);
    expect(index.entry({ ...key, version: "2" })).toBeUndefined();
    expect(index.entry({ ...key, member: "n" })).toBeUndefined();
    expect(index.entry({ ...key, question: "other" })).toBeUndefined();
    expect(index.entry({ ...key, fork: forkId("other") })).toBeUndefined();
    expect(new CalibrationIndex().book).toEqual({ entries: [] });
  });

  it("CAL1.29 a book that does not parse, or lists a key twice, is refused", () => {
    expect(() => new CalibrationIndex({ entries: [entryOf({ member: "" })] })).toThrow(/not a calibration book/);
    expect(() => new CalibrationIndex({ entries: [entryOf(), entryOf({ calibrator: { kind: "identity" } })] })).toThrow(/more than one entry for fork "permission.risk", member "m", version "1", question "risk"/);
    expect(() => parseCalibration({ entries: "no" })).toThrow(RangeError);
    expect(() => new CalibrationIndex({ entries: [entryOf(), entryOf({ version: "2" }), entryOf({ question: "q2" }), entryOf({ member: "n" }), entryOf({ fork: forkId("other") })] })).not.toThrow();
  });

  it("CAL1.30 with() returns a new index with that key's entry replaced or added, and leaves the old one alone", () => {
    const first = entryOf();
    const index = new CalibrationIndex({ $schema: "./calibration.schema.json", entries: [first, entryOf({ question: "second" })] });
    const replacement = entryOf({ calibrator: { kind: "identity" } });
    const replaced = index.with(replacement);
    expect(replaced.book.entries.map((e) => e.question)).toEqual(["risk", "second"]);
    expect(replaced.entry(key)!.calibrator).toEqual({ kind: "identity" });
    expect(replaced.book.$schema).toBe("./calibration.schema.json");
    expect(index.entry(key)).toEqual(first);
    const added = index.with(entryOf({ version: "2" }));
    expect(added.book.entries.length).toBe(3);
    expect(added.entry({ ...key, version: "2" })).toBeDefined();
    expect(index.book.entries.length).toBe(2);
    expect(() => index.with(entryOf({ question: "" }))).toThrow(/not a calibration entry/);
  });

  it("CAL1.31 calibrate applies an entry to the answers of exactly its fork, member, version and question", () => {
    const answers: Answers = { risk: choice({ a: 3, b: 1 }), other: choice({ a: 3, b: 1 }) };
    const index = new CalibrationIndex({ entries: [entryOf()] });
    const out = index.calibrate({ fork: FORK, member: "m", version: "1" }, answers);
    expect(out["risk"]).toEqual(applyCalibrator({ kind: "temperature", temperature: temperature(2) }, answers["risk"]!));
    expect(out["other"]).toBe(answers["other"]);
    expect(Object.keys(out)).toEqual(["risk", "other"]);
  });

  it("CAL1.32 calibrate never applies an entry fitted for a different version, member or fork", () => {
    const answers: Answers = { risk: choice({ a: 3, b: 1 }) };
    const index = new CalibrationIndex({ entries: [entryOf()] });
    for (const other of [{ version: "2" }, { member: "n" }, { fork: forkId("other") }]) {
      expect(index.calibrate({ fork: FORK, member: "m", version: "1", ...other }, answers)).toEqual(answers);
    }
  });

  it("CAL1.33 calibrate leaves an answer alone when its entry is the identity, or a Platt one and the answer is not a boolean", () => {
    const answers: Answers = { risk: choice({ a: 3, b: 1 }), flag: answerOfDistribution("boolean", booleanDistribution(0.7)) };
    const index = new CalibrationIndex({ entries: [entryOf({ calibrator: { kind: "platt", a: 2, b: 0 } }), entryOf({ question: "flag", calibrator: { kind: "identity" } })] });
    const out = index.calibrate({ fork: FORK, member: "m", version: "1" }, answers);
    expect(out["risk"]).toBe(answers["risk"]);
    expect(out["flag"]).toBe(answers["flag"]);
    const boolPlatt = new CalibrationIndex({ entries: [entryOf({ question: "flag", calibrator: { kind: "platt", a: 2, b: 0 } })] });
    expect(boolPlatt.calibrate({ fork: FORK, member: "m", version: "1" }, answers)["flag"]!.distribution["true"]).toBeCloseTo(1 / (1 + Math.exp(-2 * Math.log(7 / 3))), 12);
    const odd: Answers = { flag: answerOfDistribution("boolean", dist({ yes: 1, no: 1 })) };
    expect(boolPlatt.calibrate({ fork: FORK, member: "m", version: "1" }, odd)["flag"]).toBe(odd["flag"]);
  });
});

describe("fitBook", () => {
  const record = (i: number, answers: Answers, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
    id: `dec-${i}`,
    fork: FORK,
    forkVersion: "1",
    at: i,
    input: { truth: "a" },
    rung: "model",
    member: "m",
    memberVersion: "1",
    policy: "p",
    answers,
    action: "x",
    confidence: probability(0.5),
    propensity: probability(1),
    explored: false,
    mode: "active",
    trace: [],
    ...over,
  });
  const truth = (r: DecisionRecord, _question: string): string | undefined => (r.input as { truth?: string }).truth;
  const samples = overconfident(80, 3, 0.5);
  const recordsOf = (over: (i: number) => Partial<DecisionRecord> = () => ({})) =>
    samples.map((x, i) => record(i, { risk: answerOfDistribution("choice", x.distribution) }, { input: { truth: x.label }, ...over(i) }));

  it("CAL1.34 records are grouped by fork, member, version and question and each group is fitted", () => {
    const records = [...recordsOf(), ...recordsOf((i) => ({ id: `dec-${1000 + i}`, memberVersion: "2" })), ...recordsOf((i) => ({ id: `dec-${2000 + i}`, member: "n" }))];
    const book = fitBook({ records, labelOf: truth, at: 77 });
    expect(book.entries.map((e) => [e.member, e.version, e.question, e.fitted.n, e.fitted.at])).toEqual([
      ["m", "1", "risk", 80, 77],
      ["m", "2", "risk", 80, 77],
      ["n", "1", "risk", 80, 77],
    ]);
    expect(book.entries[0]).toEqual(fitEntry({ fork: FORK, member: "m", version: "1", question: "risk", type: "choice", samples, at: 77 }));
  });

  it("CAL1.35 a member's own answers before calibration are used when the record kept them", () => {
    const calibrated = new CalibrationIndex({ entries: [entryOf({ calibrator: { kind: "temperature", temperature: temperature(5) } })] });
    const records = samples.map((x, i) => {
      const raw = { risk: answerOfDistribution("choice", x.distribution) };
      return record(i, calibrated.calibrate({ fork: FORK, member: "m", version: "1" }, raw), { raw, input: { truth: x.label } });
    });
    const book = fitBook({ records, labelOf: truth, at: 1 });
    expect(book.entries[0]).toEqual(fitEntry({ fork: FORK, member: "m", version: "1", question: "risk", type: "choice", samples, at: 1 }));
  });

  it("CAL1.36 a raw answer is used per question and the calibrated answer for the questions raw does not have", () => {
    const rawOnly = samples.map((x, i) =>
      record(i, { risk: choice({ a: 1, b: 1 }), extra: answerOfDistribution("choice", x.distribution) }, { raw: { risk: answerOfDistribution("choice", x.distribution) }, input: { truth: x.label } }),
    );
    const book = fitBook({ records: rawOnly, labelOf: truth, at: 1 });
    expect(book.entries.map((e) => e.question)).toEqual(["risk", "extra"]);
    expect(book.entries[0]!.fitted.n).toBe(80);
    expect(book.entries[1]!.fitted.n).toBe(80);
    expect(book.entries[0]).toEqual({ ...book.entries[1]!, question: "risk" });
  });

  it("CAL1.37 records without a label, a member or a version, and labels that are not among the options, are skipped", () => {
    const fine = (i: number) => record(500 + i, { risk: answerOfDistribution("choice", samples[i % samples.length]!.distribution) }, { input: { truth: samples[i % samples.length]!.label } });
    const noMember = many(40, (i) => {
      const { member: _member, ...rest } = fine(i);
      return rest;
    });
    const noVersion = many(40, (i) => {
      const { memberVersion: _version, ...rest } = fine(i + 100);
      return rest;
    });
    const noLabel = many(40, (i) => ({ ...fine(i + 200), input: {} }));
    const wrongLabel = many(40, (i) => ({ ...fine(i + 300), input: { truth: "z" } }));
    const book = fitBook({ records: [...recordsOf(), ...noMember, ...noVersion, ...noLabel, ...wrongLabel], labelOf: truth, at: 1 });
    expect(book.entries.length).toBe(1);
    expect(book.entries[0]!.fitted.n).toBe(80);
  });

  it("CAL1.47 a missing label is not the option that happens to be called undefined", () => {
    const records = many(40, (i) => record(i, { risk: answerOfDistribution("choice", dist({ undefined: 3, other: 1 })) }, { input: {} }));
    expect(fitBook({ records, labelOf: () => undefined, at: 1 }).entries).toEqual([]);
    expect(fitBook({ records, labelOf: () => "undefined", at: 1 }).entries.length).toBe(1);
  });

  it("CAL1.38 groups below the minimum number of samples give no entry, and answers of another type than the group's first are skipped", () => {
    expect(fitBook({ records: recordsOf().slice(0, 29), labelOf: truth, at: 1 }).entries).toEqual([]);
    expect(fitBook({ records: recordsOf().slice(0, 29), labelOf: truth, at: 1, minSamples: 29 }).entries.length).toBe(1);
    const mixed = [...recordsOf(), record(600, { risk: answerOfDistribution("score", dist({ "0": 1, "1": 1 })) }, { input: { truth: "0" } })];
    expect(fitBook({ records: mixed, labelOf: truth, at: 1 }).entries[0]!.fitted.n).toBe(80);
  });

  it("CAL1.39 boolean answers whose options are not true and false are skipped rather than fitted", () => {
    const weird = many(40, (i) => record(i, { flag: answerOfDistribution("boolean", dist({ yes: 1, no: 1 })) }, { input: { truth: "yes" } }));
    expect(fitBook({ records: weird, labelOf: truth, at: 1 }).entries).toEqual([]);
    const fine = many(40, (i) => record(i, { flag: answerOfDistribution("boolean", booleanDistribution(0.9)) }, { input: { truth: i < 20 ? "true" : "false" } }));
    expect(fitBook({ records: fine, labelOf: truth, at: 1 }).entries[0]!.question).toBe("flag");
  });

  it("CAL1.40 fitting into an index replaces the entries it fits and keeps the others, order and schema line included", () => {
    const old = entryOf({ question: "risk" });
    const kept = entryOf({ question: "kept" });
    const index = new CalibrationIndex({ $schema: "./calibration.schema.json", entries: [kept, old] });
    const book = fitBook({ records: recordsOf(), labelOf: truth, at: 3, index });
    expect(book.$schema).toBe("./calibration.schema.json");
    expect(book.entries.map((e) => e.question)).toEqual(["kept", "risk"]);
    expect(book.entries[0]).toEqual(kept);
    expect(book.entries[1]!.fitted.at).toBe(3);
    expect(index.book.entries[1]).toEqual(old);
  });

  it("CAL1.41 the labels come from labelOf(record, question)", () => {
    const seen: string[] = [];
    fitBook({ records: recordsOf().slice(0, 2), labelOf: (r, q) => (seen.push(`${r.id}:${q}`), undefined), at: 1 });
    expect(seen).toEqual(["dec-0:risk", "dec-1:risk"]);
  });
});

describe("calibration data", () => {
  const file = JSON.parse(readFileSync(new URL("../data/calibration.json", import.meta.url), "utf8")) as Record<string, unknown>;

  it("CAL1.42 the shipped book parses, and names its JSON Schema, which is generated from the parser", async () => {
    expect(parseCalibration(file).entries).toEqual([]);
    expect(file["$schema"]).toBe("./calibration.schema.json");
    await expect(`${JSON.stringify(calibrationJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/calibration.schema.json");
  });

  it("CAL1.43 a book that cannot be right is refused, naming where", () => {
    expect(() => parseCalibration({ entries: [{ ...entryOf(), version: "" }] })).toThrow(/entries\[0\]\.version|entries.*version/s);
    expect(() => parseCalibration({ entries: [], extra: 1 })).toThrow(/extra/);
    expect(new CalibrationIndex(parseCalibration(file)).book.entries).toEqual([]);
  });
});
