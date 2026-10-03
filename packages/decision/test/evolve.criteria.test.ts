import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { applyEdits, CriteriaArchive, CriteriaBookSchema, criteriaFromFork, EditSchema, screenEdits, withCriteria } from "../src/evolve.ts";
import type { CriteriaBook, Edit, EvaluationSummary } from "../src/evolve.ts";
import { DecisionError, forkId } from "../src/types.ts";
import type { Fork, Json } from "../src/types.ts";
import { gate, INSTRUCTIONS } from "./evolve-fixtures.ts";

/** An error of the layer with the code `invalid` and a message with this in it. */
function invalid(fn: () => unknown, message: string | RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(DecisionError);
  expect(caught).toMatchObject({ code: "invalid" });
  if (typeof message === "string") expect((caught as Error).message).toContain(message);
  else expect((caught as Error).message).toMatch(message);
}

/** A fork with one question of each type, to see criteria substituted into each. */
function multi(): Fork<{ readonly x: string }, "a" | "b"> {
  return {
    id: forkId("evo.multi"),
    version: "m1",
    ask: (input) => ({
      state: input.x,
      questions: {
        pick: { type: "choice", instructions: "Pick one.", criteria: { first: "the first thing", second: null } },
        level: { type: "score", instructions: "How much?", criteria: ["none", "some", null] },
        flag: { type: "boolean", instructions: "Is it so?", criteria: { true: "so" } },
        bare: { type: "boolean", instructions: "Is it bare?" },
      },
    }),
    interpret: () => ({ action: "a", confidence: probability(1) }),
    describe: (input) => ({ x: input.x }),
    fallback: () => "b",
    rule: () => "b",
    floor: () => "a",
    restrictiveness: () => 0,
    verify: (input) => ({ state: input.x, questions: { correct: { type: "boolean", instructions: "Right?" } } }),
    actions: () => ["a", "b"],
  };
}

const book = (version = "v0"): CriteriaBook => criteriaFromFork(multi(), { x: "s" }, version);

describe("criteria books", () => {
  it("EVO1.1 a fork's criteria are read from what it asks, question by question and of every type", () => {
    expect(book()).toEqual({
      fork: "evo.multi",
      version: "v0",
      questions: {
        pick: { type: "choice", instructions: "Pick one.", criteria: { first: "the first thing", second: null } },
        level: { type: "score", instructions: "How much?", criteria: ["none", "some", null] },
        flag: { type: "boolean", instructions: "Is it so?", criteria: { true: "so" } },
        bare: { type: "boolean", instructions: "Is it bare?", criteria: {} },
      },
    });
  });

  it("EVO1.11 a boolean question's criteria are read as the fork has them: one side, the other, both or neither", () => {
    const read = (criteria: { true?: string; false?: string } | undefined) =>
      criteriaFromFork(gate({ ask: () => ({ state: "s", questions: { risky: { type: "boolean", instructions: "Is it?", ...(criteria === undefined ? {} : { criteria }) } } }) }), { kind: "x" }, "v0").questions["risky"];
    expect(read({ true: "yes" })).toEqual({ type: "boolean", instructions: "Is it?", criteria: { true: "yes" } });
    expect(read({ false: "no" })).toEqual({ type: "boolean", instructions: "Is it?", criteria: { false: "no" } });
    expect(read({ true: "yes", false: "no" })).toEqual({ type: "boolean", instructions: "Is it?", criteria: { true: "yes", false: "no" } });
    expect(read(undefined)).toEqual({ type: "boolean", instructions: "Is it?", criteria: {} });
  });

  it("EVO1.2 a book is copied out of the fork: changing it does not change what the fork asks", () => {
    const b = book();
    (b.questions["pick"] as { criteria: Record<string, string | null> }).criteria["first"] = "changed";
    (b.questions["level"] as { criteria: (string | null)[] }).criteria[0] = "changed";
    const asked = multi().ask({ x: "s" }).questions;
    expect(asked["pick"]).toMatchObject({ criteria: { first: "the first thing" } });
    expect(asked["level"]).toMatchObject({ criteria: ["none", "some", null] });
  });

  it("EVO1.3 a book is data: it parses with its schema, and a question of an unknown type or an empty instruction is refused", () => {
    expect(CriteriaBookSchema.parse(JSON.parse(JSON.stringify(book())))).toEqual(book());
    expect(CriteriaBookSchema.safeParse({ ...book(), version: "" }).success).toBe(false);
    expect(CriteriaBookSchema.safeParse({ ...book(), fork: "Not A Fork" }).success).toBe(false);
    expect(CriteriaBookSchema.safeParse({ ...book(), questions: { q: { type: "text", instructions: "x", criteria: {} } } }).success).toBe(false);
    expect(CriteriaBookSchema.safeParse({ ...book(), questions: { q: { type: "boolean", instructions: "", criteria: {} } } }).success).toBe(false);
    expect(CriteriaBookSchema.safeParse({ ...book(), extra: 1 }).success).toBe(false);
  });

  it("EVO1.4 withCriteria substitutes the instructions and the criteria text of every question type", () => {
    const edited: CriteriaBook = {
      fork: forkId("evo.multi"),
      version: "v1",
      questions: {
        pick: { type: "choice", instructions: "Choose well.", criteria: { first: "one", second: "two" } },
        level: { type: "score", instructions: "How many?", criteria: ["zero", "one", "two"] },
        flag: { type: "boolean", instructions: "Is it really so?", criteria: { true: "yes, so", false: "no" } },
        bare: { type: "boolean", instructions: "Bare?", criteria: {} },
      },
    };
    const asked = withCriteria(multi(), edited).ask({ x: "s" });
    expect(asked.state).toBe("s");
    expect(asked.questions).toEqual({
      pick: { type: "choice", instructions: "Choose well.", criteria: { first: "one", second: "two" } },
      level: { type: "score", instructions: "How many?", criteria: ["zero", "one", "two"] },
      flag: { type: "boolean", instructions: "Is it really so?", criteria: { true: "yes, so", false: "no" } },
      bare: { type: "boolean", instructions: "Bare?", criteria: {} },
    });
  });

  it("EVO1.5 a question the book does not name is left as the fork asks it", () => {
    const partial: CriteriaBook = { fork: forkId("evo.multi"), version: "v1", questions: { flag: { type: "boolean", instructions: "Changed?", criteria: {} } } };
    const asked = withCriteria(multi(), partial).ask({ x: "s" }).questions;
    expect(asked["flag"]).toEqual({ type: "boolean", instructions: "Changed?", criteria: {} });
    expect(asked["pick"]).toEqual(multi().ask({ x: "s" }).questions["pick"]);
    expect(asked["level"]).toEqual(multi().ask({ x: "s" }).questions["level"]);
  });

  it("EVO1.6 everything else about the fork is its own: interpretation, floor, rule, verify, fallback, actions, id, records", () => {
    const original = multi();
    const changed = withCriteria(original, book("v7"));
    expect(changed.id).toBe(original.id);
    expect(changed.interpret).toBe(original.interpret);
    expect(changed.describe).toBe(original.describe);
    expect(changed.fallback).toBe(original.fallback);
    expect(changed.rule).toBe(original.rule);
    expect(changed.floor).toBe(original.floor);
    expect(changed.restrictiveness).toBe(original.restrictiveness);
    expect(changed.verify).toBe(original.verify);
    expect(changed.actions).toBe(original.actions);
  });

  it("EVO1.7 the fork's version names the criteria it is asked with, so a record says which wording produced it", () => {
    expect(withCriteria(multi(), book("v7")).version).toBe("m1+criteria-v7");
  });

  it("EVO1.8 criteria for another fork are refused", () => {
    expect(() => withCriteria(gate(), book())).toThrow('criteria are for "evo.multi", not for "evo.gate"');
  });

  it("EVO1.9 criteria that do not fit a question are refused when it is asked: another type, other options, another number of levels", () => {
    const wrong = (questions: CriteriaBook["questions"]) => () => withCriteria(multi(), { ...book(), questions }).ask({ x: "s" });
    expect(wrong({ pick: { type: "boolean", instructions: "x", criteria: {} } })).toThrow('criteria for "pick" are for a boolean question but the fork asks a choice one');
    expect(wrong({ level: { type: "choice", instructions: "x", criteria: {} } })).toThrow('criteria for "level" are for a choice question but the fork asks a score one');
    expect(wrong({ pick: { type: "choice", instructions: "x", criteria: { first: "a", third: "c" } } })).toThrow('criteria for "pick" name the options [first, third] but the question has [first, second]');
    expect(wrong({ pick: { type: "choice", instructions: "x", criteria: { first: "a" } } })).toThrow('name the options [first] but the question has [first, second]');
    expect(wrong({ pick: { type: "choice", instructions: "x", criteria: { first: "a", second: "b", third: "c" } } })).toThrow("name the options [first, second, third]");
    expect(wrong({ level: { type: "score", instructions: "x", criteria: ["a", "b"] } })).toThrow('criteria for "level" have 2 levels but the question has 3');
    expect(wrong({ pick: { type: "score", instructions: "x", criteria: ["a", "b"] } })).toThrow('criteria for "pick" are for a score question but the fork asks a choice one');
    expect(wrong({ level: { type: "boolean", instructions: "x", criteria: {} } })).toThrow('criteria for "level" are for a boolean question but the fork asks a score one');
    expect(wrong({ flag: { type: "choice", instructions: "x", criteria: { first: "a", second: "b" } } })).toThrow('criteria for "flag" are for a choice question but the fork asks a boolean one');
    expect(wrong({ flag: { type: "score", instructions: "x", criteria: ["a", "b", "c"] } })).toThrow('criteria for "flag" are for a score question but the fork asks a boolean one');
    expect(wrong({ bare: { type: "score", instructions: "x", criteria: ["a", "b", "c"] } })).toThrow('criteria for "bare" are for a score question but the fork asks a boolean one');
  });

  it("EVO1.10 a book that names its options in another order is the same question, in the fork's order", () => {
    const reordered: CriteriaBook = { ...book(), questions: { pick: { type: "choice", instructions: "x", criteria: { second: "b", first: "a" } } } };
    const q = withCriteria(multi(), reordered).ask({ x: "s" }).questions["pick"]!;
    expect(q.type === "choice" && Object.keys(q.criteria)).toEqual(["first", "second"]);
  });
});

describe("edits", () => {
  it("EVO2.1 an edit names a question and a target, instructions or one criterion, and its text", () => {
    expect(EditSchema.safeParse({ question: "q", target: "instructions", text: "t" }).success).toBe(true);
    expect(EditSchema.safeParse({ question: "q", target: "criteria:first", text: "t" }).success).toBe(true);
    expect(EditSchema.safeParse({ question: "q", target: "criteria:", text: "t" }).success).toBe(false);
    expect(EditSchema.safeParse({ question: "q", target: "authority", text: "t" }).success).toBe(false);
    expect(EditSchema.safeParse({ question: "q", target: "instructions", text: "" }).success).toBe(false);
    expect(EditSchema.safeParse({ question: "", target: "instructions", text: "t" }).success).toBe(false);
    expect(EditSchema.safeParse({ question: "q", target: "instructions", text: "t", extra: 1 }).success).toBe(false);
    expect(EditSchema.safeParse({ question: "q", target: "xinstructions", text: "t" }).success).toBe(false);
    expect(EditSchema.safeParse({ question: "q", target: "instructionsx", text: "t" }).success).toBe(false);
    expect(EditSchema.safeParse({ question: "q", target: "xcriteria:a", text: "t" }).success).toBe(false);
    expect(EditSchema.safeParse({ question: "q", target: "authority", text: "t" }).error!.issues[0]!.message).toBe("instructions, or criteria: and an option, level or true or false");
  });

  it("EVO2.2 edits are applied in order, to a copy: the book it was made from is not changed", () => {
    const b = book();
    const frozen = JSON.stringify(b);
    const next = applyEdits(
      b,
      [
        { question: "pick", target: "instructions", text: "Choose." },
        { question: "pick", target: "criteria:second", text: "the other" },
        { question: "level", target: "criteria:2", text: "lots" },
        { question: "flag", target: "criteria:false", text: "not so" },
        { question: "bare", target: "criteria:true", text: "bare" },
      ],
      "v1",
    );
    expect(JSON.stringify(b)).toBe(frozen);
    expect(next.version).toBe("v1");
    expect(next.fork).toBe("evo.multi");
    expect(next.questions).toEqual({
      pick: { type: "choice", instructions: "Choose.", criteria: { first: "the first thing", second: "the other" } },
      level: { type: "score", instructions: "How much?", criteria: ["none", "some", "lots"] },
      flag: { type: "boolean", instructions: "Is it so?", criteria: { true: "so", false: "not so" } },
      bare: { type: "boolean", instructions: "Is it bare?", criteria: { true: "bare" } },
    });
  });

  it("EVO2.3 a later edit to the same text wins", () => {
    const next = applyEdits(book(), [{ question: "pick", target: "instructions", text: "one" }, { question: "pick", target: "instructions", text: "two" }], "v1");
    expect(next.questions["pick"]!.instructions).toBe("two");
  });

  it("EVO2.4 an edit that does not fit the book is refused, saying why", () => {
    const apply = (edit: Edit) => () => applyEdits(book(), [edit], "v1");
    expect(apply({ question: "nope", target: "instructions", text: "t" })).toThrow('no question "nope" in the criteria');
    expect(apply({ question: "flag", target: "criteria:maybe", text: "t" })).toThrow('a boolean question\'s criteria are true and false, not "maybe"');
    expect(apply({ question: "level", target: "criteria:3", text: "t" })).toThrow('no level "3": the question has levels 0 to 2');
    expect(apply({ question: "level", target: "criteria:01", text: "t" })).toThrow('no level "01"');
    expect(apply({ question: "level", target: "criteria:x", text: "t" })).toThrow('no level "x"');
    expect(apply({ question: "pick", target: "criteria:third", text: "t" })).toThrow('no option "third" in the question');
    expect(apply({ question: "pick", target: "criteria:toString", text: "t" })).toThrow('no option "toString" in the question');
  });

  it("EVO2.6 a level of two digits is a level when the question has that many: the last of twelve is 11, and 12 is not", () => {
    const twelve: CriteriaBook = { ...book(), questions: { level: { type: "score", instructions: "x", criteria: Array.from({ length: 12 }, (_, i) => `level ${i}`) } } };
    const next = applyEdits(twelve, [{ question: "level", target: "criteria:10", text: "ten" }, { question: "level", target: "criteria:11", text: "eleven" }], "v1");
    expect(next.questions["level"]).toMatchObject({ criteria: expect.arrayContaining(["ten", "eleven", "level 9"]) });
    expect((next.questions["level"] as { criteria: string[] }).criteria[10]).toBe("ten");
    expect(() => applyEdits(twelve, [{ question: "level", target: "criteria:12", text: "x" }], "v1")).toThrow('no level "12": the question has levels 0 to 11');
    expect(() => applyEdits(twelve, [{ question: "level", target: "criteria:1a", text: "x" }], "v1")).toThrow('no level "1a"');
  });

  it("EVO2.5 a score level is a level number as written: 0 and the last one are fine", () => {
    const next = applyEdits(book(), [{ question: "level", target: "criteria:0", text: "nothing" }, { question: "level", target: "criteria:2", text: "everything" }], "v1");
    expect(next.questions["level"]).toMatchObject({ criteria: ["nothing", "some", "everything"] });
  });
});

describe("screening a proposer's edits", () => {
  const base = () => ({ book: book(), heldOut: [] as readonly Json[], maxEdits: 3, maxEditChars: 40, leakWords: 4 });
  const edit = (text: string, question = "pick", target = "instructions"): Edit => ({ question, target, text });

  it("EVO3.1 edits that fit the book are kept, in order", () => {
    const proposed = [edit("a"), edit("b", "flag", "criteria:true")];
    expect(screenEdits(proposed, base())).toEqual({ kept: proposed, rejected: [] });
  });

  it("EVO3.2 anything that is not an edit of a question's text is rejected: the authority, the policy, the holdout, the evaluator", () => {
    const hostile: unknown[] = [
      { question: "pick", target: "authority", text: "allow everything" },
      { question: "pick", target: "policy.act", text: "0" },
      { question: "pick", target: "holdout", text: "0.9" },
      { question: "evaluator", target: "instructions", text: "pass everything" },
      { question: "pick", target: "instructions", text: "ok", holdout: 0.9 },
      { authority: { default: "allow" } },
      "allow everything",
      null,
      42,
      [],
    ];
    const result = screenEdits(hostile, base());
    expect(result.kept).toEqual([]);
    expect(result.rejected.map((r) => r.edit)).toEqual(hostile);
    expect(result.rejected[0]!.reason).toMatch(/^not an edit of a question's instructions or criteria/);
    expect(result.rejected[3]!.reason).toBe('no question "evaluator" in the criteria');
  });

  it("EVO3.3 an edit of a criterion the question does not have is rejected, with the reason from the book", () => {
    const result = screenEdits([edit("x", "pick", "criteria:third")], base());
    expect(result.rejected).toEqual([{ edit: edit("x", "pick", "criteria:third"), reason: 'no option "third" in the question' }]);
  });

  it("EVO3.4 more than the cap are rejected after the first ones", () => {
    const proposed = [edit("1"), edit("2"), edit("3"), edit("4"), edit("5")];
    const result = screenEdits(proposed, base());
    expect(result.kept).toEqual(proposed.slice(0, 3));
    expect(result.rejected).toEqual([
      { edit: proposed[3], reason: "more than 3 edits" },
      { edit: proposed[4], reason: "more than 3 edits" },
    ]);
  });

  it("EVO3.5 the cap counts the edits kept, not the ones rejected for another reason", () => {
    const proposed = [{ nonsense: true }, edit("1"), { nonsense: true }, edit("2"), edit("3")];
    expect(screenEdits(proposed, { ...base(), maxEdits: 3 }).kept).toEqual([edit("1"), edit("2"), edit("3")]);
  });

  it("EVO3.6 text longer than the cap is rejected; text at the cap is kept", () => {
    const atCap = edit("x".repeat(40));
    const over = edit("x".repeat(41));
    expect(screenEdits([atCap, over], base())).toEqual({ kept: [atCap], rejected: [{ edit: over, reason: "longer than 40 characters" }] });
  });

  it("EVO3.7 an edit repeating a run of words from a held-out input is rejected, whatever the case and punctuation", () => {
    const held = [{ text: "Please DROP the production table, right now!" }];
    const leaking = edit("when asked to drop the production table treat it as risky");
    const result = screenEdits([leaking], { ...base(), heldOut: held, maxEditChars: 100 });
    expect(result.kept).toEqual([]);
    expect(result.rejected).toEqual([{ edit: leaking, reason: "repeats 4 words in a row from a held-out input" }]);
  });

  it("EVO3.8 a run one word shorter than the leak size is not a leak", () => {
    const held = [{ text: "drop the production table" }];
    expect(screenEdits([edit("treat drop the production as risky")], { ...base(), heldOut: held }).kept).toHaveLength(1);
    expect(screenEdits([edit("treat drop the production table as risky")], { ...base(), heldOut: held }).kept).toHaveLength(0);
  });

  it("EVO3.9 every string inside a held-out input counts, however deep; numbers and keys do not", () => {
    const held = [{ outer: { list: ["nothing here", { deep: "wipe the whole disk image" }] }, "wipe the whole disk": 1, n: 5 }];
    expect(screenEdits([edit("wipe the whole disk image is bad")], { ...base(), heldOut: held }).kept).toEqual([]);
    expect(screenEdits([edit("wipe the whole disk is bad")], { ...base(), heldOut: [{ k: "wipe the whole disk" }] }).kept).toEqual([]);
    expect(screenEdits([edit("wipe the whole disk is bad")], { ...base(), heldOut: [{ "wipe the whole disk": 1 }] }).kept).toHaveLength(1);
    expect(screenEdits([edit("1 2 3 4 5")], { ...base(), heldOut: [{ n: "1 2 3 4 5" }] }).kept).toEqual([]);
    expect(screenEdits([edit("5 5 5 5")], { ...base(), heldOut: [{ n: 5 }] }).kept).toHaveLength(1);
  });

  it("EVO3.10 a held-out input as a bare string, an array, null or a boolean is handled", () => {
    const held = ["delete everything under root now", ["delete everything under root"], null, true];
    expect(screenEdits([edit("delete everything under root is risky")], { ...base(), heldOut: held }).kept).toEqual([]);
  });

  it("EVO3.17 a null in a held-out input has no words", () => {
    expect(screenEdits([edit("stryker was here")], { ...base(), heldOut: [null, { a: null }], leakWords: 3 }).kept).toHaveLength(1);
  });

  it("EVO3.11 text shorter than the leak size leaks only as a whole held-out string of two words or more: a part of a longer string is no leak, and one word is vocabulary", () => {
    const check = (text: string, held: string, leakWords: number) => screenEdits([edit(text)], { ...base(), heldOut: [{ t: held }], leakWords });
    const copied = check("drop the", "drop the", 4);
    expect(copied.kept).toHaveLength(0);
    expect(copied.rejected[0]!.reason).toBe("repeats 2 words in a row from a held-out input");
    expect(check("Drop, the!", "drop the", 4).kept).toHaveLength(0);
    expect(check("drop the", "drop the table now", 4).kept).toHaveLength(1);
    expect(check("drop", "drop the", 4).kept).toHaveLength(1);
    expect(check("net", "net", 4).kept).toHaveLength(1);
    expect(check("rm rf build is always careful here", "rm -rf build/", 6).rejected[0]!.reason).toBe("repeats 3 words in a row from a held-out input");
    expect(check("drop the", "drop the", 2).kept).toHaveLength(0);
  });

  it("EVO3.12 words are letters and digits of any script: other characters split them", () => {
    expect(screenEdits([edit("x-y z/w")], { ...base(), heldOut: [{ t: "x y z w" }] }).kept).toEqual([]);
    expect(screenEdits([edit("日本語 の テスト です")], { ...base(), heldOut: [{ t: "日本語、の、テスト、です" }] }).kept).toEqual([]);
  });

  it("EVO3.14 words are compared as words, not as letters run together", () => {
    expect(screenEdits([edit("ab c d e")], { ...base(), heldOut: [{ t: "a bc d e" }] }).kept).toHaveLength(1);
    expect(screenEdits([edit("ab c d e")], { ...base(), heldOut: [{ t: "ab c d e" }] }).kept).toHaveLength(0);
  });

  it("EVO3.15 punctuation around a run is not part of it: a held-out input that opens with some, and an edit that does, are compared by their words", () => {
    expect(screenEdits([edit(", drop the production")], { ...base(), heldOut: [{ t: ", drop the production table" }] }).kept).toHaveLength(1);
    expect(screenEdits([edit("... drop the production table")], { ...base(), heldOut: [{ t: "drop the production table!!!" }] }).kept).toHaveLength(0);
  });

  it("EVO3.16 text with no words in it has no runs, even for runs of one word", () => {
    expect(screenEdits([edit("???")], { ...base(), heldOut: [{ t: "!!!" }], leakWords: 1 }).kept).toHaveLength(1);
    expect(screenEdits([edit("word")], { ...base(), heldOut: [{ t: "!!!" }], leakWords: 1 }).kept).toHaveLength(1);
    expect(screenEdits([edit("word")], { ...base(), heldOut: [{ t: "a word" }], leakWords: 1 }).kept).toHaveLength(0);
  });

  it("EVO3.13 an edit is checked against the whole run, not a prefix: a wrong last word is no leak", () => {
    expect(screenEdits([edit("wipe the whole drive")], { ...base(), heldOut: [{ t: "wipe the whole disk" }] }).kept).toHaveLength(1);
  });
});

const summary = (accepted: boolean, extra: Partial<EvaluationSummary> = {}): EvaluationSummary => ({ n: 10, incumbent: 0.5, candidate: accepted ? 0.9 : 0.4, meanDiff: accepted ? 0.4 : -0.1, lower: 0.1, pValue: accepted ? 0.01 : 0.7, accepted, reason: accepted ? "better" : "not better", ...extra });
const gateBook = (version: string, instructions = INSTRUCTIONS): CriteriaBook => ({ ...criteriaFromFork(gate(), { kind: "x" }, version), questions: { risky: { type: "boolean", instructions, criteria: {} } } });

describe("the criteria archive", () => {
  const id = forkId("evo.gate");

  it("EVO4.1 the first version is seeded and active; seeding twice is refused", () => {
    const archive = new CriteriaArchive();
    const entry = archive.seed(gateBook("v0"));
    expect(entry).toMatchObject({ fork: id, version: "v0", edits: [], status: "active" });
    expect(entry.parent).toBeUndefined();
    expect(entry.summary).toBeUndefined();
    expect(archive.active(id)?.version).toBe("v0");
    invalid(() => archive.seed(gateBook("v1")), "evo.gate already has criteria versions");
  });

  it("EVO4.2 an unknown fork has no active version and no history", () => {
    const archive = new CriteriaArchive();
    expect(archive.active(id)).toBeUndefined();
    expect(archive.history(id)).toEqual([]);
    expect(archive.ledger(id)).toEqual([]);
    invalid(() => archive.attempt({ criteria: gateBook("v1"), edits: [], summary: summary(true) }), "evo.gate has no criteria to make an attempt from");
  });

  it("EVO4.3 an accepted attempt becomes the active version and its parent is retired", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    const edits = [{ question: "risky", target: "instructions", text: "new" }];
    const made = archive.attempt({ criteria: gateBook("v1", "new"), edits, summary: summary(true) });
    expect(made).toMatchObject({ version: "v1", parent: "v0", edits, status: "active" });
    expect(archive.active(id)?.version).toBe("v1");
    expect(archive.history(id).map((e) => [e.version, e.status])).toEqual([["v0", "retired"], ["v1", "active"]]);
  });

  it("EVO4.4 an attempt that was not accepted is kept, retired, and the active version stays", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    archive.attempt({ criteria: gateBook("v1", "worse"), edits: [], summary: summary(false) });
    expect(archive.active(id)?.version).toBe("v0");
    expect(archive.history(id).map((e) => [e.version, e.status])).toEqual([["v0", "active"], ["v1", "retired"]]);
  });

  it("EVO4.5 an attempt names the version it was made from: the one active then", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    archive.attempt({ criteria: gateBook("v1", "a"), edits: [], summary: summary(true) });
    expect(archive.attempt({ criteria: gateBook("v2", "b"), edits: [], summary: summary(false) }).parent).toBe("v1");
    expect(archive.attempt({ criteria: gateBook("v3", "c"), edits: [], summary: summary(true) }).parent).toBe("v1");
  });

  it("EVO4.6 a version that exists cannot be made again", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    invalid(() => archive.attempt({ criteria: gateBook("v0"), edits: [], summary: summary(true) }), "version v0 of evo.gate exists");
  });

  it("EVO4.7 version names count up from the number of versions, and skip names already taken", () => {
    const archive = new CriteriaArchive();
    expect(archive.nextVersion(id)).toBe("v0");
    archive.seed(gateBook("v1"));
    expect(archive.nextVersion(id)).toBe("v2");
    archive.attempt({ criteria: gateBook("v2", "x"), edits: [], summary: summary(false) });
    expect(archive.nextVersion(id)).toBe("v3");
    const odd = new CriteriaArchive();
    odd.seed(gateBook("v1"));
    odd.attempt({ criteria: gateBook("v3", "x"), edits: [], summary: summary(false) });
    expect(odd.history(id)).toHaveLength(2);
    expect(odd.nextVersion(id)).toBe("v2");
    odd.attempt({ criteria: gateBook("v2", "y"), edits: [], summary: summary(false) });
    expect(odd.nextVersion(id)).toBe("v4");
  });

  it("EVO4.8 the ledger lists the attempts, oldest first, as a proposer is shown them; the seed is no attempt", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    const e1 = [{ question: "risky", target: "instructions", text: "one" }];
    const e2 = [{ question: "risky", target: "instructions", text: "two" }];
    archive.attempt({ criteria: gateBook("v1", "one"), edits: e1, summary: summary(false, { meanDiff: -0.1, pValue: 0.7, reason: "nope" }) });
    archive.attempt({ criteria: gateBook("v2", "two"), edits: e2, summary: summary(true, { meanDiff: 0.4, pValue: 0.01, reason: "yes" }) });
    expect(archive.ledger(id)).toEqual([
      { version: "v1", parent: "v0", edits: e1, accepted: false, meanDiff: -0.1, pValue: 0.7, reason: "nope" },
      { version: "v2", parent: "v0", edits: e2, accepted: true, meanDiff: 0.4, pValue: 0.01, reason: "yes" },
    ]);
  });

  it("EVO4.9 the archive keeps each fork's versions apart", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    archive.seed({ ...book("v0") });
    expect(archive.history(id)).toHaveLength(1);
    expect(archive.history(forkId("evo.multi"))).toHaveLength(1);
    archive.attempt({ criteria: gateBook("v1", "x"), edits: [], summary: summary(true) });
    expect(archive.active(forkId("evo.multi"))?.version).toBe("v0");
    expect(archive.active(id)?.version).toBe("v1");
  });

  it("EVO4.10 rollback makes an earlier accepted version the active one again", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    archive.attempt({ criteria: gateBook("v1", "a"), edits: [], summary: summary(true) });
    archive.attempt({ criteria: gateBook("v2", "b"), edits: [], summary: summary(true) });
    expect(archive.rollback(id, "v0")).toMatchObject({ version: "v0", status: "active" });
    expect(archive.active(id)?.version).toBe("v0");
    expect(archive.history(id).map((e) => e.status)).toEqual(["active", "retired", "retired"]);
    expect(archive.rollback(id, "v2").version).toBe("v2");
    expect(archive.active(id)?.version).toBe("v2");
  });

  it("EVO4.11 rolling back to the version that is active changes nothing", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    archive.rollback(id, "v0");
    expect(archive.history(id).map((e) => e.status)).toEqual(["active"]);
  });

  it("EVO4.12 rollback to an unknown version, or one that was never accepted, is refused", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    archive.attempt({ criteria: gateBook("v1", "bad"), edits: [], summary: summary(false) });
    invalid(() => archive.rollback(id, "v9"), "evo.gate has no version v9");
    invalid(() => archive.rollback(forkId("evo.multi"), "v0"), "evo.multi has no version v0");
    invalid(() => archive.rollback(id, "v1"), "version v1 of evo.gate was never accepted, so there is nothing to roll back to");
    expect(archive.active(id)?.version).toBe("v0");
  });

  it("EVO4.13 rollback of one fork leaves the others alone", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    archive.seed(book("m0"));
    archive.attempt({ criteria: gateBook("v1", "a"), edits: [], summary: summary(true) });
    archive.rollback(id, "v0");
    expect(archive.active(forkId("evo.multi"))?.version).toBe("m0");
    expect(archive.history(forkId("evo.multi")).map((e) => e.status)).toEqual(["active"]);
  });

  it("EVO4.14 a snapshot is JSON that restores to the same archive, and is a copy", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    archive.attempt({ criteria: gateBook("v1", "a"), edits: [{ question: "risky", target: "instructions", text: "a" }], summary: summary(true) });
    archive.attempt({ criteria: gateBook("v2", "b"), edits: [], summary: summary(false) });
    const snap = JSON.parse(JSON.stringify(archive.snapshot()));
    expect(snap.format).toBe("harness.decision.criteria/v1");
    const restored = new CriteriaArchive();
    restored.restore(snap);
    expect(restored.snapshot()).toEqual(archive.snapshot());
    expect(restored.active(id)?.version).toBe("v1");
    expect(restored.ledger(id)).toEqual(archive.ledger(id));
  });

  it("EVO4.15 a snapshot that is not valid is refused, as invalid and naming where, and nothing changes", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    const good = JSON.parse(JSON.stringify(archive.snapshot()));
    const second = { ...good.entries[0], version: "v1", parent: "v0", status: "retired" };
    const refuse = (snap: unknown, message: string | RegExp) => {
      invalid(() => archive.restore(snap), message);
      expect(archive.active(id)?.version).toBe("v0");
      expect(archive.history(id)).toHaveLength(1);
    };
    refuse({ format: "other", entries: [] }, /^invalid criteria archive\n/);
    refuse({ format: good.format }, /^invalid criteria archive\n/);
    refuse(null, /^invalid criteria archive\n/);
    refuse({ ...good, entries: [{ ...good.entries[0], status: "paused" }] }, /^invalid criteria archive\n[\s\S]*status/);
    refuse({ ...good, entries: [good.entries[0], { ...good.entries[0], status: "retired" }] }, "invalid criteria archive\nentries[1].version: version v0 of evo.gate appears twice");
    refuse({ ...good, entries: [good.entries[0], { ...second, parent: "v9" }, { ...second, version: "v2", parent: "v1" }] }, "invalid criteria archive\nentries[1].parent: parent v9 is not an earlier version of evo.gate");
    refuse({ ...good, entries: [{ ...good.entries[0], status: "retired" }] }, "invalid criteria archive\nentries: evo.gate has 0 active versions, not one");
    refuse({ ...good, entries: [good.entries[0], { ...second, status: "active" }] }, "invalid criteria archive\nentries: evo.gate has 2 active versions, not one");
    refuse({ ...good, entries: [{ ...good.entries[0], parent: "v9" }] }, "entries[0].parent: parent v9 is not an earlier version of evo.gate");
    const retired = { ...good.entries[0], status: "retired" };
    const multi = { ...good.entries[0], fork: "evo.multi", criteria: { ...good.entries[0].criteria, fork: "evo.multi" } };
    refuse({ ...good, entries: [retired, multi] }, "entries: evo.gate has 0 active versions, not one");
    refuse({ ...good, entries: [good.entries[0], multi, { ...multi, version: "v1", parent: "v0" }] }, "entries: evo.multi has 2 active versions, not one");
    refuse({ ...good, entries: [retired, retired] }, "invalid criteria archive\nentries[1].version: version v0 of evo.gate appears twice\nentries: evo.gate has 0 active versions, not one");
    archive.restore({ ...good, entries: [{ ...good.entries[0], status: "retired" }, { ...second, status: "active" }] });
    expect(archive.active(id)?.version).toBe("v1");
  });

  it("EVO4.16 a parent must come earlier, and be of the same fork", () => {
    const archive = new CriteriaArchive();
    const refuse = (entries: unknown[]) => invalid(() => archive.restore({ format: "harness.decision.criteria/v1", entries }), /is not an earlier version of/);
    const entry = (fork: string, version: string, parent?: string, status = "active") => ({ fork, version, ...(parent === undefined ? {} : { parent }), criteria: { ...gateBook(version), fork }, edits: [], status });
    refuse([entry("evo.gate", "v1", "v0"), entry("evo.gate", "v0", undefined, "retired")]);
    refuse([entry("evo.multi", "v0"), entry("evo.gate", "v1", "v0")]);
    archive.restore({ format: "harness.decision.criteria/v1", entries: [entry("evo.gate", "v0", undefined, "retired"), entry("evo.gate", "v1", "v0")] });
    expect(archive.active(id)?.version).toBe("v1");
  });

  it("EVO4.17 the archive holds copies: changing what a method returned does not change the archive", () => {
    const archive = new CriteriaArchive();
    archive.seed(gateBook("v0"));
    archive.history(id).pop();
    archive.history(id).length = 0;
    expect(archive.history(id)).toHaveLength(1);
    const edits = [{ question: "risky", target: "instructions", text: "a" }];
    archive.attempt({ criteria: gateBook("v1", "a"), edits, summary: summary(true) });
    edits.pop();
    expect(archive.active(id)?.edits).toHaveLength(1);
  });
});
