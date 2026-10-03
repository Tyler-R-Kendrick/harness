import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { SeededEntropy } from "@harness/testkit";
import { applyCalibrator, brier, CalibrationIndex, ece, fitEntry, fitPlatt, fitTemperature } from "../src/calibration.ts";
import type { CalibrationSample } from "../src/calibration.ts";
import { answerOfDistribution, argmax, booleanDistribution, distributionFromWeights, isDistribution, softmaxWithTemperature, temperatureTransform } from "../src/distribution.ts";
import { uniform } from "../src/explore.ts";
import { forkId, temperature } from "../src/types.ts";
import type { Answer, Distribution } from "../src/types.ts";

const weights = fc.array(fc.double({ min: 0.001, max: 100, noNaN: true }), { minLength: 2, maxLength: 5 });
const sampleArb: fc.Arbitrary<CalibrationSample> = fc
  .tuple(weights, fc.nat())
  .map(([w, at]) => ({ distribution: distributionFromWeights(Object.fromEntries(w.map((x, i) => [`o${i}`, x]))), label: `o${at % w.length}` }));
const samplesArb = fc.array(sampleArb, { minLength: 1, maxLength: 40 });

const label = (d: Distribution, u: number): string => {
  let cumulative = 0;
  for (const [option, p] of Object.entries(d)) {
    cumulative += p;
    if (u < cumulative) return option;
  }
  return Object.keys(d).at(-1)!;
};
function world(n: number, seed: number, t0: number): CalibrationSample[] {
  const rng = uniform(new SeededEntropy(seed));
  return Array.from({ length: n }, () => {
    const q = softmaxWithTemperature({ a: (rng() - 0.5) * 6, b: (rng() - 0.5) * 6, c: (rng() - 0.5) * 6 });
    return { distribution: temperatureTransform(q, t0), label: label(q, rng()) };
  });
}

describe("calibration properties", () => {
  test.prop([samplesArb, fc.integer({ min: 1, max: 20 })])("CAL2.1 ECE is between 0 and 1 and Brier between 0 and 2", (samples, bins) => {
    expect(ece(samples, bins)).toBeGreaterThanOrEqual(0);
    expect(ece(samples, bins)).toBeLessThanOrEqual(1);
    expect(brier(samples)).toBeGreaterThanOrEqual(0);
    expect(brier(samples)).toBeLessThanOrEqual(2);
  });

  test.prop([fc.integer({ min: 2, max: 12 }), fc.nat()])("CAL2.2 a member that is right exactly as often as it says has zero ECE", (m, r) => {
    const lo = Math.ceil(m / 2);
    const k = lo + (r % (m - lo + 1));
    const p = k / m;
    const samples = Array.from({ length: m }, (_, i) => ({ distribution: distributionFromWeights({ a: p, b: 1 - p }), label: i < k ? "a" : "b" }));
    expect(ece(samples)).toBeLessThan(1e-9);
  });

  test.prop([samplesArb])("CAL2.3 a member that puts everything on the right option has zero Brier and zero ECE", (samples) => {
    const sure = samples.map((x) => ({ distribution: distributionFromWeights(Object.fromEntries(Object.keys(x.distribution).map((o) => [o, o === x.label ? 1 : 0]))), label: x.label }));
    expect(brier(sure)).toBe(0);
    expect(ece(sure)).toBe(0);
  });

  test.prop([samplesArb])("CAL2.4 the fitted temperature is never worse than leaving the probabilities as they are", (samples) => {
    const fit = fitTemperature(samples);
    const unchanged = samples.reduce((sum, x) => sum - Math.log(Math.max(x.distribution[x.label]!, 1e-12)), 0) / samples.length;
    expect(fit.nll).toBeLessThanOrEqual(unchanged + 1e-9);
    expect(fit.temperature).toBeGreaterThanOrEqual(0.05 - 1e-9);
    expect(fit.temperature).toBeLessThanOrEqual(20 + 1e-9);
  });

  it("CAL2.5 the temperature fitted on data made with a known temperature recovers it", () => {
    for (const [t0, seed] of [[0.4, 1], [0.6, 2], [0.8, 3], [1.5, 4], [2.5, 5]] as const) {
      const fitted = fitTemperature(world(4000, seed, t0)).temperature;
      expect(Math.abs(fitted * t0 - 1)).toBeLessThan(0.12);
    }
  });

  test.prop([samplesArb, fc.double({ min: 0.05, max: 20, noNaN: true })])("CAL2.6 a temperature calibrator gives a distribution in the same order, with the argmax on top", (samples, t) => {
    const lead = Object.values(samples[0]!.distribution).sort((a, b) => b - a);
    fc.pre(lead[0]! - lead[1]! > 1e-9); // an ulp-close pair may swap under rounding
    const answer = answerOfDistribution("choice", samples[0]!.distribution);
    const out = applyCalibrator({ kind: "temperature", temperature: temperature(t) }, answer);
    expect(isDistribution(out.distribution)).toBe(true);
    expect(out.top).toBe(argmax(out.distribution));
    expect(out.top).toBe(answer.top);
  });

  test.prop([fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: -5, max: 5, noNaN: true }), fc.double({ min: -5, max: 5, noNaN: true })])("CAL2.7 a Platt calibrator gives a boolean distribution whose top is its argmax", (p, a, b) => {
    const out = applyCalibrator({ kind: "platt", a, b }, answerOfDistribution("boolean", booleanDistribution(p)));
    expect(isDistribution(out.distribution)).toBe(true);
    expect(out.top).toBe(argmax(out.distribution));
  });

  const booleans = fc.array(fc.tuple(fc.double({ min: 0.01, max: 0.99, noNaN: true }), fc.boolean()), { minLength: 1, maxLength: 60 }).map((rows) => rows.map(([p, yes]) => ({ distribution: booleanDistribution(p), label: yes ? "true" : "false" })));

  test.prop([booleans])("CAL2.8 fitted Platt scaling is never worse than leaving the probabilities as they are, and is finite", (samples) => {
    const fit = fitPlatt(samples);
    const unchanged = samples.reduce((sum, x) => sum - Math.log(Math.max(x.distribution[x.label]!, 1e-12)), 0) / samples.length;
    expect(Number.isFinite(fit.a) && Number.isFinite(fit.b)).toBe(true);
    expect(fit.nll).toBeLessThanOrEqual(unchanged + 1e-9);
  });

  it("CAL2.9 calibration fitted on one sample of a world improves ECE on a fresh sample of it", () => {
    for (const [t0, seed] of [[0.5, 11], [0.7, 12], [2, 13]] as const) {
      const entry = fitEntry({ fork: forkId("f"), member: "m", version: "1", question: "q", type: "choice", samples: world(800, seed, t0), at: 0 })!;
      const fresh = world(4000, seed + 100, t0);
      const after = fresh.map((x) => ({ ...x, distribution: applyCalibrator(entry.calibrator, answerOfDistribution("choice", x.distribution)).distribution }));
      expect(ece(after)).toBeLessThan(ece(fresh));
      expect(brier(after)).toBeLessThan(brier(fresh));
    }
  });

  it("CAL2.10 calibration fitted on a world with a shifted boolean member improves ECE on a fresh sample", () => {
    const rng = uniform(new SeededEntropy(41));
    const make = (n: number) =>
      Array.from({ length: n }, () => {
        const p = 0.05 + 0.9 * rng();
        return { distribution: booleanDistribution(p), label: rng() < 1 / (1 + Math.exp(-(Math.log(p / (1 - p)) - 1.2))) ? "true" : "false" };
      });
    const entry = fitEntry({ fork: forkId("f"), member: "m", version: "1", question: "q", type: "boolean", samples: make(800), at: 0 })!;
    const fresh = make(4000);
    const after = fresh.map((x) => ({ ...x, distribution: applyCalibrator(entry.calibrator, answerOfDistribution("boolean", x.distribution)).distribution }));
    expect(entry.calibrator.kind).toBe("platt");
    expect(ece(after)).toBeLessThan(ece(fresh) / 2);
  });

  test.prop([fc.string({ minLength: 1, maxLength: 6 }), fc.string({ minLength: 1, maxLength: 6 }), samplesArb])("CAL2.11 an entry is never applied to another version of its member", (fitted, other, samples) => {
    fc.pre(fitted !== other);
    const index = new CalibrationIndex({
      entries: [{ fork: forkId("f"), member: "m", version: fitted, question: "q", calibrator: { kind: "temperature", temperature: temperature(3) }, fitted: { n: 1, at: 0, eceBefore: 0, eceAfter: 0, brierBefore: 0, brierAfter: 0 } }],
    });
    const answers: Record<string, Answer> = { q: answerOfDistribution("choice", samples[0]!.distribution) };
    expect(index.calibrate({ fork: forkId("f"), member: "m", version: other }, answers)).toEqual(answers);
    expect(index.calibrate({ fork: forkId("f"), member: "m", version: fitted }, answers)["q"]).not.toBe(answers["q"]);
  });
});
