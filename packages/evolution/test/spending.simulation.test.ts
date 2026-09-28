import { describe, expect, it } from "vitest";
import { campaign, toggle } from "./world.ts";

const CALIBRATED = { rule: "calibrated", alpha: 0.1, resamples: 400, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 };

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
  }, 300_000);

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
  }, 300_000);
});
