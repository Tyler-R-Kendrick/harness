import { describe, expect, it } from "vitest";
import { campaign, toggle } from "./world.ts";

/**
 * The power table of ADR 0018: what the calibrated rule can certify, for a real gain
 * proposed in the first round of a 20-round run (so its test level is that of the whole run,
 * alpha 0.1 over 60 tests), 20 seeded runs per row, in the simulated world of RS10.1: a
 * fifth of the tasks always fail, two fifths always pass, a fifth are coin flips. The other
 * rows of the table are RS10.3 (+0.10 on 240 tasks) and RS14.62 (+0.05 on 240 tasks).
 */
const SELECT = { rule: "calibrated", alpha: 0.1, resamples: 1200, margin: 0.01, saving: 0.05, beta0: 0.1, beta1: 35 };
const found = async (n: number, real: (i: number) => number) => {
  let k = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const r = await campaign({ n, seed, rounds: 20, select: SELECT, through: 0, effects: { real }, propose: (q) => (q.candidate === "A" ? toggle("real") : toggle(`null${q.round}`)) });
    if (r.last === "A") k++;
  }
  return k;
};

describe("power of the calibrated rule", () => {
  it("RS17.1 60 tasks, a +20 point gain (+1 on a fifth of the tasks): certified in about half of 20 runs", async () => {
    const k = await found(60, (i) => (i % 5 === 0 ? 1 : 0));
    expect(k).toBeGreaterThanOrEqual(6);
    expect(k).toBeLessThanOrEqual(14); // observed 10
  }, 300_000);

  it("RS17.2 60 tasks, a +10 point gain (+0.25 on two fifths): certified in few of 20 runs", async () => {
    const k = await found(60, (i) => (i % 5 < 2 ? 0.25 : 0));
    expect(k).toBeLessThanOrEqual(9); // observed 4
  }, 300_000);

  it("RS17.3 240 tasks, a +10 point gain (+1 on a tenth): certified in nearly all of 20 runs", async () => {
    const k = await found(240, (i) => (i % 10 === 0 ? 1 : 0));
    expect(k).toBeGreaterThanOrEqual(15); // observed 19
  }, 300_000);
});
