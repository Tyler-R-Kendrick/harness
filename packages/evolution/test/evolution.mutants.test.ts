import { describe, expect, it } from "vitest";
import { defineSurface, Evolution } from "@harness/evolution";
import type { Documents, EvolutionPorts, LedgerRecord, Split, TaskRun } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { DocsSchema, scripted, settings, toggle, world } from "./world.ts";

type World = ReturnType<typeof world>;

const start = (w: World, s = settings(), evaluate: EvolutionPorts["evaluate"] = w.evaluate, split: Split = w.split, seed = 1) => Evolution.start({ surface: w.surface, settings: s, split, documents: w.documents, ports: { evaluate, entropy: new SeededEntropy(seed) } });
const ports = (w: World, propose: EvolutionPorts["propose"], extra: Partial<EvolutionPorts> = {}): EvolutionPorts => ({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(2), ...extra });
const byCandidate = (records: readonly LedgerRecord[]) => Object.fromEntries(records.map((r) => [r.candidate, r]));
const ruleNames = (documents: Documents) => Object.keys((documents["policy"] as { rules: Record<string, boolean> }).rules);
const addRule = (id: string, rule: string) => ({ id, hypothesis: `${rule} helps`, targets: "failures", ops: [{ op: "add", document: "policy", path: `/rules/${rule}`, value: true }] });
const PAPER = { rule: "paper", delta: 0.01, beta0: 0.1, beta1: 35, ws: 1414, wc: 15, wn: 0.5, prune: 4 };

describe("documents the surface checks", () => {
  it("RS20.1 a check is the host's liveness check of a text document: one given to a JSON document is never run", async () => {
    const w = world({ n: 40, base: () => 0 });
    const check = () => "it would always fail";
    for (const spec of [{ kind: "json", schema: DocsSchema, check }, { schema: DocsSchema, check }]) {
      const surface = defineSurface({ documents: { policy: spec as never }, components: ["prompt", "config"] });
      const e = await Evolution.start({ surface, settings: settings(), split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } });
      expect(e.completed).toBe(0);
    }
  });

  it("RS20.2 a text document that has no check is not checked", async () => {
    const w = world({ n: 40, base: () => 0 });
    const surface = defineSurface({ documents: { policy: { schema: DocsSchema }, notes: { kind: "text", component: "skill" } }, components: ["prompt", "config", "skill"] });
    const e = await Evolution.start({ surface, settings: settings(), split: w.split, documents: { ...w.documents, notes: "anything at all" }, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } });
    expect(e.completed).toBe(0);
    expect(e.documents["notes"]).toBe("anything at all");
  });

  it("RS20.3 documents that are not an object of JSON values are refused as invalid documents", async () => {
    const w = world({ n: 40, base: () => 0 });
    const surface = defineSurface({ documents: {}, components: ["prompt"] });
    await expect(Evolution.start({ surface, settings: settings(), split: w.split, documents: null as never, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } })).rejects.toThrow(/^invalid documents\n/);
  });
});

describe("what a run starts from", () => {
  it("RS20.4 a base harness with a holdout starts with no holdout query spent, and one without a holdout keeps no holdout state", async () => {
    const held = await start(world({ n: 40, holdout: 20, base: () => 0.5 }));
    expect((held.save() as Record<string, unknown>)["holdout"]).toStrictEqual({ queries: 0 });
    const plain = await start(world({ n: 40, base: () => 0.5 }));
    expect(plain.save()).not.toHaveProperty("holdout");
  });

  it("RS20.5 the paper's noise band is z times the spread of the base harness's repeated scores", async () => {
    const { delta: _, ...open } = PAPER;
    const deltaFor = async (z: number) => {
      const w = world({ n: 40, base: () => 0.5 });
      const e = await start(w, settings({ select: { ...open, z } }));
      return (e.save() as { delta: number }).delta;
    };
    const one = await deltaFor(1);
    expect(one).toBeGreaterThan(0);
    expect(await deltaFor(3)).toBeCloseTo(3 * one, 12);
  });
});

describe("an evaluation with too many missing trials is not a measurement", () => {
  // 40 tasks of 2 trials: 80 expected; at `invalid` 0.25, 20 may be missing.
  const lenient = () => settings({ invalid: 0.25 });
  const missing = (runs: readonly TaskRun[], trials: number): TaskRun[] => {
    const whole = Math.floor(trials / 2);
    return runs.slice(whole).map((run, i) => (i === 0 && trials % 2 ? { ...run, trials: run.trials.slice(1) } : run));
  };
  const losing = (w: World, when: (documents: Documents) => boolean, trials: number): EvolutionPorts["evaluate"] => async (documents, tasks, k) => {
    const runs = await w.evaluate(documents, tasks, k);
    return when(documents) ? missing(runs, trials) : runs;
  };

  it("RS20.6 the base harness's evaluation that loses exactly the share it may is valid, one trial more is not", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await start(w, lenient(), losing(w, () => true, 20));
    expect(e.incumbent).toMatchObject({ missing: 20, expected: 80 });
    await expect(start(w, lenient(), losing(w, () => true, 21))).rejects.toThrow("the base harness's evaluation is invalid: 21 of 80 trials missing");
  });

  it("RS20.7 one lost trial of the base harness is not too many when the share allowed is a quarter", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await start(w, lenient(), losing(w, () => true, 1));
    expect(e.incumbent).toMatchObject({ missing: 1, expected: 80 });
  });

  it("RS20.8 a round whose incumbent loses exactly the share allowed goes on, one trial more stops it", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await start(w, lenient());
    const { propose } = scripted((r) => toggle(`noop${r.round}${r.candidate}`));
    const bare = (d: Documents) => ruleNames(d).length === 0;
    await expect(e.round(ports(w, propose, { evaluate: losing(w, bare, 21) }))).rejects.toThrow("the incumbent's evaluation is invalid: 21 of 80 trials missing; run the round again");
    expect(e.completed).toBe(0);
    const report = await e.round(ports(w, propose, { evaluate: losing(w, bare, 20) }));
    expect(report.round).toBe(0);
    expect(e.completed).toBe(1);
  });

  it("RS20.9 one lost trial of the incumbent in a round is not too many when the share allowed is a quarter", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await start(w, lenient());
    const { propose } = scripted((r) => toggle(`noop${r.round}${r.candidate}`));
    await e.round(ports(w, propose, { evaluate: losing(w, (d) => ruleNames(d).length === 0, 1) }));
    expect(e.completed).toBe(1);
  });

  it("RS20.10 a candidate that loses exactly the share allowed is measured, one trial more screens it as invalid", async () => {
    const w = world({ n: 40, base: () => 0 });
    const lossy = (d: Documents) => ruleNames(d).includes("lossy");
    const one = async (trials: number) => {
      const e = await start(w, lenient());
      const { propose } = scripted((r) => (r.candidate === "A" ? toggle("lossy") : toggle(`noop${r.round}${r.candidate}`)));
      return byCandidate((await e.round(ports(w, propose, { evaluate: losing(w, lossy, trials) }))).records)["A"]!;
    };
    const at = await one(20);
    expect(at.outcome).toBe("rejected");
    expect(at.measured).toBeDefined();
    expect(await one(21)).toMatchObject({ outcome: "screened", reason: "evaluation invalid: 21 of 80 trials missing" });
  });

  it("RS20.11 one lost trial of a candidate is not too many when the share allowed is a quarter", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await start(w, lenient());
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("lossy") : toggle(`noop${r.round}${r.candidate}`)));
    const report = await e.round(ports(w, propose, { evaluate: losing(w, (d) => ruleNames(d).includes("lossy"), 1) }));
    const a = byCandidate(report.records)["A"]!;
    expect(a.outcome).toBe("rejected");
    expect(a.reason).not.toMatch(/evaluation invalid/);
    expect(a.measured).toMatchObject({ gain: expect.any(Number), lower: expect.any(Number), upper: expect.any(Number) });
  });
});

describe("a proposal that is refused is recorded as it was", () => {
  const none = (w: World) => start(w, settings({ repair: 0 }));

  it("RS20.12 a candidate that leaks is a screened change, its problems told apart by semicolons", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await none(w);
    const leak = { summary: "leak", edits: [{ id: "e1", hypothesis: "h", targets: "t", ops: [{ op: "replace", document: "policy", path: "/prompt/system", value: "Always reconcile ledger 3 against invoice batch 1 first (e000)." }] }] };
    const { propose } = scripted((r) => (r.candidate === "A" ? leak : toggle("fine")));
    const a = byCandidate((await e.round(ports(w, propose))).records)["A"]!;
    expect(a.kind).toBe("change");
    expect(a.outcome).toBe("screened");
    expect(a.reason).toBe('edit e1 leaks the evolve set: it names task e000; edit e1 leaks the evolve set: it repeats "reconcile ledger 3 against invoice batch" from task e000');
  });

  it("RS20.13 a candidate the proposer gave no proposal for is a screened change with no edits", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await none(w);
    const { propose } = scripted((r) => (r.candidate === "A" ? "no idea" : toggle("fine")));
    const a = byCandidate((await e.round(ports(w, propose))).records)["A"]!;
    expect(a).toMatchObject({ kind: "change", outcome: "screened", reason: "the proposer gave no proposal: no idea" });
    expect(a.edits).toStrictEqual([]);
  });

  it("RS20.14 a proposal that is not one says where, every issue with its path in dots, told apart by semicolons, and has no edits", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await none(w);
    const { propose } = scripted((r) => (r.candidate === "A" ? { summary: "s", edits: [{ id: "e1" }] } : toggle("fine")));
    const a = byCandidate((await e.round(ports(w, propose))).records)["A"]!;
    expect(a.reason).toMatch(/^the proposal is not one: edits\.0\.hypothesis: [^;]+; edits\.0\.targets: [^;]+; edits\.0\.ops: [^;]+$/);
    expect(a.edits).toStrictEqual([]);
  });

  it("RS20.15 the critic's acceptance lets a candidate through, whatever reasons it gives", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await none(w);
    const { propose } = scripted((r) => toggle(`noop${r.round}${r.candidate}`));
    const report = await e.round(ports(w, propose, { critic: async () => ({ accept: true, reasons: ["looks general"] }) }));
    for (const r of report.records) {
      expect(r.outcome).toBe("rejected");
      expect(r.measured).toBeDefined();
    }
    expect(report.records).toHaveLength(2);
  });
});

describe("a reserved exploration slot", () => {
  const second = async (answer: unknown) => {
    const w = world({ n: 40, base: () => 0, components: { skillrule: "skill" } });
    const e = await start(w, settings({ repair: 0 }));
    const { propose } = scripted((r) => (r.round < 2 ? toggle(`noop${r.round}${r.candidate}`) : r.candidate === "B" ? answer : toggle(`noop${r.round}${r.candidate}`)));
    await e.round(ports(w, propose));
    await e.round(ports(w, propose));
    return byCandidate((await e.round(ports(w, propose))).records)["B"]!;
  };

  it("RS20.16 is met by one of a candidate's edits changing a component the run never exercised, the others free to change tried ones", async () => {
    const b = await second({ summary: "two", edits: [addRule("e1", "noopx"), addRule("e2", "skillrule")] });
    expect(b.outcome).toBe("rejected");
    expect(b.measured).toBeDefined();
  });

  it("RS20.17 is met by an edit that changes an unexercised component among others", async () => {
    const both = { id: "e1", hypothesis: "h", targets: "t", ops: [addRule("x", "noopx").ops[0], addRule("y", "skillrule").ops[0]] };
    const b = await second({ summary: "one", edits: [both] });
    expect(b.edits[0]!.components).toEqual(["config", "skill"]);
    expect(b.outcome).toBe("rejected");
    expect(b.measured).toBeDefined();
  });

  it("RS20.18 is not met by edits that change only components the run has exercised", async () => {
    const b = await second({ summary: "two", edits: [addRule("e1", "noopx"), addRule("e2", "noopy")] });
    expect(b.outcome).toBe("screened");
    expect(b.reason).toMatch(/^this candidate holds a reserved exploration slot/);
  });
});
