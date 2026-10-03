import { describe, expect, it } from "vitest";
import { Evolution, score } from "@harness/evolution";
import type { EvolutionPorts, LedgerRecord, State, Task } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { scripted, settings, toggle, world } from "./world.ts";

type World = ReturnType<typeof world>;

const start = (w: World, s = settings(), evaluate: EvolutionPorts["evaluate"] = w.evaluate, seed = 1, split = w.split) => Evolution.start({ surface: w.surface, settings: s, split, documents: w.documents, ports: { evaluate, entropy: new SeededEntropy(seed) } });
const ports = (w: World, propose: EvolutionPorts["propose"], extra: Partial<EvolutionPorts> = {}): EvolutionPorts => ({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(2), ...extra });
const byCandidate = (records: readonly LedgerRecord[]) => Object.fromEntries(records.map((r) => [r.candidate, r]));
const clone = (e: Evolution) => JSON.parse(JSON.stringify(e.save())) as Record<string, unknown> & State;
const restore = (w: World, s: ReturnType<typeof settings>, saved: unknown) => new Evolution({ surface: w.surface, settings: s, split: w.split, saved });
const addRule = (id: string, rule: string, hypothesis = `${rule} helps`) => ({ id, hypothesis, targets: "failures", ops: [{ op: "add", document: "policy", path: `/rules/${rule}`, value: true }] });
const noop = (r: { round: number; candidate: string }) => toggle(`noop${r.round}${r.candidate}`);
const PAPER = { rule: "paper", delta: 0.01, beta0: 0.1, beta1: 35, ws: 1414, wc: 15, wn: 0.5, prune: 4 };

describe("predictions are judged against the incumbent task by task", () => {
  const predicting = async (predicted: string[]) => {
    const w = world({ n: 40, base: (i) => (i === 30 ? 1 : 0), effects: { verify: (i) => (i < 20 ? 1 : 0) } });
    const e = await start(w);
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("verify", true, { predicted }) : noop(r)));
    return byCandidate((await e.round(ports(w, propose))).records)["A"]!.measured!;
  };

  it("RS20.19 a predicted task that is not one of the evolve tasks is a miss, not a hit and not left out", async () => {
    const m = await predicting(["e000", "e999"]);
    expect(m.hits).toEqual(["e000"]);
    expect(m.misses).toEqual(["e999"]);
  });

  it("RS20.20 a predicted task is compared with itself in the incumbent's measurement: one that already passes did not improve", async () => {
    const m = await predicting(["e000", "e030"]);
    expect(m.hits).toEqual(["e000"]);
    expect(m.misses).toEqual(["e030"]);
  });

  it("RS20.21 a predicted task that did not improve is a miss even when another task improved", async () => {
    const m = await predicting(["e025", "e030"]);
    expect(m.hits).toEqual([]);
    expect(m.misses).toEqual(["e025", "e030"]);
  });
});

describe("what the ledger and the state keep when nothing reported tokens", () => {
  const silent = (w: World): EvolutionPorts["evaluate"] => async (documents, tasks, k) => (await w.evaluate(documents, tasks, k)).map((run) => ({ ...run, trials: run.trials.map(({ reward }) => ({ reward })) }));
  const propose = scripted((r) => (r.candidate === "A" ? toggle("verify") : noop(r))).propose;
  const make = () => world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0) } });

  it("RS20.22 a measured record has no cost, no cost change and no bounds on one, and the state holds together", async () => {
    const w = make();
    const e = await start(w, settings(), silent(w));
    const report = await e.round(ports(w, propose, { evaluate: silent(w) }));
    for (const r of report.records) expect(Object.keys(r.measured!).sort()).toEqual(["alpha", "gain", "hits", "lower", "misses", "score", "upper", "verdict"]);
    expect(() => restore(w, settings(), e.save())).not.toThrow();
  });

  it("RS20.23 a measured record of an evaluation that reported tokens has the cost, its change and both bounds", async () => {
    const w = make();
    const e = await start(w);
    const report = await e.round(ports(w, propose));
    for (const r of report.records) expect(Object.keys(r.measured!).sort()).toEqual(["alpha", "cost", "costChange", "costLower", "costUpper", "gain", "hits", "lower", "misses", "score", "upper", "verdict"]);
  });
});

describe("what the proposer is shown of the incumbent", () => {
  /** Tasks e000..e007, each with the given mean over two trials (0, 0.5 or 1). */
  const rewards = (mean: number) => (mean === 0 ? [0, 0] : mean === 0.5 ? [1, 0] : [1, 1]);
  const means = (m: number[]): EvolutionPorts["evaluate"] => async (_, tasks, k) => tasks.map((t) => ({ task: t.id, trials: rewards(m[Number(t.id.slice(1))]!).slice(0, k).map((reward) => ({ reward: score(reward) })) }));
  const shown = async (m: number[], overrides: Record<string, unknown> = {}) => {
    const w = world({ n: 8, base: () => 0.5 });
    const evaluate = means(m);
    const e = await start(w, settings(overrides), evaluate);
    const { propose, requests } = scripted(noop);
    await e.round(ports(w, propose, { evaluate }));
    return { w, analysis: requests[0]!.analysis };
  };
  const ids = (views: readonly { task: string }[]) => views.map((v) => v.task);

  it("RS20.24 a task that always passes is not among the failures", async () => {
    const { analysis } = await shown([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(analysis.failures).toEqual([]);
    expect(ids(analysis.successes)).toEqual(["e007", "e006"]);
  });

  it("RS20.25 a task that never passes is not among the successes, and a failure carries no feedback when the verifier said nothing", async () => {
    const { w, analysis } = await shown([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(analysis.successes).toEqual([]);
    expect(ids(analysis.failures)).toEqual(["e000", "e001", "e002"]);
    expect(analysis.failures[0]).toStrictEqual({ task: "e000", text: w.split.evolve[0]!.text, score: 0 });
  });

  it("RS20.26 a task among the failures is not also among the successes, and one that sometimes passes counts as both candidates", async () => {
    const { analysis } = await shown([0, 0, 0.5, 0.5, 0.5, 0.5, 1, 1], { analysis: { failures: 5, successes: 5, history: 20 } });
    expect(ids(analysis.failures)).toEqual(["e000", "e001", "e002", "e003", "e004"]);
    expect(ids(analysis.successes)).toEqual(["e007", "e006", "e005"]);
  });
});

describe("the removal of a mechanism is chosen among those that are due", () => {
  const rules = ["verify", "f1", "f2", "f3"];
  /** A run that accepted four mechanisms in round 0 (all with the same lower bound), saved. */
  const accepted = async (overrides: Record<string, unknown> = {}) => {
    const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0), f1: () => 0, f2: () => 0, f3: () => 0 } });
    const s = settings({ budget: { min: 1, max: 4 }, explore: { window: 2, reserved: 0 }, ...overrides });
    const e = await start(w, s);
    const bundle = { summary: "four", edits: rules.map((r, i) => addRule(`e${i + 1}`, r)) };
    const { propose } = scripted((r) => (r.round === 0 && r.candidate === "A" ? bundle : noop(r)));
    expect((await e.round(ports(w, propose))).accepted).toBe("A");
    expect(e.mechanisms.map((m) => m.id)).toEqual(["r0A.e1", "r0A.e2", "r0A.e3", "r0A.e4"]);
    return { w, s, saved: clone(e), propose };
  };
  type Fields = { round?: number; lower?: number; ablated?: number; entangled?: boolean };
  /** Round 4 of the run, its mechanisms (in the order given, by id) with those fields; the removal drafted, if any. */
  const drafted = async (fields: Record<string, Fields>, order = ["r0A.e1", "r0A.e2", "r0A.e3", "r0A.e4"], overrides: Record<string, unknown> = {}) => {
    const { w, s, saved, propose } = await accepted(overrides);
    saved.round = 4;
    const mechanisms = saved.mechanisms;
    saved.mechanisms = order.map((id) => ({ ...mechanisms.find((m) => m.id === id)!, ...(fields[id] ?? {}) }));
    const e = restore(w, s, saved);
    const report = await e.round(ports(w, propose));
    return { report, prune: byCandidate(report.records)["P"], e };
  };

  it("RS20.27 the one with the weakest evidence is removed first, whatever its place in the state", async () => {
    const { prune } = await drafted({ "r0A.e1": { lower: 0.3 }, "r0A.e2": { lower: 0.1 }, "r0A.e3": { lower: 0.2 }, "r0A.e4": { lower: 0.4 } });
    expect(prune!.edits.map((e) => e.id)).toEqual(["r0A.e2"]);
  });

  it("RS20.28 of equal evidence, the one accepted earliest is removed first", async () => {
    const { prune } = await drafted({ "r0A.e1": { round: 2, lower: 0.1 }, "r0A.e2": { round: 1, lower: 0.1 }, "r0A.e3": { round: 0, lower: 0.5 }, "r0A.e4": { round: 0, lower: 0.5 } });
    expect(prune!.edits.map((e) => e.id)).toEqual(["r0A.e2"]);
  });

  it("RS20.29 of equal evidence and age, the one with the smallest id is removed first", async () => {
    const { prune } = await drafted({ "r0A.e1": { round: 1, lower: 0.1 }, "r0A.e2": { round: 1, lower: 0.1 }, "r0A.e3": { lower: 0.5 }, "r0A.e4": { lower: 0.5 } }, ["r0A.e2", "r0A.e1", "r0A.e3", "r0A.e4"]);
    expect(prune!.edits.map((e) => e.id)).toEqual(["r0A.e1"]);
  });

  it("RS20.30 a mechanism accepted fewer than `after` rounds ago is not due: with none due nothing is drafted", async () => {
    const young = { round: 3 };
    const { prune, e } = await drafted({ "r0A.e1": young, "r0A.e2": young, "r0A.e3": young, "r0A.e4": young }, undefined, { prune: { after: 2, every: 10 } });
    expect(prune).toBeUndefined();
    expect(e.mechanisms.map((m) => m.id)).toEqual(["r0A.e1", "r0A.e2", "r0A.e3", "r0A.e4"]);
    expect(e.mechanisms.every((m) => m.ablated === undefined)).toBe(true);
  });

  it("RS20.31 a mechanism that is entangled is passed over, however weak its evidence", async () => {
    const { prune } = await drafted({ "r0A.e1": { lower: 0.05, entangled: true }, "r0A.e2": { lower: 0.2 }, "r0A.e3": { lower: 0.3 }, "r0A.e4": { lower: 0.4 } });
    expect(prune!.edits.map((e) => e.id)).toEqual(["r0A.e2"]);
  });

  it("RS20.32 a mechanism ablated fewer than `every` rounds ago is passed over", async () => {
    const { prune } = await drafted({ "r0A.e1": { lower: 0.05, ablated: 3 }, "r0A.e2": { lower: 0.2 }, "r0A.e3": { lower: 0.3 }, "r0A.e4": { lower: 0.4 } }, undefined, { prune: { after: 1, every: 3 } });
    expect(prune!.edits.map((e) => e.id)).toEqual(["r0A.e2"]);
  });

  it("RS20.33 the removal is recorded as the mechanism's own edit, with what it was for and nothing predicted", async () => {
    const { prune } = await drafted({ "r0A.e2": { lower: 0.01 } });
    expect(prune).toMatchObject({ kind: "prune", candidate: "P" });
    expect(prune!.edits).toStrictEqual([{ id: "r0A.e2", hypothesis: "prune: f1 helps", targets: "a mechanism that may no longer earn its place", components: ["config"], footprint: 0, predicted: [] }]);
  });

  it("RS24.1 a removal that is refused marks its mechanism as ablated in that round, and no other", async () => {
    // Removing `verify` (e1), which earns its place, is refused; the weakest evidence (lower) makes it the one drafted.
    const { report, prune, e } = await drafted({ "r0A.e1": { lower: 0.01 } });
    expect(prune!.edits.map((x) => x.id)).toEqual(["r0A.e1"]);
    expect(prune!.outcome).toBe("rejected");
    expect(report.accepted).toBeUndefined();
    expect(e.mechanisms.map((m) => [m.id, m.ablated])).toEqual([
      ["r0A.e1", 4],
      ["r0A.e2", undefined],
      ["r0A.e3", undefined],
      ["r0A.e4", undefined],
    ]);
  });

  it("RS24.2 a round that drafts no removal marks no mechanism as ablated", async () => {
    const { prune, e } = await drafted({}, undefined, { prune: { after: 10, every: 10 } });
    expect(prune).toBeUndefined();
    expect(e.mechanisms).toHaveLength(4);
    for (const m of e.mechanisms) expect(m).not.toHaveProperty("ablated");
  });
});

describe("a winner the holdout confirms or refuses", () => {
  it("RS20.34 the removal of a mechanism that proved harmful on the evolve set is confirmed by the holdout when it is no worse there", async () => {
    // Round 0: `bad` helps everywhere. From round 1 it hurts the evolve tasks and does nothing on the holdout.
    let phase = 0;
    const w = world({
      n: 40,
      holdout: 20,
      base: () => (phase === 0 ? 0 : 1),
      effects: { bad: (i, h) => (phase === 0 ? ((h ? i < 10 : i < 20) ? 1 : 0) : h ? 0 : i < 20 ? -1 : 0) },
    });
    const e = await start(w);
    const { propose } = scripted((r) => (r.candidate === "A" && r.round === 0 ? toggle("bad") : noop(r)));
    expect((await e.round(ports(w, propose))).accepted).toBe("A");
    phase = 1;
    const report = await e.round(ports(w, propose));
    const p = byCandidate(report.records)["P"]!;
    expect(p.measured!.lower).toBeGreaterThan(0);
    expect(p.measured!.holdout).toMatchObject({ gain: 0, confirmed: true, exhausted: false, remaining: 0 });
    expect(p.outcome).toBe("accepted");
    expect(p.reason).not.toMatch(/holdout/);
    expect(report.accepted).toBe("P");
    expect(e.mechanisms).toEqual([]);
  });
});

describe("the state across rounds", () => {
  it("RS20.35 a round that accepts nothing keeps the incumbent's fresh measurement as the one the proposer reads next", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    const e = await start(w);
    const { propose } = scripted(noop);
    expect((await e.round(ports(w, propose))).accepted).toBeUndefined();
    const saved = e.save() as State;
    expect(saved.incumbent).toHaveLength(2);
    expect(saved.observed).toEqual(saved.incumbent[1]);
    expect(saved.observed).not.toEqual(saved.base);
  });

  it("RS20.36 under the paper's rule a round that accepts nothing keeps the measurement the incumbent was chosen on", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await start(w, settings({ select: PAPER }));
    const { propose } = scripted(noop);
    expect((await e.round(ports(w, propose))).accepted).toBeUndefined();
    const saved = e.save() as State;
    expect(saved.observed).toEqual(saved.base);
  });

  it("RS20.37 a run without a holdout keeps no holdout state through a round", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    const e = await start(w);
    await e.round(ports(w, scripted(noop).propose));
    expect(e.save()).not.toHaveProperty("holdout");
  });

  it("RS20.38 a state saved before the split had a holdout starts counting its queries when it is restored with one", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0.5 });
    const e = await start(w);
    const saved = clone(e);
    delete saved.holdout;
    const restored = restore(w, settings(), saved);
    await restored.round(ports(w, scripted(noop).propose));
    expect((restored.save() as State).holdout).toStrictEqual({ queries: 0 });
  });
});

describe("the paper's rule", () => {
  it("RS20.39 chooses among the admissible candidates by score, not by the lower bound", async () => {
    // `wide` gains a quarter in every group, `narrow` gains all of three groups: the better score has the weaker bound.
    const w = world({ n: 40, base: () => 0, groups: 10, effects: { wide: (i) => (i < 10 ? 1 : 0), narrow: (i) => (i % 10 < 3 ? 1 : 0) } });
    const e = await start(w, settings({ select: PAPER }));
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("wide") : toggle("narrow")));
    const report = await e.round(ports(w, propose));
    const r = byCandidate(report.records);
    expect(r["A"]!.outcome).toBe("admissible");
    expect(r["B"]!.measured!.score).toBeGreaterThan(r["A"]!.measured!.score);
    expect(r["B"]!.measured!.lower).toBeLessThan(r["A"]!.measured!.lower);
    expect(report.accepted).toBe("B");
  });

  describe("the prune set B_t the proposer is shown", () => {
    const shown = async () => {
      const w = world({ n: 40, base: () => 0, components: { skillrule: "skill" } });
      const e = await start(w, settings({ select: PAPER }));
      const { propose, requests } = scripted((r) => (r.candidate === "A" ? toggle("skillrule") : noop(r)));
      await e.round(ports(w, propose));
      await e.round(ports(w, propose));
      return requests.at(-1)!.prune;
    };

    it("RS20.40 holds its components in alphabetical order, not in the order they were tried", async () => {
      expect((await shown())!.map((p) => p.component)).toEqual(["config", "skill"]);
    });

    it("RS20.41 names, with each component, the ids of the accepted mechanisms that touch it", async () => {
      expect(await shown()).toEqual([
        { component: "config", mechanisms: [] },
        { component: "skill", mechanisms: ["r0A.e1"] },
      ]);
    });
  });

  describe("novelty: a structural component no accepted edit has touched", () => {
    const make = () => world({ n: 40, base: () => 0, components: { skillrule1: "skill", skillrule2: "skill" }, effects: { verify: (i) => (i < 20 ? 1 : 0), skillrule1: () => 0 } });

    it("RS20.42 is not used up by a candidate that was only admissible, or by one that was refused", async () => {
      const w = make();
      const e = await start(w, settings({ select: PAPER }));
      const first = scripted((r) => (r.candidate === "A" ? toggle("verify") : toggle("skillrule1")));
      const report = await e.round(ports(w, first.propose));
      expect(byCandidate(report.records)["B"]).toMatchObject({ outcome: "admissible", reason: expect.stringMatching(/nu = 1/) });
      const second = await e.round(ports(w, scripted((r) => (r.candidate === "A" ? toggle("skillrule2") : noop(r))).propose));
      expect(byCandidate(second.records)["A"]).toMatchObject({ outcome: "accepted", reason: expect.stringMatching(/nu = 1/) });
    });

    it("RS20.43 is used up by an accepted change of the component: a later candidate on it is no longer new", async () => {
      const w = world({ n: 40, base: () => 0, components: { skillrule1: "skill", skillrule2: "skill" }, effects: { skillrule1: (i) => (i < 20 ? 1 : 0) } });
      const e = await start(w, settings({ select: PAPER }));
      const answer = scripted((r) => (r.round === 0 ? (r.candidate === "A" ? toggle("skillrule1") : noop(r)) : r.candidate === "A" ? noop(r) : toggle("skillrule2")));
      expect((await e.round(ports(w, answer.propose))).accepted).toBe("A");
      const second = await e.round(ports(w, answer.propose));
      expect(byCandidate(second.records)["B"]).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/shaped 0\.0000 \(nu = 0\)/) });
    });

    it("RS20.44 is not used up by an accepted removal of a mechanism of the component", async () => {
      const w = make();
      const e = await start(w, settings({ select: PAPER }));
      const saved = clone(e);
      const removal = { round: 0, candidate: "P", kind: "prune", edits: [{ id: "x", hypothesis: "h", targets: "t", components: ["skill"], footprint: 0, predicted: [] }], outcome: "accepted", reason: "removed" };
      saved.records = [removal as never];
      const second = restore(w, settings({ select: PAPER }), saved);
      const report = await second.round(ports(w, scripted((r) => (r.candidate === "A" ? toggle("skillrule1") : noop(r))).propose));
      expect(byCandidate(report.records)["A"]).toMatchObject({ outcome: "accepted", reason: expect.stringMatching(/nu = 1/) });
    });
  });
});

describe("what selection and the ledger are given of cost", () => {
  const verify = { verify: (i: number) => (i < 20 ? 1 : 0) };
  const proposeVerify = scripted((r) => (r.candidate === "A" ? toggle("verify") : noop(r))).propose;

  it("RS24.3 a candidate's cost reaches selection: a gain that costs a hundred times the base harness's tokens is refused for it", async () => {
    const w = world({ n: 40, base: () => 0, effects: verify, cost: { verify: 99000 } });
    const e = await start(w);
    const a = byCandidate((await e.round(ports(w, proposeVerify))).records)["A"]!;
    expect(a.measured!.gain).toBeGreaterThan(0);
    expect(a.outcome).toBe("rejected");
    expect(a.reason).toMatch(/tokens over the base harness, more than the/);
  });

  it("RS24.4 the base harness's cost is the anchor of that cap: the same candidate is not refused for it when the base harness reported no tokens", async () => {
    const w = world({ n: 40, base: () => 0, effects: verify, cost: { verify: 99000 } });
    let calls = 0;
    // The base harness (measured by start, before any round) reports no tokens; later evaluations do.
    const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => {
      const runs = await w.evaluate(documents, tasks, k);
      return calls++ === 0 ? runs.map((run) => ({ ...run, trials: run.trials.map(({ reward }) => ({ reward })) })) : runs;
    };
    const e = await start(w, settings(), evaluate);
    const a = byCandidate((await e.round(ports(w, proposeVerify, { evaluate }))).records)["A"]!;
    expect(a.reason).not.toMatch(/tokens over the base harness/);
  });

  it("RS24.5 a cost change whose upper bound is unbounded is recorded without that bound (JSON has no infinity), the change and its lower bound kept", async () => {
    const w = world({ n: 40, base: () => 0, effects: verify });
    // Tokens are reported on the even tasks by the incumbent and on the odd ones by a candidate: no task reports on both sides.
    const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => {
      const candidate = Object.keys((documents["policy"] as { rules: Record<string, boolean> }).rules).length > 0;
      return (await w.evaluate(documents, tasks, k)).map((run) => (Number(run.task.slice(1)) % 2 === (candidate ? 1 : 0) ? run : { ...run, trials: run.trials.map(({ reward }) => ({ reward })) }));
    };
    const e = await start(w, settings(), evaluate);
    const report = await e.round(ports(w, proposeVerify, { evaluate }));
    const m = byCandidate(report.records)["A"]!.measured!;
    expect(m.costLower).toBe(-1);
    expect(m).toHaveProperty("costChange");
    expect(m).not.toHaveProperty("costUpper");
    expect(() => restore(w, settings(), JSON.parse(JSON.stringify(e.save())))).not.toThrow();
  });
});

describe("the task set is checked as a whole", () => {
  const w = world({ n: 40, holdout: 20, base: () => 0 });
  const bad = (patch: (tasks: readonly Task[]) => readonly Task[], where: "evolve" | "holdout") => ({ ...w.split, [where]: patch(w.split[where]!) });

  it("RS24.6 a task of the holdout that is also an evolve task is a task listed twice", async () => {
    const split = { ...w.split, holdout: [w.split.evolve[3]!, ...w.split.holdout!.slice(1)] };
    await expect(start(w, settings(), w.evaluate, 1, split)).rejects.toThrow("task e003 is in the task set twice");
  });

  it("RS24.7 the weight of an evolve task must be positive and finite", async () => {
    const split = bad((tasks) => tasks.map((t, i) => (i === 2 ? { ...t, weight: 0 } : t)), "evolve");
    await expect(start(w, settings(), w.evaluate, 1, split)).rejects.toThrow("the weight of task e002 must be positive and finite, not 0");
  });

  it("RS24.8 the weight of a holdout task must be positive and finite too", async () => {
    const split = bad((tasks) => tasks.map((t, i) => (i === 1 ? { ...t, weight: Number.POSITIVE_INFINITY } : t)), "holdout");
    await expect(start(w, settings(), w.evaluate, 1, split)).rejects.toThrow("the weight of task h001 must be positive and finite, not Infinity");
  });
});

describe("futility staging", () => {
  const select = (futility?: object) => ({ rule: "calibrated", alpha: 0.1, resamples: 400, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35, ...(futility ? { futility } : {}) });
  const harmful = scripted((r) => (r.candidate === "A" ? toggle("harm") : noop(r))).propose;
  const make = () => world({ n: 40, base: () => 1, effects: { harm: () => -1 } });

  it("RS24.9 a run with a futility setting stages nothing when its prefix is all the evolve tasks: every candidate is evaluated in one call, on the tasks in their order", async () => {
    const w = make();
    const e = await start(w, settings({ select: select({ fraction: 0.99, alpha: 0.1 }) }));
    w.calls.length = 0;
    const a = byCandidate((await e.round(ports(w, harmful))).records)["A"]!;
    expect(a.reason).not.toMatch(/abandoned for futility/);
    expect(w.calls).toHaveLength(3);
    for (const call of w.calls) expect(call.tasks).toEqual(w.split.evolve);
  });

  it("RS24.10 a run without a futility setting never stages", async () => {
    const w = make();
    const e = await start(w, settings({ select: select() }));
    w.calls.length = 0;
    const a = byCandidate((await e.round(ports(w, harmful))).records)["A"]!;
    expect(a.reason).not.toMatch(/abandoned for futility/);
    expect(w.calls).toHaveLength(3);
    for (const call of w.calls) expect(call.tasks).toEqual(w.split.evolve);
  });

  it("RS24.11 a run with a futility setting that does stage abandons a clearly harmful candidate on the prefix", async () => {
    const w = make();
    const e = await start(w, settings({ select: select({ fraction: 0.5, alpha: 0.1 }) }));
    const a = byCandidate((await e.round(ports(w, harmful))).records)["A"]!;
    expect(a.reason).toMatch(/^abandoned for futility after 20 of 40 evolve tasks/);
    expect(a.reason).toMatch(/is below -0\.0200,/);
  });
});
