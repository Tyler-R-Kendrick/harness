import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { AttentionInbox, DispatchInputSchema, PermissionFactsSchema, standardLabelOf, StuckInputSchema, withRules } from "../src/compose.ts";
import { parseCalibration } from "../src/calibration.ts";
import { DecisionError } from "../src/types.ts";
import type { AttentionItem } from "../src/attention.ts";
import type { ForkGenerator } from "../src/fork.ts";
import type { Fork } from "../src/types.ts";
import { answer, chose, levels, record, yes } from "./loops-fixtures.ts";
import { humanOutcome, rig, saying, shippedAuthority, shippedCalibration, shippedSettings } from "./compose-fixtures.ts";
import { failing, gate, sure } from "./fork-fixtures.ts";
import type { Act, In } from "./fork-fixtures.ts";

const CRITICAL = { boolean: 0.95, score: [0, 0, 0.1, 0.9] };
const ROUTINE = { boolean: 0.02, score: [0.9, 0.1, 0, 0] };
const rm = { tool: "Bash", kind: "execute", command: "rm -rf build" };

describe("the layer's forks", () => {
  it("DCO1.1 the built-in forks are registered, in order, and listed with their versions and policies", () => {
    const { layer } = rig();
    expect(layer.registry.list().map((f) => f.id)).toEqual(["permission.risk", "attention", "stuck", "dispatch"]);
    expect(layer.forks().map((f) => [f.id, f.policy.act])).toEqual([
      ["permission.risk", 0.9],
      ["attention", 0.9],
      ["stuck", 0.9],
      ["dispatch", 0.9],
    ]);
    expect(layer.forks()[1]!.version).toBe(shippedSettings().attention.version);
    expect(layer.forks().every((f) => f.rules.candidate + f.rules.shadow + f.rules.active + f.rules.retired === 0 && f.criteria === undefined)).toBe(true);
  });

  it("DCO1.2 a fork is decided by name on an input parsed for it, and the decision is recorded with its session and saga", async () => {
    const { layer, log } = rig({ members: [saying("m", CRITICAL)] });
    const decision = await layer.decideNamed("permission.risk", rm, { session: "s1", correlation: "cor-4" });
    expect(decision).toMatchObject({ action: "critical", rung: "model", active: true, needsHuman: false });
    const stored = (await log.get(decision.id))!;
    expect(stored).toMatchObject({ fork: "permission.risk", member: "m", memberVersion: "v1", session: "s1", correlation: "cor-4", policy: "policy-t", at: 10_000 });
    expect(stored.input).toEqual({ tool: "Bash", kind: "execute", command: "rm -rf build" });
  });

  it("DCO1.3 decide takes any fork, registered or not, and passes the context through", async () => {
    const { layer, log } = rig({ members: [sure("m", 0.97)] });
    const decision = await layer.decide(gate(), { text: "hi" }, { session: "s9" });
    expect(decision.action).toBe("allow");
    expect((await log.get(decision.id))!.session).toBe("s9");
  });

  it("DCO1.4 inputs a fork cannot take are refused as invalid, naming what is wrong, and nothing is recorded", async () => {
    const { layer, log } = rig({ members: [saying("m", CRITICAL)] });
    for (const [fork, input, what] of [
      ["permission.risk", { tool: "" }, "invalid permission facts"],
      ["permission.risk", { tool: "x", bogus: 1 }, "invalid permission facts"],
      ["attention", { id: "a" }, "invalid attention item"],
      ["stuck", { goal: "g", steps: [{ action: 3 }] }, "invalid stuck input"],
      ["dispatch", { context: -1, current: "small", task: "t" }, "invalid dispatch input"],
    ] as const) {
      const failure = await layer.decideNamed(fork, input).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(DecisionError);
      expect(failure).toMatchObject({ code: "invalid" });
      expect((failure as Error).message).toContain(what);
    }
    await expect(layer.decideNamed("nope", {})).rejects.toMatchObject({ code: "unknown-fork" });
    expect(await log.size()).toBe(0);
  });

  it("DCO1.5 the input schemas take what the forks take", () => {
    expect(PermissionFactsSchema.parse({ tool: "t", kind: "read", path: "/a", cwd: "/", session: "s", url: "u", command: "c", input: { a: [1] } })).toMatchObject({ tool: "t" });
    expect(StuckInputSchema.parse({ goal: "g", steps: [{ action: "a", state: "s", progress: 2 }] }).steps).toHaveLength(1);
    expect(DispatchInputSchema.parse({ context: 10, current: "large", task: "t", facts: { irreversible: true } }).current).toBe("large");
    expect(() => StuckInputSchema.parse({ goal: "g", steps: [{ action: "a", progress: Number.NaN }] })).toThrow();
  });

  it("DCO1.6 the authority and the permission questions the layer is given are the fork's: a forbidden request is decided by rule with no model asked", async () => {
    const m = saying("m", ROUTINE);
    const { layer } = rig({ members: [m], authority: shippedAuthority() });
    const forbidden = await layer.decideNamed("permission.risk", { tool: "Bash", kind: "execute", command: "rm -rf /" });
    expect(forbidden).toMatchObject({ action: "critical", rung: "rule" });
    expect(m.calls).toHaveLength(0);
    const read = await layer.decideNamed("permission.risk", { tool: "Read", kind: "read", path: "/w/a.ts", cwd: "/w" });
    expect(read).toMatchObject({ action: "routine", rung: "model" });
    expect(layer.registry.get("permission.risk").version).toBe(`${shippedSettings().permission!.version}+${shippedAuthority().version}`);
    const asked = m.calls[0]!;
    expect(asked.questions["irreversible"]!.instructions).toBe(shippedSettings().permission!.questions.irreversible.instructions);
  });

  it("DCO1.7 without permission questions the fork asks its minimal ones, and without an authority nothing is permitted", async () => {
    const { permission: _dropped, ...settings } = shippedSettings();
    const { layer } = rig({ members: [saying("m", ROUTINE)], settings });
    expect(layer.registry.get("permission.risk").version).toBe("minimal+none");
    expect(await layer.decideNamed("permission.risk", { tool: "Read", kind: "read" })).toMatchObject({ action: "careful" });
  });

  it("DCO1.8 the members, the judge and the generator are the ladder's: a verdict short of acting goes to the judge, then the generator, then a person", async () => {
    const unsure = saying("m", { boolean: 0.7, score: [0.1, 0.4, 0.3, 0.2] });
    const judge = saying("j", { boolean: 0.99 });
    const { layer } = rig({ members: [unsure], judge });
    const viaJudge = await layer.decide(gate({ verify: (input, action) => ({ state: { text: input.text, action }, questions: { correct: { type: "boolean", instructions: "right?" } } }) }), { text: "x" });
    expect(viaJudge.rung).toBe("judge");
    const { layer: bare } = rig({ members: [failing("m")], generator: (async () => ({ action: "allow", confidence: probability(0.4) })) as unknown as ForkGenerator });
    expect((await bare.decide(gate(), { text: "x" })).rung).toBe("generator");
    const { layer: alone } = rig({ members: [failing("m")] });
    expect(await alone.decide(gate(), { text: "x" })).toMatchObject({ rung: "human", needsHuman: true });
  });

  it("DCO1.9 decisions are published to the host as decision.made, with the session", async () => {
    const { layer, published } = rig({ members: [saying("m", CRITICAL)] });
    const decision = await layer.decideNamed("permission.risk", rm, { session: "s1" });
    expect(published).toEqual([{ type: "decision.made", sessionId: "s1", payload: { id: decision.id, fork: "permission.risk", rung: "model", action: "critical", confidence: decision.confidence, mode: "active" } }]);
  });

  it("DCO1.10 with exploration on, a decision of a model explores at random with its propensity recorded, from the entropy given", async () => {
    const { layer } = rig({ members: [saying("m", CRITICAL)], policyPatch: { default: { explore: 1 } } });
    const records = [];
    for (let i = 0; i < 12; i++) records.push((await layer.decideNamed("permission.risk", rm)).record);
    expect(records.every((r) => r.explored)).toBe(true);
    expect(records.every((r) => Math.abs(r.propensity - 0.5) < 1e-9)).toBe(true);
    expect(new Set(records.map((r) => r.action)).size).toBeGreaterThan(1);
    const again = rig({ members: [saying("m", CRITICAL)], policyPatch: { default: { explore: 1 } } });
    const replay = [];
    for (let i = 0; i < 12; i++) replay.push((await again.layer.decideNamed("permission.risk", rm)).action);
    expect(replay).toEqual(records.map((r) => r.action));
  });

  it("DCO1.11 the calibration the layer starts with is applied to a member's answers, and the raw answers are kept", async () => {
    const book = parseCalibration({
      entries: [{ fork: "test.gate", member: "m", version: "v1", question: "q", calibrator: { kind: "temperature", temperature: 1.5 }, fitted: { n: 50, at: 1, eceBefore: 0.4, eceAfter: 0.05, brierBefore: 0.3, brierAfter: 0.1 } }],
    });
    const { layer } = rig({ members: [sure("m", 0.97)], calibration: book });
    expect(layer.calibration().entries).toHaveLength(1);
    const decision = await layer.decide(gate(), { text: "x" });
    expect(decision.record.raw?.["q"]?.distribution["true"]).toBeCloseTo(0.97, 12);
    expect(decision.record.answers["q"]!.distribution["true"]).toBeLessThan(0.95);
    expect(decision.confidence).toBeGreaterThan(0.9);
    expect(decision.confidence).toBeLessThan(0.95);
  });

  it("DCO1.12 the shipped calibration book parses and starts a layer", () => {
    expect(rig({ calibration: shippedCalibration() }).layer.calibration().entries).toEqual(shippedCalibration().entries);
  });

  it("DCO1.14 a decision is read back by its id, and decisions by a filter, from the log", async () => {
    const { layer } = rig({ members: [saying("m", CRITICAL)] });
    const first = await layer.decideNamed("permission.risk", rm, { session: "s1" });
    await layer.decideNamed("permission.risk", rm, { session: "s2" });
    expect(await layer.record(first.id)).toEqual(first.record);
    expect(await layer.record("dec-99")).toBeUndefined();
    expect((await layer.records()).map((r) => r.session)).toEqual(["s1", "s2"]);
    expect((await layer.records({ session: "s2" })).map((r) => r.id)).toEqual(["dec-1"]);
  });

  it("DCO1.15 the dispatch fork takes the tier the session is on, either of the two", async () => {
    const { layer } = rig({ members: [saying("m", { score: [0.1, 0.1, 0.1, 0.7] })] });
    for (const current of ["small", "large"] as const) {
      const decision = await layer.decideNamed("dispatch", { context: 20_000, current, task: "rename a symbol everywhere" });
      expect(decision.record.input).toMatchObject({ current, context: 20_000 });
    }
    await expect(layer.decideNamed("dispatch", { context: 1, current: "", task: "t" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("DCO1.13 a host's own fork is registered like the built-in ones, and decided by name with its parser", async () => {
    const { layer } = rig({ members: [sure("m", 0.97)] });
    layer.register(gate({}, "host.gate"), (raw) => ({ text: String((raw as { t: unknown }).t) }));
    expect(layer.registry.has("host.gate")).toBe(true);
    expect((await layer.decideNamed("host.gate", { t: 5 })).record.input).toEqual({ text: "5" });
    expect(() => layer.register(gate({}, "host.gate"))).toThrow(/already registered/);
  });
});

describe("induced rules on a fork (withRules)", () => {
  const act = (a: Act): Fork<In, Act> => gate({ rule: () => a });

  it("DCO2.1 the fork's own rule wins over an induced one", () => {
    const fork = withRules(gate({ rule: (i) => (i.text === "own" ? "deny" : undefined), actions: () => ["allow", "deny"] }), () => "allow");
    expect(fork.rule!({ text: "own" })).toBe("deny");
    expect(fork.rule!({ text: "other" })).toBe("allow");
  });

  it("DCO2.2 an induced rule is asked about the fork's description of the input, not the input", () => {
    const seen: unknown[] = [];
    const fork = withRules(gate({ describe: (i) => ({ described: i.text }) }), (facts) => (seen.push(facts), undefined));
    expect(fork.rule!({ text: "abc" })).toBeUndefined();
    expect(seen).toEqual([{ described: "abc" }]);
  });

  it("DCO2.3 an induced answer that is not among the actions the fork lists for the input is ignored", () => {
    const fork = withRules(gate({ actions: () => ["allow", "deny"] }), () => "maybe");
    expect(fork.rule!({ text: "x" })).toBeUndefined();
  });

  it("DCO2.4 a fork that lists no actions takes the induced answer as it is; the rest of the fork is untouched", () => {
    const base = gate({ floor: () => "deny", restrictiveness: (a) => (a === "deny" ? 1 : 0) });
    const fork = withRules(base, () => "allow");
    expect(fork.rule!({ text: "x" })).toBe("allow");
    expect(fork.floor).toBe(base.floor);
    expect(fork.ask).toBe(base.ask);
    expect(fork.id).toBe(base.id);
    expect(act("allow").rule!({ text: "x" })).toBe("allow");
  });

  it("DCO2.5 actions are compared as values: a key order does not matter", () => {
    const base = { ...gate({ actions: () => [{ b: 1, a: 2 }] as unknown as Act[] }) } as unknown as Fork<In, Act>;
    const fork = withRules(base, () => ({ a: 2, b: 1 }));
    expect(fork.rule!({ text: "x" })).toEqual({ a: 2, b: 1 });
  });
});

describe("standardLabelOf", () => {
  const withOutcome = (outcome: ReturnType<typeof humanOutcome>, answers = { q: yes(0.9), pick: chose({ a: 0.6, b: 0.4 }), lvl: levels([0.1, 0.9]) }) => record({ answers, outcome });

  it("DCO3.1 a label keyed by question id names the option that was right for that question", () => {
    const r = withOutcome(humanOutcome("overridden", { label: { q: "false", pick: "b" } }));
    expect(standardLabelOf(r, "q")).toBe("false");
    expect(standardLabelOf(r, "pick")).toBe("b");
  });

  it("DCO3.2 a label's number or boolean is the option's name; any other value is no label; a question the label leaves out falls through to correctness", () => {
    const r = withOutcome(humanOutcome("overridden", { correct: true, label: { q: true, lvl: 1, pick: ["a"] } }));
    expect(standardLabelOf(r, "q")).toBe("true");
    expect(standardLabelOf(r, "lvl")).toBe("1");
    expect(standardLabelOf(r, "pick")).toBeUndefined();
    const partial = withOutcome(humanOutcome("correct", { correct: true, label: { q: "false" } }));
    expect(standardLabelOf(partial, "pick")).toBe("a");
  });

  it("DCO3.3 an outcome that says the decision was correct makes the answer's top option the label, for every question type", () => {
    const r = withOutcome(humanOutcome("correct", { correct: true }));
    expect(standardLabelOf(r, "q")).toBe("true");
    expect(standardLabelOf(r, "pick")).toBe("a");
    expect(standardLabelOf(r, "lvl")).toBe("1");
  });

  it("DCO3.4 an outcome that says it was wrong gives a boolean question the other option, and no label to a choice or a score", () => {
    const r = withOutcome(humanOutcome("incorrect", { correct: false }));
    expect(standardLabelOf(r, "q")).toBe("false");
    expect(standardLabelOf(r, "pick")).toBeUndefined();
    expect(standardLabelOf(r, "lvl")).toBeUndefined();
    const no = withOutcome(humanOutcome("incorrect", { correct: false }), { q: yes(0.2), pick: answer("choice", { a: 1, b: 1 }), lvl: levels([1, 1]) });
    expect(standardLabelOf(no, "q")).toBe("true");
  });

  it("DCO3.5 no outcome, no verdict on correctness, a label that is not an object, or no answer to the question: no label", () => {
    expect(standardLabelOf(record({ answers: { q: yes(0.9) } }), "q")).toBeUndefined();
    expect(standardLabelOf(withOutcome(humanOutcome("approved")), "q")).toBeUndefined();
    expect(standardLabelOf(withOutcome(humanOutcome("overridden", { label: "allow" })), "q")).toBeUndefined();
    expect(standardLabelOf(withOutcome(humanOutcome("overridden", { label: ["q"] })), "q")).toBeUndefined();
    expect(standardLabelOf(withOutcome(humanOutcome("overridden", { label: null })), "q")).toBeUndefined();
    expect(standardLabelOf(withOutcome(humanOutcome("correct", { correct: true })), "missing")).toBeUndefined();
  });

  it("DCO3.6 the label comes from the calibrated answers the verdict was taken from, not the raw ones", () => {
    const r = record({ answers: { q: yes(0.4) }, raw: { q: yes(0.9) }, outcome: humanOutcome("correct", { correct: true }) });
    expect(standardLabelOf(r, "q")).toBe("false");
  });

  it("DCO3.7 a decision the authority's floor raised has no label from `correct`: it vouches for the raised action, and the answers were about another", async () => {
    const { layer } = rig({ members: [sure("m", 0.95)] });
    const raised = await layer.decide(gate({ floor: () => "deny", restrictiveness: (a) => (a === "deny" ? 1 : 0) }), { text: "x" });
    const plain = await layer.decide(gate(), { text: "x" });
    expect(raised.record).toMatchObject({ action: "deny", verdict: "allow" });
    for (const [decision, correct, label] of [[raised, true, undefined], [raised, false, undefined], [plain, true, "true"], [plain, false, "false"]] as const) {
      await layer.outcome(decision.id, humanOutcome(correct ? "correct" : "incorrect", { correct }));
      expect(standardLabelOf((await layer.record(decision.id))!, "q"), `${decision.id} ${correct}`).toBe(label);
    }
    // nothing was said about the raised decision that a calibration can be fitted on
    const records = await layer.records();
    expect(standardLabelOf(records[0]!, "q")).toBeUndefined();
  });

  it("DCO3.8 a decision that explored has a label only when its draw landed on the verdict the answers were about", async () => {
    const { layer } = rig({ members: [sure("m", 0.95)], policyPatch: { default: { explore: 1 } } });
    const landed = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const decision = await layer.decide(gate({ actions: () => ["allow", "deny"] }), { text: "x" });
      await layer.outcome(decision.id, humanOutcome("correct", { correct: true }));
      const stored = (await layer.record(decision.id))!;
      expect(stored).toMatchObject({ explored: true, verdict: "allow" });
      expect(standardLabelOf(stored, "q"), `${stored.id} ${String(stored.action)}`).toBe(stored.action === "allow" ? "true" : undefined);
      landed.add(String(stored.action));
    }
    expect([...landed].sort()).toEqual(["allow", "deny"]);
  });

  it("DCO3.9 a record that does not say what its verdict was is taken to have acted on it unless it explored", () => {
    const outcome = humanOutcome("correct", { correct: true });
    expect(standardLabelOf(record({ answers: { q: yes(0.9) }, outcome }), "q")).toBe("true");
    expect(standardLabelOf(record({ answers: { q: yes(0.9) }, outcome, explored: true, propensity: probability(0.9) }), "q")).toBeUndefined();
    expect(standardLabelOf(record({ answers: { q: yes(0.9) }, outcome, action: "allow", verdict: "allow" }), "q")).toBe("true");
    expect(standardLabelOf(record({ answers: { q: yes(0.9) }, outcome, action: "deny", verdict: "allow" }), "q")).toBeUndefined();
    expect(standardLabelOf(record({ answers: { q: yes(0.9) }, outcome, action: { b: 1, a: 2 }, verdict: { a: 2, b: 1 } }), "q")).toBe("true");
  });

  it("DCO3.10 an outcome that names the right option keeps its label for a decision that was raised or explored", () => {
    const named = humanOutcome("overridden", { label: { q: "false" } });
    expect(standardLabelOf(record({ answers: { q: yes(0.9) }, outcome: named, action: "deny", verdict: "allow", explored: true }), "q")).toBe("false");
  });
});

describe("AttentionInbox", () => {
  const item = (patch: Partial<AttentionItem> = {}): AttentionItem => ({ id: "i1", session: "s1", kind: "review", since: 5_000, blocked: false, ...patch });
  const inbox = () => new AttentionInbox(shippedSettings().attention);

  it("DCO4.1 an added item is held, and listed in the order added, as copies", () => {
    const box = inbox();
    expect(box.size).toBe(0);
    box.add(item({ id: "b" }));
    const added = box.add(item({ id: "a" }));
    added.blocked = true;
    expect(box.list().map((i) => i.id)).toEqual(["b", "a"]);
    expect(box.get("a")!.blocked).toBe(false);
    box.list()[0]!.session = "changed";
    expect(box.get("b")!.session).toBe("s1");
    expect(box.size).toBe(2);
    expect(box.get("none")).toBeUndefined();
  });

  it("DCO4.2 adding an id again updates the item and keeps the earlier time it began waiting", () => {
    const box = inbox();
    box.add(item({ since: 5_000, text: "first" }));
    expect(box.add(item({ since: 9_000, text: "second", blocked: true }))).toMatchObject({ since: 5_000, text: "second", blocked: true });
    expect(box.add(item({ since: 1_000 })).since).toBe(1_000);
    expect(box.size).toBe(1);
  });

  it("DCO4.3 an item that is not an attention item is refused as invalid", () => {
    expect(() => inbox().add({ id: "", session: "s", kind: "review", since: 0, blocked: false })).toThrow(DecisionError);
    expect(() => inbox().add({ id: "", session: "s", kind: "review", since: 0, blocked: false })).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(() => inbox().add({ ...item(), kind: "bogus" as AttentionItem["kind"] })).toThrow(/invalid attention item/);
  });

  it("DCO4.4 resolving takes an item off, and says whether there was one", () => {
    const box = inbox();
    box.add(item());
    expect(box.resolve("i1")).toBe(true);
    expect(box.resolve("i1")).toBe(false);
    expect(box.size).toBe(0);
  });

  it("DCO4.5 a session's items are cleared, all of them or only of the kinds given, and only that session's", () => {
    const box = inbox();
    box.add(item({ id: "r1", kind: "review" }));
    box.add(item({ id: "f1", kind: "failure" }));
    box.add(item({ id: "p1", kind: "permission", blocked: true }));
    box.add(item({ id: "r2", kind: "review", session: "s2" }));
    expect(box.clearSession("s1", ["review", "idle"])).toBe(1);
    expect(box.list().map((i) => i.id)).toEqual(["f1", "p1", "r2"]);
    expect(box.clearSession("s1")).toBe(2);
    expect(box.list().map((i) => i.id)).toEqual(["r2"]);
    expect(box.clearSession("nobody")).toBe(0);
  });

  it("DCO4.6 ranking puts a blocked permission before a review, whatever the order added, with reasons", () => {
    const box = inbox();
    box.add(item({ id: "review", kind: "review" }));
    box.add(item({ id: "perm", kind: "permission", blocked: true }));
    const ranked = box.rank(5_000 + 60_000);
    expect(ranked.map((r) => r.item.id)).toEqual(["perm", "review"]);
    expect(ranked[0]!.reasons.some((r) => r.startsWith("blocked"))).toBe(true);
    expect(ranked[0]!.priority).toBeGreaterThan(ranked[1]!.priority);
    expect(box.list().map((i) => i.id)).toEqual(["review", "perm"]);
  });
});
