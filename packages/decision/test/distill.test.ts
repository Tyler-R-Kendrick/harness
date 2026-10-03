import { describe, expect, it } from "vitest";
import {
  correctActionOf,
  stableJson,
  examplesToJsonl,
  fnv1a32,
  holdoutSplit,
  mineDisagreements,
  parseExamplesJsonl,
  ruleFits,
  toExamples,
} from "../src/distill.ts";
import type { Example } from "../src/distill.ts";
import type { Json, TraceStep } from "../src/types.ts";
import { probability } from "@harness/cognitive";
import { answer, chose, record, outcome, yes } from "./loops-fixtures.ts";

const labelBy = (r: { action: Json }) => (typeof r.action === "string" ? r.action : undefined);
/** A label for the boolean question `q`: the record's action says allow (true) or not. */
const allowIs = (r: { action: Json }, question: string) => (question === "q" ? (r.action === "allow" ? "true" : "false") : undefined);

describe("holdout split", () => {
  it("DST1.1 FNV-1a is the standard 32-bit hash: the published test vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("DST1.2 a decision id is always on the same side, for the same share and salt", () => {
    for (const id of ["dec-0", "dec-1", "dec-2", "dec-17", "dec-1000"]) {
      const first = holdoutSplit(id, 0.5, "s");
      for (let i = 0; i < 3; i++) expect(holdoutSplit(id, 0.5, "s")).toBe(first);
    }
  });

  it("DST1.3 a share of 0 holds out nothing and a share of 1 holds out everything", () => {
    for (let n = 0; n < 50; n++) {
      expect(holdoutSplit(`dec-${n}`, 0)).toBe("train");
      expect(holdoutSplit(`dec-${n}`, 1)).toBe("holdout");
    }
  });

  it("DST1.4 a record held out at a share stays held out at any larger share (splits nest)", () => {
    for (let n = 0; n < 100; n++) {
      if (holdoutSplit(`dec-${n}`, 0.2) === "holdout") expect(holdoutSplit(`dec-${n}`, 0.4)).toBe("holdout");
    }
  });

  it("DST1.5 the salt changes which records are held out, and the empty salt is the default", () => {
    const ids = Array.from({ length: 200 }, (_, n) => `dec-${n}`);
    const held = (salt?: string) => ids.filter((id) => holdoutSplit(id, 0.3, salt) === "holdout");
    expect(held()).toEqual(held(""));
    expect(held("a")).not.toEqual(held("b"));
  });

  it("DST1.6 a share that is not from 0 to 1 is refused", () => {
    for (const share of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => holdoutSplit("dec-1", share)).toThrow(`a holdout share is from 0 to 1, got ${share}`);
  });
});

describe("toExamples", () => {
  const options = { labelOf: allowIs, holdout: 0 };

  it("DST2.1 a record with an outcome gives an example for each question it answered, with its provenance", () => {
    const r = record({ id: 7, input: { tool: "bash" }, member: "m1", memberVersion: "v3", policy: "pol-2", answers: { q: yes(0.8), r: chose({ a: 1, b: 1 }) }, action: "allow", outcome: outcome("correct") });
    const examples = toExamples([r], { labelOf: (rec, q) => (q === "q" ? "true" : "a"), holdout: 0 });
    expect(examples).toEqual([
      { id: "dec-7:q", fork: "test.gate", question: "q", state: { tool: "bash" }, options: ["true", "false"], label: "true", source: "outcome", weight: 1, split: "train", provenance: { decision: "dec-7", member: "m1", memberVersion: "v3", policy: "pol-2" } },
      { id: "dec-7:r", fork: "test.gate", question: "r", state: { tool: "bash" }, options: ["a", "b"], label: "a", source: "outcome", weight: 1, split: "train", provenance: { decision: "dec-7", member: "m1", memberVersion: "v3", policy: "pol-2" } },
    ]);
  });

  it("DST2.2 provenance leaves out a member and version the record does not have", () => {
    const [e] = toExamples([record({ id: 1, outcome: outcome("correct") })], options);
    expect(e?.provenance).toStrictEqual({ decision: "dec-1", policy: "p1" });
  });

  it("DST2.3 a record with no outcome and no accepted later rung gives no example", () => {
    for (const rung of ["rule", "model", "human"] as const) expect(toExamples([record({ rung })], options), rung).toEqual([]);
  });

  it("DST2.4 a record decided by a later rung, the judge or the generator, gives an escalation example without an outcome", () => {
    for (const rung of ["judge", "generator"] as const) {
      const examples = toExamples([record({ id: 3, rung })], options);
      expect(examples.map((e) => [e.source, e.weight, e.label]), rung).toEqual([["escalation", 0.5, "true"]]);
    }
  });

  it("DST2.5 an outcome makes an example whatever rung decided", () => {
    for (const rung of ["rule", "model", "judge", "generator", "human"] as const) expect(toExamples([record({ rung, outcome: outcome("correct") })], options), rung).toHaveLength(1);
  });

  it("DST2.6 weights are the outcome's and the escalation's, as given", () => {
    const records = [record({ id: 1, outcome: outcome("correct") }), record({ id: 2, rung: "judge" })];
    expect(toExamples(records, { ...options, weights: { outcome: 2, escalation: 0.25 } }).map((e) => e.weight)).toEqual([2, 0.25]);
    expect(() => toExamples(records, { ...options, weights: { outcome: -1, escalation: 1 } })).toThrow("a weight is finite and not negative, got -1");
    expect(() => toExamples(records, { ...options, weights: { outcome: 1, escalation: Number.NaN } })).toThrow("a weight is finite and not negative, got NaN");
  });

  it("DST2.7 a question the labeller has no label for, or a label that is not one of the options, gives no example", () => {
    const r = record({ id: 1, answers: { q: yes(0.9), other: yes(0.5) }, outcome: outcome("correct") });
    expect(toExamples([r], { labelOf: allowIs, holdout: 0 }).map((e) => e.question)).toEqual(["q"]);
    expect(toExamples([r], { labelOf: () => "maybe", holdout: 0 })).toEqual([]);
  });

  it("DST2.8 the labeller is asked with the record and the question, and is not asked for a record that gives no example", () => {
    const asked: string[] = [];
    const labelOf = (rec: { id: string }, q: string) => {
      asked.push(`${rec.id}/${q}`);
      return "true";
    };
    toExamples([record({ id: 1, outcome: outcome("correct") }), record({ id: 2 })], { labelOf, holdout: 0 });
    expect(asked).toEqual(["dec-1/q"]);
  });

  it("DST2.9 the split follows the decision id, the same for all of a record's questions, and salt and share are as given", () => {
    const many = Array.from({ length: 60 }, (_, n) => record({ id: n, answers: { q: yes(0.9), r: yes(0.5) }, outcome: outcome("correct") }));
    const examples = toExamples(many, { labelOf: () => "true", holdout: 0.3, salt: "x" });
    expect(examples).toHaveLength(120);
    for (const e of examples) expect(e.split).toBe(holdoutSplit(e.provenance.decision, 0.3, "x"));
    const byDecision = new Map<string, Set<string>>();
    for (const e of examples) byDecision.set(e.provenance.decision, (byDecision.get(e.provenance.decision) ?? new Set()).add(e.split));
    for (const splits of byDecision.values()) expect(splits.size).toBe(1);
    expect(new Set(examples.map((e) => e.split))).toEqual(new Set(["train", "holdout"]));
    expect(toExamples(many, { labelOf: () => "true", holdout: 0.3, salt: "y" }).map((e) => e.split)).not.toEqual(examples.map((e) => e.split));
  });

  it("DST2.10 the same records give the same examples in whatever order they come", () => {
    const rs = Array.from({ length: 20 }, (_, n) => record({ id: n, outcome: outcome("correct") }));
    const forward = toExamples(rs, { labelOf: allowIs, holdout: 0.5 });
    const backward = toExamples([...rs].reverse(), { labelOf: allowIs, holdout: 0.5 });
    expect(new Map(backward.map((e) => [e.id, e.split]))).toEqual(new Map(forward.map((e) => [e.id, e.split])));
  });

  it("DST2.11 a share that is not from 0 to 1 is refused", () => {
    expect(() => toExamples([], { labelOf: labelBy, holdout: 2 })).toThrow("a holdout share is from 0 to 1, got 2");
  });

  it("DST2.12 a record answered no question gives no example, and the raw answers are not needed", () => {
    expect(toExamples([record({ answers: {}, outcome: outcome("correct") })], options)).toEqual([]);
  });
});

describe("correctActionOf", () => {
  it("DST2.13 an outcome's label is the correct action, whatever the outcome said", () => {
    expect(correctActionOf(record({ action: "allow", outcome: outcome("incorrect", { label: "deny" }) }))).toBe("deny");
    expect(correctActionOf(record({ action: "allow", outcome: outcome("correct", { label: "deny" }) }))).toBe("deny");
  });

  it("DST2.14 an outcome that says the decision was right (by its flag, or by its kind) makes the action itself correct", () => {
    for (const kind of ["correct", "approved", "completed", "rated-good"] as const) expect(correctActionOf(record({ action: "allow", outcome: outcome(kind) })), kind).toBe("allow");
    expect(correctActionOf(record({ action: "allow", outcome: outcome("denied", { correct: true }) }))).toBe("allow");
  });

  it("DST2.15 an outcome that says it was wrong without saying what was right leaves the correct action unknown", () => {
    for (const kind of ["incorrect", "denied", "failed", "rated-bad", "overridden"] as const) expect(correctActionOf(record({ outcome: outcome(kind) })), kind).toBeUndefined();
    expect(correctActionOf(record({ outcome: outcome("approved", { correct: false }) }))).toBeUndefined();
  });

  it("DST2.16 with no outcome, only a later rung's action is taken as correct", () => {
    expect(correctActionOf(record({ rung: "judge", action: "deny" }))).toBe("deny");
    expect(correctActionOf(record({ rung: "generator", action: "deny" }))).toBe("deny");
    for (const rung of ["rule", "model", "human"] as const) expect(correctActionOf(record({ rung, action: "deny" })), rung).toBeUndefined();
  });

  it("DST2.17 a later rung's action is taken as correct only when it was taken: not when exploration chose it at random, nor when the floor raised it", () => {
    for (const rung of ["judge", "generator"] as const) {
      expect(correctActionOf(record({ rung, action: "random-pick", explored: true, propensity: probability(0.05) })), `${rung} explored`).toBeUndefined();
      expect(correctActionOf(record({ rung, action: "critical", verdict: "routine", greedy: "critical" })), `${rung} raised`).toBeUndefined();
      expect(correctActionOf(record({ rung, action: "deny", verdict: "deny", greedy: "deny", explored: true })), `${rung} explored onto the verdict`).toBe("deny");
      expect(correctActionOf(record({ rung, action: "deny", verdict: "deny", greedy: "deny" })), `${rung} taken`).toBe("deny");
    }
  });

  it("DST2.18 an outcome still says what was right of a decision exploration or the floor changed: its label, or that the action taken was right", () => {
    const changed = { explored: true, verdict: "allow", greedy: "allow", action: "deny" } as const;
    expect(correctActionOf(record({ ...changed, outcome: outcome("overridden", { label: "allow" }) }))).toBe("allow");
    expect(correctActionOf(record({ ...changed, outcome: outcome("correct", { correct: true }) }))).toBe("deny");
    expect(correctActionOf(record({ ...changed, outcome: outcome("incorrect", { correct: false }) }))).toBeUndefined();
  });
});

describe("ruleFits", () => {
  it("DST2.19 an outcome that says the action taken was wrong, by its kind or by its flag, is a miss for a rule with that action and nothing for a rule with another", () => {
    for (const kind of ["incorrect", "failed", "rated-bad", "overridden"] as const) {
      expect(ruleFits(record({ action: "allow", outcome: outcome(kind) }), "allow"), kind).toBe(false);
      expect(ruleFits(record({ action: "allow", outcome: outcome(kind) }), "deny"), `${kind} other`).toBeUndefined();
    }
    expect(ruleFits(record({ action: "allow", outcome: outcome("denied", { correct: false }) }), "allow")).toBe(false);
    expect(ruleFits(record({ action: "allow", outcome: outcome("completed", { correct: false }) }), "allow")).toBe(false);
  });

  it("DST2.20 an outcome that says the action was right or names the right one is a fit or a miss; an approval or a denial that says nothing more is no evidence; no outcome says what a later rung took", () => {
    expect(ruleFits(record({ action: "allow", outcome: outcome("correct") }), "allow")).toBe(true);
    expect(ruleFits(record({ action: "allow", outcome: outcome("correct") }), "deny")).toBe(false);
    expect(ruleFits(record({ action: "allow", outcome: outcome("overridden", { label: "deny" }) }), "deny")).toBe(true);
    for (const kind of ["approved", "denied"] as const) expect(ruleFits(record({ action: "allow", outcome: outcome(kind) }), "allow"), kind).toBeUndefined();
    expect(ruleFits(record({ rung: "judge", action: "deny" }), "deny")).toBe(true);
    expect(ruleFits(record({ rung: "model", action: "deny" }), "deny")).toBeUndefined();
  });
});

describe("mineDisagreements", () => {
  const step = (rung: TraceStep["rung"], outcomeText: string): TraceStep => ({ rung, outcome: outcomeText });

  it("DST3.1 a decision an outcome overruled, with the action that was right, is a disagreement", () => {
    const r = record({ id: 1, action: "allow", outcome: outcome("incorrect", { label: "deny" }) });
    expect(mineDisagreements([r])).toEqual([{ record: r, by: "outcome", label: "deny" }]);
  });

  it("DST3.2 an outcome that agrees, or gives no label, or has the same label, is not a disagreement", () => {
    const records = [
      record({ action: "allow", outcome: outcome("correct") }),
      record({ action: "allow", outcome: outcome("incorrect") }),
      record({ action: "allow", outcome: outcome("correct", { label: "allow" }) }),
      record({ action: { a: 1 }, outcome: outcome("incorrect", { label: { a: 1 } }) }),
    ];
    expect(mineDisagreements(records)).toEqual([]);
  });

  it("DST3.3 structured actions are compared by value, not by the order of their keys", () => {
    const same = record({ action: { a: 1, b: 2 }, outcome: outcome("incorrect", { label: { b: 2, a: 1 } }) });
    const other = record({ action: { a: 1, b: 2 }, outcome: outcome("incorrect", { label: { a: 1, b: 3 } }) });
    expect(mineDisagreements([same, other]).map((d) => d.record)).toEqual([other]);
  });

  it("DST3.4 a candidate the judge rejected, settled by the generator, is a disagreement labelled with the generator's action", () => {
    const r = record({ id: 2, rung: "generator", action: "deny", trace: [step("model", "to be verified"), step("judge", "rejected"), step("generator", "generated")] });
    expect(mineDisagreements([r])).toEqual([{ record: r, by: "generator", label: "deny" }]);
  });

  it("DST3.5 a judge that accepted, a generator that was asked without a judge's rejection, and a person who was asked, are not disagreements", () => {
    const records = [
      record({ rung: "judge", trace: [step("model", "to be verified"), step("judge", "accepted")] }),
      record({ rung: "generator", trace: [step("model", "below verify"), step("generator", "generated")] }),
      record({ rung: "human", trace: [step("model", "below verify"), step("judge", "rejected"), step("human", "a person is asked")] }),
      record({ rung: "model", trace: [step("model", "accepted")] }),
    ];
    expect(mineDisagreements(records)).toEqual([]);
  });

  it("DST3.6 a decision that an outcome overruled and that a generator settled is mined once, by its outcome", () => {
    const r = record({ rung: "generator", action: "allow", trace: [step("judge", "rejected")], outcome: outcome("incorrect", { label: "deny" }) });
    expect(mineDisagreements([r])).toEqual([{ record: r, by: "outcome", label: "deny" }]);
  });

  it("DST3.7 disagreements come in the order of the records", () => {
    const a = record({ id: 5, action: "allow", outcome: outcome("incorrect", { label: "deny" }) });
    const b = record({ id: 4, action: "allow", outcome: outcome("incorrect", { label: "deny" }) });
    expect(mineDisagreements([a, b]).map((d) => d.record.id)).toEqual(["dec-5", "dec-4"]);
  });
});

describe("examples as JSON lines", () => {
  const examples = (n: number): Example[] => toExamples(Array.from({ length: n }, (_, i) => record({ id: i, input: { n: i, text: `line\n${i}` }, outcome: outcome("correct") })), { labelOf: allowIs, holdout: 0.5 });

  it("DST4.1 examples make one JSON line each, and parse back to the same examples", () => {
    const list = examples(5);
    const text = examplesToJsonl(list);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd().split("\n")).toHaveLength(5);
    expect(parseExamplesJsonl(text)).toEqual({ examples: list, bad: [] });
  });

  it("DST4.2 no examples make no text, and no text makes no examples", () => {
    expect(examplesToJsonl([])).toBe("");
    expect(parseExamplesJsonl("")).toEqual({ examples: [], bad: [] });
  });

  it("DST4.3 a last line that was cut short is reported and the lines before it are kept", () => {
    const text = examplesToJsonl(examples(3));
    const cut = text.slice(0, text.length - 40);
    const parsed = parseExamplesJsonl(cut);
    expect(parsed.examples).toHaveLength(2);
    expect(parsed.bad).toEqual([{ line: 3, reason: "the last line is cut short" }]);
  });

  it("DST4.4 a line that is not JSON in the middle is reported with its number, and the others are kept", () => {
    const [a, b] = examplesToJsonl(examples(2)).trimEnd().split("\n");
    const parsed = parseExamplesJsonl(`${a}\nnot json\n${b}\n`);
    expect(parsed.examples).toHaveLength(2);
    expect(parsed.bad).toHaveLength(1);
    expect(parsed.bad[0]).toMatchObject({ line: 2 });
    expect(parsed.bad[0]?.reason).toMatch(/not JSON/);
  });

  it("DST4.5 a line that is JSON but not an example is reported, naming what is wrong", () => {
    const [a] = examplesToJsonl(examples(1)).trimEnd().split("\n");
    const broken = JSON.stringify({ ...JSON.parse(a!), split: "somewhere" });
    const parsed = parseExamplesJsonl(`${broken}\n{"id":1}\n`);
    expect(parsed.examples).toEqual([]);
    expect(parsed.bad.map((b) => b.line)).toEqual([1, 2]);
    expect(parsed.bad[0]?.reason).toMatch(/split/);
  });

  it("DST4.6 blank lines, and a missing final newline on a whole last line, are fine", () => {
    const text = examplesToJsonl(examples(2));
    expect(parseExamplesJsonl(`\n${text}\n\n`)).toMatchObject({ bad: [] });
    expect(parseExamplesJsonl(text.trimEnd()).examples).toHaveLength(2);
    expect(parseExamplesJsonl(text.trimEnd()).bad).toEqual([]);
  });

  it("DST4.7 windows line endings are read as line endings", () => {
    expect(parseExamplesJsonl(examplesToJsonl(examples(3)).replaceAll("\n", "\r\n")).examples).toHaveLength(3);
  });

  it("DST4.8 a last line that is invalid but ends with a newline is a bad line, not a cut one", () => {
    const parsed = parseExamplesJsonl(`${examplesToJsonl(examples(1))}oops\n`);
    expect(parsed.bad).toHaveLength(1);
    expect(parsed.bad[0]?.reason).toMatch(/not JSON/);
  });

  it("DST4.9 an example of a question with a whole-number score level survives the round trip", () => {
    const r = record({ id: 9, answers: { s: answer("score", { "0": 1, "1": 2, "2": 1 }) }, outcome: outcome("correct") });
    const list = toExamples([r], { labelOf: () => "1", holdout: 0 });
    expect(parseExamplesJsonl(examplesToJsonl(list)).examples).toEqual(list);
  });
});

describe("details of the holdout, the text and the examples", () => {
  const step = (rung: TraceStep["rung"], outcomeText: string): TraceStep => ({ rung, outcome: outcomeText });

  it("DST9.1 a decision is held out when its place in the hash is below the share, not at it", () => {
    const at = 1572010443 / 2 ** 32; // where dec-0 falls, with no salt
    expect(holdoutSplit("dec-0", at)).toBe("train");
    expect(holdoutSplit("dec-0", at + 1e-9)).toBe("holdout");
    expect(holdoutSplit("dec-0", at - 1e-9)).toBe("train");
  });

  it("DST9.2 JSON is written with sorted keys, no spaces, and every kind of value", () => {
    expect(stableJson(null)).toBe("null");
    expect(stableJson("a\"b")).toBe('"a\\"b"');
    expect(stableJson([1, "a", null, true])).toBe('[1,"a",null,true]');
    expect(stableJson({ b: 1, a: [1, 2], c: { z: null, y: false } })).toBe('{"a":[1,2],"b":1,"c":{"y":false,"z":null}}');
    expect(stableJson([])).toBe("[]");
    expect(stableJson({})).toBe("{}");
  });

  it("DST9.3 a weight of zero is a weight", () => {
    const r = record({ id: 1, outcome: outcome("correct") });
    expect(toExamples([r], { labelOf: allowIs, holdout: 0, weights: { outcome: 0, escalation: 0 } }).map((e) => e.weight)).toEqual([0]);
    expect(() => toExamples([r], { labelOf: allowIs, holdout: 0, weights: { outcome: -1, escalation: 0 } })).toThrow("a weight is finite and not negative, got -1");
    expect(() => toExamples([r], { labelOf: allowIs, holdout: 0, weights: { outcome: 0, escalation: Number.NaN } })).toThrow("got NaN");
  });

  it("DST9.4 a generator's decision is a disagreement only when a judge rejected a candidate before it", () => {
    const withTrace = (rung: "generator" | "judge", trace: TraceStep[]) => record({ rung, action: "deny", trace });
    expect(mineDisagreements([withTrace("generator", [step("model", "rejected"), step("judge", "accepted"), step("generator", "generated")])])).toEqual([]);
    expect(mineDisagreements([withTrace("generator", [step("judge", "accepted")])])).toEqual([]);
    expect(mineDisagreements([withTrace("generator", [step("model", "rejected")])])).toEqual([]);
    expect(mineDisagreements([withTrace("judge", [step("model", "to be verified"), step("judge", "rejected"), step("model", "to be verified"), step("judge", "accepted")])])).toEqual([]);
    expect(mineDisagreements([withTrace("generator", [step("model", "x"), step("judge", "accepted"), step("judge", "rejected")])])).toHaveLength(1);
  });

  it("DST9.5 a line of blanks is no example and no mistake, and windows line endings leave no bad lines", () => {
    const list = toExamples([record({ id: 1, outcome: outcome("correct") })], { labelOf: allowIs, holdout: 0.5 });
    const text = examplesToJsonl(list);
    expect(parseExamplesJsonl(`   \n\t\n${text}   \n`)).toEqual({ examples: list, bad: [] });
    expect(parseExamplesJsonl(text.replaceAll("\n", "\r\n"))).toEqual({ examples: list, bad: [] });
  });

  it("DST9.6 an example of an escalation, with a question named at length, is an example", () => {
    const r = record({ id: 3, rung: "judge", answers: { risk: yes(0.8) } });
    const list = toExamples([r], { labelOf: () => "true", holdout: 0.5 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "dec-3:risk", question: "risk", source: "escalation", weight: 0.5 });
    expect(parseExamplesJsonl(examplesToJsonl(list))).toEqual({ examples: list, bad: [] });
  });

  it("DST9.7 a labeller that has no label for a question leaves it out", () => {
    const r = record({ id: 4, outcome: outcome("correct"), answers: { q: yes(0.9), other: yes(0.2) } });
    expect(toExamples([r], { labelOf: (_, q) => (q === "q" ? "true" : undefined), holdout: 0 }).map((e) => e.question)).toEqual(["q"]);
    expect(toExamples([r], { labelOf: () => "maybe", holdout: 0 })).toEqual([]);
  });
});
