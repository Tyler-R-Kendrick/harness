import { describe, expect, it } from "vitest";
import { createDecisionLayer } from "../src/compose.ts";
import { CriteriaArchive, criteriaFromFork } from "../src/evolve.ts";
import type { CriteriaBook } from "../src/evolve.ts";
import type { InduceOptions } from "../src/distill.ts";
import type { LayerLifecycleState } from "../src/compose.ts";
import { parseLifecycleSettings } from "../src/lifecycle.ts";
import { MemoryDecisionLog } from "../src/records.ts";
import { DecisionError, forkId } from "../src/types.ts";
import type { DecisionId, Outcome } from "../src/types.ts";
import { humanOutcome, put, rig, saying, shippedSettings } from "./compose-fixtures.ts";
import type { RigOptions } from "./compose-fixtures.ts";
import { gate as evoGate, INSTRUCTIONS, reader, records as evoRecords, SALT, settings as evoSettings, sideOf } from "./evolve-fixtures.ts";

const ATTENTION = forkId("attention");
const EVO_GATE = forkId("evo.gate");
const INDUCE: InduceOptions = { fields: ["kind"], minSupport: 4, minPurity: 0.9, maxRules: 5, maxConditions: 1 };
const label = (action: string): Outcome => humanOutcome("overridden", { label: action });

const item = (id: string, kind: "permission" | "review") => ({ id, session: "s", kind, since: 1_000, blocked: kind === "permission" });

/** A layer with a history: eight permission items a person called urgent and eight reviews called low, in sessions train-0 to train-15. */
async function withHistory(over: RigOptions = {}) {
  const r = rig(over);
  for (let i = 0; i < 8; i++) {
    const kind = i % 2 === 0 ? "permission" : "review";
    const decision = await r.layer.decideNamed("attention", item(`h${i}`, kind), { session: `train-${i}` });
    await r.layer.outcome(decision.id, label(kind === "permission" ? "urgent" : "low"));
  }
  for (let i = 8; i < 16; i++) {
    const kind = i % 2 === 0 ? "permission" : "review";
    const decision = await r.layer.decideNamed("attention", item(`h${i}`, kind), { session: `train-${i}` });
    await r.layer.outcome(decision.id, label(kind === "permission" ? "urgent" : "low"));
  }
  return r;
}

/** Decisions in two live sessions, each labelled as the rule says, until the rules have the evidence to be promoted. */
async function promote(r: Awaited<ReturnType<typeof withHistory>>, kind: "permission" | "review" = "permission", action = "urgent", n = 6) {
  for (let i = 0; i < n; i++) {
    const decision = await r.layer.decideNamed("attention", item(`live-${kind}-${i}`, kind), { session: `live-${i % 2}` });
    await r.layer.outcome(decision.id, label(action));
  }
}

describe("induce", () => {
  it("DCO10.1 rules are induced from the decisions of a fork, added as shadow candidates keyed by fork and rule, with the history as no evidence", async () => {
    const r = await withHistory();
    // a decision of another fork is not a decision to induce this fork's rules from
    await put(r.log, { fork: forkId("dispatch"), input: item("elsewhere", "permission"), answers: {}, outcome: label("low") });
    const result = await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    expect(result.fork).toBe(ATTENTION);
    expect(result.records).toBe(16);
    expect(result.rules.map((e) => [e.rule.when, e.rule.action, e.rule.support, e.added, e.state])).toEqual([
      [{ eq: ["kind", "permission"] }, "urgent", 8, true, "candidate"],
      [{ eq: ["kind", "review"] }, "low", 8, true, "candidate"],
    ]);
    expect(result.rules.every((e) => e.key === `attention:${e.rule.id}`)).toBe(true);
    // every record is from a session the rules were built from, so none of them is evidence
    expect(result.observed).toBe(0);
  });

  it("DCO10.2 a decision with no session is nobody's training session, and the rule induced from it is no more shown right by it: only outcomes that did not build the rule are evidence, once", async () => {
    const r = rig();
    for (let i = 0; i < 6; i++) {
      const kind = i % 2 === 0 ? "permission" : "review";
      await put(r.log, { fork: ATTENTION, input: item(`a${i}`, kind), answers: {}, outcome: label(kind === "permission" ? "urgent" : "low") });
    }
    await put(r.log, { fork: ATTENTION, input: item("a6", "permission"), answers: {}, outcome: label("normal") });
    await put(r.log, { fork: ATTENTION, input: item("a7", "permission"), answers: {} });
    // settled by the judge, but nobody said what became of it: not evidence
    await put(r.log, { fork: ATTENTION, rung: "judge", action: "urgent", input: item("a8", "permission"), answers: {} });
    // said to be wrong with no label: not a decision the rule was induced from, and a miss for the rule that says urgent
    await put(r.log, { fork: ATTENTION, action: "urgent", input: item("a9", "permission"), answers: {}, outcome: humanOutcome("denied", { correct: false }) });
    // a person's approval that says nothing of the level: no evidence
    await put(r.log, { fork: ATTENTION, action: "urgent", input: item("a10", "permission"), answers: {}, outcome: humanOutcome("approved", {}) });
    const result = await r.layer.induce({ fork: ATTENTION, ...INDUCE, minSupport: 3, minPurity: 0.7 });
    // the seven decisions with a known right answer built the rules, session or none; of the others, one is evidence
    expect(result.observed).toBe(1);
    const permission = r.layer.rules().rules.find((e) => e.rule.action === "urgent")!;
    expect(permission).toMatchObject({ fits: 0, misses: 1, state: "shadow", sessions: [] });
    expect(r.layer.rules().rules.find((e) => e.rule.action === "low")).toMatchObject({ fits: 0, misses: 0, state: "candidate" });
    const again = await r.layer.induce({ fork: ATTENTION, ...INDUCE, minSupport: 3, minPurity: 0.7 });
    expect(again.observed).toBe(0);
    expect(r.layer.rules().rules.find((e) => e.rule.action === "urgent")).toMatchObject({ fits: 0, misses: 1 });
  });

  it("DCO10.3 inducing again leaves known rules as they are, whatever their state, and gives them no evidence twice", async () => {
    const r = await withHistory();
    const first = await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    const again = await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    expect(again.rules.map((e) => [e.key, e.added])).toEqual(first.rules.map((e) => [e.key, false]));
    expect(again.observed).toBe(0);
    expect(r.layer.rules().rules).toHaveLength(2);
  });

  it("DCO10.6 a rule induced from decisions made over the wire, with no session, cannot be promoted on its own training data", async () => {
    const r = rig();
    for (let i = 0; i < 30; i++) await put(r.log, { fork: ATTENTION, input: item(`w${i}`, "permission"), action: "urgent", answers: {}, outcome: humanOutcome("approved") });
    const result = await r.layer.induce({ fork: ATTENTION, ...INDUCE, minSupport: 4, maxRules: 5 });
    expect(result.observed).toBe(0);
    expect(r.layer.rules().rules).toHaveLength(1);
    expect(r.layer.rules().rules[0]).toMatchObject({ state: "candidate", fits: 0, misses: 0 });
    // two live decisions it gets wrong, in two sessions: the rule has its two misses and no fit from its training data, so it is retired and not active
    for (const session of ["x", "y"]) {
      const decision = await r.layer.decideNamed("attention", item(`live-${session}`, "permission"), { session });
      await r.layer.outcome(decision.id, label("normal"));
    }
    expect(r.layer.rules().rules[0]).toMatchObject({ state: "retired", fits: 0, misses: 2, sessions: ["x", "y"] });
    expect((await r.layer.decideNamed("attention", item("next", "permission"), { session: "z" })).rung).not.toBe("rule");
  });

  it("DCO10.7 an active rule is retired by outcomes that say its action was wrong without saying what was right", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    await promote(r, "permission", "urgent", 5);
    expect(r.layer.rules().counts).toMatchObject({ active: 1, retired: 0 });
    for (let i = 0; i < 2; i++) {
      const decision = await r.layer.decideNamed("attention", item(`wrong-${i}`, "permission"), { session: `live-${i}` });
      expect(decision).toMatchObject({ rung: "rule", action: "urgent" });
      await r.layer.outcome(decision.id, humanOutcome("denied", { correct: false }));
    }
    expect(r.layer.rules().rules.find((e) => e.rule.action === "urgent")).toMatchObject({ state: "retired", activeMisses: 2, activeFits: 0 });
    expect((await r.layer.decideNamed("attention", item("after", "permission"), { session: "live-9" })).rung).not.toBe("rule");
  });

  it("DCO10.8 a person's approval or denial that does not say whether the decision was right is no evidence for a rule", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    await promote(r, "permission", "urgent", 5);
    const before = r.layer.rules().rules.find((e) => e.rule.action === "urgent")!;
    for (const kind of ["approved", "denied"] as const) {
      const decision = await r.layer.decideNamed("attention", item(`silent-${kind}`, "permission"), { session: "live-0" });
      await r.layer.outcome(decision.id, humanOutcome(kind));
    }
    const after = r.layer.rules().rules.find((e) => e.rule.action === "urgent")!;
    expect([after.fits, after.misses, after.activeFits, after.activeMisses]).toEqual([before.fits, before.misses, before.activeFits, before.activeMisses]);
  });

  it("DCO10.9 two outcomes arriving together for one decision are one piece of evidence: the first is evidence and the other replaces it", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    const decision = await r.layer.decideNamed("attention", item("live", "permission"), { session: "live-0" });
    const [first, second] = await Promise.all([r.layer.outcome(decision.id, label("normal")), r.layer.outcome(decision.id, humanOutcome("completed"))]);
    expect([first, second]).toEqual([true, true]);
    const urgent = r.layer.rules().rules.find((e) => e.rule.action === "urgent")!;
    expect(urgent).toMatchObject({ fits: 0, misses: 1, state: "shadow" });
    expect((await r.layer.record(decision.id))!.outcome).toMatchObject({ kind: "completed" });
  });

  it("DCO10.10 outcomes for different decisions at once are each counted, and an outcome for a decision the log does not have is false", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    const decisions = await Promise.all(["a", "b", "c"].map((id) => r.layer.decideNamed("attention", item(id, "permission"), { session: `live-${id}` })));
    const results = await Promise.all([...decisions.map((d) => r.layer.outcome(d.id, label("urgent"))), r.layer.outcome("dec-999", label("urgent"))]);
    expect(results).toEqual([true, true, true, false]);
    expect(r.layer.rules().rules.find((e) => e.rule.action === "urgent")).toMatchObject({ fits: 3, misses: 0 });
  });

  it("DCO10.12 an outcome waits for every earlier one for its decision, also when it arrives after the first of them has been attached", async () => {
    // a log that holds the second outcome call open until released
    class Holding extends MemoryDecisionLog {
      calls = 0;
      release: () => void = () => undefined;
      readonly #held = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      override async outcome(id: DecisionId, outcome: Outcome): Promise<boolean> {
        this.calls += 1;
        if (this.calls === 2) await this.#held;
        return super.outcome(id, outcome);
      }
    }
    const base = rig();
    const log = new Holding();
    const layer = createDecisionLayer({ ...base.options, log });
    const decision = await layer.decideNamed("attention", item("live", "permission"), { session: "live-0" });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const first = layer.outcome(decision.id, label("urgent"));
    const second = layer.outcome(decision.id, humanOutcome("completed"));
    await first;
    await settle();
    expect(log.calls).toBe(2);
    const third = layer.outcome(decision.id, label("normal"));
    await settle();
    // the third is still behind the second, which is open
    expect(log.calls).toBe(2);
    log.release();
    expect(await Promise.all([second, third])).toEqual([true, true]);
    expect(log.calls).toBe(3);
    expect((await layer.record(decision.id))!.outcome).toMatchObject({ kind: "overridden", label: "normal" });
  });

  it("DCO10.11 an outcome that fails does not hold up the next one for the decision", async () => {
    const r = await withHistory();
    const decision = await r.layer.decideNamed("attention", item("live", "permission"), { session: "live-0" });
    await expect(r.layer.outcome(decision.id, { at: -1 } as never)).rejects.toThrow();
    expect(await r.layer.outcome(decision.id, label("urgent"))).toBe(true);
  });

  it("DCO10.4 a fork that is not registered cannot have rules induced for it", async () => {
    const r = rig();
    await expect(r.layer.induce({ fork: forkId("nope"), ...INDUCE })).rejects.toMatchObject({ code: "unknown-fork" });
  });

  it("DCO10.5 options the induction refuses are refused", async () => {
    const r = await withHistory();
    await expect(r.layer.induce({ fork: ATTENTION, ...INDUCE, minPurity: 2 })).rejects.toThrow(RangeError);
  });
});

describe("rules earn their place through the lifecycle", () => {
  it("DCO11.1 an outcome from another session is evidence for the rules that cover the decision; enough of it promotes a rule, which then answers at rung 0", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    await promote(r);
    const rules = r.layer.rules();
    expect(rules.counts).toEqual({ candidate: 1, shadow: 0, active: 1, retired: 0 });
    const decision = await r.layer.decideNamed("attention", item("new", "permission"), { session: "live-9" });
    expect(decision).toMatchObject({ action: "urgent", rung: "rule", confidence: 1 });
    expect(decision.record.trace).toEqual([{ rung: "rule", outcome: "decided by rule", confidence: 1 }]);
  });

  it("DCO11.2 a rule that is only a shadow candidate never answers", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    await promote(r, "permission", "urgent", 3);
    const decision = await r.layer.decideNamed("attention", item("new", "permission"), { session: "live-9" });
    expect(decision.rung).toBe("human");
    expect(r.layer.rules().counts).toMatchObject({ shadow: 1, active: 0 });
  });

  it("DCO11.3 an induced rule is never less restrictive than the fork's floor: a permission item stays at least high whatever a rule says", async () => {
    const r = rig();
    // a person's habit of calling permission items low is induced and promoted ...
    for (let i = 0; i < 8; i++) {
      const d = await r.layer.decideNamed("attention", item(`p${i}`, "permission"), { session: `train-${i}` });
      await r.layer.outcome(d.id, label("low"));
    }
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    await promote(r, "permission", "low");
    expect(r.layer.rules().counts.active).toBe(1);
    // ... and it answers at rung 0, but the floor of the fork still holds
    const decision = await r.layer.decideNamed("attention", item("new", "permission"), { session: "live-9" });
    expect(decision).toMatchObject({ rung: "rule", action: "high" });
    expect(decision.record.trace.at(-1)!.outcome).toContain("authority raised to");
  });

  it("DCO11.4 the fork's own rule wins over an induced one", async () => {
    const r = rig({ members: [saying("m", { boolean: 0.9 })] });
    r.layer.register(evoGate(), (raw) => raw as never);
    for (let i = 0; i < 8; i++) await put(r.log, { fork: forkId("evo.gate"), input: { kind: "halt" }, session: `train-${i}`, outcome: label("allow") });
    await r.layer.induce({ fork: forkId("evo.gate"), ...INDUCE });
    for (let i = 0; i < 6; i++) {
      const d = await r.layer.decideNamed("evo.gate", { kind: "halt" }, { session: `live-${i % 2}` });
      await r.layer.outcome(d.id, label("allow"));
    }
    expect(r.layer.rules(forkId("evo.gate")).counts.active).toBe(1);
    // the fork's own rule for `halt` is deny; the induced rule says allow, and has no say
    expect(await r.layer.decideNamed("evo.gate", { kind: "halt" })).toMatchObject({ action: "deny", rung: "rule" });
  });

  it("DCO11.5 evidence from a session a rule was built from does not count", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    const d = await r.layer.decideNamed("attention", item("again", "permission"), { session: "train-0" });
    await r.layer.outcome(d.id, label("urgent"));
    expect(r.layer.rules().rules.every((e) => e.fits === 0 && e.misses === 0)).toBe(true);
  });

  it("DCO11.6 an outcome that replaces another is not counted again, and an outcome that names no right action is no evidence", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    const d = await r.layer.decideNamed("attention", item("x", "permission"), { session: "live-0" });
    expect(await r.layer.outcome(d.id, label("urgent"))).toBe(true);
    expect(await r.layer.outcome(d.id, label("low"))).toBe(true);
    const permission = r.layer.rules().rules.find((e) => e.rule.action === "urgent")!;
    expect(permission).toMatchObject({ fits: 1, misses: 0 });
    const wrongNoLabel = await r.layer.decideNamed("attention", item("y", "permission"), { session: "live-1" });
    await r.layer.outcome(wrongNoLabel.id, humanOutcome("incorrect", { correct: false }));
    expect(r.layer.rules().rules.find((e) => e.rule.action === "urgent")).toMatchObject({ fits: 1, misses: 0 });
  });

  it("DCO11.7 a rule that is wrong by the margin is retired, stays retired when induced again, and no longer answers", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    for (let i = 0; i < 2; i++) {
      const d = await r.layer.decideNamed("attention", item(`m${i}`, "permission"), { session: `live-${i}` });
      await r.layer.outcome(d.id, label("normal"));
    }
    expect(r.layer.rules().rules.find((e) => e.rule.action === "urgent")!.state).toBe("retired");
    // the two misses are now in the history, so the rule is a little less pure; a looser purity finds it again
    const again = await r.layer.induce({ fork: ATTENTION, ...INDUCE, minPurity: 0.7 });
    expect(again.rules.find((e) => e.rule.action === "urgent")).toMatchObject({ added: false, state: "retired" });
    const decision = await r.layer.decideNamed("attention", item("after", "permission"), { session: "live-5" });
    expect(decision.rung).not.toBe("rule");
  });

  it("DCO11.8 an active rule is audited: every n-th use it does not answer, and what the audit sees is evidence", async () => {
    const settings = { ...shippedSettings(), lifecycle: parseLifecycleSettings({ promote: { fits: 5, sessions: 2, lowerBound: 0.55 }, retire: { margin: 2 }, audit: { every: 2 } }) };
    const r = await withHistory({ settings });
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    await promote(r, "permission", "urgent", 5);
    const first = await r.layer.decideNamed("attention", item("u1", "permission"), { session: "live-0" });
    const second = await r.layer.decideNamed("attention", item("u2", "permission"), { session: "live-1" });
    expect([first.rung, second.rung]).toEqual(["rule", "human"]);
    await r.layer.outcome(second.id, label("urgent"));
    const rule = r.layer.rules().rules.find((e) => e.rule.action === "urgent")!;
    expect(rule).toMatchObject({ state: "active", uses: 2, activeFits: 1 });
  });

  it("DCO11.9 an outcome for a decision the log does not have attaches nothing and is no evidence", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    const missing: DecisionId = "dec-9999";
    expect(await r.layer.outcome(missing, label("urgent"))).toBe(false);
    expect(r.layer.rules().rules.every((e) => e.fits === 0)).toBe(true);
  });

  it("DCO11.10 an outcome the log refuses is an error, and nothing is counted", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    const d = await r.layer.decideNamed("attention", item("x", "permission"), { session: "live-0" });
    await expect(r.layer.outcome(d.id, { at: -1 } as unknown as Outcome)).rejects.toBeInstanceOf(DecisionError);
    expect(r.layer.rules().rules.every((e) => e.fits === 0)).toBe(true);
  });
});

describe("rules and the lifecycle, listed and persisted", () => {
  it("DCO12.1 rules are listed with their stats, for one fork or all, and counted by state", async () => {
    const r = await withHistory();
    r.layer.register(evoGate(), (raw) => raw as never);
    expect(r.layer.rules()).toEqual({ rules: [], counts: { candidate: 0, shadow: 0, active: 0, retired: 0 } });
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    const all = r.layer.rules();
    expect(all.rules.map((e) => [e.fork, e.key === `attention:${e.rule.id}`, e.state, e.builtFrom.length])).toEqual([[ATTENTION, true, "candidate", 16], [ATTENTION, true, "candidate", 16]]);
    expect(all.counts.candidate).toBe(2);
    expect(r.layer.rules(forkId("evo.gate")).rules).toEqual([]);
    expect(r.layer.rules(ATTENTION).rules).toHaveLength(2);
    expect(r.layer.forks().find((f) => f.id === ATTENTION)!.rules).toEqual({ candidate: 2, shadow: 0, active: 0, retired: 0 });
    expect(r.layer.forks().find((f) => f.id === EVO_GATE)!.rules).toEqual({ candidate: 0, shadow: 0, active: 0, retired: 0 });
  });

  it("DCO12.2 onLifecycle is told the state when rules are added and when evidence is counted, and not when it is not", async () => {
    const told: LayerLifecycleState[] = [];
    const r = await withHistory({ onLifecycle: (state) => void told.push(state) });
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    expect(told).toHaveLength(1);
    expect(told[0]!.rules.map((s) => s.fork)).toEqual([ATTENTION, ATTENTION]);
    const ignored = await r.layer.decideNamed("attention", item("same", "permission"), { session: "train-1" });
    await r.layer.outcome(ignored.id, label("urgent"));
    expect(told).toHaveLength(1);
    const counted = await r.layer.decideNamed("attention", item("other", "permission"), { session: "live-1" });
    await r.layer.outcome(counted.id, label("urgent"));
    expect(told).toHaveLength(2);
    expect(told[1]!.lifecycle.artefacts.find((a) => a.fits === 1)).toBeDefined();
    await r.layer.outcome(counted.id, label("urgent"));
    expect(told).toHaveLength(2);
  });

  it("DCO12.3 a layer started from a saved state has the same rules in the same states, and an active rule answers", async () => {
    let saved: LayerLifecycleState | undefined;
    const r = await withHistory({ onLifecycle: (state) => void (saved = JSON.parse(JSON.stringify(state))) });
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    await promote(r);
    expect(saved).toBeDefined();
    const restarted = rig({ lifecycle: saved! });
    expect(restarted.layer.rules()).toEqual(r.layer.rules());
    expect(await restarted.layer.decideNamed("attention", item("new", "permission"))).toMatchObject({ action: "urgent", rung: "rule" });
  });

  it("DCO12.4 a saved state that is not valid is refused, naming what is wrong, and a rule with no lifecycle entry is refused", async () => {
    let saved: LayerLifecycleState | undefined;
    const r = await withHistory({ onLifecycle: (state) => void (saved = JSON.parse(JSON.stringify(state))) });
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    expect(() => rig({ lifecycle: { lifecycle: {}, rules: [] } as unknown as LayerLifecycleState })).toThrowError(expect.objectContaining({ code: "invalid", name: "DecisionError" }));
    expect(() => rig({ lifecycle: { rules: [] } as unknown as LayerLifecycleState })).toThrow(/invalid layer lifecycle state/);
    expect(() => rig({ lifecycle: { ...saved!, lifecycle: { ...saved!.lifecycle, artefacts: [] } } })).toThrowError(expect.objectContaining({ code: "invalid", message: expect.stringMatching(/has no lifecycle entry/) }));
    expect(() => rig({ lifecycle: { ...saved!, rules: [{ fork: "x", rule: {} } as never] } })).toThrow(/invalid layer lifecycle state/);
  });

  it("DCO12.5 an async onLifecycle is waited for", async () => {
    let done = 0;
    const r = await withHistory({ onLifecycle: async () => (await Promise.resolve(), void (done += 1)) });
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    expect(done).toBe(1);
  });
});

describe("rules belong to their fork", () => {
  it("DCO11.12 a fork's active rule does not answer another fork, and the other fork's outcomes are no evidence for it", async () => {
    const r = await withHistory({ members: [] });
    r.layer.register(evoGate(), (raw) => raw as never);
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    await promote(r);
    expect(r.layer.rules().counts.active).toBe(1);
    // evo.gate's facts have a `kind` too, and the rule is about kind permission
    const other = await r.layer.decideNamed("evo.gate", { kind: "permission" }, { session: "live-7" });
    expect(other.rung).not.toBe("rule");
    const before = r.layer.rules().rules.find((e) => e.state === "active")!;
    await r.layer.outcome(other.id, label("allow"));
    expect(r.layer.rules().rules.find((e) => e.state === "active")).toMatchObject({ fits: before.fits, misses: before.misses, uses: before.uses });
  });

  it("DCO12.6 the lifecycle's other artefacts are not listed as rules", async () => {
    const r = await withHistory();
    r.layer.lifecycle.add("some-head", { origin: "fitted" });
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    expect(r.layer.rules().rules.map((e) => e.key)).not.toContain("some-head");
    expect(r.layer.rules().rules).toHaveLength(2);
    expect((await r.layer.status()).lifecycle.candidate).toBe(3);
  });
});

describe("status", () => {
  it("DCO13.1 the status gives the policy, the forks, the members as they are served, the log size, the calibration, the rules by state and the inbox", async () => {
    const state: { served?: { id: string; version: string } } = {};
    const m = { ...saying("panel", { boolean: 0.95 }), served: () => state.served };
    const judge = saying("judge", { boolean: 0.5 }, "j9");
    const r = rig({ members: [m, saying("plain", {})], judge });
    expect(await r.layer.status()).toMatchObject({
      policy: "policy-t",
      members: [{ id: "panel", version: "v1" }, { id: "plain", version: "v1" }],
      judge: { id: "judge", version: "j9" },
      decisions: 0,
      calibration: { entries: 0 },
      lifecycle: { candidate: 0, shadow: 0, active: 0, retired: 0 },
      inbox: 0,
    });
    state.served = { id: "model-a", version: "abc" };
    r.layer.inbox.add(item("i", "review"));
    await put(r.log);
    const status = await r.layer.status();
    expect(status.members[0]).toEqual({ id: "panel", version: "v1", served: { id: "model-a", version: "abc" } });
    expect("served" in status.members[1]!).toBe(false);
    expect(status).toMatchObject({ decisions: 1, inbox: 1 });
    expect(status.forks.map((f) => f.id)).toEqual(["permission.risk", "attention", "stuck", "dispatch"]);
    const { judge: _judge, ...bare } = await rig().layer.status();
    expect("judge" in bare).toBe(false);
  });

  it("DCO13.2 the status counts the rules by lifecycle state", async () => {
    const r = await withHistory();
    await r.layer.induce({ fork: ATTENTION, ...INDUCE });
    await promote(r);
    expect((await r.layer.status()).lifecycle).toEqual({ candidate: 1, shadow: 0, active: 1, retired: 0 });
  });
});

describe("evolve", () => {
  const EVO = forkId("evo.gate");
  const QUOTA = { held: { net: 8, read: 6, disk: 2 }, train: { net: 4, read: 3, disk: 1 } } as const;
  const NET_AND_DISK = "Is the call risky? Watch for: disk, net.";
  const widen = (text = NET_AND_DISK) => async () => [{ question: "risky", target: "instructions", text }];

  async function evolving(over: RigOptions = {}, salt: string | null = SALT) {
    const member = reader();
    const r = rig({ members: [member], settings: { ...shippedSettings(), evolve: evoSettings() }, ...(salt === null ? {} : { holdoutSalt: salt }), ...over });
    r.layer.register(evoGate(), (raw) => raw as never);
    for (const rec of evoRecords(QUOTA, { note: (_, n) => `case${n}` })) {
      while ((await r.log.next()) !== rec.id);
      await r.log.append(rec);
    }
    return { ...r, member };
  }

  it("DCO14.1 a better wording is accepted, archived and persisted, and the fork then asks with it and records the criteria version", async () => {
    const archives: unknown[] = [];
    const r = await evolving({ onArchive: (snapshot) => void archives.push(snapshot) });
    const result = await r.layer.evolve({ fork: EVO, proposer: widen() });
    expect(result).toMatchObject({ status: "accepted", version: "v1" });
    expect(archives).toHaveLength(1);
    expect(r.layer.archive.active(EVO)).toMatchObject({ version: "v1", parent: "v0" });
    expect(r.layer.forks().find((f) => f.id === EVO)).toMatchObject({ criteria: "v1", version: "f1+criteria-v1" });
    const decision = await r.layer.decideNamed("evo.gate", { kind: "net" });
    expect((r.member.calls.at(-1)!.questions["risky"] as { instructions: string }).instructions).toBe(NET_AND_DISK);
    expect(decision.record.forkVersion).toBe("f1+criteria-v1");
    expect(decision.action).toBe("deny");
  });

  it("DCO14.2 a wording that is not better is archived but not applied", async () => {
    const archives: unknown[] = [];
    const r = await evolving({ onArchive: (snapshot) => void archives.push(snapshot) });
    const result = await r.layer.evolve({ fork: EVO, proposer: widen("Is the call risky? Watch for: disk, please.") });
    expect(result.status).toBe("rejected");
    expect(archives).toHaveLength(1);
    await r.layer.decideNamed("evo.gate", { kind: "net" });
    expect((r.member.calls.at(-1)!.questions["risky"] as { instructions: string }).instructions).toBe(INSTRUCTIONS);
    expect(r.layer.forks().find((f) => f.id === EVO)!.criteria).toBeUndefined();
    expect(r.layer.forks().find((f) => f.id === EVO)!.version).toBe("f1");
  });

  it("DCO14.3 when an evolution changes nothing in the archive, onArchive is not told", async () => {
    const archives: unknown[] = [];
    const r = await evolving({ onArchive: (snapshot) => void archives.push(snapshot) });
    await r.layer.evolve({ fork: EVO, proposer: widen() });
    const second = await r.layer.evolve({ fork: EVO, proposer: widen("never used") });
    expect(second.status).toBe("no-failures");
    expect(archives).toHaveLength(1);
  });

  it("DCO14.4 a rollback makes an earlier criteria version the active one again, persisted, and the fork asks with its own wording", async () => {
    const archives: unknown[] = [];
    const r = await evolving({ onArchive: (snapshot) => void archives.push(snapshot) });
    await r.layer.evolve({ fork: EVO, proposer: widen() });
    await r.layer.rollback(EVO, "v0");
    expect(archives).toHaveLength(2);
    expect(r.layer.archive.active(EVO)!.version).toBe("v0");
    await r.layer.decideNamed("evo.gate", { kind: "net" });
    expect((r.member.calls.at(-1)!.questions["risky"] as { instructions: string }).instructions).toBe(INSTRUCTIONS);
    await expect(r.layer.rollback(EVO, "v7")).rejects.toMatchObject({ code: "invalid" });
    expect(archives).toHaveLength(2);
  });

  it("DCO14.13 a layer without an archive callback rolls back and evolves all the same", async () => {
    const r = await evolving();
    await r.layer.evolve({ fork: EVO, proposer: widen() });
    await r.layer.rollback(EVO, "v0");
    expect(r.layer.archive.active(EVO)!.version).toBe("v0");
  });

  it("DCO14.5 a layer started from an archive asks with the criteria it holds", async () => {
    const first = await evolving();
    await first.layer.evolve({ fork: EVO, proposer: widen() });
    const snapshot = first.layer.archive.snapshot();
    const member = reader();
    const second = rig({ members: [member], archive: snapshot });
    second.layer.register(evoGate(), (raw) => raw as never);
    await second.layer.decideNamed("evo.gate", { kind: "net" });
    expect((member.calls[0]!.questions["risky"] as { instructions: string }).instructions).toBe(NET_AND_DISK);
    expect(() => rig({ archive: { format: "x" } })).toThrow(DecisionError);
  });

  it("DCO14.6 criteria that do not fit the fork's questions never stop a decision: the fork asks its own", async () => {
    const archive = new CriteriaArchive();
    const v0 = criteriaFromFork(evoGate(), { kind: "x" }, "v0");
    archive.seed(v0);
    const broken: CriteriaBook = { ...v0, version: "v1", questions: { risky: { type: "score", instructions: "nonsense", criteria: ["a", "b"] } } };
    archive.attempt({ criteria: broken, edits: [], summary: { n: 2, incumbent: 0, candidate: 1, meanDiff: 1, lower: 0.5, pValue: 0.01, accepted: true, reason: "r" } });
    const member = reader();
    const r = rig({ members: [member], archive: archive.snapshot() });
    r.layer.register(evoGate(), (raw) => raw as never);
    await r.layer.decideNamed("evo.gate", { kind: "net" });
    expect((member.calls[0]!.questions["risky"] as { instructions: string }).instructions).toBe(INSTRUCTIONS);
  });

  it("DCO14.7 the first evolution seeds the archive from what the fork asks about a recorded input; a host may give the starting criteria", async () => {
    const r = await evolving();
    expect(r.layer.archive.active(EVO)).toBeUndefined();
    await r.layer.evolve({ fork: EVO, proposer: widen("unused"), member: "reader" });
    expect(r.layer.archive.history(EVO)[0]).toMatchObject({ version: "v0", edits: [] });
    expect((r.layer.archive.history(EVO)[0]!.criteria.questions["risky"] as { instructions: string }).instructions).toBe(INSTRUCTIONS);
    const given = await evolving();
    const initial = criteriaFromFork(evoGate(), { kind: "x" }, "start");
    await given.layer.evolve({ fork: EVO, proposer: widen(), initial });
    expect(given.layer.archive.history(EVO)[0]!.version).toBe("start");
  });

  it("DCO14.8 the replay uses the member asked for, by id; an unknown member, no member at all, or an unknown fork is refused", async () => {
    const r = await evolving({ members: [reader("first"), reader("second")] });
    await expect(r.layer.evolve({ fork: EVO, proposer: widen(), member: "ghost" })).rejects.toMatchObject({ code: "no-member", message: "no member is named ghost" });
    await expect(r.layer.evolve({ fork: forkId("ghost.fork"), proposer: widen() })).rejects.toMatchObject({ code: "unknown-fork", message: "no fork is registered as ghost.fork" });
    const none = rig({ settings: { ...shippedSettings(), evolve: evoSettings() } });
    none.layer.register(evoGate(), (raw) => raw as never);
    await expect(none.layer.evolve({ fork: EVO, proposer: widen() })).rejects.toMatchObject({ code: "no-member", message: "there is no member to replay decisions with" });
  });

  it("DCO14.9 with no decisions of the fork and no starting criteria there is nothing to take the criteria from", async () => {
    const r = rig({ members: [reader()], settings: { ...shippedSettings(), evolve: evoSettings() } });
    r.layer.register(evoGate(), (raw) => raw as never);
    await expect(r.layer.evolve({ fork: EVO, proposer: widen() })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("no decisions of evo.gate") });
  });

  it("DCO14.10 decisions whose recorded input is not the fork's input again are left out of the replay", async () => {
    const r = await evolving();
    r.layer.registry.get("evo.gate");
    // a decision recorded under the fork's id with an input its parser refuses
    await put(r.log, { fork: EVO, input: { not: "a gate input" }, outcome: label("allow") });
    const strict = rig({ members: [reader()], settings: { ...shippedSettings(), evolve: evoSettings() }, holdoutSalt: SALT });
    strict.layer.register(evoGate(), (raw) => {
      if (typeof (raw as { kind?: unknown }).kind !== "string") throw new Error("kind is required");
      return raw as never;
    });
    for (const rec of evoRecords(QUOTA, { note: (_, n) => `case${n}` })) {
      while ((await strict.log.next()) !== rec.id);
      await strict.log.append(rec);
    }
    await put(strict.log, { fork: EVO, input: { not: "a gate input" }, outcome: label("allow") });
    expect(await strict.layer.evolve({ fork: EVO, proposer: widen() })).toMatchObject({ status: "accepted" });
  });

  it("DCO14.11 the archive is told even when the evolution fails after seeding it", async () => {
    const archives: unknown[] = [];
    const r = await evolving({ onArchive: (snapshot) => void archives.push(snapshot) });
    const result = await r.layer.evolve({
      fork: EVO,
      proposer: async () => {
        throw new Error("model down");
      },
    });
    expect(result).toMatchObject({ status: "proposal-failed", reason: "model down" });
    expect(archives).toHaveLength(1);
    expect(r.layer.archive.history(EVO)).toHaveLength(1);
  });

  it("DCO14.12 the holdout salt the host gave is the evolver's split; a host that gives none gets `harness`", async () => {
    const salted = await evolving();
    const plain = await evolving({}, null);
    const a = await salted.layer.evolve({ fork: EVO, proposer: widen() });
    const b = await plain.layer.evolve({ fork: EVO, proposer: widen() });
    const heldUnder = (salt: string) => evoRecords(QUOTA, { note: (_, n) => `case${n}` }).filter((rec) => sideOf(rec.input, evoSettings().holdout, salt) === "holdout").length;
    expect(heldUnder(SALT)).toBe(16);
    expect(heldUnder("harness")).not.toBe(16);
    expect(a.summary!.n).toBe(16);
    if (heldUnder("harness") >= evoSettings().minHoldout) expect(b.summary!.n).toBe(heldUnder("harness"));
    else expect(b).toMatchObject({ status: "insufficient-holdout", reason: expect.stringContaining(`${heldUnder("harness")} held-out decisions`) });
  });

  it("DCO14.13 starting criteria a client gives are refused unless they are for the fork and are what the fork asks now, and nothing is seeded or told", async () => {
    const archives: unknown[] = [];
    const r = await evolving({ onArchive: (snapshot) => void archives.push(snapshot) });
    const own = criteriaFromFork(evoGate(), { kind: "x" }, "start");
    const refuse = async (initial: CriteriaBook, message: string) => {
      await expect(r.layer.evolve({ fork: EVO, proposer: widen(), initial })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining(message) });
      expect(r.layer.archive.history(EVO)).toEqual([]);
      expect(archives).toEqual([]);
    };
    await refuse({ ...own, fork: forkId("stuck") }, 'the initial criteria are for "stuck", not for "evo.gate"');
    await refuse({ ...own, questions: {} }, "are not what evo.gate asks now");
    await refuse({ ...own, questions: { risky: { type: "score", instructions: "How risky?", criteria: ["a", "b"] } } }, "are not what evo.gate asks now");
    // criteria that fit but say other than what is asked now would be an incumbent that is not what is deployed
    await refuse({ ...own, questions: { risky: { type: "boolean", instructions: "Something else entirely.", criteria: {} } } }, "are not what evo.gate asks now");
    const none = rig({ members: [reader()], settings: { ...shippedSettings(), evolve: evoSettings() } });
    none.layer.register(evoGate(), (raw) => raw as never);
    await expect(none.layer.evolve({ fork: EVO, proposer: widen(), initial: own })).rejects.toMatchObject({ code: "invalid", message: "there are no decisions of evo.gate to check the initial criteria against" });
    expect(none.layer.archive.history(EVO)).toEqual([]);
    expect(await r.layer.evolve({ fork: EVO, proposer: widen(), initial: own })).toMatchObject({ status: "accepted" });
  });

  it("DCO14.14 only the decisions of the fork are looked at: decisions of another fork are no sample to take the criteria from or to check them against", async () => {
    const other = async () => {
      const r = rig({ members: [reader()], settings: { ...shippedSettings(), evolve: evoSettings() } });
      r.layer.register(evoGate(), (raw) => raw as never);
      await put(r.log, { fork: forkId("test.gate"), input: { kind: "net" }, outcome: label("deny") });
      return r;
    };
    const taking = await other();
    await expect(taking.layer.evolve({ fork: EVO, proposer: widen() })).rejects.toMatchObject({ code: "invalid", message: "there are no decisions of evo.gate to take its criteria from: pass the initial criteria" });
    expect(taking.layer.archive.history(EVO)).toEqual([]);
    const checking = await other();
    const own = criteriaFromFork(evoGate(), { kind: "x" }, "start");
    await expect(checking.layer.evolve({ fork: EVO, proposer: widen(), initial: own })).rejects.toMatchObject({ code: "invalid", message: "there are no decisions of evo.gate to check the initial criteria against" });
    expect(checking.layer.archive.history(EVO)).toEqual([]);
  });

  it("DCO14.15 starting criteria are ignored once the fork has criteria: they are not checked against anything", async () => {
    const r = await evolving();
    const own = criteriaFromFork(evoGate(), { kind: "x" }, "v0");
    r.layer.archive.seed(own);
    const elsewhere: CriteriaBook = { ...own, version: "other", fork: forkId("stuck"), questions: {} };
    expect(await r.layer.evolve({ fork: EVO, proposer: widen(), initial: elsewhere })).toMatchObject({ status: "accepted", version: "v1" });
    expect(r.layer.archive.history(EVO).map((e) => e.version)).toEqual(["v0", "v1"]);
  });

  it("DCO14.16 starting criteria that are for another fork are refused for that, before anything about the decisions or the questions", async () => {
    const stuck = { ...criteriaFromFork(evoGate(), { kind: "x" }, "start"), fork: forkId("stuck") };
    const none = rig({ members: [reader()], settings: { ...shippedSettings(), evolve: evoSettings() } });
    none.layer.register(evoGate(), (raw) => raw as never);
    const wrongFork = { code: "invalid", message: 'the initial criteria are for "stuck", not for "evo.gate"' };
    await expect(none.layer.evolve({ fork: EVO, proposer: widen(), initial: stuck })).rejects.toMatchObject(wrongFork);
    const r = await evolving();
    await expect(r.layer.evolve({ fork: EVO, proposer: widen(), initial: { ...stuck, questions: {} } })).rejects.toMatchObject(wrongFork);
  });
});
