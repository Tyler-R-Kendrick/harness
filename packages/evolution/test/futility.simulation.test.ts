import { describe, expect, it } from "vitest";
import { campaign, toggle } from "./world.ts";

const CALIBRATED = { rule: "calibrated", alpha: 0.1, resamples: 400, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 };
const FUTILITY = { fraction: 0.5, alpha: 0.05 };

/**
 * Monte Carlo studies of whole runs from fixed seeds, so they are regression tests with
 * counts we measured (comments give what was observed when they were written). The world
 * is that of RS10.1-RS10.3: a fifth of the tasks always fail, two fifths always pass, a
 * fifth is a coin flip. Futility is {fraction 0.5, alpha 0.05}.
 *
 * Measured beyond what these tests run (same worlds, more seeds, 600 for power): a
 * candidate with a real gain of +0.05 on 240 tasks was abandoned in 0 of 300 runs at
 * (0.5, 0.05), 0 of 300 at (0.5, 0.01), 0 of 300 at (0.3, 0.05) and 1 of 300 at (0.25, 0.1).
 * The rate at which such a run accepted it (unpaired, since staging changes which random
 * trials each candidate gets): 220 of 600 without staging, 239 with it: no loss we can see.
 */
const bad = (harm: number) => ({ bad: (i: number) => (i % 5 === 2 || i % 5 === 3 ? -harm : 0) });
const nullProposer = (r: { round: number; candidate: string }) => toggle(`null${r.round}${r.candidate}`);
const stagedRule = { ...CALIBRATED, futility: FUTILITY };

describe("futility staging: Monte Carlo over whole runs", () => {
  it("RS14.60 under the null (no candidate has any effect) staged runs accept a change in at most alpha of 40 runs of 10 rounds, as unstaged ones do", async () => {
    let plain = 0;
    let staged = 0;
    let abandoned = 0;
    for (let seed = 1; seed <= 40; seed++) {
      if ((await campaign({ n: 60, seed, rounds: 10, select: CALIBRATED, propose: nullProposer })).accepted > 0) plain++;
      const r = await campaign({ n: 60, seed, rounds: 10, select: stagedRule, propose: nullProposer });
      if (r.accepted > 0) staged++;
      abandoned += r.abandoned;
    }
    expect(plain).toBeLessThanOrEqual(4); // observed 2 (RS10.1)
    expect(staged).toBeLessThanOrEqual(4); // alpha = 0.1 of 40 runs; observed 0
    // A do-nothing candidate is almost never stopped: 4 of the 800 drawn in these runs.
    expect(abandoned).toBeLessThanOrEqual(40);
  }, 300_000);

  it("RS14.61 clearly bad candidates are abandoned early: a fifth fewer evolve tasks evaluated over a run with one bad candidate a round, none accepted", async () => {
    const study = async (select: object, harm: number) => {
      let tasks = 0;
      let accepted = 0;
      let abandoned = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const r = await campaign({ n: 60, seed, rounds: 10, select, effects: bad(harm), propose: (q) => (q.candidate === "A" ? toggle("bad") : nullProposer(q)) });
        tasks += r.tasks;
        accepted += r.accepted;
        abandoned += r.abandoned;
      }
      return { tasks, accepted, abandoned };
    };
    const plain = await study(CALIBRATED, 0.5);
    const staged = await study(stagedRule, 0.5);
    // Half the passing tasks now fail half the time: a true loss of 0.2 (of 400 bad candidates, A's, over the 40 runs).
    expect(plain).toMatchObject({ abandoned: 0, accepted: 0 });
    expect(plain.tasks).toBe(52800); // observed: 60 tasks x (incumbent, A, B) x 10 rounds x 40 runs, plus the ablations
    expect(staged.accepted).toBe(0);
    expect(staged.abandoned).toBeGreaterThanOrEqual(300); // observed 331 of 400
    expect(staged.tasks).toBeLessThan(0.85 * plain.tasks); // observed 42870: 18.8% fewer (34% fewer than the candidates' share, since the incumbent is always measured in full)
    // The worse the candidate, the more often it is stopped (a loss of 0.1: 167 of 400; of 0.4: all 400).
    const mild = await study(stagedRule, 0.25);
    const total = await study(stagedRule, 1);
    expect(mild.abandoned).toBeLessThan(staged.abandoned);
    expect(total.abandoned).toBe(400);
    expect(total.tasks).toBeLessThan(staged.tasks);
    expect(mild.tasks).toBeGreaterThan(staged.tasks);
  }, 300_000);

  it("RS14.62 a real, broad gain is still found: never abandoned in 140 runs, and accepted about as often as without staging (unpaired counts)", async () => {
    const study = async (select: object, seeds: number, effect: number) => {
      let found = 0;
      let abandoned = 0;
      for (let seed = 1; seed <= seeds; seed++) {
        const r = await campaign({ n: 240, seed, rounds: 20, select: { ...select, resamples: 1200 }, through: 0, effects: { real: (i) => (i % 5 < 2 ? effect : 0) }, propose: (q) => (q.candidate === "A" ? toggle("real") : toggle(`null${q.round}`)) });
        if (r.last === "A") found++;
        if (r.abandonedA) abandoned++;
      }
      return { found, abandoned };
    };
    // +0.10 true gain (RS10.3's world): 39 of 40 without staging, 37 with.
    const strong = { plain: await study(CALIBRATED, 40, 0.25), staged: await study(stagedRule, 40, 0.25) };
    expect(strong.staged.abandoned).toBe(0);
    expect(strong.staged.found).toBeGreaterThanOrEqual(33);
    expect(strong.plain.found).toBeGreaterThanOrEqual(33);
    // +0.05 true gain, close to what 240 tasks can certify: 40 of 100 without staging, 36 with (600 runs: 220 and 239).
    const weak = { plain: await study(CALIBRATED, 100, 0.125), staged: await study(stagedRule, 100, 0.125) };
    expect(weak.staged.abandoned).toBe(0);
    expect(weak.staged.found).toBeGreaterThanOrEqual(30);
    expect(weak.plain.found).toBeGreaterThanOrEqual(30);
    expect(Math.abs(weak.staged.found - weak.plain.found)).toBeLessThanOrEqual(10); // the sampling noise of two counts of 100
  }, 300_000);
});
