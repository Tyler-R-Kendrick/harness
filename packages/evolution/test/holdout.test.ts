import { describe, expect, it } from "vitest";
import { startHoldout, thresholdout } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { Uniform } from "../src/random.ts";

const exact = { threshold: 0.03, sigma: 0, budget: 2 };

describe("a reusable holdout (Thresholdout)", () => {
  it("RS4.1 with no noise the threshold is exact; with noise it is drawn around it", () => {
    const u = new Uniform(new SeededEntropy(1));
    expect(startHoldout(exact, u)).toEqual({ budget: 2, threshold: 0.03, queries: 0, overfits: 0 });
    const noisy = Array.from({ length: 2000 }, () => startHoldout({ ...exact, sigma: 0.01 }, u).threshold);
    expect(noisy.reduce((s, x) => s + x, 0) / noisy.length).toBeCloseTo(0.03, 2);
    expect(new Set(noisy).size).toBeGreaterThan(1000);
  });

  it("RS4.2 when the evolve set and the holdout agree within the threshold, the answer is the evolve set's and the holdout is not spent", () => {
    const u = new Uniform(new SeededEntropy(1));
    const state = startHoldout(exact, u);
    const r = thresholdout(state, exact, { evolve: 0.05, holdout: 0.03 }, u);
    expect(r).toEqual({ kind: "answer", answer: 0.05, overfit: false, state: { ...state, queries: 1 } });
    // A disagreement exactly at the threshold is agreement.
    expect(thresholdout({ ...state, threshold: 0.25 }, exact, { evolve: 0.5, holdout: 0.25 }, u)).toMatchObject({ answer: 0.5, overfit: false });
  });

  it("RS4.3 when they disagree by more, overfitting is detected: the answer is the holdout's (with noise) and one unit of budget is spent", () => {
    const u = new Uniform(new SeededEntropy(1));
    const state = startHoldout(exact, u);
    const r = thresholdout(state, exact, { evolve: 0.05, holdout: 0.01 }, u);
    expect(r).toEqual({ kind: "answer", answer: 0.01, overfit: true, state: { budget: 1, threshold: 0.03, queries: 1, overfits: 1 } });
    const noisy = thresholdout(state, { ...exact, sigma: 0.001 }, { evolve: 0.5, holdout: 0.01 }, u);
    expect(noisy.kind === "answer" && noisy.answer !== 0.01 && Math.abs(noisy.answer - 0.01) < 0.05).toBe(true);
  });

  it("RS4.4 a spent holdout answers nothing: past its budget its guarantee is gone", () => {
    const u = new Uniform(new SeededEntropy(1));
    const spent = { budget: 0, threshold: 0.03, queries: 4, overfits: 2 };
    expect(thresholdout(spent, exact, { evolve: 0.05, holdout: 0.05 }, u)).toEqual({ kind: "exhausted", state: spent });
  });
});
