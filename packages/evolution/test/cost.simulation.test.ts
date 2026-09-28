import { describe, expect, it } from "vitest";
import { Evolution, tokens } from "@harness/evolution";
import type { EvolutionPorts, TaskRun } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { Uniform } from "../src/random.ts";
import { scripted, settings, toggle, world } from "./world.ts";

/**
 * Cost claims under trial-to-trial token noise. The world: 100 tasks whose scores are
 * deterministic (half always pass), so nothing but tokens can make a candidate look
 * better; every trial's tokens are its rule's cost times a lognormal factor with mean 1
 * and coefficient of variation `cv`. A candidate that changes nothing has no saving: any
 * acceptance is a false one. The reviewer's measurement of the point-ratio rule (no
 * error control on cost) was 19 of 20 runs accepting a change at cv 0.6 and 1.0, and 9 of
 * 20 at 0.3, at alpha 0.1.
 */
const CALIBRATED = { rule: "calibrated", alpha: 0.1, resamples: 700, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 };
const base = (i: number) => (i % 2 ? 1 : 0);

function noisy(w: ReturnType<typeof world>, seed: number, cv: number): EvolutionPorts["evaluate"] {
  const u = new Uniform(new SeededEntropy(seed * 31 + 7));
  const sigma = Math.sqrt(Math.log(1 + cv * cv));
  const gauss = () => Math.sqrt(-2 * Math.log(u.next())) * Math.cos(2 * Math.PI * u.next());
  return async (documents, tasks, k) => (await w.evaluate(documents, tasks, k)).map((r): TaskRun => ({ ...r, trials: r.trials.map((x) => ({ ...x, tokens: tokens(x.tokens! * Math.exp(sigma * gauss() - (sigma * sigma) / 2)) })) }));
}

async function run(seed: number, cv: number, rounds: number, propose: Parameters<typeof scripted>[0], through?: number) {
  const w = world({ n: 100, base, seed, cost: { saver: -400 } });
  const evaluate = noisy(w, seed, cv);
  const e = await Evolution.start({ surface: w.surface, settings: settings({ rounds, select: CALIBRATED, prune: { after: 1, every: 30 } }), split: w.split, documents: w.documents, ports: { evaluate, entropy: new SeededEntropy(seed) } });
  const { propose: p } = scripted(propose);
  let accepted = 0;
  while (!e.done && (through === undefined || e.completed <= through)) if ((await e.round({ evaluate, propose: p, entropy: new SeededEntropy(seed * 7 + e.completed) })).accepted) accepted++;
  return { accepted, e };
}

describe("cost claims carry error control", () => {
  for (const cv of [0.6, 1.0])
    it(`RS19.20 candidates with no effect are accepted in at most alpha of 40 runs of 20 rounds when tokens are noisy (cv ${cv})`, async () => {
      let accepting = 0;
      for (let seed = 1; seed <= 40; seed++) if ((await run(seed, cv, 20, (r) => toggle(`null${r.round}${r.candidate}`))).accepted > 0) accepting++;
      expect(accepting).toBeLessThanOrEqual(4); // alpha = 0.1 of 40 runs; observed 0 at both
    }, 600_000);

  for (const cv of [0.6, 1.0])
    it(`RS19.21 a rule that really cuts tokens by 40% at equal score is accepted, at token noise cv ${cv}`, async () => {
      let found = 0;
      for (let seed = 1; seed <= 10; seed++) {
        const { accepted, e } = await run(seed, cv, 20, (r) => (r.candidate === "A" ? toggle("saver") : toggle(`null${r.round}`)), 0);
        if (accepted === 1 && (e.documents["policy"] as { rules: Record<string, boolean> }).rules["saver"]) found++;
      }
      expect(found).toBeGreaterThanOrEqual(8); // observed 10 of 10 at cv 0.6 and 9 of 10 at 1.0
    }, 600_000);
});
