import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { averageAnswers, answerOf, fromJudgeAnswer } from "../src/member.ts";
import { ForkRegistry, booleanGate, chooseOne } from "../src/fork.ts";
import { MemoryDecisionLog } from "../src/records.ts";
import { DecisionError, DecisionRecordSchema, forkId } from "../src/types.ts";
import type { Answers, Calibrate, Fork, Json, State } from "../src/types.ts";
import { boolAnswer, entropyOf, failing, fixedRng, gate, member, neverAsked, policyJson, rig, sure, testExplorer, withActions, withFloor, withVerify } from "./fork-fixtures.ts";
import type { In } from "./fork-fixtures.ts";

const input: In = { text: "hello" };
const p = probability;

describe("ForkRegistry", () => {
  it("FRK1.1 a registered fork is found by its id, listed, and known", () => {
    const registry = new ForkRegistry();
    const fork = gate();
    registry.register(fork);
    expect(registry.get("test.gate")).toBe(fork);
    expect(registry.has("test.gate")).toBe(true);
    expect(registry.has("other")).toBe(false);
    expect(registry.list()).toEqual([fork]);
  });

  it("FRK1.2 an unknown id is an unknown-fork error naming it", () => {
    const registry = new ForkRegistry();
    expect(() => registry.get("nope")).toThrow(DecisionError);
    expect(() => registry.get("nope")).toThrow(/nope/);
    expect(() => registry.get("nope")).toThrowError(expect.objectContaining({ code: "unknown-fork" }));
  });

  it("FRK1.3 a second fork with the same id is refused and the first stays", () => {
    const registry = new ForkRegistry();
    const first = gate();
    registry.register(first);
    expect(() => registry.register(gate())).toThrowError(expect.objectContaining({ code: "refused", message: expect.stringContaining("test.gate") }));
    expect(registry.get("test.gate")).toBe(first);
  });

  it("FRK1.4 forks are listed in the order they were registered", () => {
    const registry = new ForkRegistry();
    registry.register(gate({}, "b.fork"));
    registry.register(gate({}, "a.fork"));
    expect(registry.list().map((f) => f.id)).toEqual(["b.fork", "a.fork"]);
  });

  it("FRK1.5 parse runs the fork's parser, and passes the input through when it has none", () => {
    const registry = new ForkRegistry();
    registry.register(gate({}, "with.parser"), (raw) => ({ text: String((raw as { t: unknown }).t) }));
    registry.register(gate({}, "without.parser"));
    expect(registry.parse("with.parser", { t: 5 })).toEqual({ text: "5" });
    const raw = { anything: 1 };
    expect(registry.parse("without.parser", raw)).toBe(raw);
  });

  it("FRK1.6 a parser that throws is an invalid error with the parser's message", () => {
    const registry = new ForkRegistry();
    registry.register(gate(), () => {
      throw new Error("text is required");
    });
    expect(() => registry.parse("test.gate", {})).toThrowError(expect.objectContaining({ code: "invalid", message: "text is required" }));
  });

  it("FRK1.7 a parser that throws something that is not an Error still gives a message", () => {
    const registry = new ForkRegistry();
    registry.register(gate(), () => {
      throw "plain string";
    });
    expect(() => registry.parse("test.gate", {})).toThrow("plain string");
  });

  it("FRK1.8 parse of an unknown fork is an unknown-fork error", () => {
    expect(() => new ForkRegistry().parse("nope", {})).toThrowError(expect.objectContaining({ code: "unknown-fork" }));
  });
});

describe("the ladder: rule and model", () => {
  it("FRK2.1 a rule that decides answers at confidence 1 without asking any member", async () => {
    const m = sure("m", 0.99);
    const { decider } = rig({ members: [m] });
    const d = await decider.decide(gate({ rule: (i) => (i.text === "hello" ? "allow" : undefined) }), input);
    expect(d).toMatchObject({ action: "allow", rung: "rule", confidence: 1, needsHuman: false, explored: false, active: true, mode: "active" });
    expect(m.calls).toHaveLength(0);
    expect(d.record.trace).toEqual([{ rung: "rule", outcome: "decided by rule", confidence: 1 }]);
    expect(d.record.answers).toEqual({});
    expect(d.record.member).toBeUndefined();
    expect(d.record.memberVersion).toBeUndefined();
  });

  it("FRK2.2 a rule that has no answer for this input passes the decision to the models", async () => {
    const { decider } = rig({ members: [sure("m", 0.95)] });
    const d = await decider.decide(gate({ rule: () => undefined }), input);
    expect(d.rung).toBe("model");
    expect(d.record.trace[0]).toEqual({ rung: "rule", outcome: "no rule applies" });
  });

  it("FRK2.3 the first member at or above act decides, and later members are not asked", async () => {
    const first = sure("first", 0.95);
    const second = sure("second", 0.99);
    const { decider } = rig({ members: [first, second] });
    const d = await decider.decide(gate(), input);
    expect(d).toMatchObject({ action: "allow", rung: "model", confidence: 0.95 });
    expect(second.calls).toHaveLength(0);
    expect(d.record).toMatchObject({ member: "first", memberVersion: "v1", forkVersion: "f1", fork: "test.gate" });
    expect(d.record.answers["q"]!.top).toBe("true");
    expect(d.record.trace).toEqual([{ rung: "model", member: "first", outcome: "accepted", confidence: 0.95 }]);
  });

  it("FRK2.4 confidence exactly at act is acted on", async () => {
    const { decider } = rig({ members: [sure("m", 0.9)] });
    expect((await decider.decide(gate(), input)).rung).toBe("model");
  });

  it("FRK2.5 a member below act is passed over for the next one, which decides", async () => {
    const weak = sure("weak", 0.45);
    const strong = sure("strong", 0.97);
    const { decider } = rig({ members: [weak, strong], policy: policyJson({ default: { verify: 0.6 } }) });
    const d = await decider.decide(gate(), input);
    expect(d).toMatchObject({ action: "allow", rung: "model", confidence: 0.97 });
    expect(d.record.member).toBe("strong");
    expect(d.record.trace).toEqual([
      { rung: "model", member: "weak", outcome: "below verify", confidence: 0.55 },
      { rung: "model", member: "strong", outcome: "accepted", confidence: 0.97 },
    ]);
  });

  it("FRK2.6 a member that throws is traced and the next member is asked", async () => {
    const { decider } = rig({ members: [failing("down", "connection refused"), sure("up", 0.95)] });
    const d = await decider.decide(gate(), input);
    expect(d.rung).toBe("model");
    expect(d.record.trace[0]).toEqual({ rung: "model", member: "down", outcome: "failed: connection refused" });
  });

  it("FRK2.7 a member that throws something that is not an Error is traced too", async () => {
    const odd = member("odd", () => {
      throw "boom";
    });
    const { decider } = rig({ members: [odd] });
    const d = await decider.decide(gate(), input);
    expect(d.record.trace[0]).toEqual({ rung: "model", member: "odd", outcome: "failed: boom" });
  });

  it("FRK2.8 when every member throws the decision goes to a person and nothing is thrown", async () => {
    const { decider } = rig({ members: [failing("a"), failing("b")] });
    const d = await decider.decide(gate(), input);
    expect(d).toMatchObject({ action: "deny", rung: "human", needsHuman: true, confidence: 0 });
    expect(d.record.trace.map((s) => s.outcome)).toEqual(["failed: unreachable", "failed: unreachable", "a person is asked"]);
  });

  it("FRK2.9 answers the fork cannot separate are traced and the member is skipped", async () => {
    const tied = sure("tied", 0.6);
    const { decider } = rig({ members: [tied] });
    const d = await decider.decide(gate({ interpret: () => undefined }), input);
    expect(d.rung).toBe("human");
    expect(d.record.trace[0]).toEqual({ rung: "model", member: "tied", outcome: "answers do not separate the options" });
  });

  it("FRK2.10 answers that make interpret throw are unusable: traced, skipped", async () => {
    const silent = member("silent", () => ({}));
    const { decider } = rig({ members: [silent, sure("next", 0.95)] });
    const d = await decider.decide(gate(), input);
    expect(d.record.trace[0]).toEqual({ rung: "model", member: "silent", outcome: "unusable answer: no answer to q" });
    expect(d.record.member).toBe("next");
  });

  it("FRK2.11 a member with a fallback identity is asked with the question the fork wrote", async () => {
    const m = sure("m", 0.95);
    const { decider } = rig({ members: [m] });
    await decider.decide(gate(), { text: "the state" });
    expect(m.calls).toEqual([{ state: "the state", questions: { q: { type: "boolean", instructions: "ok?" } } }]);
  });

  it("FRK2.12 with no members and no other rung the decision goes to a person", async () => {
    const { decider } = rig();
    const d = await decider.decide(gate(), input);
    expect(d).toMatchObject({ rung: "human", needsHuman: true, action: "deny", confidence: 0 });
    expect(d.record.trace).toEqual([{ rung: "human", outcome: "a person is asked", confidence: 0 }]);
  });

  it("FRK2.13 a fork's own thresholds decide what its members can act on", async () => {
    const policy = policyJson({ forks: { "test.gate": { act: 0.6, verify: 0.6 } } });
    const { decider } = rig({ members: [sure("m", 0.7)], policy });
    expect((await decider.decide(gate(), input)).rung).toBe("model");
    const { decider: strict } = rig({ members: [sure("m", 0.7)] });
    expect((await strict.decide(gate(), input)).rung).toBe("human");
  });
});

describe("answers are recorded as the member gave them", () => {
  const scored: Fork<In, string> = {
    id: forkId("test.scored"),
    version: "s1",
    ask: () => ({ state: "x", questions: { s: { type: "score", instructions: "how good", criteria: ["bad", "ok", "good"] } } }),
    interpret: () => ({ action: "ok", confidence: probability(0.99) }),
    describe: () => null,
    fallback: () => "none",
  };
  // a score of 0.123 is not what this distribution's mean would be: only the member's own figure says so
  const odd = () => member("odd", () => ({ s: { type: "score", distribution: { "0": p(0.2), "1": p(0.3), "2": p(0.5) }, top: "2", score: 0.123 } }));

  it("FRK2.14 with no rotation and no calibration the record keeps the member's answers exactly", async () => {
    const { decider } = rig({ members: [odd()] });
    const d = await decider.decide(scored, input);
    expect(d.record.answers["s"]).toEqual({ type: "score", distribution: { "0": 0.2, "1": 0.3, "2": 0.5 }, top: "2", score: 0.123 });
  });

  it("FRK2.15 a question that is not rotated keeps the member's answer exactly, whatever the rotation asked for", async () => {
    const { decider } = rig({ members: [odd()], policy: policyJson({ default: { rotate: 4 } }) });
    const d = await decider.decide(scored, input);
    expect(d.record.answers["s"]!.score).toBe(0.123);
  });
});

describe("the ladder: judge", () => {
  const candidate = () => sure("model", 0.7);

  it("FRK3.1 a verdict between verify and act is put to the judge, and accepted at or above accept", async () => {
    const judge = sure("judge", 0.8);
    const { decider } = rig({ members: [candidate()], judge });
    const d = await decider.decide(gate(withVerify), input);
    expect(d).toMatchObject({ action: "allow", rung: "judge", confidence: 0.8, needsHuman: false });
    expect(judge.calls).toEqual([{ state: { text: "hello", action: "allow" }, questions: { correct: { type: "boolean", instructions: "is the action right?" } } }]);
    expect(d.record.member).toBe("model");
    expect(d.record.memberVersion).toBe("v1");
    expect(d.record.answers["q"]).toBeDefined();
    expect(d.record.trace).toEqual([
      { rung: "model", member: "model", outcome: "to be verified", confidence: 0.7 },
      { rung: "judge", member: "judge", outcome: "accepted", confidence: 0.8 },
    ]);
  });

  it("FRK3.2 a judge below accept rejects: the decision goes on to a person", async () => {
    const { decider } = rig({ members: [candidate()], judge: sure("judge", 0.79) });
    const d = await decider.decide(gate(withVerify), input);
    expect(d).toMatchObject({ rung: "human", needsHuman: true });
    expect(d.record.trace[1]).toEqual({ rung: "judge", member: "judge", outcome: "rejected", confidence: 0.79 });
  });

  it("FRK3.3 a judge that rejects hands the decision to the generator when there is one", async () => {
    const generator = async () => ({ action: "deny" as never, confidence: p(0.6) });
    const { decider } = rig({ members: [candidate()], judge: sure("judge", 0.1), generator });
    expect((await decider.decide(gate(withVerify), input)).rung).toBe("generator");
  });

  it("FRK3.4 a judge answer that is not a boolean `correct` counts as p=0 and is traced", async () => {
    for (const answers of [{}, { correct: answerOf("choice", { a: 1, b: 1 }) }] as Answers[]) {
      const judge = member("judge", () => answers);
      const { decider } = rig({ members: [candidate()], judge });
      const d = await decider.decide(gate(withVerify), input);
      expect(d.rung).toBe("human");
      expect(d.record.trace[1]).toEqual({ rung: "judge", member: "judge", outcome: "unusable answer, taken as p=0", confidence: 0 });
    }
  });

  it("FRK3.5 a judge that throws counts as p=0 and is traced", async () => {
    const { decider } = rig({ members: [candidate()], judge: failing("judge", "quota") });
    const d = await decider.decide(gate(withVerify), input);
    expect(d.rung).toBe("human");
    expect(d.record.trace[1]).toEqual({ rung: "judge", member: "judge", outcome: "failed, taken as p=0: quota", confidence: 0 });
  });

  it("FRK3.6 a verdict that could be verified but has no judge is traced and goes on", async () => {
    const { decider } = rig({ members: [candidate()] });
    const d = await decider.decide(gate(withVerify), input);
    expect(d.rung).toBe("human");
    expect(d.record.trace[1]).toEqual({ rung: "judge", outcome: "no judge available" });
  });

  it("FRK3.7 a verdict from a fork with no verify question is traced and goes on", async () => {
    const judge = sure("judge", 0.99);
    const { decider } = rig({ members: [candidate()], judge });
    const d = await decider.decide(gate(), input);
    expect(d.rung).toBe("human");
    expect(judge.calls).toHaveLength(0);
    expect(d.record.trace[1]).toEqual({ rung: "judge", outcome: "the fork has no verify question" });
  });

  it("FRK3.8 the most confident candidate above verify is the one verified", async () => {
    const judge = sure("judge", 0.95);
    const a = sure("a", 0.6);
    const b = sure("b", 0.85);
    const c = sure("c", 0.7);
    const { decider } = rig({ members: [a, b, c], judge });
    const d = await decider.decide(gate(withVerify), input);
    expect(d.rung).toBe("judge");
    expect(d.record.member).toBe("b");
  });

  it("FRK3.9 a candidate that ties an earlier one does not replace it", async () => {
    const { decider } = rig({ members: [sure("first", 0.7), sure("second", 0.7)], judge: sure("judge", 0.95) });
    expect((await decider.decide(gate(withVerify), input)).record.member).toBe("first");
  });

  it("FRK3.10 a verdict below verify is not put to the judge", async () => {
    const judge = sure("judge", 0.99);
    const { decider } = rig({ members: [sure("m", 0.55)], judge, policy: policyJson({ default: { verify: 0.6 } }) });
    const d = await decider.decide(gate(withVerify), input);
    expect(d.rung).toBe("human");
    expect(judge.calls).toHaveLength(0);
  });

  it("FRK3.11 a verdict exactly at verify is put to the judge", async () => {
    const judge = sure("judge", 0.99);
    const { decider } = rig({ members: [sure("m", 0.5)], judge });
    const d = await decider.decide(gate(withVerify), input);
    expect(d.rung).toBe("judge");
  });

  it("FRK3.12 the judge is asked only when no member acted on its own", async () => {
    const judge = sure("judge", 0.99);
    const { decider } = rig({ members: [candidate(), sure("strong", 0.95)], judge });
    const d = await decider.decide(gate(withVerify), input);
    expect(d.rung).toBe("model");
    expect(judge.calls).toHaveLength(0);
  });

  it("FRK3.13 a judge's answer is used at accept exactly", async () => {
    const { decider } = rig({ members: [candidate()], judge: sure("judge", 0.8) });
    expect((await decider.decide(gate(withVerify), input)).confidence).toBe(0.8);
  });
});

describe("the ladder: generator and person", () => {
  it("FRK4.1 the generator is asked with the fork, the input and what was asked, and its verdict is taken as it is", async () => {
    const seen: unknown[] = [];
    const generator = async (f: unknown, i: unknown, asked: unknown) => {
      seen.push([f, i, asked]);
      return { action: "allow" as never, confidence: p(0.66) };
    };
    const fork = gate();
    const { decider } = rig({ members: [sure("m", 0.2)], generator: generator as never });
    const d = await decider.decide(fork, input);
    expect(d).toMatchObject({ rung: "generator", action: "allow", confidence: 0.66, needsHuman: false });
    expect(seen).toEqual([[fork, input, fork.ask(input)]]);
    expect(d.record.member).toBeUndefined();
    expect(d.record.trace.at(-1)).toEqual({ rung: "generator", outcome: "generated", confidence: 0.66 });
  });

  it("FRK4.2 a generator that throws is traced and the decision goes to a person", async () => {
    const { decider } = rig({
      generator: async () => {
        throw new Error("rate limited");
      },
    });
    const d = await decider.decide(gate(), input);
    expect(d.rung).toBe("human");
    expect(d.record.trace).toEqual([
      { rung: "generator", outcome: "failed: rate limited" },
      { rung: "human", outcome: "a person is asked", confidence: 0 },
    ]);
  });

  it("FRK4.3 a generator with no verdict is traced and the decision goes to a person", async () => {
    const { decider } = rig({ generator: async () => undefined });
    const d = await decider.decide(gate(), input);
    expect(d.rung).toBe("human");
    expect(d.record.trace[0]).toEqual({ rung: "generator", outcome: "gave no verdict" });
  });

  it("FRK4.4 the generator is not asked when a member decided", async () => {
    const { decider } = rig({ members: [sure("m", 0.95)], generator: neverAsked });
    expect((await decider.decide(gate(), input)).rung).toBe("model");
  });

  it("FRK4.5 a person is asked with the fork's fallback action and confidence 0", async () => {
    const { decider } = rig();
    const d = await decider.decide(gate({ fallback: () => "allow" }), input);
    expect(d).toMatchObject({ action: "allow", needsHuman: true, rung: "human", confidence: 0 });
  });
});

describe("rotation", () => {
  const abc = () => chooseOne({
    id: "test.choose",
    version: "c1",
    instructions: "which?",
    options: { a: "first", b: "second", c: "third" },
    describe: (i: In) => ({ text: i.text }),
    text: (i: In) => i.text,
    fallback: () => "a",
  });
  /** Content says "b"; a position bias adds weight to whichever option is listed first. */
  const biased = (id = "biased") =>
    member(id, (asked) => {
      const q = asked.questions["choice"]!;
      const keys = q.type === "choice" ? Object.keys(q.criteria) : [];
      return { choice: answerOf("choice", Object.fromEntries(keys.map((k, i) => [k, 1 + (k === "b" ? 1 : 0) + (i === 0 ? 2 : 0)]))) };
    });
  const order = (asked: { questions: Record<string, unknown> }) => Object.keys((asked.questions["choice"] as { criteria: object }).criteria);

  it("FRK5.1 without rotation a position-biased member's first option wins", async () => {
    const { decider } = rig({ members: [biased()], policy: policyJson({ default: { act: 0.4, verify: 0.4 } }) });
    const d = await decider.decide(abc(), input);
    expect(d.action).toBe("a");
  });

  it("FRK5.2 rotating and averaging cancels the position bias and the content shows through", async () => {
    const m = biased();
    const { decider } = rig({ members: [m], policy: policyJson({ default: { act: 0.4, verify: 0.4, rotate: 3 } }) });
    const d = await decider.decide(abc(), input);
    expect(d.action).toBe("b");
    expect(m.calls.map(order)).toEqual([["a", "b", "c"], ["b", "c", "a"], ["c", "a", "b"]]);
    const dist = d.record.answers["choice"]!.distribution;
    expect(Object.keys(dist)).toEqual(["a", "b", "c"]);
    expect(dist["a"]! + dist["b"]! + dist["c"]!).toBeCloseTo(1, 12);
    expect(dist["b"]).toBeCloseTo(8 / 18, 12);
    expect(dist["a"]).toBeCloseTo(5 / 18, 12);
  });

  it("FRK5.3 asking again is capped by the number of distinct rotations", async () => {
    const m = biased();
    const { decider } = rig({ members: [m], policy: policyJson({ default: { act: 0.4, verify: 0.4, rotate: 8 } }) });
    await decider.decide(abc(), input);
    expect(m.calls).toHaveLength(3);
  });

  it("FRK5.4 a rotation of 1 asks once, in the fork's order", async () => {
    const m = biased();
    const { decider } = rig({ members: [m] });
    await decider.decide(abc(), input);
    expect(m.calls.map(order)).toEqual([["a", "b", "c"]]);
  });

  it("FRK5.5 only choice questions are asked again; a boolean question is asked once", async () => {
    const both: Fork<In, string> = {
      ...abc(),
      ask: (i) => ({ state: i.text, questions: { ...abc().ask(i).questions, flag: { type: "boolean", instructions: "flag?" } } }),
    };
    const m = member("m", (asked) => ({
      ...(asked.questions["choice"] ? { choice: answerOf("choice", { a: 1, b: 2, c: 1 }) } : {}),
      ...(asked.questions["flag"] ? { flag: boolAnswer(0.9) } : {}),
    }));
    const { decider } = rig({ members: [m], policy: policyJson({ default: { act: 0.3, verify: 0.3, rotate: 2 } }) });
    const d = await decider.decide(both, input);
    expect(m.calls.map((c) => Object.keys(c.questions))).toEqual([["choice", "flag"], ["choice"]]);
    expect(d.record.answers["flag"]!.distribution["true"]).toBeCloseTo(0.9, 12);
  });

  it("FRK5.6 a fork with no choice question is asked once however high the rotation", async () => {
    const m = sure("m", 0.95);
    const { decider } = rig({ members: [m], policy: policyJson({ default: { rotate: 5 } }) });
    await decider.decide(gate(), input);
    expect(m.calls).toHaveLength(1);
  });

  it("FRK5.7 a member that fails on a later rotation fails as a whole and is traced", async () => {
    const m = member("flaky", (_asked, call) => {
      if (call === 1) throw new Error("second call failed");
      return { choice: answerOf("choice", { a: 1, b: 0, c: 0 }) };
    });
    const { decider } = rig({ members: [m], policy: policyJson({ default: { rotate: 2 } }) });
    const d = await decider.decide(abc(), input);
    expect(d.rung).toBe("human");
    expect(d.record.trace[0]).toEqual({ rung: "model", member: "flaky", outcome: "failed: second call failed" });
  });

  it("FRK5.8 answers of a rotation over other options than the question's fail the member", async () => {
    const m = member("odd", (_asked, call) => ({ choice: call === 0 ? answerOf("choice", { a: 1, b: 1, c: 1 }) : answerOf("choice", { a: 1, b: 1, z: 1 }) }));
    const { decider } = rig({ members: [m], policy: policyJson({ default: { rotate: 2 } }) });
    const d = await decider.decide(abc(), input);
    expect(d.record.trace[0]!.outcome).toMatch(/^failed: .*same options/);
  });

  it("FRK5.9 a later rotation that leaves a question unanswered averages the answers there are", async () => {
    const m = member("skips", (asked, call) => (call === 0 ? { choice: answerOf("choice", { a: 1, b: 3, c: 0 }) } : { other: asked.questions["choice"] ? boolAnswer(0.5) : boolAnswer(0.5) }));
    const { decider } = rig({ members: [m], policy: policyJson({ default: { act: 0.7, verify: 0.7, rotate: 2 } }) });
    const d = await decider.decide(abc(), input);
    expect(d.action).toBe("b");
    expect(d.confidence).toBeCloseTo(0.75, 12);
  });

  it("FRK5.10 a question the first round left out but a later rotation answered is averaged from what came", async () => {
    const m = member("late", (_asked, call) => (call === 0 ? {} : { choice: answerOf("choice", { a: 0, b: 1, c: 0 }) }));
    const { decider } = rig({ members: [m], policy: policyJson({ default: { act: 0.9, verify: 0.9, rotate: 2 } }) });
    const d = await decider.decide(abc(), input);
    expect(d.action).toBe("b");
  });

  it("FRK5.12 questions with fewer options than the rotation asked for are asked as many times as they have options", async () => {
    const two = { type: "choice", instructions: "two", criteria: { x: "x", y: "y" } } as const;
    const three = { type: "choice", instructions: "three", criteria: { a: "a", b: "b", c: "c" } } as const;
    const fork: Fork<In, string> = { ...abc(), ask: (i) => ({ state: i.text, questions: { two, three } }) };
    const m = member("m", (asked) => Object.fromEntries(Object.entries(asked.questions).map(([id, q]) => [id, answerOf("choice", Object.fromEntries(Object.keys(q.type === "choice" ? q.criteria : {}).map((k) => [k, 1])))])));
    const { decider } = rig({ members: [m], policy: policyJson({ default: { act: 0, verify: 0, rotate: 3 } }) });
    await decider.decide(fork, input);
    expect(m.calls.map((c) => Object.keys(c.questions))).toEqual([["two", "three"], ["two", "three"], ["three"]]);
    expect(m.calls.map((c) => Object.keys((c.questions["three"] as typeof three).criteria))).toEqual([["a", "b", "c"], ["b", "c", "a"], ["c", "a", "b"]]);
    expect(m.calls.map((c) => (c.questions["two"] ? Object.keys((c.questions["two"] as typeof two).criteria) : null))).toEqual([["x", "y"], ["y", "x"], null]);
  });

  it("FRK5.13 a member that leaves the rotated question unanswered every time is unusable, not a failure", async () => {
    const silent = member("silent", () => ({}));
    const { decider } = rig({ members: [silent], policy: policyJson({ default: { rotate: 2 } }) });
    const d = await decider.decide(abc(), input);
    expect(silent.calls).toHaveLength(2);
    expect(d.record.trace[0]).toEqual({ rung: "model", member: "silent", outcome: "answers do not separate the options" });
  });

  it("FRK5.11 averageAnswers of the rounds is what the record keeps", async () => {
    const m = biased();
    const { decider } = rig({ members: [m], policy: policyJson({ default: { act: 0.4, verify: 0.4, rotate: 3 } }) });
    const d = await decider.decide(abc(), input);
    const rounds = [0, 1, 2].map((k) => answerOf("choice", Object.fromEntries(order(m.calls[k]!).map((key, i) => [key, 1 + (key === "b" ? 1 : 0) + (i === 0 ? 2 : 0)]))));
    const mean = averageAnswers(rounds);
    for (const key of ["a", "b", "c"]) expect(d.record.answers["choice"]!.distribution[key]).toBeCloseTo(mean.distribution[key]!, 12);
  });
});

describe("calibration", () => {
  const squash: Calibrate = (key, answers) =>
    key.member !== "m" ? answers : Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, a.type === "boolean" ? fromJudgeAnswer({ type: "boolean", instructions: "" }, { type: "boolean", probability: p(0.6) }) : a]));

  it("FRK6.1 with no calibrate the answers are the member's own and no raw copy is kept", async () => {
    const { decider } = rig({ members: [sure("m", 0.95)] });
    const d = await decider.decide(gate(), input);
    expect(d.record.raw).toBeUndefined();
    expect(d.record.answers["q"]!.distribution["true"]).toBeCloseTo(0.95, 12);
  });

  it("FRK6.2 the injected calibrate gets the fork, member and version and the member's raw answers", async () => {
    const seen: [unknown, Answers][] = [];
    const calibrate: Calibrate = (key, answers) => {
      seen.push([key, answers]);
      return answers;
    };
    const { decider } = rig({ members: [sure("m", 0.95, "v9")], calibrate });
    await decider.decide(gate(), input);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toEqual({ fork: "test.gate", member: "m", version: "v9" });
    expect(seen[0]![1]["q"]!.distribution["true"]).toBeCloseTo(0.95, 12);
  });

  it("FRK6.3 calibrated answers decide, and the record keeps them with the raw ones when calibration changed them", async () => {
    const { decider } = rig({ members: [sure("m", 0.95)], calibrate: squash });
    const d = await decider.decide(gate(), input);
    expect(d.rung).toBe("human");
    const seen = rig({ members: [sure("m", 0.95)], calibrate: squash, generator: async () => ({ action: "allow" as never, confidence: p(0.5) }) });
    const g = await seen.decider.decide(gate(), input);
    expect(g.rung).toBe("generator");
    const withCandidate = rig({ members: [sure("m", 0.95)], calibrate: squash, judge: sure("j", 0.99) });
    const j = await withCandidate.decider.decide(gate(withVerify), input);
    expect(j.rung).toBe("judge");
    expect(j.record.answers["q"]!.distribution["true"]).toBeCloseTo(0.6, 12);
    expect(j.record.raw!["q"]!.distribution["true"]).toBeCloseTo(0.95, 12);
  });

  it("FRK6.4 a calibrator that leaves the answers as they were leaves no raw copy", async () => {
    const same: Calibrate = (_key, answers) => ({ ...answers });
    const { decider } = rig({ members: [sure("m", 0.95)], calibrate: same });
    expect((await decider.decide(gate(), input)).record.raw).toBeUndefined();
  });

  it("FRK6.5 a calibrator that throws makes the member's answers unusable: traced, skipped", async () => {
    const broken: Calibrate = () => {
      throw new Error("bad book");
    };
    const { decider } = rig({ members: [sure("m", 0.95)], calibrate: broken });
    const d = await decider.decide(gate(), input);
    expect(d.rung).toBe("human");
    expect(d.record.trace[0]).toEqual({ rung: "model", member: "m", outcome: "unusable answer: bad book" });
  });

  it("FRK6.6 a member that fails over says which model answered, and that one is calibrated and recorded", async () => {
    const seen: unknown[] = [];
    const base = sure("ensemble", 0.95, "e1");
    const served = { ...base, ask: base.ask, served: () => ({ id: "fallback-model", version: "f7" }) };
    const calibrate: Calibrate = (key, answers) => {
      seen.push(key);
      return answers;
    };
    const { decider } = rig({ members: [served], calibrate });
    const d = await decider.decide(gate(), input);
    expect(seen).toEqual([{ fork: "test.gate", member: "fallback-model", version: "f7" }]);
    expect(d.record).toMatchObject({ member: "fallback-model", memberVersion: "f7" });
    expect(d.record.trace[0]!.member).toBe("fallback-model");
  });

  it("FRK6.7 a member whose served() has nothing to say is recorded under its own identity", async () => {
    const base = sure("plain", 0.95, "p1");
    const { decider } = rig({ members: [{ ...base, ask: base.ask, served: () => undefined }] });
    expect((await decider.decide(gate(), input)).record).toMatchObject({ member: "plain", memberVersion: "p1" });
  });

  it("FRK6.8 the judge's answer is calibrated under the judge's own key", async () => {
    const seen: unknown[] = [];
    const calibrate: Calibrate = (key, answers) => {
      seen.push(key);
      return key.member === "j" ? Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, a.type === "boolean" ? boolAnswer(0.1) : a])) : answers;
    };
    const { decider } = rig({ members: [sure("m", 0.7)], judge: { ...sure("j", 0.99, "j3") }, calibrate });
    const d = await decider.decide(gate(withVerify), input);
    expect(seen).toEqual([
      { fork: "test.gate", member: "m", version: "v1" },
      { fork: "test.gate", member: "j", version: "j3" },
    ]);
    expect(d.rung).toBe("human");
    expect(d.record.trace[1]).toMatchObject({ outcome: "rejected", confidence: 0.1 });
  });

  it("FRK6.9 a judge that fails over is calibrated and traced under the model that answered", async () => {
    const base = sure("j", 0.99, "j1");
    const judge = { ...base, ask: base.ask, served: () => ({ id: "j-backup", version: "b2" }) };
    const seen: unknown[] = [];
    const { decider } = rig({ members: [sure("m", 0.7)], judge, calibrate: (key, answers) => (seen.push(key), answers) });
    const d = await decider.decide(gate(withVerify), input);
    expect(seen[1]).toEqual({ fork: "test.gate", member: "j-backup", version: "b2" });
    expect(d.record.trace[1]!.member).toBe("j-backup");
  });

  it("FRK6.10 a calibrator that throws on the judge's answer counts as an unusable judge", async () => {
    const calibrate: Calibrate = (key, answers) => {
      if (key.member === "j") throw new Error("no book");
      return answers;
    };
    const { decider } = rig({ members: [sure("m", 0.7)], judge: sure("j", 0.99), calibrate });
    const d = await decider.decide(gate(withVerify), input);
    expect(d.record.trace[1]).toEqual({ rung: "judge", member: "j", outcome: "failed, taken as p=0: no book", confidence: 0 });
  });
});

describe("authority: a decision is never less restrictive than its floor", () => {
  const floorDeny = withFloor(() => "deny");

  it("FRK7.1 a model's allow below a deny floor becomes deny, traced, its rung unchanged", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)] });
    const d = await decider.decide(gate(floorDeny), input);
    expect(d).toMatchObject({ action: "deny", rung: "model", confidence: 0.97 });
    expect(d.record.action).toBe("deny");
    expect(d.record.trace.at(-1)).toEqual({ rung: "model", outcome: 'authority raised to "deny"' });
  });

  it("FRK7.2 a model's deny above an allow floor stays deny", async () => {
    const { decider } = rig({ members: [sure("m", 0.03)] });
    const d = await decider.decide(gate(withFloor(() => "allow")), input);
    expect(d.action).toBe("deny");
    expect(d.record.trace.map((s) => s.outcome)).not.toContain(expect.stringMatching(/authority/));
  });

  it("FRK7.3 a floor as restrictive as the action changes nothing and leaves no trace", async () => {
    const { decider } = rig({ members: [sure("m", 0.03)] });
    const d = await decider.decide(gate(floorDeny), input);
    expect(d.action).toBe("deny");
    expect(d.record.trace).toHaveLength(1);
  });

  it("FRK7.4 a person's fallback is raised to the floor too, and a person is still asked", async () => {
    const { decider } = rig();
    const d = await decider.decide(gate({ ...floorDeny, fallback: () => "allow" }), input);
    expect(d).toMatchObject({ action: "deny", needsHuman: true, rung: "human" });
    expect(d.record.trace.at(-1)).toEqual({ rung: "human", outcome: 'authority raised to "deny"' });
  });

  it("FRK7.5 a rule's answer is raised to the floor", async () => {
    const { decider } = rig();
    const d = await decider.decide(gate({ ...floorDeny, rule: () => "allow" }), input);
    expect(d).toMatchObject({ action: "deny", rung: "rule" });
  });

  it("FRK7.6 a generator's answer is raised to the floor", async () => {
    const { decider } = rig({ generator: async () => ({ action: "allow" as never, confidence: p(0.9) }) });
    expect((await decider.decide(gate(floorDeny), input)).action).toBe("deny");
  });

  it("FRK7.7 an input with no floor is left alone", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)] });
    expect((await decider.decide(gate(withFloor(() => undefined)), input)).action).toBe("allow");
    // a ranking that refuses what it does not know is never asked about "no floor"
    const refusing = {
      floor: () => undefined,
      restrictiveness: (a: string) => {
        if (a !== "allow" && a !== "deny") throw new Error("unknown action");
        return a === "deny" ? 1 : 0;
      },
    };
    expect((await decider.decide(gate(refusing), input)).action).toBe("allow");
  });

  it("FRK7.8 a floor without a way to rank actions is not applied", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)] });
    expect((await decider.decide(gate({ floor: () => "deny" }), input)).action).toBe("allow");
  });

  it("FRK7.9 in shadow mode the recorded action is raised to the floor and the decision is not active", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)], policy: policyJson({ default: { mode: "shadow" } }) });
    const d = await decider.decide(gate(floorDeny), input);
    expect(d).toMatchObject({ action: "deny", active: false, mode: "shadow" });
    expect(d.record).toMatchObject({ action: "deny", mode: "shadow" });
  });

  it("FRK7.10 the floor is looked up for the input being decided", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)] });
    const fork = gate(withFloor((i) => (i.text === "danger" ? "deny" : undefined)));
    expect((await decider.decide(fork, { text: "danger" })).action).toBe("deny");
    expect((await decider.decide(fork, { text: "fine" })).action).toBe("allow");
  });
});

describe("exploration", () => {
  const exploring = (extra: Record<string, unknown> = {}) => policyJson({ default: { explore: 0.5, ...extra } });

  it("FRK8.1 with explore at 0 the explorer is never called and propensity is 1", async () => {
    const calls: unknown[] = [];
    const { decider } = rig({ members: [sure("m", 0.97)], explorer: (args) => (calls.push(args), testExplorer(args)), rng: fixedRng(0) });
    const d = await decider.decide(gate(withActions), input);
    expect(calls).toHaveLength(0);
    expect(d).toMatchObject({ explored: false, action: "allow" });
    expect(d.record).toMatchObject({ propensity: 1, explored: false });
  });

  it("FRK8.2 the explorer is handed the options, the greedy action, epsilon and the draws, and its choice is the action", async () => {
    const seen: { options: readonly unknown[]; greedy: unknown; epsilon: number; rng: () => number }[] = [];
    const { decider } = rig({
      members: [sure("m", 0.97)],
      policy: exploring({ explore: 0.25 }),
      rng: fixedRng(0.1, 0.9),
      explorer: (args) => {
        seen.push(args);
        return testExplorer(args);
      },
    });
    const d = await decider.decide(gate(withActions), input);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ options: ["allow", "deny"], greedy: "allow", epsilon: 0.25 });
    expect(d).toMatchObject({ action: "deny", explored: true });
    expect(d.record).toMatchObject({ action: "deny", explored: true, propensity: 0.125 });
    expect(d.record.trace.at(-1)).toEqual({ rung: "model", outcome: 'explored: chose "deny" (propensity 0.125)' });
  });

  it("FRK8.3 an exploration that keeps the greedy action records the propensity of taking it", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring({ explore: 0.5 }), rng: fixedRng(0.9), explorer: testExplorer });
    const d = await decider.decide(gate(withActions), input);
    expect(d).toMatchObject({ action: "allow", explored: false });
    expect(d.record.propensity).toBe(0.75);
    expect(d.record.trace).toHaveLength(1);
  });

  it("FRK8.4 the explorer's random draw is reported as explored even when it picked the greedy action", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring({ explore: 0.5 }), rng: fixedRng(0.1, 0.1), explorer: testExplorer });
    const d = await decider.decide(gate(withActions), input);
    expect(d).toMatchObject({ action: "allow", explored: true });
    expect(d.record.propensity).toBe(0.75);
  });

  it("FRK8.5 shadow decisions do not explore", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring({ mode: "shadow" }), rng: fixedRng(0), explorer: testExplorer });
    const d = await decider.decide(gate(withActions), input);
    expect(d).toMatchObject({ explored: false, action: "allow", active: false });
    expect(d.record.propensity).toBe(1);
  });

  it("FRK8.6 without fork.actions, an explorer, or any source of draws nothing is explored", async () => {
    const base = { members: [sure("m", 0.97)], policy: exploring() };
    expect((await rig({ ...base, explorer: testExplorer, rng: fixedRng(0) }).decider.decide(gate(), input)).explored).toBe(false);
    expect((await rig({ ...base, rng: fixedRng(0) }).decider.decide(gate(withActions), input)).explored).toBe(false);
    expect((await rig({ ...base, explorer: testExplorer }).decider.decide(gate(withActions), input)).explored).toBe(false);
  });

  it("FRK8.7 with entropy in place of an rng the draws come from it: 53 bits, never 1", async () => {
    const draws: number[] = [];
    const record = (entropy: number[]) =>
      rig({
        members: [sure("m", 0.97)],
        policy: exploring(),
        entropy: entropyOf(entropy),
        explorer: (args) => {
          draws.push(args.rng(), args.rng());
          return testExplorer({ ...args, rng: fixedRng(0.9) });
        },
      }).decider.decide(gate(withActions), input);
    await record([0, 0, 0, 0, 0, 0, 0]);
    expect(draws).toEqual([0, 0]);
    draws.length = 0;
    await record([255, 255, 255, 255, 255, 255, 255]);
    expect(draws[0]).toBe((2 ** 53 - 1) / 2 ** 53);
    expect(draws[0]).toBeLessThan(1);
    draws.length = 0;
    await record([0x20, 0, 0, 0, 0, 0, 1]);
    expect(draws[0]).toBe(1 / 2 ** 53);
    draws.length = 0;
    await record([0, 1, 0, 0, 0, 0, 0]);
    expect(draws[0]).toBe(2 ** 40 / 2 ** 53);
    draws.length = 0;
    await record([0, 0, 0, 0, 0, 1, 0]);
    expect(draws[0]).toBe(2 ** 8 / 2 ** 53);
  });

  it("FRK8.8 entropy that gives fewer bytes than asked for is refused", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring(), entropy: { bytes: () => new Uint8Array(3) }, explorer: (args) => testExplorer({ ...args, rng: args.rng }) });
    await expect(decider.decide(gate(withActions), input)).rejects.toThrow(/7 bytes/);
  });

  it("FRK8.9 an rng takes precedence over entropy", async () => {
    let asked = 0;
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring(), rng: fixedRng(0.9), entropy: { bytes: () => (asked++, new Uint8Array(7)) }, explorer: testExplorer });
    await decider.decide(gate(withActions), input);
    expect(asked).toBe(0);
  });

  it("FRK8.10 options below the floor are not explored; the floor's own restrictiveness and above are", async () => {
    const seen: (readonly unknown[])[] = [];
    const three = gate({
      actions: () => ["allow", "deny"],
      floor: () => "deny",
      restrictiveness: (a) => (a === "deny" ? 1 : 0),
    });
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring(), rng: fixedRng(0.1, 0), explorer: (args) => (seen.push(args.options), testExplorer(args)) });
    const d = await decider.decide(three, input);
    expect(seen).toEqual([["deny"]]);
    expect(d.action).toBe("deny");
    expect(d.record.propensity).toBe(1);
  });

  it("FRK8.11 the action about to be taken is an option even when the fork does not list it", async () => {
    const seen: (readonly unknown[])[] = [];
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring(), rng: fixedRng(0.9), explorer: (args) => (seen.push(args.options), testExplorer(args)) });
    await decider.decide(gate({ actions: () => ["deny"] }), input);
    expect(seen).toEqual([["deny", "allow"]]);
  });

  it("FRK8.12 actions that are equal as values are one option, whatever the order of their keys", async () => {
    type Obj = { readonly a: number; readonly b: number };
    const seen: { options: readonly Obj[]; greedy: Obj }[] = [];
    const fork: Fork<In, Obj> = {
      id: forkId("test.objects"),
      version: "1",
      ask: gate().ask,
      interpret: () => ({ action: { b: 2, a: 1 }, confidence: p(0.99) }),
      describe: () => null,
      fallback: () => ({ a: 0, b: 0 }),
      actions: () => [{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 3, b: 4 }],
    };
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring(), rng: fixedRng(0.9), explorer: (args) => (seen.push(args as never), testExplorer(args)) });
    await decider.decide(fork, input);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.options).toEqual([{ a: 1, b: 2 }, { a: 3, b: 4 }]);
    expect(seen[0]!.options).toContain(seen[0]!.greedy);
  });

  it("FRK8.17 the greedy action handed to the explorer is the one about to be taken, not merely the first option", async () => {
    const seen: { options: readonly unknown[]; greedy: unknown }[] = [];
    const { decider } = rig({ members: [sure("m", 0.03)], policy: exploring(), rng: fixedRng(0.9), explorer: (args) => (seen.push(args), testExplorer(args)) });
    const d = await decider.decide(gate(withActions), input);
    expect(d.action).toBe("deny");
    expect(seen).toEqual([{ options: ["allow", "deny"], greedy: "deny", epsilon: 0.5, rng: expect.any(Function) }]);
  });

  it("FRK8.18 a fork that ranks its actions but has no floor for this input explores all of them", async () => {
    const seen: (readonly unknown[])[] = [];
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring(), rng: fixedRng(0.9), explorer: (args) => (seen.push(args.options), testExplorer(args)) });
    await decider.decide(gate({ ...withActions, ...withFloor(() => undefined) }), input);
    expect(seen).toEqual([["allow", "deny"]]);
  });

  it("FRK8.19 a floor with nothing to rank actions by is not applied to the options either", async () => {
    const seen: (readonly unknown[])[] = [];
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring(), rng: fixedRng(0.9), explorer: (args) => (seen.push(args.options), testExplorer(args)) });
    await decider.decide(gate({ ...withActions, floor: () => "deny" }), input);
    expect(seen).toEqual([["allow", "deny"]]);
  });

  it("FRK8.20 an option exactly as restrictive as the floor is still an option", async () => {
    const rank: Record<string, number> = { allow: 0, escalate: 1, deny: 2 };
    const fork: Fork<In, string> = {
      id: forkId("test.three"),
      version: "1",
      ask: gate().ask,
      interpret: () => ({ action: "deny", confidence: p(0.99) }),
      describe: () => null,
      fallback: () => "deny",
      actions: () => ["allow", "escalate", "deny"],
      floor: () => "escalate",
      restrictiveness: (a) => rank[a]!,
    };
    const seen: (readonly unknown[])[] = [];
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring(), rng: fixedRng(0.9), explorer: (args) => (seen.push(args.options), testExplorer(args)) });
    await decider.decide(fork, input);
    expect(seen).toEqual([["escalate", "deny"]]);
  });

  it("FRK8.13 rules and questions to a person are not explored", async () => {
    const calls: unknown[] = [];
    const explorer: typeof testExplorer = (args) => (calls.push(args), testExplorer(args));
    const base = { policy: exploring(), rng: fixedRng(0), explorer };
    const ruled = await rig(base).decider.decide(gate({ ...withActions, rule: () => "allow" }), input);
    const asked = await rig(base).decider.decide(gate(withActions), input);
    expect(calls).toHaveLength(0);
    expect([ruled.explored, asked.explored]).toEqual([false, false]);
  });

  it("FRK8.14 a generator's and a judge's answers are explored like a model's", async () => {
    const calls: unknown[] = [];
    const explorer: typeof testExplorer = (args) => (calls.push(args), testExplorer(args));
    const gen = rig({ policy: exploring(), rng: fixedRng(0.9), explorer, generator: async () => ({ action: "allow" as never, confidence: p(0.5) }) });
    await gen.decider.decide(gate(withActions), input);
    const judged = rig({ members: [sure("m", 0.7)], judge: sure("j", 0.9), policy: exploring(), rng: fixedRng(0.9), explorer });
    await judged.decider.decide(gate({ ...withActions, ...withVerify }), input);
    expect(calls).toHaveLength(2);
  });

  it("FRK8.15 a propensity that is not a probability is a programmer error", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)], policy: exploring(), rng: fixedRng(0), explorer: ({ greedy }) => ({ choice: greedy, propensity: 1.5, explored: false }) });
    await expect(decider.decide(gate(withActions), input)).rejects.toThrow(RangeError);
  });
});

describe("records and events", () => {
  it("FRK9.1 a decision is appended to the log as a valid record with everything the run knew", async () => {
    const { decider, log, clock } = rig({ members: [sure("m", 0.95, "v3")] });
    clock.set(4242);
    const d = await decider.decide(gate(), { text: "the input" }, { session: "s1", correlation: "saga-9" });
    expect(d.id).toBe("dec-0");
    expect(d.record).toEqual({
      id: "dec-0",
      fork: "test.gate",
      forkVersion: "f1",
      at: 4242,
      session: "s1",
      correlation: "saga-9",
      input: { text: "the input" },
      rung: "model",
      member: "m",
      memberVersion: "v3",
      policy: "policy-t",
      answers: d.record.answers,
      action: "allow",
      verdict: "allow",
      greedy: "allow",
      confidence: 0.95,
      propensity: 1,
      explored: false,
      mode: "active",
      trace: [{ rung: "model", member: "m", outcome: "accepted", confidence: 0.95 }],
    });
    expect(DecisionRecordSchema.safeParse(d.record).success).toBe(true);
    expect(await log.get("dec-0")).toEqual(d.record);
    expect(await log.size()).toBe(1);
  });

  it("FRK9.2 a decision made with no session or correlation has neither in its record", async () => {
    const { decider } = rig({ members: [sure("m", 0.95)] });
    const d = await decider.decide(gate(), input);
    expect(d.record).not.toHaveProperty("session");
    expect(d.record).not.toHaveProperty("correlation");
  });

  it("FRK9.3 ids follow the log's, in the order decisions are recorded", async () => {
    const { decider } = rig({ members: [sure("m", 0.95)] });
    const ids = [(await decider.decide(gate(), input)).id, (await decider.decide(gate(), input)).id, (await decider.decide(gate(), input)).id];
    expect(ids).toEqual(["dec-0", "dec-1", "dec-2"]);
  });

  it("FRK9.4 the decision is published as decision.made, with the session id when there is one", async () => {
    const { decider, published } = rig({ members: [sure("m", 0.95)] });
    const d = await decider.decide(gate(), input, { session: "s1" });
    await decider.decide(gate(), input);
    expect(published).toStrictEqual([
      { type: "decision.made", payload: { id: d.id, fork: "test.gate", rung: "model", action: "allow", confidence: 0.95, mode: "active" }, sessionId: "s1" },
      { type: "decision.made", payload: { id: "dec-1", fork: "test.gate", rung: "model", action: "allow", confidence: 0.95, mode: "active" } },
    ]);
  });

  it("FRK9.5 the event is published after the record is in the log", async () => {
    const log = new MemoryDecisionLog();
    const sizes: Promise<number>[] = [];
    const { decider } = rig({ log, members: [sure("m", 0.95)], publish: () => void sizes.push(log.size()) });
    await decider.decide(gate(), input);
    expect(await sizes[0]).toBe(1);
  });

  it("FRK9.6 a decider with no publisher decides all the same", async () => {
    const { decider, published } = rig({ members: [sure("m", 0.95)], publishing: false });
    expect((await decider.decide(gate(), input)).rung).toBe("model");
    expect(published).toEqual([]);
  });

  it("FRK9.7 a shadow decision is recorded and published as shadow, and is not active", async () => {
    const { decider, published } = rig({ members: [sure("m", 0.95)], policy: policyJson({ forks: { "test.gate": { mode: "shadow" } } }) });
    const d = await decider.decide(gate(), input);
    expect(d).toMatchObject({ active: false, mode: "shadow" });
    expect(published[0]!.payload).toMatchObject({ mode: "shadow" });
    expect(d.record.mode).toBe("shadow");
  });

  it("FRK9.8 the record says what the fork described, not the raw input", async () => {
    const { decider } = rig({ members: [sure("m", 0.95)] });
    const d = await decider.decide(gate({ describe: (i) => ({ length: i.text.length }) }), { text: "secret" });
    expect(d.record.input).toEqual({ length: 6 });
  });

  it("FRK9.9 a log that cannot append is an error, not a lost decision", async () => {
    const log = new MemoryDecisionLog();
    const broken = { ...log, next: () => log.next(), append: async () => { throw new Error("disk full"); } } as unknown as MemoryDecisionLog;
    const { decider } = rig({ log: broken, members: [sure("m", 0.95)] });
    await expect(decider.decide(gate(), input)).rejects.toThrow("disk full");
  });

  it("FRK9.10 outcome attaches to a decision through the decider, and says false for one it does not have", async () => {
    const { decider, log } = rig({ members: [sure("m", 0.95)] });
    const d = await decider.decide(gate(), input);
    expect(await decider.outcome(d.id, { at: 2000, source: "human", kind: "approved", correct: true })).toBe(true);
    expect((await log.get(d.id))?.outcome).toMatchObject({ kind: "approved" });
    expect(await decider.outcome("dec-99", { at: 1, source: "system", kind: "completed" })).toBe(false);
  });

  it("FRK9.11 the clock stamps each record when it is written", async () => {
    const { decider, clock } = rig({ members: [sure("m", 0.95)] });
    const a = await decider.decide(gate(), input);
    clock.advance(500);
    const b = await decider.decide(gate(), input);
    expect([a.record.at, b.record.at]).toEqual([1000, 1500]);
  });

  it("FRK9.12 the policy version is recorded", async () => {
    const { decider } = rig({ members: [sure("m", 0.95)] });
    expect((await decider.decide(gate(), input)).record.policy).toBe("policy-t");
  });
});

describe("decideNamed", () => {
  it("FRK10.1 runs a registered fork on the parsed input", async () => {
    const registry = new ForkRegistry();
    registry.register(gate(), (raw) => ({ text: String((raw as { t: unknown }).t).toUpperCase() }));
    const m = sure("m", 0.95);
    const { decider } = rig({ members: [m], registry });
    const d = await decider.decideNamed("test.gate", { t: "hi" }, { session: "s" });
    expect(d.record.input).toEqual({ text: "HI" });
    expect(d.record.session).toBe("s");
    expect(m.calls[0]!.state).toBe("HI");
  });

  it("FRK10.2 bad input is an invalid error with the parser's message, and nothing is recorded", async () => {
    const registry = new ForkRegistry();
    registry.register(gate(), () => {
      throw new Error("t must be a string");
    });
    const { decider, log } = rig({ registry });
    await expect(decider.decideNamed("test.gate", {})).rejects.toMatchObject({ code: "invalid", message: "t must be a string" });
    expect(await log.size()).toBe(0);
  });

  it("FRK10.3 an unknown fork is an unknown-fork error", async () => {
    const { decider } = rig({ registry: new ForkRegistry() });
    await expect(decider.decideNamed("nope", {})).rejects.toMatchObject({ code: "unknown-fork" });
  });

  it("FRK10.4 a decider with no registry cannot decide by name", async () => {
    const { decider } = rig();
    await expect(decider.decideNamed("test.gate", {})).rejects.toBeInstanceOf(DecisionError);
    await expect(decider.decideNamed("test.gate", {})).rejects.toThrow(/registry/);
    await expect(decider.decideNamed("test.gate", {})).rejects.toMatchObject({ code: "unavailable" });
  });

  it("FRK10.5 without a parser the input goes to the fork as it came", async () => {
    const registry = new ForkRegistry();
    registry.register(gate());
    const { decider } = rig({ members: [sure("m", 0.95)], registry });
    const d = await decider.decideNamed("test.gate", { text: "raw" });
    expect(d.record.input).toEqual({ text: "raw" });
  });
});

describe("recordExternal", () => {
  const external = {
    fork: { id: forkId("tool.calls"), version: "x1" },
    input: { request: "list files" } as Json,
    action: { calls: [] } as Json,
    rung: "model" as const,
    confidence: p(0.93),
    trace: [{ rung: "model" as const, outcome: "confidence 0.93" }],
  };

  it("FRK11.1 writes and publishes a record for a decision made elsewhere", async () => {
    const { decider, log, published, clock } = rig();
    clock.set(5000);
    const d = await decider.recordExternal({ ...external, member: "router-a", memberVersion: "r2", session: "s1", correlation: "c1" });
    expect(d).toMatchObject({ id: "dec-0", rung: "model", confidence: 0.93, action: { calls: [] }, active: true, explored: false, needsHuman: false, mode: "active" });
    expect(await log.get("dec-0")).toEqual({
      id: "dec-0",
      fork: "tool.calls",
      forkVersion: "x1",
      at: 5000,
      session: "s1",
      correlation: "c1",
      input: { request: "list files" },
      rung: "model",
      member: "router-a",
      memberVersion: "r2",
      policy: "policy-t",
      answers: {},
      action: { calls: [] },
      verdict: { calls: [] },
      greedy: { calls: [] },
      confidence: 0.93,
      propensity: 1,
      explored: false,
      mode: "active",
      trace: external.trace,
    });
    expect(published).toEqual([{ type: "decision.made", payload: { id: "dec-0", fork: "tool.calls", rung: "model", action: { calls: [] }, confidence: 0.93, mode: "active" }, sessionId: "s1" }]);
  });

  it("FRK11.2 without member, session or correlation the record has none of them", async () => {
    const { decider } = rig();
    const d = await decider.recordExternal(external);
    for (const key of ["member", "memberVersion", "session", "correlation"]) expect(d.record).not.toHaveProperty(key);
  });

  it("FRK11.3 the fork's policy decides the mode, so an external decision can be shadow", async () => {
    const { decider } = rig({ policy: policyJson({ forks: { "tool.calls": { mode: "shadow" } } }) });
    const d = await decider.recordExternal(external);
    expect(d).toMatchObject({ mode: "shadow", active: false });
  });

  it("FRK11.4 a person-rung external decision needs a person", async () => {
    const { decider } = rig();
    expect((await decider.recordExternal({ ...external, rung: "human", confidence: p(0) })).needsHuman).toBe(true);
  });

  it("FRK11.6 a member with no version is recorded without one, and a member that is not named leaves both out", async () => {
    const { decider } = rig();
    const named = await decider.recordExternal({ ...external, member: "router-a" });
    expect(named.record.member).toBe("router-a");
    expect(named.record).not.toHaveProperty("memberVersion");
    const unnamed = await decider.recordExternal({ ...external, memberVersion: "orphan" });
    expect(unnamed.record).not.toHaveProperty("member");
    expect(unnamed.record).not.toHaveProperty("memberVersion");
  });

  it("FRK11.5 an invalid record is refused by the log", async () => {
    const { decider } = rig();
    await expect(decider.recordExternal({ ...external, input: { bad: undefined } as unknown as Json })).rejects.toThrow();
  });
});

describe("chooseOne", () => {
  const options = { search: "look something up", write: "write a file" };
  const none = { key: "none", description: "neither applies" };
  const fork = (extra: Record<string, unknown> = {}) =>
    chooseOne({ id: "pick.tool", version: "p1", instructions: "Which tool fits?", options, none, describe: (i: In) => ({ text: i.text }), text: (i: In): State => i.text, fallback: () => "none", ...extra });
  const answered = (weights: Record<string, number>): Answers => ({ choice: answerOf("choice", weights) });

  it("FRK12.1 asks one choice question over the options and the none option, with the state as text", () => {
    expect(fork().ask({ text: "find x" })).toEqual({
      state: "find x",
      questions: { choice: { type: "choice", instructions: "Which tool fits?", criteria: { search: "look something up", write: "write a file", none: "neither applies" } } },
    });
    expect(fork().id).toBe("pick.tool");
    expect(fork().version).toBe("p1");
  });

  it("FRK12.2 without a none option the question offers only the options", () => {
    const f = chooseOne({ id: "pick.tool", version: "1", instructions: "?", options, describe: () => null, text: () => "", fallback: () => "search" });
    expect(Object.keys((f.ask({ text: "" }).questions["choice"] as { criteria: object }).criteria)).toEqual(["search", "write"]);
  });

  it("FRK12.3 the top option is the action, with its probability as confidence", () => {
    expect(fork().interpret(answered({ search: 6, write: 3, none: 1 }), { text: "" })).toEqual({ action: "search", confidence: 0.6 });
  });

  it("FRK12.4 a top of the none option is the none key", () => {
    expect(fork().interpret(answered({ search: 1, write: 1, none: 8 }), { text: "" })).toEqual({ action: "none", confidence: 0.8 });
  });

  it("FRK12.5 a top that does not lead the runner-up is not a verdict", () => {
    expect(fork().interpret(answered({ search: 1, write: 1, none: 0 }), { text: "" })).toBeUndefined();
  });

  it("FRK12.6 a lead of any size counts, whatever the policy says", () => {
    const v = fork().interpret({ choice: { type: "choice", distribution: { search: p(0.5000001), write: p(0.4999999), none: p(0) }, top: "search" } }, { text: "" });
    expect(v?.action).toBe("search");
  });

  it("FRK12.7 no answer to the question, or an answer of another type, is not a verdict", () => {
    expect(fork().interpret({}, { text: "" })).toBeUndefined();
    expect(fork().interpret({ choice: boolAnswer(0.9) }, { text: "" })).toBeUndefined();
  });

  it("FRK12.8 lists its options and the none key as its actions, and describes and falls back as told", () => {
    const f = fork({ fallback: () => "write" });
    expect(f.actions?.({ text: "" })).toEqual(["search", "write", "none"]);
    expect(f.describe({ text: "x" })).toEqual({ text: "x" });
    expect(f.fallback({ text: "x" })).toBe("write");
    expect(f.rule).toBeUndefined();
    expect(f.verify).toBeUndefined();
    expect(f.floor).toBeUndefined();
  });

  it("FRK12.9 a none key that is also an option, or too few options, is refused", () => {
    expect(() => fork({ none: { key: "search", description: "x" } })).toThrow(DecisionError);
    expect(() => fork({ none: { key: "search", description: "x" } })).toThrow(/search/);
    expect(() => fork({ none: { key: "search", description: "x" } })).toThrowError(expect.objectContaining({ code: "invalid" }));
    const one = () => chooseOne({ id: "pick.tool", version: "1", instructions: "?", options: { only: "x" }, describe: () => null, text: () => "", fallback: () => "only" });
    expect(one).toThrow(/two options/);
    expect(one).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(() => chooseOne({ id: "pick.tool", version: "1", instructions: "?", options: { only: "x" }, none, describe: () => null, text: () => "", fallback: () => "only" })).not.toThrow();
  });

  it("FRK12.10 an id that is not a fork id is refused", () => {
    expect(() => fork({ id: "Not A Fork" })).toThrow(RangeError);
  });

  it("FRK12.11 decides end to end through the ladder", async () => {
    const m = member("m", () => answered({ search: 19, write: 1, none: 0 }));
    const { decider } = rig({ members: [m] });
    const d = await decider.decide(fork(), { text: "find x" });
    expect(d).toMatchObject({ action: "search", rung: "model" });
    expect(d.confidence).toBeCloseTo(0.95, 12);
  });
});

describe("booleanGate", () => {
  const make = (extra: Record<string, unknown> = {}) =>
    booleanGate<In, "go" | "stop">({ id: "gate.go", version: "g1", instructions: "Go?", state: (i) => ({ text: i.text }), whenTrue: "go", whenFalse: "stop", describe: (i) => ({ text: i.text }), fallback: () => "stop", ...extra });
  const said = (pTrue: number): Answers => ({ gate: boolAnswer(pTrue) });

  it("FRK13.1 asks one boolean question with the state and the criteria when there are any", () => {
    expect(make().ask({ text: "x" })).toStrictEqual({ state: { text: "x" }, questions: { gate: { type: "boolean", instructions: "Go?" } } });
    const criteria = { true: "safe", false: "unsafe" };
    expect(make({ criteria }).ask({ text: "x" }).questions["gate"]).toEqual({ type: "boolean", instructions: "Go?", criteria });
  });

  it("FRK13.2 a probability above one half is whenTrue with that confidence", () => {
    const v = make().interpret(said(0.8), { text: "" });
    expect(v?.action).toBe("go");
    expect(v?.confidence).toBeCloseTo(0.8, 12);
  });

  it("FRK13.3 a probability below one half is whenFalse with the complement as confidence", () => {
    const v = make().interpret(said(0.1), { text: "" });
    expect(v?.action).toBe("stop");
    expect(v?.confidence).toBeCloseTo(0.9, 12);
  });

  it("FRK13.4 exactly one half is whenTrue at confidence one half", () => {
    const v = make().interpret(said(0.5), { text: "" });
    expect(v).toEqual({ action: "go", confidence: 0.5 });
  });

  it("FRK13.5 no answer, or an answer that is not a boolean, is not a verdict", () => {
    expect(make().interpret({}, { text: "" })).toBeUndefined();
    expect(make().interpret({ gate: answerOf("choice", { a: 1, b: 1 }) }, { text: "" })).toBeUndefined();
  });

  it("FRK13.6 lists both actions, describes and falls back as told", () => {
    const g = make();
    expect(g.actions?.({ text: "" })).toEqual(["go", "stop"]);
    expect(g.describe({ text: "d" })).toEqual({ text: "d" });
    expect(g.fallback({ text: "" })).toBe("stop");
    expect(g).not.toHaveProperty("floor");
    expect(g).not.toHaveProperty("restrictiveness");
    expect(g.id).toBe("gate.go");
    expect(g.version).toBe("g1");
  });

  it("FRK13.7 a floor and its restrictiveness are passed through, and a floor alone is refused", () => {
    const g = make({ floor: () => "stop", restrictiveness: (a: string) => (a === "stop" ? 1 : 0) });
    expect(g.floor?.({ text: "" })).toBe("stop");
    expect(g.restrictiveness?.("stop")).toBe(1);
    expect(() => make({ floor: () => "stop" })).toThrow(DecisionError);
    expect(() => make({ floor: () => "stop" })).toThrow(/restrictiveness/);
    expect(() => make({ floor: () => "stop" })).toThrowError(expect.objectContaining({ code: "invalid" }));
  });

  it("FRK13.8 a restrictiveness without a floor is accepted and carried", () => {
    expect(make({ restrictiveness: () => 0 }).restrictiveness).toBeDefined();
  });

  it("FRK13.9 decides end to end and is raised by its floor", async () => {
    const g = make({ floor: () => "stop", restrictiveness: (a: string) => (a === "stop" ? 1 : 0) });
    const { decider } = rig({ members: [member("m", () => said(0.99))] });
    expect(await decider.decide(g, { text: "x" })).toMatchObject({ action: "stop", rung: "model", confidence: 0.99 });
  });
});

describe("which model answered an ask", () => {
  const ab = () =>
    chooseOne({
      id: "test.pick",
      version: "p1",
      instructions: "which?",
      options: { a: "first", b: "second" },
      describe: (i: In) => ({ text: i.text }),
      text: (i: In) => i.text,
      fallback: () => "a",
    });
  const picking = (a: number) => (asked: { questions: Record<string, unknown> }): Answers => {
    const q = asked.questions["choice"] as { criteria: Record<string, string> };
    return { choice: answerOf("choice", Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === "a" ? a : 1 - a]))) };
  };
  const rotating = policyJson({ default: { act: 0.4, verify: 0.4, rotate: 2 } });

  it("FRK14.1 a member that fails over between the asks of a rotation round is passed over: the average of two models' answers belongs to neither", async () => {
    let call = 0;
    const flipping = {
      ...member("ens", picking(0.99), "e1"),
      askWithIdentity: async (asked: { questions: Record<string, unknown> }) => ({
        answers: picking(call === 0 ? 0.99 : 0.6)(asked),
        served: { id: call++ === 0 ? "a-model" : "b-model", version: "v" },
      }),
    };
    const { decider } = rig({ members: [flipping], policy: rotating });
    const d = await decider.decide(ab(), input);
    expect(d.rung).toBe("human");
    expect(d.record.member).toBeUndefined();
    expect(d.record.trace[0]).toEqual({ rung: "model", member: "ens", outcome: "failed: the member changed models within a rotation round: a-model@v, then b-model@v" });
  });

  it("FRK14.2 a version change within the round is a change of model too, and a member that only has served() is held to the same", async () => {
    let call = 0;
    const base = member("ens", picking(0.9));
    const versions = ["1", "2"];
    const old = { ...base, ask: base.ask, served: () => ({ id: "same", version: versions[call++ % 2]! }) };
    const { decider } = rig({ members: [old], policy: rotating });
    const d = await decider.decide(ab(), input);
    expect(d.rung).toBe("human");
    expect(d.record.trace[0]!.outcome).toBe("failed: the member changed models within a rotation round: same@1, then same@2");
  });

  it("FRK14.3 a round answered by one model throughout is averaged, and the record names that model, from the asks and not from the member's latest word", async () => {
    const base = member("ens", picking(0.8), "e1");
    const steady = { ...base, askWithIdentity: async (asked: Parameters<typeof base.ask>[0]) => ({ answers: await base.ask(asked), served: { id: "only-model", version: "o1" } }), served: () => ({ id: "liar", version: "x" }) };
    const seen: unknown[] = [];
    const { decider } = rig({ members: [steady], policy: rotating, calibrate: (key, answers) => (seen.push(key), answers) });
    const d = await decider.decide(ab(), input);
    expect(base.calls).toHaveLength(2);
    expect(d.rung).toBe("model");
    expect(d.record).toMatchObject({ member: "only-model", memberVersion: "o1" });
    expect(seen).toEqual([{ fork: "test.pick", member: "only-model", version: "o1" }]);
  });

  it("FRK14.4 decisions made at once on a shared member each record the model that answered their own asks", async () => {
    const answerFor = (text: string) => picking(text === "slow" ? 0.93 : 0.97);
    const shared = {
      ...member("ens", () => ({}), "e1"),
      askWithIdentity: async (asked: { state: unknown; questions: Record<string, unknown> }) => {
        const text = String(asked.state);
        await new Promise((resolve) => setTimeout(resolve, text === "slow" ? 20 : 1));
        return { answers: answerFor(text)(asked), served: { id: `model-${text}`, version: "v" } };
      },
    };
    const { decider } = rig({ members: [shared] });
    const [slow, quick] = await Promise.all([decider.decide(ab(), { text: "slow" }), decider.decide(ab(), { text: "quick" })]);
    expect(slow.record).toMatchObject({ member: "model-slow" });
    expect(quick.record).toMatchObject({ member: "model-quick" });
  });

  it("FRK14.5 a judge that says which model answered is calibrated and traced under that model", async () => {
    const base = sure("j", 0.99, "j1");
    const judge = { ...base, askWithIdentity: async (asked: Parameters<typeof base.ask>[0]) => ({ answers: await base.ask(asked), served: { id: "j-asked", version: "a9" } }), served: () => ({ id: "j-latest", version: "z" }) };
    const seen: unknown[] = [];
    const { decider } = rig({ members: [sure("m", 0.7)], judge, calibrate: (key, answers) => (seen.push(key), answers) });
    const d = await decider.decide(gate(withVerify), input);
    expect(seen[1]).toEqual({ fork: "test.gate", member: "j-asked", version: "a9" });
    expect(d.record.trace[1]!.member).toBe("j-asked");
  });

  it("FRK14.6 an ask that says nothing of its model is the member itself", async () => {
    const base = sure("plain", 0.95, "p1");
    const quiet = { ...base, askWithIdentity: async (asked: Parameters<typeof base.ask>[0]) => ({ answers: await base.ask(asked), served: undefined }) };
    const { decider } = rig({ members: [quiet] });
    expect((await decider.decide(gate(), input)).record).toMatchObject({ member: "plain", memberVersion: "p1" });
  });
});

describe("the verdict and the greedy action in a record", () => {
  it("FRK15.1 a decision that nothing changed has its action as its verdict and its greedy action", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)] });
    const d = await decider.decide(gate(), input);
    expect(d.record).toMatchObject({ action: "allow", verdict: "allow", greedy: "allow" });
  });

  it("FRK15.2 the floor raises the action and not the verdict, which stays what the answers were about", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)] });
    const d = await decider.decide(gate(withFloor(() => "deny")), input);
    expect(d.record).toMatchObject({ action: "deny", verdict: "allow", greedy: "deny", explored: false });
  });

  it("FRK15.3 exploration replaces the action and not the verdict or the greedy action", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)], policy: policyJson({ default: { explore: 0.25 } }), rng: fixedRng(0.1, 0.9), explorer: testExplorer });
    const d = await decider.decide(gate({ ...withActions, ...withFloor(() => undefined) }), input);
    expect(d.record).toMatchObject({ action: "deny", explored: true, verdict: "allow", greedy: "allow" });
  });

  it("FRK15.4 with the floor and exploration both, the greedy action is the raised one", async () => {
    const { decider } = rig({ members: [sure("m", 0.97)], policy: policyJson({ default: { explore: 0.25 } }), rng: fixedRng(0.9), explorer: testExplorer });
    const d = await decider.decide(gate({ ...withActions, ...withFloor(() => "deny") }), input);
    expect(d.record).toMatchObject({ action: "deny", verdict: "allow", greedy: "deny" });
  });

  it("FRK15.5 a decision made elsewhere has taken its action as its verdict", async () => {
    const { decider } = rig();
    const made = await decider.recordExternal({ fork: { id: forkId("tool.cascade"), version: "t1" }, input: { tool: "x" }, action: "ask", rung: "model", confidence: p(0.8), trace: [] });
    expect(made.record).toMatchObject({ action: "ask", verdict: "ask", greedy: "ask" });
  });
});
