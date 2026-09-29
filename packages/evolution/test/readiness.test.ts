import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineSurface, Evolution, evolveGroups, minimumGroups, score } from "@harness/evolution";
import type { Task } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { settings, world } from "./world.ts";

const tasks = (n: number, group?: (i: number) => string): Task[] => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, text: `task ${i}`, ...(group ? { group: group(i) } : {}) }));

describe("what an evolve set needs before a run can accept anything", () => {
  it("RS16.1 a run of G groups can certify nothing below level 2^-G: the fewest groups is the least G with 2^-G below the level", () => {
    expect(minimumGroups(0.5)).toBe(2);
    expect(minimumGroups(0.1)).toBe(4);
    expect(minimumGroups(0.125)).toBe(4);
    expect(minimumGroups(0.126)).toBe(3);
    expect(minimumGroups(0.1 / 18)).toBe(8);
    expect(() => minimumGroups(0)).toThrow(/level/);
    expect(() => minimumGroups(1)).toThrow(/level/);
  });

  it("RS16.2 tasks are counted by group, a task with no group being its own", () => {
    expect(evolveGroups(tasks(5))).toBe(5);
    expect(evolveGroups(tasks(12, (i) => `g${i % 3}`))).toBe(3);
    expect(evolveGroups([...tasks(2), ...tasks(4, () => "shared").map((t) => ({ ...t, id: `s${t.id}` }))])).toBe(3);
    expect(evolveGroups([])).toBe(0);
  });

  it("RS16.3 a run whose evolve set has too few groups for its smallest test level is refused before anything is evaluated", async () => {
    const w = world({ n: 6, base: () => 0.5 });
    const calls: unknown[] = [];
    const evaluate: typeof w.evaluate = async (...a) => (calls.push(a), w.evaluate(...a));
    // alpha 0.1 over 6 rounds and (2 + 1) tests a round: level 0.0055 needs 8 groups.
    const start = (split: typeof w.split, s = settings()) => Evolution.start({ surface: w.surface, settings: s, split, documents: w.documents, ports: { evaluate, entropy: new SeededEntropy(1) } });
    await expect(start(w.split)).rejects.toThrow("the evolve set has 6 groups, and a run whose smallest test is at level 0.0056 needs at least 8 for any change to be certifiable: use more tasks, more groups, fewer rounds or candidates, or a larger alpha");
    expect(calls).toHaveLength(0);
    const clustered = world({ n: 40, base: () => 0.5, groups: 4 });
    await expect(start(clustered.split)).rejects.toThrow(/the evolve set has 4 groups/);
    // Exactly enough groups is enough.
    const enough = world({ n: 8, base: () => 0.5 });
    await expect(start(enough.split)).resolves.toBeInstanceOf(Evolution);
  });

  it("RS16.4 the smallest level of a geometric schedule is its last round's, and the paper's rule (which certifies nothing) is not held to it", async () => {
    const w = world({ n: 10, base: () => 0.5 });
    const geometric = settings({ select: { rule: "calibrated", alpha: 0.1, resamples: 4000, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35, spending: { kind: "geometric", ratio: 0.5 } } });
    const start = (s: ReturnType<typeof settings>, split = w.split) => Evolution.start({ surface: w.surface, settings: s, split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } });
    await expect(start(geometric)).rejects.toThrow(/the evolve set has 10 groups/);
    const paper = settings({ select: { rule: "paper", delta: 0.01, beta0: 0.1, beta1: 35, ws: 1, wc: 1, wn: 0.5, prune: 4 } });
    const few = world({ n: 3, base: () => 0.5 });
    await expect(start(paper, few.split)).resolves.toBeInstanceOf(Evolution);
  });

  it("RS16.5 a restored run is held to it too", async () => {
    const w = world({ n: 8, base: () => 0.5 });
    const e = await Evolution.start({ surface: w.surface, settings: settings(), split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } });
    const fewer = world({ n: 6, base: () => 0.5 });
    expect(() => new Evolution({ surface: w.surface, settings: settings(), split: fewer.split, saved: e.save() })).toThrow(/the evolve set has 6 groups/);
    expect(new Evolution({ surface: w.surface, settings: settings(), split: w.split, saved: e.save() }).completed).toBe(0);
  });

  it("RS16.6 the base harness's text documents are run through their check before anything is evaluated", async () => {
    const surface = defineSurface({ documents: { code: { kind: "text", schema: z.string().min(1), check: (t) => (t.includes("syntax error") ? "line 1: unexpected token" : undefined) } }, components: ["prompt"] });
    const w = world({ n: 8, base: () => 0.5 });
    const calls: unknown[] = [];
    const evaluate: typeof w.evaluate = async (_, ts, k) => (calls.push(ts.length), ts.map((t) => ({ task: t.id, trials: Array.from({ length: k }, () => ({ reward: score(0.5) })) })));
    const start = (text: string) => Evolution.start({ surface, settings: settings(), split: w.split, documents: { code: text }, ports: { evaluate, entropy: new SeededEntropy(1) } });
    await expect(start("a syntax error")).rejects.toThrow("the base harness's code fails its check: line 1: unexpected token");
    expect(calls).toHaveLength(0);
    await expect(start("fine")).resolves.toBeInstanceOf(Evolution);
    expect(calls).toEqual([8]);
  });
});
