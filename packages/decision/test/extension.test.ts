import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { Ensemble, probability } from "@harness/cognitive";
import { decisionExtension, DEFAULT_LIMIT } from "../src/extension.ts";
import type { DecisionExtensionOptions } from "../src/extension.ts";
import { switchPlan } from "../src/dispatch.ts";
import { toSpan } from "../src/otel.ts";
import { forkId } from "../src/types.ts";
import { yes } from "./loops-fixtures.ts";
import { gate as evoGate, reader, records as evoRecords, SALT, settings as evoSettings } from "./evolve-fixtures.ts";
import { humanOutcome, put, rig, saying, shippedSettings } from "./compose-fixtures.ts";
import type { RigOptions } from "./compose-fixtures.ts";

const right = humanOutcome("correct", { correct: true });
const wrong = humanOutcome("incorrect", { correct: false });
const CRITICAL = { boolean: 0.95, score: [0, 0, 0.1, 0.9] };

function setup(over: RigOptions = {}, options: DecisionExtensionOptions = {}) {
  const r = rig(over);
  const extension = decisionExtension(r.layer, options);
  // the replies are JSON that each test reads field by field
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (op: string, input?: unknown): Promise<any> => extension.operations![op]!(input);
  return { ...r, extension, call };
}
const failure = async (promise: Promise<unknown>): Promise<string> => (await promise.then(() => undefined, (e: Error) => e.message)) ?? "";

describe("the decision extension", () => {
  it("DCX1.1 it is `decision`, brings no models and requires nothing, and serves its operations by name", () => {
    const { extension } = setup();
    expect(extension.id).toBe("decision");
    expect(extension.models).toEqual([]);
    expect(extension.requires).toBeUndefined();
    expect(Object.keys(extension.operations!).sort()).toEqual(
      ["calibrate", "decide", "dispatch", "distill", "estimate", "evolve", "forks", "inbox", "induce", "outcome", "policy", "record", "report", "rules", "spans", "status", "thresholds"].sort(),
    );
  });

  it("DCX1.2 installed in an ensemble it is served as decision.<op>", async () => {
    const { extension } = setup();
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.install(extension);
    expect(ensemble.extensions()).toEqual(["decision"]);
    const status = await ensemble.operation("decision.status")!({});
    expect(status).toMatchObject({ policy: "policy-t", decisions: 0 });
    expect(ensemble.operation("decision.nope")).toBeUndefined();
  });

  it("DCX1.3 status gives the policy version, the forks with their policy, the members as served, the log size, the calibration and the rules by state", async () => {
    const { call, log } = setup({ members: [saying("m", CRITICAL)] });
    await put(log);
    const status = await call("status");
    expect(status).toMatchObject({ policy: "policy-t", decisions: 1, calibration: { entries: 0 }, lifecycle: { candidate: 0, shadow: 0, active: 0, retired: 0 }, members: [{ id: "m", version: "v1" }] });
    expect(status.forks.map((f: { id: string }) => f.id)).toEqual(["permission.risk", "attention", "stuck", "dispatch"]);
    expect(status.forks[0].policy).toMatchObject({ act: 0.9, mode: "active" });
  });

  it("DCX1.4 forks lists the registered forks, and policy gives the policy data with each fork's resolved policy", async () => {
    const { call } = setup({ policyPatch: { forks: { attention: { act: 0.7 } } } });
    expect((await call("forks")).forks.map((f: { id: string }) => f.id)).toEqual(["permission.risk", "attention", "stuck", "dispatch"]);
    const policy = await call("policy");
    expect(policy.policy.version).toBe("policy-t");
    expect(policy.forks.find((f: { id: string }) => f.id === "attention").policy.act).toBe(0.7);
    expect(policy.forks.find((f: { id: string }) => f.id === "stuck").policy.act).toBe(0.9);
  });

  it("DCX1.5 an input that is not an object of the operation's shape is refused before anything runs, naming the operation and what is wrong", async () => {
    const { call, log } = setup({ members: [saying("m", CRITICAL)] });
    expect(await failure(call("decide", { fork: "permission.risk", input: { tool: "x" }, extra: 1 }))).toMatch(/^invalid decision\.decide input\n/);
    expect(await failure(call("decide", { input: {} }))).toContain("invalid decision.decide input");
    expect(await failure(call("status", { surprise: true }))).toContain("invalid decision.status input");
    expect(await failure(call("report", { fork: "Not A Fork" }))).toContain("invalid decision.report input");
    expect(await failure(call("calibrate", { minSamples: 0 }))).toContain("invalid decision.calibrate input");
    expect(await log.size()).toBe(0);
  });

  it("DCX1.6 an operation called with no input takes it as an empty object", async () => {
    const { call } = setup();
    expect((await call("forks", undefined)).forks).toHaveLength(4);
    expect((await call("rules", undefined)).counts).toEqual({ candidate: 0, shadow: 0, active: 0, retired: 0 });
  });
});

describe("decide, record, outcome and spans", () => {
  it("DCX2.1 decide runs a fork by name on its input, with the session and saga, and returns the decision with its record", async () => {
    const { call, log } = setup({ members: [saying("m", CRITICAL)] });
    const decision = await call("decide", { fork: "permission.risk", input: { tool: "Bash", command: "rm -rf build" }, session: "s1", correlation: "cor-2" });
    expect(decision).toMatchObject({ action: "critical", rung: "model", active: true, needsHuman: false, mode: "active", explored: false });
    expect(decision.record).toMatchObject({ id: decision.id, session: "s1", correlation: "cor-2", fork: "permission.risk" });
    expect((await log.get(decision.id))!.session).toBe("s1");
    const bare = await call("decide", { fork: "permission.risk", input: { tool: "Bash" } });
    expect("session" in bare.record).toBe(false);
  });

  it("DCX2.2 a failure keeps the DecisionError's code in the message", async () => {
    const { call } = setup();
    expect(await failure(call("decide", { fork: "nope", input: {} }))).toBe("decision.decide failed (unknown-fork): no fork is registered as nope");
    expect(await failure(call("decide", { fork: "permission.risk", input: { tool: "" } }))).toMatch(/^decision\.decide failed \(invalid\): invalid permission facts/);
  });

  it("DCX2.3 record by id gives the decision, and an unknown id is an error", async () => {
    const { call, log } = setup();
    const made = await put(log);
    expect((await call("record", { id: made.id })).record).toEqual(made);
    expect(await failure(call("record", { id: "dec-77" }))).toBe("decision.record failed (invalid): no decision dec-77");
  });

  it("DCX2.4 record by filter gives matching decisions, a hundred at most unless limit says, and whether there are more", async () => {
    const { call, log } = setup();
    for (let i = 0; i < 5; i++) await put(log, { session: i < 3 ? "s1" : "s2" });
    expect((await call("record", { session: "s1" })).records.map((r: { id: string }) => r.id)).toEqual(["dec-0", "dec-1", "dec-2"]);
    const limited = await call("record", { limit: 2 });
    expect(limited.records.map((r: { id: string }) => r.id)).toEqual(["dec-0", "dec-1"]);
    expect(limited.more).toBe(true);
    expect((await call("record", { limit: 5 })).more).toBe(false);
    expect((await call("record", { after: "dec-3" })).records.map((r: { id: string }) => r.id)).toEqual(["dec-4"]);
    expect((await call("record", {})).records).toHaveLength(5);
    expect(DEFAULT_LIMIT).toBe(100);
  });

  it("DCX2.9 a filter takes either mode, and nothing else", async () => {
    const { call, log } = setup();
    await put(log, { mode: "active" });
    await put(log, { mode: "shadow" });
    expect((await call("record", { mode: "active" })).records.map((r: { id: string }) => r.id)).toEqual(["dec-0"]);
    expect((await call("record", { mode: "shadow" })).records.map((r: { id: string }) => r.id)).toEqual(["dec-1"]);
    expect(await failure(call("record", { mode: "paused" }))).toContain("invalid decision.record input");
  });

  it("DCX2.5 the default page is a hundred decisions", async () => {
    const { call, log } = setup();
    for (let i = 0; i < DEFAULT_LIMIT + 1; i++) await put(log);
    const found = await call("record", {});
    expect(found.records).toHaveLength(DEFAULT_LIMIT);
    expect(found.more).toBe(true);
  });

  it("DCX2.6 an outcome is attached to a decision, at the layer's time unless it brings its own", async () => {
    const { call, log, clock } = setup();
    const made = await put(log);
    clock.advance(500);
    expect(await call("outcome", { id: made.id, outcome: { source: "human", kind: "correct", correct: true } })).toEqual({ id: made.id, attached: true });
    expect((await log.get(made.id))!.outcome).toEqual({ at: 10_500, source: "human", kind: "correct", correct: true });
    await call("outcome", { id: made.id, outcome: { at: 42, source: "judge", kind: "incorrect", correct: false, by: "j" } });
    expect((await log.get(made.id))!.outcome).toEqual({ at: 42, source: "judge", kind: "incorrect", correct: false, by: "j" });
  });

  it("DCX2.7 an outcome for an unknown decision, or one that is not an outcome, is an error", async () => {
    const { call } = setup();
    expect(await failure(call("outcome", { id: "dec-5", outcome: { source: "human", kind: "correct" } }))).toBe("decision.outcome failed (invalid): no decision dec-5");
    expect(await failure(call("outcome", { id: "dec-5", outcome: { source: "robot", kind: "correct" } }))).toContain("invalid decision.outcome input");
    expect(await failure(call("outcome", { id: "dec-5", outcome: { source: "human", kind: "correct", bogus: 1 } }))).toContain("invalid decision.outcome input");
  });

  it("DCX2.8 spans are the decisions as OpenTelemetry spans, narrowed by the filter", async () => {
    const { call, log } = setup();
    const a = await put(log, { session: "s1", outcome: right });
    await put(log, { session: "s2" });
    const all = await call("spans", {});
    expect(all.spans).toHaveLength(2);
    expect(all.more).toBe(false);
    expect(all.spans[0]).toEqual(JSON.parse(JSON.stringify(toSpan(a))));
    expect((await call("spans", { filter: { session: "s2" } })).spans).toHaveLength(1);
    expect((await call("spans", { filter: { limit: 1 } })).more).toBe(true);
  });
});

describe("measuring", () => {
  it("DCX3.1 report is the layer's report, for one fork or all, with a filter", async () => {
    const { call, log, layer } = setup();
    await put(log, { outcome: right });
    await put(log, { mode: "shadow" });
    expect((await call("report", {})).reports).toEqual(JSON.parse(JSON.stringify(await layer.report())));
    expect((await call("report", { fork: "test.gate", filter: { mode: "shadow" } })).reports[0].decisions).toBe(1);
    expect((await call("report", { fork: "nope.fork" })).reports).toEqual([]);
  });

  it("DCX3.2 calibrate fits and installs a book and says what it fitted", async () => {
    const { call, log, layer } = setup();
    for (let i = 0; i < 20; i++) await put(log, { member: "m", memberVersion: "v1", answers: { q: yes(0.95) }, outcome: i % 2 === 0 ? right : wrong });
    expect(await call("calibrate", { minSamples: 100 })).toEqual({ fitted: [], entries: 0 });
    const result = await call("calibrate", { at: 77, minSamples: 10 });
    expect(result.entries).toBe(1);
    expect(result.fitted[0]).toMatchObject({ member: "m", question: "q", fitted: { at: 77, n: 20 } });
    expect(layer.calibration().entries).toHaveLength(1);
    expect((await call("calibrate", {})).fitted).toEqual([]);
  });

  it("DCX3.3 thresholds gives the recommended act threshold with the bound", async () => {
    const { call, log } = setup();
    for (let i = 0; i < 200; i++) await put(log, { outcome: right });
    const result = await call("thresholds", { fork: "test.gate", targetRisk: 0.1, delta: 0.1, bound: "hoeffding" });
    expect(result).toMatchObject({ fork: "test.gate", threshold: 0.9, samples: 200, currentAct: 0.9, risk: 0 });
    expect(await failure(call("thresholds", { fork: "test.gate", targetRisk: 5, delta: 0.1, bound: "hoeffding" }))).toMatch(/^decision\.thresholds failed: /);
    expect(await failure(call("thresholds", { fork: "test.gate", targetRisk: 0.1, delta: 0.1, bound: "other" }))).toContain("invalid decision.thresholds input");
  });

  it("DCX3.4 estimate values acting on another threshold from what was logged", async () => {
    const { call, log } = setup();
    for (let i = 0; i < 4; i++) await put(log, { outcome: right });
    for (let i = 0; i < 4; i++) await put(log, { confidence: probability(0.6), outcome: i === 0 ? right : wrong });
    const result = await call("estimate", { fork: "test.gate", target: { act: 0.5 } });
    expect(result.target.estimate).toBeCloseTo(5 / 8, 12);
    expect(result.current.estimate).toBe(1);
    expect(await failure(call("estimate", { fork: "test.gate", target: {} }))).toContain("target.act");
    expect(await failure(call("estimate", { fork: "test.gate", target: { act: 2 } }))).toContain("invalid decision.estimate input");
    // the other fields of a policy are taken (only the threshold is estimated) within their ranges
    for (const target of [{ act: 0.5, mode: "active" }, { act: 0.5, mode: "shadow" }, { act: 0.5, rotate: 1 }, { act: 0.5, rotate: 16 }, { act: 0.5, verify: 0.2, accept: 0.7, explore: 0.1 }]) {
      expect((await call("estimate", { fork: "test.gate", target })).target.act).toBe(0.5);
    }
    for (const target of [{ act: 0.5, mode: "paused" }, { act: 0.5, rotate: 0 }, { act: 0.5, rotate: 17 }, { act: 0.5, rotate: 1.5 }, { act: 0.5, extra: 1 }]) {
      expect(await failure(call("estimate", { fork: "test.gate", target }))).toContain("invalid decision.estimate input");
    }
  });

  it("DCX3.5 distill gives examples as JSON lines, with counts", async () => {
    const { call, log } = setup();
    for (let i = 0; i < 20; i++) await put(log, { answers: { q: yes(0.9) }, outcome: right });
    const all = await call("distill", { fork: "test.gate", holdout: 0 });
    expect(all).toMatchObject({ examples: 20, holdout: 0 });
    const lines = all.jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(20);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: "dec-0:q", label: "true", split: "train" });
    const held = await call("distill", { holdout: 1, salt: "x" });
    expect(held).toMatchObject({ examples: 20, holdout: 20 });
    expect(await failure(call("distill", { holdout: 2 }))).toMatch(/^decision\.distill failed: /);
  });
});

describe("the loops", () => {
  const item = (id: string, kind: "permission" | "review") => ({ id, session: "s", kind, since: 1_000, blocked: kind === "permission" });
  const label = (action: string) => humanOutcome("overridden", { label: action });

  it("DCX4.1 induce adds candidate rules for a fork, and rules lists them with their state", async () => {
    const { call, log } = setup();
    for (let i = 0; i < 8; i++) await put(log, { fork: forkId("attention"), input: item(`a${i}`, i % 2 === 0 ? "permission" : "review"), session: `train-${i}`, answers: {}, outcome: label(i % 2 === 0 ? "urgent" : "low") });
    const induced = await call("induce", { fork: "attention", fields: ["kind"], minSupport: 3, minPurity: 0.9, maxRules: 4, maxConditions: 1 });
    expect(induced.rules.map((e: { rule: { action: string }; state: string }) => [e.rule.action, e.state])).toEqual([["urgent", "candidate"], ["low", "candidate"]]);
    const rules = await call("rules", {});
    expect(rules.counts.candidate).toBe(2);
    expect((await call("rules", { fork: "stuck" })).rules).toEqual([]);
    expect((await call("rules", { fork: "attention" })).rules).toHaveLength(2);
    const again = await call("induce", { fork: "attention", fields: ["kind"], minSupport: 3, minPurity: 0.9, maxRules: 4, maxConditions: 1 });
    expect(again.rules.every((e: { added: boolean }) => e.added === false)).toBe(true);
    const everyField = await call("induce", { fork: "attention", minSupport: 3, minPurity: 0.9, maxRules: 4, maxConditions: 2 });
    expect(everyField.records).toBe(8);
    expect(await failure(call("induce", { fork: "attention", minSupport: 0, minPurity: 0.9, maxRules: 4, maxConditions: 1 }))).toContain("invalid decision.induce input");
    expect(await failure(call("induce", { fork: "attention", minSupport: 3, minPurity: 0.9, maxRules: 4, maxConditions: 3 }))).toContain("invalid decision.induce input");
    expect(await failure(call("induce", { fork: "nope", minSupport: 3, minPurity: 0.9, maxRules: 4, maxConditions: 1 }))).toBe("decision.induce failed (unknown-fork): no fork is registered as nope");
  });

  async function evolving(options: DecisionExtensionOptions) {
    const s = setup({ members: [reader()], settings: { ...shippedSettings(), evolve: evoSettings() }, holdoutSalt: SALT }, options);
    s.layer.register(evoGate(), (raw) => raw as never);
    for (const rec of evoRecords({ held: { net: 8, read: 6, disk: 2 }, train: { net: 4, read: 3, disk: 1 } }, { note: (_, n) => `case${n}` })) {
      while ((await s.log.next()) !== rec.id);
      await s.log.append(rec);
    }
    return s;
  }
  const EDITS = [{ question: "risky", target: "instructions", text: "Is the call risky? Watch for: disk, net." }];

  it("DCX4.2 evolve uses the proposer the extension was given", async () => {
    const asked: unknown[] = [];
    const { call } = await evolving({ proposer: async (input) => (asked.push(input), EDITS) });
    const result = await call("evolve", { fork: "evo.gate" });
    expect(result).toMatchObject({ status: "accepted", version: "v1" });
    expect(asked).toHaveLength(1);
  });

  it("DCX4.3 evolve with no proposer asks the ensemble's language model, with the instructions and token limit of the data", async () => {
    const model = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text: JSON.stringify({ edits: EDITS }) }], finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] }) });
    const { call, layer } = await evolving({ ensemble: { languageModel: () => model } });
    const result = await call("evolve", { fork: "evo.gate", member: "reader" });
    expect(result).toMatchObject({ status: "accepted" });
    const sent = model.doGenerateCalls[0]!;
    expect(sent.prompt[0]).toEqual({ role: "system", content: layer.settings.evolve.proposer.system });
    expect(sent.maxOutputTokens).toBe(layer.settings.evolve.proposer.maxTokens);
  });

  it("DCX4.4 evolve with neither a proposer nor an ensemble says what is missing", async () => {
    const { call } = await evolving({});
    expect(await failure(call("evolve", { fork: "evo.gate" }))).toMatch(/^decision\.evolve failed \(unavailable\): there is no proposer/);
  });

  it("DCX4.5 evolve takes starting criteria as data, and refuses a member or fork it does not know", async () => {
    const { call } = await evolving({ proposer: async () => EDITS });
    expect(await failure(call("evolve", { fork: "evo.gate", member: "ghost" }))).toBe("decision.evolve failed (no-member): no member is named ghost");
    expect(await failure(call("evolve", { fork: "nope.fork" }))).toContain("(unknown-fork)");
    expect(await failure(call("evolve", { fork: "evo.gate", initial: { fork: "evo.gate" } }))).toContain("invalid decision.evolve input");
    const initial = { fork: "evo.gate", version: "start", questions: { risky: { type: "boolean", instructions: "Is the call risky? Watch for: disk.", criteria: { true: "the call touches something it should not", false: "the call is harmless" } } } };
    expect(await call("evolve", { fork: "evo.gate", initial })).toMatchObject({ status: "accepted" });
  });
});

describe("the inbox and the dispatch plan", () => {
  const item = (id: string, kind: "permission" | "review") => ({ id, session: "s1", kind, since: 10_000, blocked: kind === "permission" });

  it("DCX5.1 inbox adds items, resolves items, and gives what a person should look at first as of the layer's time", async () => {
    const { call, clock } = setup();
    clock.advance(60_000);
    const first = await call("inbox", { items: [item("r", "review"), item("p", "permission")] });
    expect(first).toMatchObject({ added: 2, resolved: 0 });
    expect(first.ranked.map((r: { item: { id: string } }) => r.item.id)).toEqual(["p", "r"]);
    const second = await call("inbox", { resolve: ["p", "ghost"] });
    expect(second).toMatchObject({ added: 0, resolved: 1 });
    expect(second.ranked.map((r: { item: { id: string } }) => r.item.id)).toEqual(["r"]);
    expect((await call("inbox", {})).ranked).toHaveLength(1);
    expect(await failure(call("inbox", { items: [{ id: "x" }] }))).toContain("invalid decision.inbox input");
  });

  it("DCX5.2 dispatch is the switching plan on the data's prices and hysteresis, defaulting to moving from large to small in steps of the data's size", async () => {
    const { call, layer } = setup();
    const { prices, hysteresis, stepTokens } = layer.settings.dispatch;
    const plan = await call("dispatch", { context: 50_000, expectedStretch: 20_000 });
    const expected = switchPlan({ context: 50_000, expectedStretch: 20_000, newOutput: stepTokens, from: "large", to: "small", prices, hysteresis });
    expect(plan).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(plan.switch).toBe(true);
    const explicit = await call("dispatch", { context: 50_000, expectedStretch: 20_000, newOutput: 100, from: "small", to: "large" });
    expect(explicit).toEqual(JSON.parse(JSON.stringify(switchPlan({ context: 50_000, expectedStretch: 20_000, newOutput: 100, from: "small", to: "large", prices, hysteresis }))));
  });

  it("DCX5.3 a switch that never pays has no break-even, as null (JSON has no infinity); an unknown tier is an error", async () => {
    const { call } = setup();
    const same = await call("dispatch", { context: 1000, expectedStretch: 10, from: "large", to: "large" });
    expect(same).toMatchObject({ switch: false, breakEvenStretch: null });
    expect(await failure(call("dispatch", { context: 1000, expectedStretch: 10, to: "medium" }))).toBe('decision.dispatch failed: no prices for tier "medium"');
    expect(await failure(call("dispatch", { context: -1, expectedStretch: 10 }))).toContain("invalid decision.dispatch input");
    const finite = await call("dispatch", { context: 1000, expectedStretch: 100_000 });
    expect(typeof finite.breakEvenStretch).toBe("number");
  });
});
