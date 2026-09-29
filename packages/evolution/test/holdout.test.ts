import { describe, expect, it } from "vitest";
import { Evolution, HoldoutSettingsSchema, HoldoutStateSchema, holdoutLevel, holdoutRemaining, minimumGroups, StateSchema } from "@harness/evolution";
import type { EvolutionPorts, LedgerRecord, Split } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { scripted, settings, toggle, world } from "./world.ts";

type World = ReturnType<typeof world>;

const start = (w: World, s = settings(), split: Split = w.split, evaluate: EvolutionPorts["evaluate"] = w.evaluate) => Evolution.start({ surface: w.surface, settings: s, split, documents: w.documents, ports: { evaluate, entropy: new SeededEntropy(1) } });
const ports = (w: World, propose: EvolutionPorts["propose"], extra: Partial<EvolutionPorts> = {}): EvolutionPorts => ({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(2), ...extra });
const holdoutOf = (records: readonly LedgerRecord[], candidate = "A") => records.find((r) => r.candidate === candidate)?.measured?.holdout;
const rules = (e: Evolution) => (e.documents["policy"] as { rules: Record<string, boolean> }).rules;
const held = (w: World) => w.calls.filter((c) => c.tasks[0]!.id.startsWith("h"));
const onHoldout = (budget: number, alpha = 0.1) => settings({ holdout: { alpha, budget } });

// A rule that helps on the evolve tasks 0..19 only, and one that helps on the same share of holdout tasks.
const effects = { more: (i: number, h: boolean) => (!h && i >= 20 && i < 30 ? 1 : 0), memorize: (i: number, h: boolean) => (!h && i < 20 ? 1 : 0), general: (i: number, h: boolean) => ((h ? i < 10 : i < 20) ? 1 : 0) };

describe("a budgeted holdout: the union bound over what an adaptive analyst can ask", () => {
  it("RS19.50 the level of each query is alpha / (2^budget - 1): the queries an analyst can reach form a binary tree of depth `budget`, one accept/reject bit at each step", () => {
    expect(holdoutLevel({ alpha: 0.1, budget: 1 })).toBe(0.1);
    expect(holdoutLevel({ alpha: 0.1, budget: 2 })).toBeCloseTo(0.1 / 3, 15);
    expect(holdoutLevel({ alpha: 0.05, budget: 4 })).toBeCloseTo(0.05 / 15, 15);
    expect(holdoutLevel({ alpha: 0.1, budget: 10 })).toBeCloseTo(0.1 / 1023, 15);
    // 2^1 - 1 + 2^2 - 1 ... the tree of depth b has 1 + 2 + ... + 2^(b-1) = 2^b - 1 nodes.
    for (const budget of [1, 2, 3, 5]) expect(holdoutLevel({ alpha: 0.2, budget }) * Array.from({ length: budget }, (_, d) => 2 ** d).reduce((a, b) => a + b, 0)).toBeCloseTo(0.2, 12);
  });

  it("RS19.51 the holdout is spent after `budget` queries, counted whatever their answers", () => {
    const s = { alpha: 0.1, budget: 4 };
    expect(holdoutRemaining({ queries: 0 }, s)).toBe(4);
    expect(holdoutRemaining({ queries: 3 }, s)).toBe(1);
    expect(holdoutRemaining({ queries: 4 }, s)).toBe(0);
    expect(holdoutRemaining({ queries: 9 }, s)).toBe(0);
  });

  it("RS19.52 the settings are an alpha in (0, 1) and a budget of at least one query; the Thresholdout settings are gone", () => {
    expect(HoldoutSettingsSchema.parse({ alpha: 0.05, budget: 4 })).toEqual({ alpha: 0.05, budget: 4 });
    for (const bad of [{ alpha: 0, budget: 4 }, { alpha: 1, budget: 4 }, { alpha: 0.05, budget: 0 }, { alpha: 0.05, budget: 1.5 }, { alpha: 0.05 }, { alpha: 0.05, budget: 4, sigma: 0.01 }, { threshold: 0.03, sigma: 0.01, budget: 4 }]) expect(HoldoutSettingsSchema.safeParse(bad).success).toBe(false);
    expect(HoldoutStateSchema.parse({ queries: 2 })).toEqual({ queries: 2 });
    expect(HoldoutStateSchema.safeParse({ queries: -1 }).success).toBe(false);
    expect(HoldoutStateSchema.safeParse({ queries: 1, threshold: 0.03 }).success).toBe(false);
  });

  it("RS19.53 a level that cannot work is refused when the settings are parsed: at or above 0.5, or needing more resamples than the run takes", () => {
    expect(() => onHoldout(1, 0.6)).toThrow(/holdout\.alpha: .* level of 0\.6, which must lie in \(0, 0\.5\)/);
    expect(() => onHoldout(1, 0.4)).not.toThrow();
    // budget 12: level 0.1 / 4095 needs 40950 resamples, and the run takes 400.
    expect(() => onHoldout(12)).toThrow(/select\.resamples must be at least \d+: the holdout's confirmation level needs that many resamples/);
  });

  it("RS19.54 a holdout too small to confirm anything at its level is refused before anything is evaluated, counting groups", async () => {
    const calls: unknown[] = [];
    const small = (n: number, groups?: number) => world({ n: 40, holdout: n, base: () => 0.5, ...(groups ? { groups } : {}) });
    const check = (w: World, s = settings()) => start(w, s, w.split, async (...a) => (calls.push(a), w.evaluate(...a)));
    // alpha 0.1, budget 2: level 0.0333 needs 5 groups.
    expect(minimumGroups(0.1 / 3)).toBe(5);
    await expect(check(small(4))).rejects.toThrow("the holdout has 4 groups, and confirming at level 0.033 needs at least 5: use more holdout tasks or groups, a larger holdout.alpha or a smaller holdout.budget");
    expect(calls).toHaveLength(0);
    // Holdout tasks are counted by group too (world groups apply to the evolve set and the holdout alike).
    const clustered = small(20, 4);
    await expect(check(clustered, settings())).rejects.toThrow(/the evolve set has 4 groups|the holdout has 4 groups/);
    await expect(check(small(5))).resolves.toBeInstanceOf(Evolution);
    // A restored run is held to it as well.
    const w = small(5);
    const e = await start(w);
    expect(() => new Evolution({ surface: w.surface, settings: settings(), split: { evolve: w.split.evolve, holdout: w.split.holdout!.slice(0, 4) }, saved: e.save() })).toThrow(/the holdout has 4 groups/);
    // The paper's rule does not query the holdout and is not held to it.
    const paper = settings({ select: { rule: "paper", delta: 0.01, beta0: 0.1, beta1: 35, ws: 1, wc: 1, wn: 0.5, prune: 4 } });
    await expect(check(small(2), paper)).resolves.toBeInstanceOf(Evolution);
  });
});

describe("confirming a winner on the holdout", () => {
  it("RS19.55 a winner is measured with the incumbent, fresh, on the holdout in one window; a gain that is only on the evolve tasks is not confirmed, and the record has the holdout comparison but the proposer only its one bit", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects });
    const e = await start(w, onHoldout(2));
    expect(w.calls.map((c) => c.tasks.length)).toEqual([40]); // the base harness on the evolve tasks only: the holdout is not measured until it is queried
    const { propose, requests } = scripted((r) => (r.candidate === "A" ? toggle(r.round === 0 ? "memorize" : "noop") : toggle(`noop${r.round}`)));
    const report = await e.round(ports(w, propose));
    expect(report.accepted).toBeUndefined();
    const a = report.records.find((r) => r.candidate === "A")!;
    expect(a).toMatchObject({ outcome: "rejected", measured: { verdict: "supported", gain: 0.5 } });
    expect(a.reason).toMatch(/^supported gain: .*; not confirmed on the holdout$/);
    expect(holdoutOf(report.records)).toEqual({ gain: 0, lower: 0, upper: 0, level: 0.1 / 3, confirmed: false, exhausted: false, remaining: 1 });
    expect(rules(e)).toEqual({});
    // Two evaluations for the one query: the winner, then the incumbent, on the same 20 tasks.
    expect(held(w)).toHaveLength(2);
    expect(held(w).map((c) => Object.keys((c.documents["policy"] as { rules: object }).rules))).toEqual([["memorize"], []]);
    expect(held(w).map((c) => c.tasks.length)).toEqual([20, 20]);
    expect((e.save() as { holdout: unknown }).holdout).toEqual({ queries: 1 });
    // The proposer reads the ledger next round: it learns that A was not confirmed, and nothing of the holdout's numbers.
    await e.round(ports(w, propose));
    const row = requests.at(-1)!.history.find((h) => h.candidate === "A")!;
    expect(row).toMatchObject({ outcome: "rejected", reason: a.reason });
    expect(JSON.stringify(requests.at(-1)!.history)).not.toMatch(/"holdout"|"level"|"remaining"|"confirmed"|"lower"/);
  });

  it("RS19.56 a broad real gain is confirmed: it is accepted, and the record shows the holdout's gain, bounds, level and the queries left", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects });
    const e = await start(w, onHoldout(2));
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("general") : toggle(`noop${r.round}`)));
    const report = await e.round(ports(w, propose));
    expect(report.accepted).toBe("A");
    const h = holdoutOf(report.records)!;
    expect(h).toMatchObject({ gain: 0.5, level: 0.1 / 3, confirmed: true, exhausted: false, remaining: 1 });
    expect(h.lower!).toBeGreaterThan(0);
    expect(h.upper!).toBeLessThanOrEqual(1);
    expect(report.records.find((r) => r.candidate === "A")!.outcome).toBe("accepted");
    expect(rules(e)).toEqual({ general: true });
    expect((e.save() as { holdout: unknown }).holdout).toEqual({ queries: 1 });
    // The next query measures the incumbent afresh: no earlier draw is reused.
    const before = held(w).length;
    await e.round(ports(w, scripted((r) => (r.candidate === "A" ? toggle("general2") : toggle(`other${r.round}`))).propose));
    expect(held(w).length).toBe(before); // nothing was admissible: no query
  });

  it("RS19.57 a non-inferior saving is confirmed on the holdout by the same non-inferiority rule, and one that loses score there is not", async () => {
    const cheap = world({ n: 40, holdout: 20, base: () => 1, effects: { saver: () => 0, worse: (i, h) => (h && i < 10 ? -1 : 0) }, cost: { saver: -400, worse: -400 } });
    const e = await start(cheap, onHoldout(2));
    const { propose } = scripted((r) => (r.round === 0 ? toggle("saver") : toggle("worse")));
    const first = await e.round(ports(cheap, propose));
    expect(first.accepted).toBe("A");
    expect(first.records.find((r) => r.candidate === "A")!.reason).toMatch(/non-inferior .*, and saves 40\.0% tokens/);
    expect(holdoutOf(first.records)).toMatchObject({ gain: 0, lower: 0, upper: 0, confirmed: true, remaining: 1 });
    // A second saving that also costs score, on the holdout tasks only (probability 0 on ten of twenty).
    const second = await e.round(ports(cheap, propose));
    expect(second.accepted).toBeUndefined();
    expect(second.records.find((r) => r.candidate === "A")!.reason).toMatch(/non-inferior .*saves .*; not confirmed on the holdout$/);
    expect(holdoutOf(second.records)).toMatchObject({ gain: -0.5, confirmed: false, remaining: 0 });
    expect(holdoutOf(second.records)!.lower!).toBeLessThan(-0.02);
  });

  it("RS19.65 a saving whose holdout lower bound is exactly -margin is not confirmed: the rule is strict, as on the evolve set", async () => {
    // Identical on the evolve tasks, and on every holdout task the saving loses the whole score (1 to 0): lower bound -1, margin 1.
    const w = world({ n: 40, holdout: 20, base: () => 1, effects: { saver: (_, h) => (h ? -1 : 0) }, cost: { saver: -400 } });
    const s = settings({ select: { rule: "calibrated", alpha: 0.1, resamples: 400, margin: 1, saving: 0.05, beta0: 0.1, beta1: 35 } });
    const e = await start(w, s);
    const report = await e.round(ports(w, scripted((r) => (r.candidate === "A" ? toggle("saver") : toggle(`noop${r.round}`))).propose));
    expect(holdoutOf(report.records)).toMatchObject({ gain: -1, lower: -1, upper: -1, confirmed: false });
    expect(report.accepted).toBeUndefined();
  });

  it("RS19.58 the removal of a mechanism is confirmed like a saving", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects: { general: (i, h) => ((h ? i < 10 : i < 20) ? 1 : 0), fluff: () => 0 } });
    const e = await start(w, settings({ holdout: { alpha: 0.1, budget: 3 }, select: { rule: "calibrated", alpha: 0.1, resamples: 400, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 } }));
    const bundle = { summary: "two", edits: ["general", "fluff"].map((r, i) => ({ id: `e${i + 1}`, hypothesis: `${r} helps`, targets: "t", ops: [{ op: "add", document: "policy", path: `/rules/${r}`, value: true }] })) };
    const { propose } = scripted((r) => (r.round === 0 && r.candidate === "A" ? bundle : toggle(`noop${r.round}${r.candidate}`)));
    expect((await e.round(ports(w, propose))).accepted).toBe("A");
    const kept = await e.round(ports(w, propose));
    expect(kept.records.find((r) => r.candidate === "P")).toMatchObject({ outcome: "rejected", edits: [{ id: "r0A.e1" }] });
    expect(holdoutOf(kept.records, "P")).toBeUndefined(); // refused on the evolve set: never queried
    const removed = await e.round(ports(w, propose));
    expect(removed.accepted).toBe("P");
    expect(holdoutOf(removed.records, "P")).toMatchObject({ gain: 0, confirmed: true, exhausted: false, remaining: 1 });
    expect(rules(e)).toEqual({ general: true });
  });

  it("RS19.59 the holdout is spent after `budget` queries, confirmed or not: a spent holdout confirms nothing, and evaluates nothing", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects });
    const e = await start(w, onHoldout(1, 0.1));
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle(r.round === 0 ? "general" : "more") : toggle(`noop${r.round}`)));
    const first = await e.round(ports(w, propose));
    expect(first.accepted).toBe("A"); // confirmed: and that was the one query
    expect(holdoutOf(first.records)).toMatchObject({ confirmed: true, remaining: 0, level: 0.1 });
    const before = held(w).length;
    const second = await e.round(ports(w, propose));
    expect(second.accepted).toBeUndefined();
    expect(held(w)).toHaveLength(before);
    const a = second.records.find((r) => r.candidate === "A")!;
    expect(a.reason).toMatch(/; the holdout is spent: no change can be confirmed any more$/);
    expect(a.outcome).toBe("rejected");
    expect(holdoutOf(second.records)).toEqual({ confirmed: false, exhausted: true, remaining: 0 });
    expect((e.save() as { holdout: unknown }).holdout).toEqual({ queries: 1 });
  });

  it("RS19.60 an invalid holdout measurement throws before any state changes; it is never counted as overfitting, and the retry queries once", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects });
    const e = await start(w, onHoldout(2));
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("general") : toggle(`noop${r.round}`)));
    const before = JSON.stringify(e.save());
    const lose = (which: "winner" | "incumbent"): EvolutionPorts["evaluate"] => async (d, t, k) => {
      const isWinner = Boolean((d["policy"] as { rules: Record<string, boolean> }).rules["general"]);
      return t[0]!.id.startsWith("h") && isWinner === (which === "winner") ? [] : w.evaluate(d, t, k);
    };
    await expect(e.round(ports(w, propose, { evaluate: lose("winner") }))).rejects.toThrow("the holdout evaluation of candidate A is invalid: 40 of 40 trials missing; run the round again");
    expect(JSON.stringify(e.save())).toBe(before);
    await expect(e.round(ports(w, propose, { evaluate: lose("incumbent") }))).rejects.toThrow("the holdout evaluation of the incumbent is invalid: 40 of 40 trials missing; run the round again");
    expect(JSON.stringify(e.save())).toBe(before);
    // A few lost trials are a measurement, not an outage: under the invalid share.
    const flaky: EvolutionPorts["evaluate"] = async (d, t, k) => (await w.evaluate(d, t, k)).map((r, i) => (t[0]!.id.startsWith("h") && i === 0 ? { ...r, trials: r.trials.slice(0, 1) } : r));
    const report = await e.round(ports(w, propose, { evaluate: flaky }));
    expect(report.accepted).toBe("A");
    expect((e.save() as { holdout: unknown }).holdout).toEqual({ queries: 1 });
  });

  it("RS19.61 the two holdout evaluations of a query settle before a failure is thrown", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects });
    const e = await start(w, onHoldout(2));
    let slowFinished = false;
    const evaluate: EvolutionPorts["evaluate"] = async (d, t, k) => {
      if (t[0]!.id.startsWith("h")) {
        const isWinner = Boolean((d["policy"] as { rules: Record<string, boolean> }).rules["general"]);
        if (isWinner) throw new Error("holdout evaluator crashed");
        await new Promise((resolve) => setTimeout(resolve, 50));
        slowFinished = true;
      }
      return w.evaluate(d, t, k);
    };
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("general") : toggle(`noop${r.round}`)));
    await expect(e.round(ports(w, propose, { evaluate }))).rejects.toThrow("holdout evaluator crashed");
    expect(slowFinished).toBe(true);
  });

  it("RS19.62 the paper's rule does not query the holdout; a holdout is used only to confirm what the calibrated rule accepts", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects });
    const paper = settings({ select: { rule: "paper", delta: 0.01, beta0: 0.1, beta1: 35, ws: 1414, wc: 15, wn: 0.5, prune: 4 } });
    const e = await start(w, paper);
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("memorize") : toggle("noop")));
    expect((await e.round(ports(w, propose))).accepted).toBe("A");
    expect(held(w)).toHaveLength(0);
    // And a round that admits nothing does not query.
    const w2 = world({ n: 40, holdout: 20, base: () => 0, effects });
    const e2 = await start(w2, onHoldout(2));
    await e2.round(ports(w2, scripted((r) => toggle(`noop${r.candidate}`)).propose));
    expect(held(w2)).toHaveLength(0);
    expect((e2.save() as { holdout?: unknown }).holdout).toEqual({ queries: 0 });
  });

  it("RS19.63 the queries used survive a save and a restore: a restored holdout is as spent as it was", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects });
    const e = await start(w, onHoldout(1));
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("general") : toggle(`noop${r.round}`)));
    await e.round(ports(w, propose));
    const restored = new Evolution({ surface: w.surface, settings: onHoldout(1), split: w.split, saved: JSON.parse(JSON.stringify(e.save())) });
    const next = await restored.round(ports(w, scripted((r) => (r.candidate === "A" ? toggle("more") : toggle(`z${r.round}`))).propose));
    expect(holdoutOf(next.records)).toMatchObject({ exhausted: true });
  });
});

describe("states saved with Thresholdout", () => {
  it("RS19.64 an older state's holdout (its noisy threshold, budget and cached incumbent) reads as the queries it had made; its records lose the Thresholdout answers", async () => {
    const w = world({ n: 40, holdout: 20, base: () => 0, effects });
    const e = await start(w, onHoldout(2));
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("memorize") : toggle(`noop${r.round}`)));
    await e.round(ports(w, propose));
    const saved = JSON.parse(JSON.stringify(e.save())) as { holdout: unknown; records: { measured?: { holdout?: unknown } }[] };
    saved.holdout = { state: { budget: 1, threshold: 0.03, queries: 3, overfits: 1 }, incumbent: (e.save() as { base: unknown }).base };
    for (const r of saved.records) if (r.measured?.holdout) r.measured.holdout = { answer: 0, overfit: true, exhausted: false, state: { budget: 1, threshold: 0.03, queries: 1, overfits: 1 } };
    const state = StateSchema.parse(saved);
    expect(state.holdout).toEqual({ queries: 3 });
    expect(state.records.every((r) => r.measured?.holdout === undefined)).toBe(true);
    // The current shape is untouched by the migration.
    expect(StateSchema.parse(JSON.parse(JSON.stringify(e.save()))).records.some((r) => r.measured?.holdout !== undefined)).toBe(true);
  });
});
