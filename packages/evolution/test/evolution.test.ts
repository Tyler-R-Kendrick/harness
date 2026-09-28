import { describe, expect, it } from "vitest";
import { Evolution } from "@harness/evolution";
import type { EvolutionPorts, LedgerRecord } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { scripted, settings, toggle, world } from "./world.ts";

type World = ReturnType<typeof world>;

const start = (w: World, s = settings(), seed = 1) => Evolution.start({ surface: w.surface, settings: s, split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(seed) } });
const ports = (w: World, propose: EvolutionPorts["propose"], extra: Partial<EvolutionPorts> = {}): EvolutionPorts => ({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(2), ...extra });
const byCandidate = (records: readonly LedgerRecord[]) => Object.fromEntries(records.map((r) => [r.candidate, r]));
const rules = (e: Evolution) => (e.documents["policy"] as { rules: Record<string, boolean> }).rules;

const PAPER = { rule: "paper", delta: 0.01, beta0: 0.1, beta1: 35, ws: 1414, wc: 15, wn: 0.5, prune: 4 };

describe("an evolution run", () => {
  it("RS9.1 starts by measuring the base harness, refusing documents its surface rejects or an evaluation that lost its trials", async () => {
    const w = world({ n: 40, base: () => 0.5, holdout: 10 });
    const e = await start(w);
    expect(e.completed).toBe(0);
    expect(e.incumbent?.k).toBe(2);
    expect(w.calls.map((c) => c.tasks.length)).toEqual([40, 10]);
    await expect(Evolution.start({ surface: w.surface, settings: settings(), split: w.split, documents: { policy: { rules: {}, prompt: { system: "" } } }, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } })).rejects.toThrow(/base harness's policy does not parse/);
    await expect(Evolution.start({ surface: w.surface, settings: settings(), split: w.split, documents: w.documents, ports: { evaluate: async () => [], entropy: new SeededEntropy(1) } })).rejects.toThrow(/evaluation is invalid: 80 of 80 trials missing/);
    // The paper's rule without a delta evaluates the base harness twice and calibrates it.
    const p = world({ n: 40, base: () => 0.5 });
    const { delta: _, ...uncalibrated } = PAPER;
    const paper = await start(p, settings({ select: uncalibrated }));
    expect(p.calls).toHaveLength(2);
    expect((paper.save() as { delta: number }).delta).toBeGreaterThan(0);
  });

  it("RS9.2 a round measures the candidates with the incumbent in one window and accepts a supported gain; its own lucky measurement is not the new incumbent's evidence", async () => {
    const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0) } });
    const e = await start(w);
    const { propose, requests } = scripted((r) => (r.candidate === "A" && r.round === 0 ? toggle("verify") : toggle(`noop${r.round}${r.candidate}`)));
    const report = await e.round(ports(w, propose));
    expect(report).toMatchObject({ round: 0, budget: 2, stalled: false, accepted: "A" });
    expect(report.level).toBeCloseTo(0.1 / (6 * 3), 12);
    const r = byCandidate(report.records);
    expect(r["A"]).toMatchObject({ outcome: "accepted", kind: "change", measured: { gain: 0.5, verdict: "supported" } });
    expect(r["B"]).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/no supported gain/) });
    expect(rules(e)).toEqual({ verify: true });
    expect(e.mechanisms).toEqual([expect.objectContaining({ id: "r0A.e1", round: 0, hypothesis: "verify helps", components: ["config"] })]);
    expect(e.incumbent).toBeUndefined();
    expect(w.calls).toHaveLength(4);
    expect(requests[0]).toMatchObject({ round: 0, candidate: "A", budget: 2, components: ["prompt", "config", "skill", "memory"], analysis: { score: 0 }, history: [], mechanisms: [] });
    expect(requests[0]!.prune).toBeUndefined();

    const next = await e.round(ports(w, propose));
    expect(w.calls).toHaveLength(8); // the incumbent afresh, A, B, and the ablation of r0A.e1
    expect(e.incumbent?.score).toBe(0.5);
    expect(requests[2]!.analysis.failures.map((f) => f.task)).toEqual(["e020", "e021", "e022"]);
    expect(requests[2]!.analysis.successes.map((f) => f.task)).toEqual(["e019", "e018"]);
    expect(requests[2]!.analysis.failures[0]).toMatchObject({ text: expect.stringContaining("Case e20"), score: 0, feedback: "p=0" });
    expect(requests[2]!.mechanisms).toEqual([{ id: "r0A.e1", round: 0, hypothesis: "verify helps", components: ["config"] }]);
    expect(requests[2]!.history.map((h) => [h.candidate, h.outcome, h.verdict])).toEqual([
      ["A", "accepted", "supported"],
      ["B", "rejected", "inconclusive"],
    ]);
    expect(byCandidate(next.records)["P"]).toMatchObject({ kind: "prune", outcome: "rejected", measured: { gain: -0.5, verdict: "refuted" } });
    expect(e.mechanisms[0]!.ablated).toBe(1);
    expect(e.trajectory).toEqual([0, 0, 0.5]);
  });

  it("RS9.3 refused proposals go back to the proposer with the reasons; what cannot be repaired is recorded unmeasured", async () => {
    const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0) } });
    const e = await start(w);
    const three = { summary: "3", edits: ["x", "y", "z"].map((r, i) => ({ id: `e${i}`, hypothesis: "h", targets: "t", ops: [{ op: "add", document: "policy", path: `/rules/${r}`, value: true }] })) };
    const { propose, requests } = scripted((r) => (r.candidate === "A" ? (r.problems ? toggle("verify") : "the model gave up") : r.problems ? three : { summary: "no edits key" }));
    const report = await e.round(ports(w, propose));
    expect(requests.map((r) => [r.candidate, r.problems])).toEqual([
      ["A", undefined],
      ["A", ["the proposer gave no proposal: the model gave up"]],
      ["B", undefined],
      ["B", [expect.stringMatching(/^the proposal is not one: edits: /)]],
    ]);
    expect(requests[1]!.previous).toBe("the model gave up");
    expect(report.accepted).toBe("A");
    expect(byCandidate(report.records)["B"]).toMatchObject({ outcome: "screened", reason: "3 edits, more than this round's budget of 2", edits: [] });
    expect(byCandidate(report.records)["B"]!.measured).toBeUndefined();
  });

  it("RS9.4 a candidate that leaks the evolve set, or that the critic refuses, is screened before any evaluation is spent", async () => {
    const w = world({ n: 40, base: () => 0 });
    const e = await start(w, settings({ repair: 0 }));
    const leak = { summary: "leak", edits: [{ id: "e1", hypothesis: "h", targets: "t", ops: [{ op: "replace", document: "policy", path: "/prompt/system", value: "Always reconcile ledger 3 against invoice batch 1 first." }] }] };
    const critic = async () => ({ accept: false, reasons: ["too specific"] });
    const { propose } = scripted((r) => (r.candidate === "A" ? leak : toggle("fine")));
    const seen: unknown[] = [];
    const report = await e.round(ports(w, propose, { critic: async (req) => (seen.push(req.examples.map((x) => x.id)), critic()) }));
    const r = byCandidate(report.records);
    expect(r["A"]).toMatchObject({ outcome: "screened", reason: 'edit e1 leaks the evolve set: it repeats "reconcile ledger 3 against invoice batch" from task e000', edits: [{ id: "e1", components: ["prompt"], footprint: 1 }] });
    expect(r["B"]).toMatchObject({ outcome: "screened", reason: "critic: too specific" });
    expect(seen).toEqual([["e000", "e001"]]);
    expect(w.calls).toHaveLength(2); // the base harness, then the incumbent: no candidate was evaluated
    const silent = await e.round(ports(w, propose, { critic: async () => ({ accept: false, reasons: [] }) }));
    expect(byCandidate(silent.records)["B"]!.reason).toBe("critic: the critic refused it");
  });

  it("RS9.5 when the run stalls, a slot is reserved for components it never exercised, judged by the paths a candidate changes", async () => {
    const w = world({ n: 40, base: () => 0, components: { skillrule: "skill" } });
    const e = await start(w, settings({ repair: 1 }));
    const { propose, requests } = scripted((r) => (r.reserved && r.problems ? toggle("skillrule") : toggle(`noop${r.round}${r.candidate}${r.problems ? "x" : ""}`)));
    const first = await e.round(ports(w, propose));
    await e.round(ports(w, propose));
    expect(first.stalled).toBe(false);
    const third = await e.round(ports(w, propose));
    expect(third.stalled).toBe(true);
    const reserved = requests.filter((r) => r.round === 2 && r.candidate === "B");
    expect(reserved[0]!.reserved).toEqual(["prompt", "skill", "memory"]);
    expect(reserved[1]!.problems).toEqual(["this candidate holds a reserved exploration slot: at least one edit must change a component the run never exercised (prompt, skill, memory), judged by the paths it changes"]);
    expect(requests.find((r) => r.round === 2 && r.candidate === "A")!.reserved).toBeUndefined();
    expect(byCandidate(third.records)["B"]).toMatchObject({ edits: [{ components: ["skill"] }] });
  });

  it("RS9.6 accepted mechanisms are ablated one at a time: one that still earns its place is kept, one that does not is removed", async () => {
    const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0), fluff: () => 0 } });
    const e = await start(w);
    const bundle = { summary: "two", edits: ["verify", "fluff"].map((r, i) => ({ id: `e${i + 1}`, hypothesis: `${r} helps`, targets: "t", ops: [{ op: "add", document: "policy", path: `/rules/${r}`, value: true }] })) };
    const { propose } = scripted((r) => (r.round === 0 && r.candidate === "A" ? bundle : toggle(`noop${r.round}${r.candidate}`)));
    await e.round(ports(w, propose));
    expect(e.mechanisms.map((m) => m.id)).toEqual(["r0A.e1", "r0A.e2"]);
    const kept = await e.round(ports(w, propose));
    expect(byCandidate(kept.records)["P"]).toMatchObject({ outcome: "rejected", edits: [{ id: "r0A.e1", hypothesis: "prune: verify helps" }] });
    const removed = await e.round(ports(w, propose));
    expect(removed.accepted).toBe("P");
    expect(byCandidate(removed.records)["P"]).toMatchObject({ outcome: "accepted", kind: "prune", reason: expect.stringMatching(/removes a mechanism/), edits: [{ id: "r0A.e2" }] });
    expect(e.mechanisms.map((m) => m.id)).toEqual(["r0A.e1"]);
    expect(rules(e)).toEqual({ verify: true });
    // Nothing else is due: no ablation this round.
    const quiet = await e.round(ports(w, propose));
    expect(byCandidate(quiet.records)["P"]).toBeUndefined();
  });

  it("RS9.7 a mechanism a later edit rewrote is entangled: it is not ablated on its own", async () => {
    const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0) } });
    const e = await start(w);
    const { propose } = scripted((r) => (r.round === 0 && r.candidate === "A" ? toggle("verify") : toggle(`noop${r.round}${r.candidate}`)));
    await e.round(ports(w, propose));
    const saved = structuredClone(e.save()) as { documents: { policy: { rules: Record<string, boolean> } } };
    saved.documents.policy.rules["verify"] = false;
    const tangled = new Evolution({ surface: w.surface, settings: settings(), split: w.split, saved });
    const report = await tangled.round(ports(w, propose));
    expect(byCandidate(report.records)["P"]).toBeUndefined();
    expect(tangled.mechanisms[0]!.entangled).toBe(true);
  });

  it("RS9.8 a gain the holdout does not confirm is refused and spends the holdout; a spent holdout confirms nothing", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects: { memorize: (i, h) => (!h && i < 20 ? 1 : 0), general: (i, h) => ((h ? i < 10 : i < 20) ? 1 : 0) } });
    const e = await start(w, settings({ holdout: { threshold: 0.05, sigma: 0, budget: 1, confirm: 0 } }));
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle(r.round === 0 ? "memorize" : "general") : toggle(`noop${r.round}`)));
    const overfit = await e.round(ports(w, propose));
    expect(overfit.accepted).toBeUndefined();
    expect(byCandidate(overfit.records)["A"]).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/supported gain.*; not confirmed on the holdout: its answer 0\.0000 is not above 0 \(the evolve set was overfit\)/), measured: { holdout: { answer: 0, overfit: true, exhausted: false, state: { budget: 0, overfits: 1 } } } });
    expect(rules(e)).toEqual({});
    const spent = await e.round(ports(w, propose));
    expect(byCandidate(spent.records)["A"]).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/the holdout is spent/), measured: { holdout: { exhausted: true } } });
  });

  it("RS9.9 a gain the holdout agrees with is confirmed, and the new incumbent's holdout measurement is kept for the next query", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects: { general: (i, h) => ((h ? i < 10 : i < 20) ? 1 : 0), more: (i, h) => ((h ? i >= 10 && i < 15 : i >= 20 && i < 30) ? 1 : 0) } });
    const e = await start(w);
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle(r.round === 0 ? "general" : "more") : toggle(`noop${r.round}`)));
    const first = await e.round(ports(w, propose));
    expect(first.accepted).toBe("A");
    expect(byCandidate(first.records)["A"]!.measured!.holdout).toMatchObject({ answer: 0.5, overfit: false });
    const before = w.calls.length;
    const second = await e.round(ports(w, propose));
    expect(second.accepted).toBe("A");
    // The incumbent on the evolve set, A, B, the ablation, and A on the holdout: the incumbent's holdout score was kept.
    expect(w.calls.slice(before).map((c) => c.tasks.length)).toEqual([40, 40, 40, 40, 20]);
    expect(rules(e)).toEqual({ general: true, more: true });
  });

  it("RS9.10 under the paper's rule the winner's own measurement is the incumbent, S* follows it, novelty admits a new structural component, and B_t goes to the proposer", async () => {
    const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0) }, components: { skillrule: "skill" } });
    const e = await start(w, settings({ select: PAPER }));
    const { propose, requests } = scripted((r) => (r.candidate === "A" ? toggle(r.round === 0 ? "verify" : `noop${r.round}`) : toggle(r.round === 0 ? "skillrule" : `other${r.round}`)));
    const report = await e.round(ports(w, propose));
    expect(w.calls).toHaveLength(3); // the base harness, A and B: the incumbent is not measured again
    expect(report.level).toBeUndefined();
    expect(byCandidate(report.records)["A"]).toMatchObject({ outcome: "accepted", reason: expect.stringMatching(/^admissible: gain 0\.5000 > delta/) });
    expect(byCandidate(report.records)["B"]).toMatchObject({ outcome: "admissible", reason: expect.stringMatching(/nu = 1/) });
    expect(e.incumbent?.score).toBe(0.5);
    expect((e.save() as { best: number }).best).toBe(0.5);
    expect(e.trajectory).toEqual([0, 0.5]);
    const second = await e.round(ports(w, propose));
    expect(requests.at(-1)!.prune).toEqual([{ component: "skill", mechanisms: [] }]);
    expect(second.records.some((r) => r.kind === "prune")).toBe(false);
  });

  it("RS9.11 a gain concentrated on two tasks passes the paper's rule and not the calibrated one", async () => {
    const narrow = { n: 60, base: () => 0, effects: { narrow: (i: number) => (i < 2 ? 1 : 0) } };
    const answer = (r: { candidate: string; round: number }) => (r.candidate === "A" ? toggle("narrow") : toggle(`noop${r.round}`));
    const wp = world(narrow);
    const paper = await start(wp, settings({ select: { ...PAPER, delta: 0.017, ws: 0 } }));
    expect((await paper.round(ports(wp, scripted(answer).propose))).accepted).toBe("A");
    const wc = world(narrow);
    const calibrated = await start(wc);
    const report = await calibrated.round(ports(wc, scripted(answer).propose));
    expect(report.accepted).toBeUndefined();
    expect(byCandidate(report.records)["A"]).toMatchObject({ measured: { verdict: "inconclusive" } });
    expect(byCandidate(report.records)["A"]!.measured!.gain).toBeCloseTo(2 / 60, 12);
  });

  it("RS9.12 guards are non-compensatory; predictions are checked against the measurement", async () => {
    const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0) } });
    const e = await start(w);
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("verify", true, { predicted: ["e000", "e030"] }) : toggle("noop")));
    const report = await e.round(ports(w, propose, { guards: (c, inc) => (c.score > inc.score ? ["valid-output rate fell"] : []) }));
    expect(byCandidate(report.records)["A"]).toMatchObject({ outcome: "rejected", reason: "domain guard violated: valid-output rate fell", measured: { hits: ["e000"], misses: ["e030"] } });
  });

  it("RS9.13 a run is saved and restored between rounds, ends after its rounds, and a round that cannot measure the incumbent changes nothing", async () => {
    const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0), crash: () => 0 } });
    const e = await start(w, settings({ rounds: 2 }));
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("verify") : toggle("crash")));
    const lossy: EvolutionPorts["evaluate"] = async (docs, tasks, k) => ((docs["policy"] as { rules: Record<string, boolean> }).rules["crash"] ? [] : w.evaluate(docs, tasks, k));
    const first = await e.round(ports(w, propose, { evaluate: lossy }));
    expect(byCandidate(first.records)["B"]).toMatchObject({ outcome: "screened", reason: "evaluation invalid: 80 of 80 trials missing" });
    const restored = new Evolution({ surface: w.surface, settings: settings({ rounds: 2 }), split: w.split, saved: JSON.parse(JSON.stringify(e.save())) });
    expect(restored.completed).toBe(1);
    expect(restored.documents).toEqual(e.documents);
    await expect(restored.round(ports(w, propose, { evaluate: async () => [] }))).rejects.toThrow(/the incumbent's evaluation is invalid: 80 of 80 trials missing; run the round again/);
    expect(restored.completed).toBe(1);
    expect(restored.records).toHaveLength(2);
    await restored.round(ports(w, propose));
    expect(restored.done).toBe(true);
    await expect(restored.round(ports(w, propose))).rejects.toThrow(/the run is over: 2 rounds/);
    expect(() => new Evolution({ surface: w.surface, settings: settings(), split: w.split, saved: { format: "other" } })).toThrow(/invalid saved evolution/);
  });
});
