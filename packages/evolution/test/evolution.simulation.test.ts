import { describe, expect, it } from "vitest";
import { Evolution } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { scripted, settings, toggle, world } from "./world.ts";

/**
 * Monte Carlo studies of whole runs, from fixed seeds (so they are regression tests with
 * exact counts, run fast enough to keep). The world: 60 evolve tasks, a fifth of them
 * noisy (success probability 1/2), the rest always pass or always fail; true score 1/2.
 */
const base = (i: number) => [0, 0, 1, 1, 0.5][i % 5]!;
const CALIBRATED = { rule: "calibrated", alpha: 0.1, resamples: 400, margin: 0.01, saving: 0.05, beta0: 0.1, beta1: 35 };
// The paper's workspace and coding instances, with delta calibrated from two base evaluations as the paper does.
const WORKSPACE = { rule: "paper", z: 2, beta0: 0.1, beta1: 35.4, ws: 1414, wc: 15, wn: 0.5, prune: 4 };
const CODING = { ...WORKSPACE, ws: 0, beta1: 44.5 };

/** A run of 10 rounds in which no candidate has any effect: every acceptance is a false one. */
async function nullRun(seed: number, select: object) {
  const w = world({ n: 60, base, seed });
  const e = await Evolution.start({ surface: w.surface, settings: settings({ rounds: 10, select, prune: { after: 1, every: 3 } }), split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(seed) } });
  const { propose } = scripted((r) => toggle(`null${r.round}${r.candidate}`));
  let accepted = 0;
  while (!e.done) if ((await e.round({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(seed * 7 + e.completed) })).accepted) accepted++;
  return { accepted, bias: e.trajectory.at(-1)! - 0.5 };
}

async function study(select: object, seeds = 40) {
  const runs = [];
  for (let seed = 1; seed <= seeds; seed++) runs.push(await nullRun(seed, select));
  return { accepting: runs.filter((r) => r.accepted > 0).length, bias: runs.reduce((s, r) => s + r.bias, 0) / runs.length };
}

describe("whole runs under the null (no candidate helps)", () => {
  it("RS10.1 the calibrated rule accepts a change in at most alpha of runs, and its estimate of the incumbent is unbiased", async () => {
    const { accepting, bias } = await study(CALIBRATED);
    expect(accepting).toBeLessThanOrEqual(4); // alpha = 0.1 of 40 runs; observed 2
    expect(Math.abs(bias)).toBeLessThan(0.005);
  }, 300_000);

  it("RS10.2 the paper's rule accepts noise in most runs of its workspace instance and inflates the incumbent's score by the winner's curse", async () => {
    const workspace = await study(WORKSPACE);
    expect(workspace.accepting).toBeGreaterThanOrEqual(28); // observed 33 of 40
    expect(workspace.bias).toBeGreaterThan(0.025); // observed +0.034: more than the paper's whole evolve-set gain on Harvey LAB (+0.011)
    const coding = await study(CODING);
    expect(coding.accepting).toBeGreaterThanOrEqual(8); // observed 10 of 40
    expect(coding.bias).toBeGreaterThan(0.01); // observed +0.016
  }, 300_000);
});

describe("whole runs with a real improvement", () => {
  it("RS10.3 the calibrated rule finds a broad real gain when the evolve set is large enough to certify it", async () => {
    let found = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const w = world({ n: 240, base, seed, effects: { real: (i) => (i % 5 < 2 ? 0.25 : 0) } });
      const e = await Evolution.start({ surface: w.surface, settings: settings({ rounds: 20, select: { ...CALIBRATED, resamples: 1200 } }), split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(seed) } });
      const { propose } = scripted((r) => (r.candidate === "A" ? toggle("real") : toggle(`null${r.round}`)));
      if ((await e.round({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(seed * 7) })).accepted === "A") found++;
    }
    expect(found).toBeGreaterThanOrEqual(16); // a true gain of 0.10 on 240 tasks; observed 19 of 20
  }, 300_000);
});
