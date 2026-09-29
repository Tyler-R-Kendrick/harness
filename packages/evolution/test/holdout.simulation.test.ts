import { describe, expect, it } from "vitest";
import { Evolution, holdoutLevel } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { coinBase, scripted, settings, toggle, world } from "./world.ts";
import type { WorldSpec } from "./world.ts";

/**
 * The budgeted holdout, over seeded worlds. Round 0 of a 20-round run (alpha 0.1) on 240
 * evolve tasks whose success probabilities are the usual coin world's; candidate A
 * switches on one rule, the holdout has `holdout` tasks drawn like the evolve set (alpha
 * 0.1, budget 2: each query is tested at level 0.1 / 3). What is counted is the runs in
 * which the evolve set certified A and the holdout was queried, and how many of those
 * it confirmed.
 */
const CALIBRATED = { rule: "calibrated", alpha: 0.1, resamples: 2000, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 };
const HOLDOUT = { alpha: 0.1, budget: 2 };

async function study(seeds: number, holdout: number, effects: NonNullable<WorldSpec["effects"]>) {
  let queried = 0;
  let confirmed = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const w = world({ n: 240, holdout, base: coinBase, seed, effects });
    const e = await Evolution.start({ surface: w.surface, settings: settings({ rounds: 20, select: CALIBRATED, holdout: HOLDOUT }), split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(seed) } });
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("real") : toggle(`null${r.round}`)));
    const report = await e.round({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(seed * 7) });
    const h = report.records.find((r) => r.candidate === "A")?.measured?.holdout;
    if (h) queried++;
    if (h?.confirmed) {
      confirmed++;
      expect(report.accepted).toBe("A");
    }
  }
  return { queried, confirmed };
}

describe("confirmation on the holdout: Monte Carlo", () => {
  it("RS19.80 a candidate whose gain is on the evolve tasks only (+0.10) is confirmed in about at most beta = alpha / 3 of the runs that queried the holdout", async () => {
    const { queried, confirmed } = await study(100, 240, { real: (i, h) => (!h && i % 5 < 2 ? 0.25 : 0) });
    expect(holdoutLevel(HOLDOUT)).toBeCloseTo(0.1 / 3, 12);
    expect(queried).toBeGreaterThanOrEqual(85); // the evolve set certifies the fitted gain nearly every time; observed 95 of 100
    expect(confirmed).toBeLessThanOrEqual(5); // beta * 100 = 3.3; observed 1 of the 95
  }, 600_000);

  it("RS19.81 a real broad gain (+0.10 everywhere) that the evolve set certifies is confirmed with high probability", async () => {
    const { queried, confirmed } = await study(100, 240, { real: (i) => (i % 5 < 2 ? 0.25 : 0) });
    expect(queried).toBeGreaterThanOrEqual(85); // observed 95 of 100
    expect(confirmed / queried).toBeGreaterThanOrEqual(0.9); // observed 95 of 95
  }, 600_000);
});
