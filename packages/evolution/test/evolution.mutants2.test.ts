import { describe, expect, it } from "vitest";
import { Evolution, score } from "@harness/evolution";
import type { EvolutionPorts, LedgerRecord, State } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { scripted, settings, toggle, world } from "./world.ts";

type World = ReturnType<typeof world>;

const start = (w: World, s = settings(), evaluate: EvolutionPorts["evaluate"] = w.evaluate, seed = 1) => Evolution.start({ surface: w.surface, settings: s, split: w.split, documents: w.documents, ports: { evaluate, entropy: new SeededEntropy(seed) } });
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
