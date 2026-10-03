import { describe, expect, it } from "vitest";
import { evaluateCondition } from "../src/condition.ts";
import { induceRules } from "../src/distill.ts";
import type { InduceOptions } from "../src/distill.ts";
import type { Json } from "../src/types.ts";
import { outcome, record } from "./loops-fixtures.ts";

/** A decision whose input is `input` and whose right action is `action`. */
const rec = (input: Json, action: Json) => record({ input, action, outcome: outcome("correct") });
const many = (n: number, make: (i: number) => ReturnType<typeof rec>) => Array.from({ length: n }, (_, i) => make(i));
const opts = (patch: Partial<InduceOptions> = {}): InduceOptions => ({ minSupport: 3, minPurity: 1, maxRules: 1000, maxConditions: 1, ...patch });
const whens = (records: ReturnType<typeof rec>[], options: InduceOptions) => induceRules(records, options).map((r) => r.when);

describe("induceRules: what a field has to be like to be used", () => {
  it("DST10.1 strings that all differ, however alike their starts (ids), make no prefix rule", () => {
    const records = many(6, (i) => rec({ id: `req-${i}` }, "ask"));
    expect(induceRules(records, opts({ fields: ["id"], minSupport: 2 }))).toEqual([]);
  });

  it("DST10.2 a rule covers at least two records, though one is asked for: a prefix of a single string is not a rule", () => {
    const records = [rec({ command: "git status" }, "allow"), rec({ command: "git status" }, "allow"), rec({ command: "make all" }, "allow")];
    expect(whens(records, opts({ minSupport: 1 }))).toEqual([{ eq: ["command", "git status"] }]);
  });

  it("DST10.3 numbers are tested for equality only, never as a set", () => {
    const records = [...many(3, () => rec({ retries: 1 }, "warn")), ...many(3, () => rec({ retries: 2 }, "warn"))];
    expect(whens(records, opts({ minSupport: 5 }))).toEqual([]);
    expect(whens(records, opts({ minSupport: 3 })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([{ eq: ["retries", 1] }, { eq: ["retries", 2] }]);
  });

  it("DST10.4 a key that is empty is not a step of a path: what is under it is not found by its inner names", () => {
    const records = many(4, () => rec({ "": { tool: "bash" } }, "ask"));
    expect(induceRules(records, opts())).toEqual([]);
  });

  it("DST10.5 a value an object has at a path that other inputs lack still counts where it is", () => {
    const records = [...many(3, () => rec({ tool: "bash", flag: "on" }, "ask")), ...many(3, () => rec({ tool: "read" }, "allow"))];
    expect(whens(records, opts({ fields: ["flag"] }))).toEqual([{ eq: ["flag", "on"] }]);
  });

  it("DST10.6 no field is invented: min purity 0 and min purity 1 are both allowed", () => {
    const records = [...many(3, () => rec({ tool: "bash" }, "ask")), rec({ tool: "bash" }, "allow")];
    expect(induceRules(records, opts({ minPurity: 0 }))).toHaveLength(1);
    expect(induceRules(records, opts({ minPurity: 1 }))).toEqual([]);
  });
});

describe("induceRules: sets and prefixes", () => {
  it("DST10.7 a set lists its strings in order, whatever the order they were seen in or how often", () => {
    const a = [...many(3, () => rec({ tool: "c" }, "allow")), ...many(2, () => rec({ tool: "a" }, "allow")), ...many(2, () => rec({ tool: "b" }, "allow")), ...many(6, () => rec({ tool: "z" }, "ask"))];
    const set = (records: typeof a) => induceRules(records, opts({ minSupport: 7 })).map((r) => r.when);
    expect(set(a)).toEqual([{ in: ["tool", ["a", "b", "c"]] }]);
    expect(set([...a].reverse())).toEqual([{ in: ["tool", ["a", "b", "c"]] }]);
  });

  it("DST10.8 a set takes the strings that occur most, then the first in order, and no more than sixteen", () => {
    const values = Array.from({ length: 20 }, (_, i) => `v${String(i).padStart(2, "0")}`).reverse(); // v19 first
    const records = [...values.flatMap((v) => many(2, () => rec({ tool: v }, "ok"))), ...many(5, () => rec({ tool: "zzz" }, "ok"))];
    const rules = induceRules(records, opts({ minSupport: 2 }));
    const set = rules.find((r) => "in" in r.when)!;
    expect(set.when).toEqual({ in: ["tool", [...Array.from({ length: 15 }, (_, i) => `v${String(i).padStart(2, "0")}`), "zzz"]] });
    expect(set.support).toBe(35);
    expect(rules.filter((r) => "eq" in r.when).map((r) => (r.when as { eq: [string, string] }).eq[1]).sort()).toEqual(["v15", "v16", "v17", "v18", "v19"]);
  });

  it("DST10.8a the same, whether the strings were first seen in order or in reverse", () => {
    const values = Array.from({ length: 20 }, (_, i) => `v${String(i).padStart(2, "0")}`); // v00 first
    const records = [...values.flatMap((v) => many(2, () => rec({ tool: v }, "ok"))), ...many(5, () => rec({ tool: "zzz" }, "ok"))];
    const set = induceRules(records, opts({ minSupport: 2 })).find((r) => "in" in r.when)!;
    expect(set.when).toEqual({ in: ["tool", [...values.slice(0, 15), "zzz"]] });
  });

  it("DST10.9 a string joins a set when its purity for the action is the purity asked, not only above it", () => {
    const records = [rec({ tool: "a" }, "allow"), rec({ tool: "a" }, "deny"), rec({ tool: "b" }, "allow"), rec({ tool: "b" }, "deny")];
    const rules = induceRules(records, opts({ minSupport: 2, minPurity: 0.5 }));
    expect(rules.map((r) => [r.when, r.action, r.support, r.purity])).toEqual(expect.arrayContaining([[{ in: ["tool", ["a", "b"]] }, "allow", 4, 0.5]]));
  });

  it("DST10.10 a string that mostly predicts another action does not join a set, so the set keeps its purity", () => {
    const records = [...many(2, () => rec({ tool: "a" }, "allow")), ...many(2, () => rec({ tool: "b" }, "allow")), rec({ tool: "c" }, "allow"), rec({ tool: "c" }, "deny"), rec({ tool: "c" }, "deny")];
    const rules = induceRules(records, opts({ minSupport: 4, minPurity: 0.5 }));
    expect(rules.map((r) => r.when)).toEqual([{ in: ["tool", ["a", "b"]] }]);
    expect(rules[0]!.purity).toBe(1);
  });

  it("DST10.11 a prefix ends at a word boundary: each of the characters that end a word does", () => {
    for (const d of [" ", "/", "-", "_", ".", ":", "=", ",", ";"]) {
      const records = [...many(3, (i) => rec({ v: `abc${d}${i}` }, "yes")), ...many(2, () => rec({ v: "xyz" }, "no"))];
      expect(whens(records, opts()), JSON.stringify(d)).toEqual([{ prefix: ["v", `abc${d}`] }]);
    }
  });

  it("DST10.12 a prefix is made at the first eight word boundaries of a string and no later one", () => {
    const text = (diverge: number, tag: string, n: number) => [..."abcdefghi".slice(0, diverge - 1), tag, String(n)].join(" ");
    const field = (diverge: number) => [...many(3, (n) => rec({ v: text(diverge, "x", n) }, "allow")), ...many(3, (n) => rec({ v: text(diverge, "y", n) }, "ask")), ...many(2, () => rec({ v: "zzz" }, "other"))];
    expect(whens(field(8), opts())).toEqual(expect.arrayContaining([{ prefix: ["v", "a b c d e f g x "] }, { prefix: ["v", "a b c d e f g y "] }]));
    expect(whens(field(8), opts())).toHaveLength(2);
    expect(whens(field(9), opts())).toEqual([]);
  });

  it("DST10.13 a prefix covers every string that starts with it, the string that is the prefix itself too", () => {
    const records = [...many(2, () => rec({ cmd: "git " }, "allow")), rec({ cmd: "git status" }, "allow"), rec({ cmd: "git log" }, "allow"), ...many(3, () => rec({ cmd: "rm x" }, "ask"))];
    const rules = induceRules(records, opts({ minSupport: 4 }));
    const git = rules.find((r) => "prefix" in r.when)!;
    expect(git.when).toEqual({ prefix: ["cmd", "git "] });
    expect(git.support).toBe(4);
    expect(records.filter((r) => evaluateCondition(git.when, r.input)).length).toBe(4);
  });

  it("DST10.14 the rows a prefix covers are in order, so that joining it to another test counts them all", () => {
    const records = [
      rec({ command: "git b1", env: "prod" }, "x"),
      rec({ command: "git a1", env: "prod" }, "x"),
      rec({ command: "git b2", env: "prod" }, "x"),
      rec({ command: "git a2", env: "prod" }, "x"),
      rec({ command: "git c", env: "dev" }, "y"),
      ...many(3, () => rec({ command: "other", env: "dev" }, "y")),
      ...many(2, () => rec({ command: "other", env: "prod" }, "y")),
    ];
    const rules = induceRules(records, opts({ minSupport: 4, maxConditions: 2 }));
    expect(rules.map((r) => [r.when, r.action, r.support])).toContainEqual([{ all: [{ eq: ["env", "prod"] }, { prefix: ["command", "git "] }] }, "x", 4]);
  });
});

describe("induceRules: choosing and ranking", () => {
  it("DST10.15 only the 256 widest tests are kept to build rules from, the first in order among equals", () => {
    const widths = (k: number) => 2 + (k % 3);
    const records = Array.from({ length: 300 }, (_, k) => many(widths(k), () => rec({ v: `v${String(k).padStart(3, "0")}` }, `a${k}`))).flat();
    const expected = Array.from({ length: 300 }, (_, k) => ({ text: `v${String(k).padStart(3, "0")}`, n: widths(k) }))
      .sort((a, b) => b.n - a.n || (a.text < b.text ? -1 : 1))
      .slice(0, 256)
      .map((v) => v.text)
      .sort();
    const rules = induceRules(records, opts({ minSupport: 2 }));
    expect(rules.map((r) => (r.when as { eq: [string, string] }).eq[1]).sort()).toEqual(expected);
  });

  it("DST10.15a the widest tests are kept across fields too: a wider test of one field before a narrower one of another", () => {
    const named = (field: string, k: number) => `${field}${String(k).padStart(3, "0")}`;
    const records = [
      ...Array.from({ length: 150 }, (_, k) => many(2, () => rec({ a: named("a", k) }, `x${k}`))).flat(),
      ...Array.from({ length: 150 }, (_, k) => many(3, () => rec({ b: named("b", k) }, `y${k}`))).flat(),
    ];
    const kept = induceRules(records, opts({ minSupport: 2 })).map((r) => (r.when as { eq: [string, string] }).eq[1]);
    const expected = [...Array.from({ length: 150 }, (_, k) => named("b", k)), ...Array.from({ length: 106 }, (_, k) => named("a", k))];
    expect([...kept].sort()).toEqual([...expected].sort());
  });

  it("DST10.15b among tests of equal width, those on the field that sorts first are kept, whichever field was seen first", () => {
    const named = (field: string, k: number) => `${field}${String(k).padStart(3, "0")}`;
    const records = [
      ...Array.from({ length: 150 }, (_, k) => many(2, () => rec({ b: named("b", k) }, `y${k}`))).flat(),
      ...Array.from({ length: 150 }, (_, k) => many(2, () => rec({ a: named("a", k) }, `x${k}`))).flat(),
    ];
    const kept = induceRules(records, opts({ minSupport: 2 })).map((r) => (r.when as { eq: [string, string] }).eq[1]);
    const expected = [...Array.from({ length: 150 }, (_, k) => named("a", k)), ...Array.from({ length: 106 }, (_, k) => named("b", k))];
    expect([...kept].sort()).toEqual([...expected].sort());
  });

  it("DST10.16 the conditions of a conjunction are in order of their text, whichever test is wider", () => {
    const grid = (wide: string, narrow: string) => {
      const cell = (w: number, n: number, action: string, times: number) => many(times, () => rec({ [wide]: w, [narrow]: n }, action));
      return [...cell(1, 1, "x", 3), ...cell(1, 0, "y", 3), ...cell(0, 1, "y", 2), ...cell(0, 0, "y", 1)];
    };
    const pair = (records: ReturnType<typeof rec>[]) => whens(records, opts({ maxConditions: 2 })).filter((w) => "all" in w);
    expect(pair(grid("zz", "aa"))).toEqual([{ all: [{ eq: ["aa", 1] }, { eq: ["zz", 1] }] }]);
    expect(pair(grid("aa", "zz"))).toEqual([{ all: [{ eq: ["aa", 1] }, { eq: ["zz", 1] }] }]);
  });

  it("DST10.17 a rule with one condition comes before a rule with two, however much wider the second is", () => {
    const xor = [
      ...many(5, () => rec({ tool: "bash", user: "alice" }, "allow")),
      ...many(5, () => rec({ tool: "bash", user: "bob" }, "ask")),
      ...many(5, () => rec({ tool: "read", user: "alice" }, "ask")),
      ...many(5, () => rec({ tool: "read", user: "bob" }, "allow")),
    ];
    const rules = induceRules([...xor, ...many(3, () => rec({ tool: "write", user: "dave" }, "deny"))], opts({ maxConditions: 2 }));
    expect(rules.map((r) => [r.support, "all" in r.when])).toEqual([[3, false], [5, true], [5, true], [5, true], [5, true]]);
  });

  it("DST10.18 equal rules in conditions and support: the purer first", () => {
    const records = [...many(5, () => rec({ a: 1 }, "p")), ...many(4, () => rec({ b: 1 }, "q")), rec({ b: 1 }, "p")];
    const rules = induceRules(records, opts({ minSupport: 5, minPurity: 0.8 }));
    expect(rules.map((r) => [r.when, r.purity])).toEqual([[{ eq: ["a", 1] }, 1], [{ eq: ["b", 1] }, 0.8]]);
    const flipped = [...many(5, () => rec({ b: 1 }, "p")), ...many(4, () => rec({ a: 1 }, "q")), rec({ a: 1 }, "p")];
    expect(induceRules(flipped, opts({ minSupport: 5, minPurity: 0.8 })).map((r) => r.purity)).toEqual([1, 0.8]);
  });

  it("DST10.19 equal rules in everything else are in order of their ids", () => {
    const records = Array.from({ length: 8 }, (_, k) => many(3, () => rec({ tool: `t${k}` }, `a${k}`))).flat();
    const rules = induceRules(records, opts());
    expect(rules).toHaveLength(8);
    expect(rules.map((r) => r.id)).toEqual(rules.map((r) => r.id).sort());
    expect(new Set(rules.map((r) => r.id)).size).toBe(8);
  });

  it("DST10.20 a rule's id is made from its condition alone, in sixteen hex digits, and does not change", () => {
    const rules = induceRules([...many(3, () => rec({ tool: "t0" }, "a")), ...many(3, () => rec({ tool: "t3" }, "b"))], opts());
    expect(Object.fromEntries(rules.map((r) => [JSON.stringify(r.when), r.id]))).toEqual({
      [JSON.stringify({ eq: ["tool", "t0"] })]: "rule-881d8ebd0287b1f4",
      [JSON.stringify({ eq: ["tool", "t3"] })]: "rule-07c75ab2f1d3c7c9",
    });
  });

  it("DST10.21 when two actions are equally common in what a test covers, the one that sorts first is the rule's", () => {
    const records = [rec({ tool: "bash" }, "deny"), rec({ tool: "bash" }, "deny"), rec({ tool: "bash" }, "allow"), rec({ tool: "bash" }, "allow")];
    expect(induceRules(records, opts({ minSupport: 4, minPurity: 0.5 })).map((r) => [r.action, r.purity])).toEqual([["allow", 0.5]]);
    expect(induceRules([...records].reverse(), opts({ minSupport: 4, minPurity: 0.5 })).map((r) => r.action)).toEqual(["allow"]);
  });

  it("DST10.22 a rule inside a wider one is kept when it says something else, and a rule that only overlaps one is kept whatever it says", () => {
    const exception = [...many(6, () => rec({ tool: "bash", flag: "y" }, "allow")), ...many(2, () => rec({ tool: "bash", flag: "x" }, "ask"))];
    const rules = induceRules(exception, opts({ minSupport: 2, minPurity: 0.75 }));
    expect(rules.map((r) => [r.when, r.action, r.support])).toEqual([[{ eq: ["tool", "bash"] }, "allow", 8], [{ eq: ["flag", "x"] }, "ask", 2]]);
    const overlap = [
      ...many(3, () => rec({ a: 1, b: 0 }, "go")),
      ...many(3, () => rec({ a: 1, b: 1 }, "go")),
      ...many(3, () => rec({ a: 0, b: 1 }, "go")),
      ...many(3, () => rec({ a: 0, b: 0 }, "stop")),
    ];
    expect(whens(overlap, opts()).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))).toEqual([{ eq: ["a", 1] }, { eq: ["b", 1] }]);
  });
});
