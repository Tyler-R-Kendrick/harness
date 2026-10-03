import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { evaluateCondition } from "../src/condition.ts";
import { compileRules, induceRules, lifecycleRule, sessionsOf, shadowRules } from "../src/distill.ts";
import type { InduceOptions } from "../src/distill.ts";
import { Lifecycle, parseLifecycleSettings } from "../src/lifecycle.ts";
import type { Json } from "../src/types.ts";
import { outcome, record } from "./loops-fixtures.ts";

/** A decision whose input is `input` and whose right action is `action`. */
const rec = (input: Json, action: Json, extra: Parameters<typeof record>[0] = {}) => record({ input, action, outcome: outcome("correct"), ...extra });
const many = (n: number, make: (i: number) => ReturnType<typeof rec>) => Array.from({ length: n }, (_, i) => make(i));
const opts = (patch: Partial<InduceOptions> = {}): InduceOptions => ({ minSupport: 3, minPurity: 0.9, maxRules: 10, maxConditions: 1, ...patch });

describe("induceRules: conditions", () => {
  it("DST5.1 a value that predicts the right action becomes a rule, with the support and purity it really has", () => {
    const records = [...many(6, () => rec({ tool: "bash" }, "ask")), ...many(4, () => rec({ tool: "read" }, "allow"))];
    const rules = induceRules(records, opts());
    expect(rules.map((r) => [r.when, r.action, r.support, r.purity])).toEqual([
      [{ eq: ["tool", "bash"] }, "ask", 6, 1],
      [{ eq: ["tool", "read"] }, "allow", 4, 1],
    ]);
  });

  it("DST5.2a a field that only some inputs have is tested only where it is present", () => {
    const records = [...many(4, () => rec({ tool: "bash", flag: "on" }, "ask")), ...many(4, () => rec({ tool: "read" }, "allow"))];
    const rules = induceRules(records, opts({ fields: ["flag"] }));
    expect(rules.map((r) => [r.when, r.action, r.support, r.purity])).toEqual([[{ eq: ["flag", "on"] }, "ask", 4, 1]]);
  });

  it("DST5.2 a rule needs the support asked for", () => {
    const records = [...many(6, () => rec({ tool: "bash" }, "ask")), ...many(2, () => rec({ tool: "read" }, "allow"))];
    expect(induceRules(records, opts()).map((r) => r.when)).toEqual([{ eq: ["tool", "bash"] }]);
    expect(induceRules(records, opts({ minSupport: 2 })).map((r) => r.when)).toHaveLength(2);
  });

  it("DST5.3 a rule needs the purity asked for, and reports the purity it has", () => {
    const records = [...many(5, () => rec({ tool: "bash" }, "allow")), rec({ tool: "bash" }, "deny")];
    expect(induceRules(records, opts({ minPurity: 0.8 })).map((r) => [r.action, r.support, r.purity])).toEqual([["allow", 6, 5 / 6]]);
    expect(induceRules(records, opts({ minPurity: 0.9 }))).toEqual([]);
    expect(induceRules(records, opts({ minPurity: 5 / 6 })).map((r) => r.action)).toEqual(["allow"]); // a purity met exactly is met
  });

  it("DST5.4 a support met exactly is met", () => {
    expect(induceRules(many(3, () => rec({ tool: "bash" }, "ask")), opts({ minSupport: 3 }))).toHaveLength(1);
    expect(induceRules(many(3, () => rec({ tool: "bash" }, "ask")), opts({ minSupport: 4 }))).toHaveLength(0);
  });

  it("DST5.5 at most the number of rules asked for are returned, the best first", () => {
    const records = [...many(3, () => rec({ tool: "a" }, "x")), ...many(5, () => rec({ tool: "b" }, "y")), ...many(4, () => rec({ tool: "c" }, "z"))];
    expect(induceRules(records, opts({ maxRules: 2 })).map((r) => r.when)).toEqual([{ eq: ["tool", "b"] }, { eq: ["tool", "c"] }]);
    expect(induceRules(records, opts({ maxRules: 0 }))).toEqual([]);
  });

  it("DST5.6 numbers and booleans are tested for equality", () => {
    const numbers = [...many(4, (i) => rec({ retries: 3, id: i }, "warn")), ...many(4, (i) => rec({ retries: 0, id: 10 + i }, "go"))];
    expect(induceRules(numbers, opts()).map((r) => [r.when, r.action])).toEqual(expect.arrayContaining([[{ eq: ["retries", 3] }, "warn"], [{ eq: ["retries", 0] }, "go"]]));
    const booleans = [...many(4, (i) => rec({ dry: true, id: i }, "warn")), ...many(4, (i) => rec({ dry: false, id: 10 + i }, "go"))];
    expect(induceRules(booleans, opts()).map((r) => [r.when, r.action])).toEqual(expect.arrayContaining([[{ eq: ["dry", true] }, "warn"], [{ eq: ["dry", false] }, "go"]]));
    for (const r of [...induceRules(numbers, opts()), ...induceRules(booleans, opts())]) expect(JSON.stringify(r.when)).not.toMatch(/prefix|"in"/);
  });

  it("DST5.7 strings that share a start, at a word boundary, make a prefix rule, though each occurs once", () => {
    const records = [...many(5, (i) => rec({ command: `git status --short ${i}` }, "allow")), ...many(5, (i) => rec({ command: `rm -rf build-${i}` }, "ask")), rec({ command: "git status" }, "allow"), rec({ command: "git status" }, "allow")];
    const rules = induceRules(records, opts({ minSupport: 4 }));
    expect(rules.find((r) => r.action === "allow")?.when).toEqual({ prefix: ["command", "git "] });
    expect(rules.find((r) => r.action === "ask")?.when).toEqual({ prefix: ["command", "rm "] });
  });

  it("DST5.8 strings that repeat and each predict one action make a set, when no one of them has the support", () => {
    const records = [...many(2, () => rec({ tool: "a" }, "allow")), ...many(2, () => rec({ tool: "b" }, "allow")), ...many(2, () => rec({ tool: "c" }, "allow")), ...many(6, () => rec({ tool: "z" }, "ask"))];
    const rules = induceRules(records, opts({ minSupport: 5 }));
    expect(rules.map((r) => [r.when, r.action, r.support])).toEqual(
      expect.arrayContaining([
        [{ eq: ["tool", "z"] }, "ask", 6],
        [{ in: ["tool", ["a", "b", "c"]] }, "allow", 6],
      ]),
    );
    expect(rules).toHaveLength(2);
  });

  it("DST5.9 a value that mostly predicts something else is not put in a set", () => {
    const records = [...many(2, () => rec({ tool: "a" }, "allow")), ...many(2, () => rec({ tool: "b" }, "allow")), rec({ tool: "b" }, "deny"), rec({ tool: "b" }, "deny"), rec({ tool: "b" }, "deny"), rec({ tool: "b" }, "deny")];
    const sets = induceRules(records, opts({ minSupport: 2, minPurity: 0.8 })).filter((r) => "in" in r.when);
    expect(sets).toEqual([]);
  });

  it("DST5.10 two conditions together make a rule that neither makes alone, when the conditions ask for two", () => {
    const records = [
      ...many(4, () => rec({ tool: "bash", user: "alice" }, "allow")),
      ...many(4, () => rec({ tool: "bash", user: "bob" }, "ask")),
      ...many(4, () => rec({ tool: "read", user: "alice" }, "ask")),
      ...many(4, () => rec({ tool: "read", user: "bob" }, "allow")),
    ];
    expect(induceRules(records, opts())).toEqual([]);
    const rules = induceRules(records, opts({ maxConditions: 2 }));
    expect(rules).toHaveLength(4);
    expect(rules.map((r) => [r.support, r.purity])).toEqual([[4, 1], [4, 1], [4, 1], [4, 1]]);
    const bashAlice = rules.find((r) => r.action === "allow" && JSON.stringify(r.when).includes("bash"));
    expect(bashAlice?.when).toEqual({ all: [{ eq: ["tool", "bash"] }, { eq: ["user", "alice"] }] });
  });

  it("DST5.11 a conjunction is not made of two tests on one path, nor when one test says it all", () => {
    const records = [...many(5, () => rec({ tool: "bash", shell: "sh" }, "ask")), ...many(5, () => rec({ tool: "read", shell: "sh" }, "allow"))];
    const rules = induceRules(records, opts({ maxConditions: 2 }));
    for (const r of rules) expect("all" in r.when).toBe(false);
  });

  it("DST5.12 a field where no value repeats is never used, however pure it would be", () => {
    const records = many(12, (i) => rec({ id: `req-${i}`, at: 1_700_000_000_000 + i * 17, tool: i < 6 ? "a" : "b" }, i < 6 ? "x" : "y"));
    const whens = induceRules(records, opts({ minSupport: 1, minPurity: 1, maxConditions: 2 })).map((r) => JSON.stringify(r.when));
    for (const w of whens) expect(w).not.toMatch(/"id"|"at"|req-/);
    expect(whens.some((w) => w.includes("tool"))).toBe(true);
  });

  it("DST5.13 a value that occurs once is never tested for, even when the support asked for is one", () => {
    const records = [rec({ tag: "once" }, "x"), rec({ tag: "twice" }, "y"), rec({ tag: "twice" }, "y")];
    expect(induceRules(records, opts({ minSupport: 1 })).map((r) => r.when)).toEqual([{ eq: ["tag", "twice"] }]);
  });

  it("DST5.14 the fields asked for are the only ones used", () => {
    const records = [...many(5, () => rec({ tool: "bash", user: "alice" }, "ask")), ...many(5, () => rec({ tool: "read", user: "bob" }, "allow"))];
    expect(induceRules(records, opts({ fields: ["user"] })).map((r) => r.when)).toEqual([{ eq: ["user", "alice"] }, { eq: ["user", "bob"] }]);
    expect(induceRules(records, opts({ fields: [] }))).toEqual([]);
  });

  it("DST5.15 nested objects and arrays are flattened to dot paths, and keys that cannot be a path are left out", () => {
    const records = many(6, () => rec({ call: { name: "bash", args: ["-l", "x"] }, "a.b": "dotted", "": "empty", nothing: null }, "ask"));
    const on = (field: string) => induceRules(records, opts({ fields: [field] })).map((r) => r.when);
    expect(on("call.name")).toEqual([{ eq: ["call.name", "bash"] }]);
    expect(on("call.args.0")).toEqual([{ eq: ["call.args.0", "-l"] }]);
    expect(on("call.args.1")).toEqual([{ eq: ["call.args.1", "x"] }]);
    for (const field of ["a.b", "", "nothing", "a", "b", "call", "call.args"]) expect(on(field), field).toEqual([]);
  });

  it("DST5.16 flattening stops at a depth, at the first items of an array, and at long text", () => {
    const items = Array.from({ length: 20 }, (_, i) => `item${i}`);
    const records = many(6, () => rec({ deep: { a: { b: { c: { d: { e: "six" } } } } }, deeper: { a: { b: { c: { d: { e: { f: "seven" } } } } } }, items, long: "z".repeat(300), edge: "y".repeat(256), short: "s" }, "ask"));
    const on = (field: string) => induceRules(records, opts({ fields: [field] })).length;
    expect(on("deep.a.b.c.d.e")).toBe(1);
    expect(on("deeper.a.b.c.d.e.f")).toBe(0);
    expect(on("items.15")).toBe(1);
    expect(on("items.16")).toBe(0);
    expect(on("long")).toBe(0);
    expect(on("edge")).toBe(1);
    expect(on("short")).toBe(1);
  });

  it("DST5.17 an input that is not an object has no paths to make rules of", () => {
    expect(induceRules(many(6, () => rec("just text", "ask")), opts())).toEqual([]);
    expect(induceRules(many(6, () => rec(7, "ask")), opts())).toEqual([]);
  });

  it("DST5.18 the right action is the outcome's label when it has one, and the decision's own when the outcome confirmed it", () => {
    const records = many(6, () => record({ input: { tool: "bash" }, action: "allow", outcome: outcome("incorrect", { label: "deny" }) }));
    expect(induceRules(records, opts()).map((r) => r.action)).toEqual(["deny"]);
  });

  it("DST5.19 decisions whose right action is not known teach nothing", () => {
    const records = [
      ...many(6, () => record({ input: { tool: "bash" }, action: "allow" })), // no outcome, decided by the model
      ...many(6, () => record({ input: { tool: "read" }, action: "allow", outcome: outcome("incorrect") })), // wrong, and no label
    ];
    expect(induceRules(records, opts())).toEqual([]);
  });

  it("DST5.20 a later rung's action counts as right for a decision with no outcome", () => {
    expect(induceRules(many(6, () => record({ input: { tool: "bash" }, action: "deny", rung: "judge" })), opts()).map((r) => r.action)).toEqual(["deny"]);
  });

  it("DST5.21 structured actions are rules' actions, and equal actions are counted whatever the order of their keys", () => {
    const records = [...many(3, () => rec({ tool: "a" }, { level: "high", why: "x" })), ...many(3, () => rec({ tool: "a" }, { why: "x", level: "high" }))];
    const [rule] = induceRules(records, opts());
    expect(rule).toMatchObject({ support: 6, purity: 1 });
    expect(rule?.action).toEqual({ level: "high", why: "x" });
  });

  it("DST5.22 when two actions tie, the one whose text sorts first is the rule's", () => {
    const records = [...many(3, () => rec({ tool: "a" }, "zed")), ...many(3, () => rec({ tool: "a" }, "alpha"))];
    expect(induceRules(records, opts({ minPurity: 0.5 }))[0]).toMatchObject({ action: "alpha", support: 6, purity: 0.5 });
  });

  it("DST5.23 no records, or none that are known, give no rules", () => {
    expect(induceRules([], opts())).toEqual([]);
  });

  it("DST5.24 options that cannot be right are refused, saying why", () => {
    expect(() => induceRules([], opts({ minSupport: 0 }))).toThrow("minSupport is a whole number from 1, got 0");
    expect(() => induceRules([], opts({ minSupport: 1.5 }))).toThrow("minSupport is a whole number from 1, got 1.5");
    expect(() => induceRules([], opts({ minPurity: 1.1 }))).toThrow("minPurity is from 0 to 1, got 1.1");
    expect(() => induceRules([], opts({ minPurity: -0.1 }))).toThrow("minPurity is from 0 to 1, got -0.1");
    expect(() => induceRules([], opts({ maxRules: -1 }))).toThrow("maxRules is a whole number from 0, got -1");
    expect(() => induceRules([], opts({ maxRules: 1.5 }))).toThrow("maxRules is a whole number from 0, got 1.5");
    expect(() => induceRules([], { ...opts(), maxConditions: 3 as never })).toThrow("maxConditions is 1 or 2, got 3");
  });
});

describe("induceRules: choosing and naming", () => {
  it("DST5.25 simpler rules come before wider ones, wider before narrower, and equals by id", () => {
    const records = [
      ...many(4, () => rec({ tool: "bash", user: "alice" }, "ask")),
      ...many(6, () => rec({ tool: "bash", user: "bob" }, "ask")),
      ...many(3, () => rec({ tool: "read", user: "alice" }, "allow")),
      ...many(3, () => rec({ tool: "read", user: "bob" }, "allow")),
    ];
    const rules = induceRules(records, opts({ maxConditions: 2, minSupport: 3 }));
    const conditions = rules.map((r) => ("all" in r.when ? 2 : 1));
    expect(conditions).toEqual([...conditions].sort());
    const singles = rules.filter((r) => !("all" in r.when));
    expect(singles.map((r) => r.support)).toEqual([...singles.map((r) => r.support)].sort((a, b) => b - a));
    const tied = rules.filter((r, _, all) => all.filter((o) => o.support === r.support && ("all" in o.when) === ("all" in r.when)).length > 1);
    for (let i = 1; i < tied.length; i++) if (tied[i - 1]!.support === tied[i]!.support && ("all" in tied[i - 1]!.when) === ("all" in tied[i]!.when)) expect(tied[i - 1]!.id < tied[i]!.id).toBe(true);
  });

  it("DST5.26 a rule's id comes from its condition alone, in a form that does not change with the records or their order", () => {
    const records = [...many(4, () => rec({ tool: "bash" }, "ask")), ...many(4, () => rec({ tool: "read" }, "allow"))];
    const a = induceRules(records, opts());
    const b = induceRules([...records].reverse(), opts());
    const more = induceRules([...records, ...many(3, () => rec({ tool: "bash" }, "ask"))], opts());
    expect(b).toEqual(a);
    expect(more.find((r) => JSON.stringify(r.when) === JSON.stringify(a[0]!.when))?.id).toBe(a[0]!.id);
    for (const r of a) expect(r.id).toMatch(/^rule-[0-9a-f]{16}$/);
    expect(new Set(a.map((r) => r.id)).size).toBe(a.length);
  });

  it("DST5.27 a condition is one rule whichever of its two tests came first", () => {
    const records = [...many(4, () => rec({ tool: "bash", user: "alice" }, "ask")), ...many(4, () => rec({ tool: "read", user: "bob" }, "allow"))];
    const ids = induceRules(records, opts({ maxConditions: 2 })).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("DST5.28 a rule that only repeats a wider rule with the same action is left out, and one with another action is kept", () => {
    const records = [
      ...many(5, () => rec({ tool: "bash", user: "alice" }, "ask")),
      ...many(5, () => rec({ tool: "bash", user: "bob" }, "ask")),
      ...many(4, () => rec({ tool: "read", user: "alice" }, "allow")),
    ];
    const rules = induceRules(records, opts({ maxConditions: 2 }));
    const text = rules.map((r) => JSON.stringify(r.when));
    expect(text).toContain('{"eq":["tool","bash"]}');
    expect(text.filter((t) => t.includes('"all"') && t.includes('"bash"'))).toEqual([]); // bash and alice is inside bash
  });

  it("DST5.29 several forms of the same test on the same records are one rule, in the simplest form", () => {
    const records = many(6, (i) => rec({ command: `git status ${i % 2}` }, "allow"));
    const rules = induceRules(records, opts({ minSupport: 6 }));
    expect(rules.map((r) => r.when)).toEqual([{ in: ["command", ["git status 0", "git status 1"]] }]);
    const same = many(6, () => rec({ command: "git status" }, "allow"));
    expect(induceRules(same, opts({ minSupport: 6 })).map((r) => r.when)).toEqual([{ eq: ["command", "git status"] }]);
  });

  it("DST5.30 a rule's support and purity are what evaluating its condition over the records gives", () => {
    const records = [...many(5, (i) => rec({ command: `git log ${i}`, n: 1 }, i === 0 ? "ask" : "allow")), ...many(5, (i) => rec({ command: `rm x${i}`, n: 2 }, "ask"))];
    for (const rule of induceRules(records, opts({ minPurity: 0.7, maxConditions: 2 }))) {
      const covered = records.filter((r) => evaluateCondition(rule.when, r.input));
      expect(covered).toHaveLength(rule.support);
      expect(covered.filter((r) => JSON.stringify(r.action) === JSON.stringify(rule.action)).length / covered.length).toBe(rule.purity);
    }
  });

  it("DST5.32 purity and support are measured on the whole input a rule meets, texts too long to be offered as values included", () => {
    const long = (i: number) => `git push --force origin branch-${i} ${"x".repeat(300)}`;
    const records = [...many(8, (i) => rec({ command: `git status ${i}` }, "routine")), ...many(20, (i) => rec({ command: long(i) }, "critical"))];
    // the prefix would cover 28 of 28 records and be right for 8: it is not a rule
    expect(induceRules(records, opts({ minSupport: 4, minPurity: 0.9 }))).toEqual([]);
    for (const rule of induceRules(records, opts({ minSupport: 4, minPurity: 0.2 }))) {
      const covered = records.filter((r) => evaluateCondition(rule.when, r.input));
      expect(covered).toHaveLength(rule.support);
      expect(covered.filter((r) => JSON.stringify(r.action) === JSON.stringify(rule.action)).length / covered.length).toBe(rule.purity);
    }
  });

  it("DST5.33 a rule that is pure on everything it meets is found when some of what it meets is a long text", () => {
    const records = [...many(4, () => rec({ command: "git status" }, "routine")), ...many(4, (i) => rec({ command: `git log ${"y".repeat(300)} ${i}` }, "routine")), ...many(6, () => rec({ command: "rm -rf dir" }, "critical"))];
    const rules = induceRules(records, opts({ minSupport: 4, minPurity: 1, fields: ["command"] }));
    expect(rules.map((r) => [r.when, r.action, r.support, r.purity])).toEqual([
      [{ prefix: ["command", "git "] }, "routine", 8, 1],
      [{ eq: ["command", "rm -rf dir"] }, "critical", 6, 1],
    ]);
  });

  it("DST5.34 a prefix reaches only the long texts that start with it: other long texts are not covered, nor counted against its purity", () => {
    const records = [
      ...many(4, () => rec({ command: "git status" }, "routine")),
      ...many(4, (i) => rec({ command: `git log ${"y".repeat(300)} ${i}` }, "routine")),
      ...many(3, (i) => rec({ command: `rm -rf ${"z".repeat(300)} ${i}` }, "critical")),
    ];
    const rules = induceRules(records, opts({ minSupport: 4, minPurity: 1, fields: ["command"] }));
    expect(rules.map((r) => [r.when, r.action, r.support, r.purity])).toEqual([[{ prefix: ["command", "git "] }, "routine", 8, 1]]);
    expect(records.filter((r) => evaluateCondition(rules[0]!.when, r.input))).toHaveLength(8);
  });

  it("DST5.31 the atoms kept for conjunctions are the widest, so a rule on a rare value is still found alone", () => {
    const records = [...many(4, () => rec({ tool: "bash", user: "alice" }, "ask")), ...many(4, () => rec({ tool: "read", user: "bob" }, "allow"))];
    expect(induceRules(records, opts({ maxConditions: 2 })).length).toBeGreaterThan(0);
  });
});

describe("compileRules", () => {
  it("DST6.1 the action of the first rule whose condition holds, in order", () => {
    const rules = [
      { id: "r1", when: { eq: ["tool", "bash"] } as const, action: "ask" as Json, support: 3, purity: probability(1) },
      { id: "r2", when: { exists: "tool" } as const, action: "allow" as Json, support: 3, purity: probability(1) },
    ];
    const run = compileRules(rules);
    expect(run({ tool: "bash" })).toBe("ask");
    expect(run({ tool: "read" })).toBe("allow");
    expect(compileRules([...rules].reverse())({ tool: "bash" })).toBe("allow");
  });

  it("DST6.2 no rule that holds, or no rules, is no answer", () => {
    expect(compileRules([])({ tool: "x" })).toBeUndefined();
    const run = compileRules(induceRules(many(4, () => rec({ tool: "bash" }, "ask")), opts()));
    expect(run({ tool: "other" })).toBeUndefined();
    expect(run("not an object")).toBeUndefined();
  });

  it("DST6.3 an answer that is null is an answer", () => {
    const run = compileRules([{ id: "r", when: { exists: "x" }, action: null, support: 1, purity: probability(1) }]);
    expect(run({ x: 1 })).toBeNull();
  });
});

describe("rules and the lifecycle", () => {
  const settings = parseLifecycleSettings({ promote: { fits: 3, sessions: 2, lowerBound: 0 }, retire: { margin: 2 }, audit: { every: 3 } });
  const bash = { id: "r-bash", when: { eq: ["tool", "bash"] } as const, action: "ask" as Json, support: 5, purity: probability(1) };
  const at = (input: Json, action: Json, session?: string, extra: Parameters<typeof record>[0] = {}) => rec(input, action, { ...(session === undefined ? {} : { session }), ...extra });

  it("DST7.1 the sessions of the records, each once, are what rules built from them should not count", () => {
    expect(sessionsOf([at({}, "a", "s1"), at({}, "a", "s2"), at({}, "a", "s1"), at({}, "a")])).toEqual(["s1", "s2"]);
  });

  it("DST7.2 rules are added as candidates, and each decision they cover is evidence: a fit when the rule's action was the right one", () => {
    const lifecycle = new Lifecycle<string>(settings);
    const records = [at({ tool: "bash" }, "ask", "s1"), at({ tool: "bash" }, "deny", "s2"), at({ tool: "read" }, "ask", "s3")];
    expect(shadowRules(lifecycle, [bash], records, { builtFrom: [] })).toEqual({ observed: 2 });
    expect(lifecycle.list()[0]).toMatchObject({ key: "r-bash", origin: "induced", fits: 1, misses: 1, sessions: ["s1", "s2"] });
  });

  it("DST7.3 the sessions a rule was built from give no evidence", () => {
    const lifecycle = new Lifecycle<string>(settings);
    const records = [at({ tool: "bash" }, "ask", "built"), at({ tool: "bash" }, "ask", "fresh")];
    expect(shadowRules(lifecycle, [bash], records, { builtFrom: ["built"] })).toEqual({ observed: 1 });
    expect(lifecycle.list()[0]).toMatchObject({ builtFrom: ["built"], fits: 1 });
  });

  it("DST7.4 decisions that do not say whether the rule's action was right are not evidence", () => {
    const lifecycle = new Lifecycle<string>(settings);
    const records = [
      record({ input: { tool: "bash" }, action: "ask" }), // no outcome, decided by the model
      record({ input: { tool: "bash" }, action: "allow", outcome: outcome("incorrect") }), // wrong, but it was another action that was wrong
      record({ input: { tool: "bash" }, action: "ask", outcome: outcome("approved") }), // a person's choice says nothing of the level
      record({ input: { tool: "bash" }, action: "ask", outcome: outcome("denied") }),
    ];
    expect(shadowRules(lifecycle, [bash], records, { builtFrom: [] })).toEqual({ observed: 0 });
  });

  it("DST7.10 a decision whose outcome says the rule's action was wrong, with no label, is a miss; so is one that names another right action", () => {
    const patient = parseLifecycleSettings({ promote: { fits: 3, sessions: 2, lowerBound: 0 }, retire: { margin: 20 }, audit: { every: 3 } });
    const lifecycle = new Lifecycle<string>(patient);
    const records = [
      record({ input: { tool: "bash" }, action: "ask", session: "s1", outcome: outcome("incorrect") }),
      record({ input: { tool: "bash" }, action: "ask", session: "s2", outcome: outcome("approved", { correct: false }) }),
      record({ input: { tool: "bash" }, action: "ask", session: "s3", outcome: outcome("failed") }),
      record({ input: { tool: "bash" }, action: "ask", session: "s4", outcome: outcome("rated-bad") }),
      record({ input: { tool: "bash" }, action: "ask", session: "s5", outcome: outcome("overridden") }),
      record({ input: { tool: "bash" }, action: "ask", session: "s6", outcome: outcome("denied", { correct: false }) }),
      record({ input: { tool: "bash" }, action: "ask", session: "s7", outcome: outcome("overridden", { label: "deny" }) }),
    ];
    expect(shadowRules(lifecycle, [bash], records, { builtFrom: [] })).toEqual({ observed: 7 });
    expect(lifecycle.list()[0]).toMatchObject({ fits: 0, misses: 7 });
  });

  it("DST7.11 a wrong outcome is a miss only for the action it was about: a rule that would have said otherwise is not shown wrong", () => {
    const lifecycle = new Lifecycle<string>(settings);
    const records = [record({ input: { tool: "bash" }, action: "allow", session: "s1", outcome: outcome("incorrect", { correct: false }) })];
    expect(shadowRules(lifecycle, [bash], records, { builtFrom: [] })).toEqual({ observed: 0 });
    expect(lifecycle.list()[0]).toMatchObject({ fits: 0, misses: 0 });
  });

  it("DST7.12 approving or denying says nothing of whether the rule's action was right unless the outcome also says correct, wrong or what was right", () => {
    const lifecycle = new Lifecycle<string>(settings);
    const records = [
      record({ input: { tool: "bash" }, action: "ask", session: "s1", outcome: outcome("approved") }),
      record({ input: { tool: "bash" }, action: "ask", session: "s2", outcome: outcome("denied") }),
      record({ input: { tool: "bash" }, action: "ask", session: "s3", outcome: outcome("approved", { correct: true }) }),
      record({ input: { tool: "bash" }, action: "allow", session: "s4", outcome: outcome("denied", { label: "ask" }) }),
    ];
    expect(shadowRules(lifecycle, [bash], records, { builtFrom: [] })).toEqual({ observed: 2 });
    expect(lifecycle.list()[0]).toMatchObject({ fits: 2, misses: 0 });
  });

  it("DST7.13 the decisions a rule was induced from are no evidence, whether or not they have a session", () => {
    const lifecycle = new Lifecycle<string>(settings);
    const built = rec({ tool: "bash" }, "ask", { id: 900 });
    const fresh = rec({ tool: "bash" }, "ask", { id: 901 });
    expect(shadowRules(lifecycle, [bash], [built, fresh], { builtFrom: [], builtFromDecisions: [built.id] })).toEqual({ observed: 1 });
    expect(lifecycle.list()[0]).toMatchObject({ fits: 1, misses: 0 });
  });

  it("DST7.5 a rule with evidence enough is promoted, and a rule that is known keeps the lifecycle's account of it", () => {
    const lifecycle = new Lifecycle<string>(settings);
    const records = ["s1", "s2", "s1", "s2"].map((s) => at({ tool: "bash" }, "ask", s));
    shadowRules(lifecycle, [bash], records, { builtFrom: [] });
    expect(lifecycle.state("r-bash")).toBe("active");
    shadowRules(lifecycle, [bash], [], { builtFrom: [] });
    expect(lifecycle.state("r-bash")).toBe("active");
  });

  it("DST7.6 evidence is per rule, and a decision no rule covers is no evidence", () => {
    const lifecycle = new Lifecycle<string>(settings);
    const read = { ...bash, id: "r-read", when: { eq: ["tool", "read"] } as const };
    shadowRules(lifecycle, [bash, read], [at({ tool: "read" }, "ask", "s1"), at({ tool: "write" }, "ask", "s2")], { builtFrom: [] });
    expect(lifecycle.list().map((a) => [a.key, a.fits, a.misses])).toEqual([["r-bash", 0, 0], ["r-read", 1, 0]]);
  });

  it("DST7.7 a rule answers through the lifecycle only when it is active", () => {
    const lifecycle = new Lifecycle<string>(settings);
    const run = lifecycleRule(lifecycle, [bash]);
    expect(run({ tool: "bash" })).toBeUndefined(); // not known yet
    shadowRules(lifecycle, [bash], [at({ tool: "bash" }, "ask", "s1")], { builtFrom: [] });
    expect(run({ tool: "bash" })).toBeUndefined(); // in shadow
    shadowRules(lifecycle, [bash], [at({ tool: "bash" }, "ask", "s2"), at({ tool: "bash" }, "ask", "s3")], { builtFrom: [] });
    expect(lifecycle.state("r-bash")).toBe("active");
    expect(run({ tool: "bash" })).toBe("ask");
    expect(run({ tool: "read" })).toBeUndefined();
  });

  it("DST7.8 every n-th use of an active rule is an audit, in which the rule does not answer", () => {
    const lifecycle = new Lifecycle<string>(settings);
    shadowRules(lifecycle, [bash], ["s1", "s2", "s3"].map((s) => at({ tool: "bash" }, "ask", s)), { builtFrom: [] });
    const run = lifecycleRule(lifecycle, [bash]);
    expect([1, 2, 3, 4, 5, 6].map(() => run({ tool: "bash" }))).toEqual(["ask", "ask", undefined, "ask", "ask", undefined]);
  });

  it("DST7.9 the first active rule that covers the input answers, and an audit of it is not passed to a later rule", () => {
    const lifecycle = new Lifecycle<string>(parseLifecycleSettings({ promote: { fits: 1, sessions: 0, lowerBound: 0 }, retire: { margin: 2 }, audit: { every: 2 } }));
    const wide = { ...bash, id: "r-wide", when: { exists: "tool" } as const, action: "wide" as Json };
    shadowRules(lifecycle, [bash, wide], [at({ tool: "bash" }, "ask"), at({ tool: "bash" }, "wide")], { builtFrom: [] });
    expect([bash, wide].map((r) => lifecycle.state(r.id))).toEqual(["active", "active"]);
    const run = lifecycleRule(lifecycle, [bash, wide]);
    expect([run({ tool: "bash" }), run({ tool: "bash" }), run({ tool: "bash" })]).toEqual(["ask", undefined, "ask"]);
  });
});
