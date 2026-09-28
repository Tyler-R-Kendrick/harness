import { describe, expect, it } from "vitest";
import { Evolution, FutilitySchema, isFutile, parseSettings, permute, prefixSize } from "@harness/evolution";
import type { EvolutionPorts, LedgerRecord, TaskRun } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { campaign, scripted, settings, toggle, world } from "./world.ts";

type World = ReturnType<typeof world>;

const CALIBRATED = { rule: "calibrated", alpha: 0.1, resamples: 400, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 };
const FUTILITY = { fraction: 0.5, alpha: 0.05 };
const LEVEL = 0.1 / 18; // alpha over 6 rounds of 3 tests
const withFutility = (futility: object | null = FUTILITY, extra: Record<string, unknown> = {}) => settings({ select: { ...CALIBRATED, ...(futility ? { futility } : {}) }, ...extra });
const start = (w: World, s = withFutility(), seed = 1) => Evolution.start({ surface: w.surface, settings: s, split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(seed) } });
const ports = (evaluate: EvolutionPorts["evaluate"], propose: EvolutionPorts["propose"], seed = 2): EvolutionPorts => ({ evaluate, propose, entropy: new SeededEntropy(seed) });
const byCandidate = (records: readonly LedgerRecord[]) => Object.fromEntries(records.map((r) => [r.candidate, r]));
const sizes = (w: World) => w.calls.map((c) => c.tasks.length);
const ids = (w: World, call: number) => w.calls[call]!.tasks.map((t) => t.id);
const ruleNames = (documents: unknown) => Object.keys((documents as { policy: { rules: Record<string, boolean> } }).policy.rules);
/** A candidate that is worse everywhere it is drawn (A), and one that does nothing (B). */
const badAndNoop = (bad: string) => scripted((r) => (r.candidate === "A" ? toggle(bad) : toggle(`noop${r.round}${r.candidate}`)));

describe("futility staging: pure pieces", () => {
  it("RS14.30 the prefix is ceil(fraction n) tasks, at least one and at most all, robust to floating point", () => {
    expect(prefixSize(0.5, 10)).toBe(5);
    expect(prefixSize(0.5, 11)).toBe(6);
    expect(prefixSize(0.51, 10)).toBe(6);
    expect(prefixSize(0.49, 10)).toBe(5);
    expect(prefixSize(0.01, 10)).toBe(1);
    expect(prefixSize(0.99, 10)).toBe(10);
    expect(prefixSize(0.5, 1)).toBe(1);
    expect(prefixSize(0.9, 2)).toBe(2);
    // 0.28 * 25 is 7.000000000000001 in floating point: still 7 tasks, not 8.
    expect(0.28 * 25).toBeGreaterThan(7);
    expect(prefixSize(0.28, 25)).toBe(7);
    expect(prefixSize(0.56, 50)).toBe(28);
    expect(() => prefixSize(0.5, 0)).toThrow(RangeError);
  });

  it("RS14.31 a permutation is deterministic given the seed, differs between seeds, and is a rearrangement of the tasks", () => {
    const items = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const a = permute(items, new SeededEntropy(5));
    expect(permute(items, new SeededEntropy(5))).toEqual(a);
    expect(permute(items, new SeededEntropy(6))).not.toEqual(a);
    expect(a).not.toEqual(items);
    expect([...a].sort()).toEqual([...items].sort());
    expect(permute([], new SeededEntropy(5))).toEqual([]);
    expect(permute(["x"], new SeededEntropy(5))).toEqual(["x"]);
  });

  it("RS14.32 stopping is a strict threshold on the upper bound at -margin", () => {
    expect(isFutile(-0.05, 0.05)).toBe(false); // exactly at the margin: not clearly worse
    expect(isFutile(-0.0500001, 0.05)).toBe(true);
    expect(isFutile(-0.0499999, 0.05)).toBe(false);
    expect(isFutile(-0.005, 0.01)).toBe(false); // inside the margin
    expect(isFutile(0.02, 0.01)).toBe(false); // the margin is a tolerance below zero, not above
    expect(isFutile(-0.02, 0.01)).toBe(true);
    expect(isFutile(0, 0)).toBe(false);
    expect(isFutile(-1e-9, 0)).toBe(true);
    expect(isFutile(1, 0.02)).toBe(false); // the widest bound (too few groups to say anything)
  });

  it("RS14.33 the setting is a fraction and a level, both strictly inside their ranges, and only the calibrated rule has it", () => {
    expect(FutilitySchema.parse({ fraction: 0.5, alpha: 0.05 })).toEqual({ fraction: 0.5, alpha: 0.05 });
    for (const bad of [{ fraction: 0, alpha: 0.05 }, { fraction: 1, alpha: 0.05 }, { fraction: 0.5, alpha: 0 }, { fraction: 0.5, alpha: 0.5 }, { fraction: 0.5 }, { alpha: 0.05 }, { fraction: 0.5, alpha: 0.05, extra: 1 }]) expect(FutilitySchema.safeParse(bad).success).toBe(false);
    expect(parseSettings(withFutility()).select).toMatchObject({ futility: FUTILITY });
    expect(parseSettings(withFutility(null)).select).not.toHaveProperty("futility");
    const paper = { rule: "paper", delta: 0.01, beta0: 0.1, beta1: 35, ws: 1, wc: 1, wn: 0, prune: 4, futility: FUTILITY };
    expect(() => settings({ select: paper })).toThrow(/select/);
  });

  it("RS14.34 a futility level needs its own resamples: settings that cannot certify it are refused, naming where", () => {
    // alpha 0.001 needs 1000 resamples; the run's level 0.1 / 18 needs 180.
    expect(() => withFutility({ fraction: 0.5, alpha: 0.001 })).toThrow(/select\.resamples.*1000/s);
    expect(() => settings({ select: { ...CALIBRATED, resamples: 1000, futility: { fraction: 0.5, alpha: 0.001 } } })).not.toThrow();
    expect(() => settings({ select: { ...CALIBRATED, resamples: 19, futility: FUTILITY } })).toThrow(/select\.resamples/);
  });
});

describe("futility staging in a round", () => {
  it("RS14.40 a candidate clearly worse on a random half of the tasks is abandoned: the rest of the tasks are never evaluated, and the record says why with the prefix's interval", async () => {
    // Every task passes (p = 1); the bad rule fails the even-numbered ones.
    const w = world({ n: 40, base: () => 1, effects: { bad: (i) => (i % 2 === 0 ? -1 : 0) } });
    const e = await start(w);
    const { propose } = badAndNoop("bad");
    const report = await e.round(ports(w.evaluate, propose));
    // start: 40. Round: the incumbent in full, A and B on 20 each, then B's remaining 20; A is never finished.
    expect(sizes(w)).toEqual([40, 40, 20, 20, 20]);
    const prefix = ids(w, 2);
    expect(ids(w, 3)).toEqual(prefix); // B's first stage: the same tasks as A's
    expect(new Set([...prefix, ...ids(w, 4)]).size).toBe(40); // B's two stages partition the evolve set
    expect(prefix.filter((id) => ids(w, 4).includes(id))).toEqual([]);
    const evens = prefix.filter((id) => Number(id.slice(1)) % 2 === 0).length;
    const a = byCandidate(report.records)["A"]!;
    expect(a.outcome).toBe("rejected");
    expect(a.reason).toMatch(/abandoned for futility/);
    expect(a.reason).toMatch(/^abandoned for futility after 20 of 40 evolve tasks: the gain's upper bound -\d\.\d{4} \(level 0\.05\) is below -0\.0200, so it can be neither a supported gain nor non-inferior; the other 20 tasks were not evaluated$/);
    expect(a.reason).toContain(`upper bound ${a.measured!.upper.toFixed(4)} `);
    expect(a.measured).toMatchObject({ verdict: "refuted", alpha: 0.05 });
    expect(a.measured!.gain).toBeCloseTo(-evens / 20, 12);
    expect(a.measured!.score).toBeCloseTo(1 - evens / 20, 12);
    expect(a.measured!.cost).toBe(1000);
    expect(a.measured!.upper).toBeLessThan(-0.02);
    expect(a.measured!.upper).toBeGreaterThanOrEqual(a.measured!.gain);
    expect(a.measured!.lower).toBeLessThanOrEqual(a.measured!.gain);
    // The other candidate went on and was judged on all 40 tasks, at the run's level.
    const b = byCandidate(report.records)["B"]!;
    expect(b.reason).not.toMatch(/futility/);
    expect(b.measured).toMatchObject({ alpha: LEVEL, gain: 0, score: 1 });
    expect(report.level).toBe(LEVEL);
    expect(report.accepted).toBeUndefined();
    expect(e.completed).toBe(1);
  });

  it("RS14.41 the prefix is drawn from the entropy port: the same seed gives the same tasks, another seed other ones", async () => {
    const prefixOf = async (seed: number) => {
      const w = world({ n: 40, base: () => 1 });
      const e = await start(w);
      const { propose } = badAndNoop("noop");
      await e.round(ports(w.evaluate, propose, seed));
      return ids(w, 2);
    };
    const first = await prefixOf(2);
    expect(await prefixOf(2)).toEqual(first);
    expect(await prefixOf(3)).not.toEqual(first);
    expect(first).toHaveLength(20);
    // ... and it is the first ceil(fraction n) of a permutation of the evolve tasks.
    const w = world({ n: 40, base: () => 1 });
    expect(new Set(first).size).toBe(20);
    expect(first.every((id) => w.split.evolve.some((t) => t.id === id))).toBe(true);
  });

  it("RS14.42 a candidate that is not clearly worse is evaluated on every task, and its measurement is the same as without staging", async () => {
    const make = () => world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0) } });
    const propose = () => scripted((r) => (r.candidate === "A" ? toggle("verify") : toggle(`noop${r.round}${r.candidate}`))).propose;
    const w = make();
    const staged = await (await start(w)).round(ports(w.evaluate, propose()));
    const v = make();
    const plain = await (await start(v, withFutility(null))).round(ports(v.evaluate, propose()));
    expect(sizes(w)).toEqual([40, 40, 20, 20, 20, 20]);
    expect(sizes(v)).toEqual([40, 40, 40, 40]);
    expect(staged.accepted).toBe("A");
    expect(plain.accepted).toBe("A");
    for (const label of ["A", "B"]) {
      const s = byCandidate(staged.records)[label]!.measured!;
      const p = byCandidate(plain.records)[label]!.measured!;
      expect(s.score).toBe(p.score);
      expect(s.gain).toBe(p.gain);
      expect(s.cost).toBe(p.cost);
      expect(s.alpha).toBe(LEVEL);
    }
    expect(byCandidate(staged.records)["A"]).toMatchObject({ outcome: "accepted", measured: { gain: 0.5, score: 0.5, verdict: "supported" } });
    expect(byCandidate(staged.records)["A"]!.measured!.lower).toBeGreaterThan(0.2);
  });

  it("RS14.43 an interval as wide as it can be (too few groups in the prefix to say anything) never stops a candidate", async () => {
    const w = world({ n: 4, base: () => 1, effects: { bad: () => -1 } });
    const e = await start(w);
    const { propose } = badAndNoop("bad");
    const report = await e.round(ports(w.evaluate, propose));
    expect(sizes(w)).toEqual([4, 4, 2, 2, 2, 2]); // A finished too
    expect(byCandidate(report.records)["A"]!.reason).not.toMatch(/futility/);
    expect(byCandidate(report.records)["A"]!.measured).toMatchObject({ alpha: LEVEL, gain: -1 });
  });

  it("RS14.44 a prefix that would be every task is no stage at all", async () => {
    const two = world({ n: 2, base: () => 1, effects: { bad: () => -1 } });
    await (await start(two, withFutility({ fraction: 0.6, alpha: 0.05 }))).round(ports(two.evaluate, badAndNoop("bad").propose));
    expect(sizes(two)).toEqual([2, 2, 2, 2]); // ceil(0.6 * 2) = 2: one evaluation of everything
    const half = world({ n: 2, base: () => 1, effects: { bad: () => -1 } });
    await (await start(half)).round(ports(half.evaluate, badAndNoop("bad").propose));
    expect(sizes(half)).toEqual([2, 2, 1, 1, 1, 1]); // ceil(0.5 * 2) = 1 of 2
    const three = world({ n: 3, base: () => 1, effects: { bad: () => -1 } });
    await (await start(three)).round(ports(three.evaluate, badAndNoop("bad").propose));
    expect(sizes(three)).toEqual([3, 3, 2, 2, 1, 1]); // ceil(0.5 * 3) = 2
    const one = world({ n: 1, base: () => 1, effects: { bad: () => -1 } });
    await (await start(one)).round(ports(one.evaluate, badAndNoop("bad").propose));
    expect(sizes(one)).toEqual([1, 1, 1, 1]);
  });

  it("RS14.45 the removal of an accepted mechanism (ablation) is never staged, and is judged at the run's level on all tasks", async () => {
    const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0) } });
    const e = await start(w);
    const { propose } = scripted((r) => (r.candidate === "A" && r.round === 0 ? toggle("verify") : toggle(`noop${r.round}${r.candidate}`)));
    expect((await e.round(ports(w.evaluate, propose))).accepted).toBe("A");
    const before = w.calls.length;
    const report = await e.round(ports(w.evaluate, propose));
    const prune = w.calls.slice(before).filter((c) => !ruleNames(c.documents).includes("verify"));
    expect(prune.map((c) => c.tasks.length)).toEqual([40]); // removing verify, which is really worse by 0.5: not stopped early
    const p = byCandidate(report.records)["P"]!;
    expect(p).toMatchObject({ kind: "prune", outcome: "rejected", measured: { gain: -0.5, alpha: LEVEL, verdict: "refuted" } });
    expect(p.reason).not.toMatch(/futility/);
  });

  it("RS14.46 predicted tasks are judged only where the candidate was measured: those outside the prefix are neither hits nor misses", async () => {
    const draw = async (predicted: string[]) => {
      const w = world({ n: 40, base: () => 1, effects: { bad: () => -1 } });
      const e = await start(w);
      const { propose } = scripted((r) => (r.candidate === "A" ? toggle("bad", true, { predicted }) : toggle(`noop${r.round}${r.candidate}`)));
      const report = await e.round(ports(w.evaluate, propose));
      return { w, a: byCandidate(report.records)["A"]! };
    };
    const probe = await draw([]);
    const inside = ids(probe.w, 2)[0]!;
    const outside = probe.w.split.evolve.map((t) => t.id).find((id) => !ids(probe.w, 2).includes(id))!;
    const { a } = await draw([inside, outside]);
    expect(a.outcome).toBe("rejected");
    expect(a.measured!.hits).toEqual([]);
    expect(a.measured!.misses).toEqual([inside]);
  });

  it("RS14.47 a prefix evaluation that lost too many trials is screened as invalid (as an unstaged one would be), with no second stage", async () => {
    const w = world({ n: 40, base: () => 1 });
    const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => (ruleNames(documents).includes("dead") ? [] : w.evaluate(documents, tasks, k));
    const e = await start(w);
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("dead") : toggle(`noop${r.round}${r.candidate}`)));
    const report = await e.round(ports(evaluate, propose));
    expect(byCandidate(report.records)["A"]).toMatchObject({ outcome: "screened", reason: "evaluation invalid: 40 of 40 trials missing" });
    expect(byCandidate(report.records)["A"]!.measured).toBeUndefined();
    expect(sizes(w)).toEqual([40, 40, 20, 20]); // A's prefix never reached the world (stub), B's stages: prefix, then rest
  });

  it("RS14.48 a second stage that lost too many trials makes the whole measurement invalid, counted against all the evolve tasks", async () => {
    const w = world({ n: 40, base: () => 1 });
    const seen = { late: 0 };
    const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => {
      if (ruleNames(documents).includes("late") && ++seen.late === 2) return [];
      return w.evaluate(documents, tasks, k);
    };
    const e = await start(w);
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("late") : toggle(`noop${r.round}${r.candidate}`)));
    const report = await e.round(ports(evaluate, propose));
    expect(byCandidate(report.records)["A"]).toMatchObject({ outcome: "screened", reason: "evaluation invalid: 40 of 80 trials missing" });
  });

  it("RS14.49 missing trials in either stage count as failures in the merged measurement, over the full denominator, and tokens are pooled", async () => {
    const w = world({ n: 40, base: () => 1 });
    const seen = { partial: 0 };
    const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => {
      const runs = await w.evaluate(documents, tasks, k);
      if (!ruleNames(documents).includes("partial")) return runs;
      // First stage whole; second stage: the last trial of four tasks is lost (4 of 80 in all: valid).
      return ++seen.partial === 2 ? runs.map((run, i): TaskRun => (i < 4 ? { ...run, trials: run.trials.slice(0, -1) } : run)) : runs;
    };
    const e = await start(w);
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("partial") : toggle(`noop${r.round}${r.candidate}`)));
    const report = await e.round(ports(evaluate, propose));
    const a = byCandidate(report.records)["A"]!;
    expect(a.outcome).toBe("rejected");
    expect(a.measured!.score).toBeCloseTo(76 / 80, 12);
    expect(a.measured!.gain).toBeCloseTo(-4 / 80, 12);
    expect(a.measured!.cost).toBe(1000);
    expect(a.measured!.alpha).toBe(LEVEL);
    expect(a.reason).not.toMatch(/futility/);
  });

  it("RS14.50 a missing trial in the prefix counts as a failure there too, over the prefix's full denominator, and can make the prefix futile", async () => {
    const w = world({ n: 40, base: () => 1 });
    const seen = { flaky: 0 };
    const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => {
      const runs = await w.evaluate(documents, tasks, k);
      // The first stage loses every trial of its first 8 tasks: 16 of 40 trials (valid under this run's `invalid` of 0.5).
      return ruleNames(documents).includes("flaky") && ++seen.flaky === 1 ? runs.map((run, i): TaskRun => (i < 8 ? { ...run, trials: [] } : run)) : runs;
    };
    const e = await start(w, withFutility(FUTILITY, { invalid: 0.5 }));
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("flaky") : toggle(`noop${r.round}${r.candidate}`)));
    const report = await e.round(ports(evaluate, propose));
    const a = byCandidate(report.records)["A"]!;
    expect(a.outcome).toBe("rejected");
    expect(a.reason).toMatch(/abandoned for futility/);
    expect(a.measured!.score).toBeCloseTo(12 / 20, 12);
    expect(a.measured!.gain).toBeCloseTo(-8 / 20, 12);
    expect(sizes(w)).toEqual([40, 40, 20, 20, 20]); // no second stage for A
  });

  it("RS14.51 an invalid incumbent measurement stops the round before any second stage is paid for, and leaves the run where it was", async () => {
    const w = world({ n: 40, base: () => 1 });
    let armed = false;
    const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => (armed && ruleNames(documents).length === 0 ? [] : w.evaluate(documents, tasks, k));
    const e = await start(w);
    armed = true;
    const { propose } = badAndNoop("noop");
    await expect(e.round(ports(evaluate, propose))).rejects.toThrow(/the incumbent's evaluation is invalid: 80 of 80 trials missing; run the round again/);
    expect(sizes(w)).toEqual([40, 20, 20]); // only the prefixes of the two candidates
    expect(e.completed).toBe(0);
  });

  it("RS14.52 without a futility setting nothing is staged, and the round is the one it always was", async () => {
    const w = world({ n: 40, base: () => 1, effects: { bad: () => -1 } });
    const e = await start(w, withFutility(null));
    const report = await e.round(ports(w.evaluate, badAndNoop("bad").propose));
    expect(sizes(w)).toEqual([40, 40, 40, 40]);
    expect(byCandidate(report.records)["A"]!.reason).not.toMatch(/futility/);
    expect(byCandidate(report.records)["A"]!.measured).toMatchObject({ alpha: LEVEL, gain: -1 });
  });

  it("RS14.53 the paper's rule ignores futility: nothing is staged under it", async () => {
    const PAPER = { rule: "paper", delta: 0.01, beta0: 0.1, beta1: 35, ws: 1414, wc: 15, wn: 0.5, prune: 4 };
    const w = world({ n: 40, base: () => 1, effects: { bad: () => -1 } });
    const e = await start(w, settings({ select: PAPER }));
    await e.round(ports(w.evaluate, badAndNoop("bad").propose));
    expect(sizes(w)).toEqual([40, 40, 40]); // start, then two candidates (the paper's rule does not re-measure the incumbent)
  });

  it("RS14.54 a run resumed from its saved state stages the same way", async () => {
    const w = world({ n: 40, base: () => 1, effects: { bad: () => -1 } });
    const s = withFutility(FUTILITY, { rounds: 2 });
    const e = await start(w, s);
    const { propose } = badAndNoop("bad");
    await e.round(ports(w.evaluate, propose));
    const restored = new Evolution({ surface: w.surface, settings: s, split: w.split, saved: JSON.parse(JSON.stringify(e.save())) });
    const before = w.calls.length;
    const report = await restored.round(ports(w.evaluate, propose, 3));
    expect(w.calls.slice(before).map((c) => c.tasks.length)).toEqual([40, 20, 20, 20]);
    expect(byCandidate(report.records)["A"]!.reason).toMatch(/abandoned for futility/);
  });
});

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
  }, 60_000);

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
  }, 60_000);

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
  }, 120_000);
});
