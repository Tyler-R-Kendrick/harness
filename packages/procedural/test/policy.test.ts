import { describe, expect, it } from "vitest";
import { ACTIONS, authorize, globMatches, GraphIdSchema, parsePolicy, policyJsonSchema } from "@harness/procedural";

const g = (text: string) => GraphIdSchema.parse(text);
const policy = (rules: unknown[], fallback?: "allow" | "deny") => parsePolicy(fallback === undefined ? { rules } : { rules, default: fallback });

describe("the access policy (plan §8.3)", () => {
  it("PX1.20 without a policy every action on every graph is allowed", () => {
    for (const action of ACTIONS) expect(authorize(undefined, action, g("any/graph"), {})).toBe(true);
    expect(ACTIONS).toEqual(["read", "write", "dream", "revert", "import"]);
  });

  it("PX1.21 a policy no rule matches falls back to its default, which is allow", () => {
    expect(authorize(policy([]), "dream", g("x"), {})).toBe(true);
    expect(authorize(policy([], "allow"), "dream", g("x"), {})).toBe(true);
    expect(authorize(policy([], "deny"), "dream", g("x"), {})).toBe(false);
    expect(parsePolicy({ rules: [] }).default).toBe("allow");
  });

  it("PX1.22 the first matching rule decides", () => {
    const p = policy([
      { when: { principal: "p" }, allow: true },
      { when: {}, allow: false },
      { when: {}, allow: true },
    ]);
    expect(authorize(p, "write", g("x"), { principal: "p" })).toBe(true);
    expect(authorize(p, "write", g("x"), { principal: "q" })).toBe(false);
  });

  it("PX1.23 a rule may name the actions it covers", () => {
    const p = policy([{ when: { actions: ["dream", "revert"] }, allow: false }]);
    expect(authorize(p, "dream", g("x"), {})).toBe(false);
    expect(authorize(p, "revert", g("x"), {})).toBe(false);
    expect(authorize(p, "read", g("x"), {})).toBe(true);
    expect(authorize(p, "import", g("x"), {})).toBe(true);
  });

  it("PX1.24 a rule may name the graphs it covers by a pattern where '*' is any run of characters", () => {
    const p = policy([{ when: { graph: "shared/*" }, allow: false }]);
    expect(authorize(p, "write", g("shared/a"), {})).toBe(false);
    expect(authorize(p, "write", g("shared/a/b"), {})).toBe(false);
    expect(authorize(p, "write", g("sharedx"), {})).toBe(true);
    expect(authorize(p, "write", g("other/shared/a"), {})).toBe(true);
    expect(globMatches("*", "anything")).toBe(true);
    expect(globMatches("exact", "exact")).toBe(true);
    expect(globMatches("exact", "exactly")).toBe(false);
    expect(globMatches("exact", "inexact")).toBe(false);
    expect(globMatches("a*b*c", "a-b-c")).toBe(true);
    expect(globMatches("a*b*c", "abc")).toBe(true);
    expect(globMatches("a*b*c", "a-c-b")).toBe(false);
    expect(globMatches("a*bc*bc", "abcbc")).toBe(true);
    expect(globMatches("a*b", "ab-b")).toBe(true);
    expect(globMatches("*b", "a")).toBe(false);
    expect(globMatches("ab*ba", "aba")).toBe(false);
    expect(globMatches("*x*", "yxy")).toBe(true);
    expect(globMatches("*x*", "yyy")).toBe(false);
    expect(globMatches("ab*ba", "abba")).toBe(true);
    expect(globMatches("a*bc*c", "abc")).toBe(false);
    expect(globMatches("*x*x*", "x")).toBe(false);
    expect(globMatches("*x*x*", "xx")).toBe(true);
  });

  it("PX1.25 a rule's session conditions are the resolver's: meta, cwdUnder and principal", () => {
    const p = policy([{ when: { meta: { role: "reviewer" }, cwdUnder: "/w", actions: ["dream"] }, allow: false }]);
    expect(authorize(p, "dream", g("x"), { meta: { role: "reviewer" }, cwd: "/w/a" })).toBe(false);
    expect(authorize(p, "dream", g("x"), { meta: { role: "reviewer" }, cwd: "/v" })).toBe(true);
    expect(authorize(p, "dream", g("x"), { meta: { role: "author" }, cwd: "/w" })).toBe(true);
  });

  it("PX1.26 parsing refuses unknown actions, empty action lists and unknown keys, naming where; the JSON Schema is generated", () => {
    expect(() => policy([{ when: { actions: ["delete"] }, allow: false }])).toThrow(/invalid procedural access policy[\s\S]*actions/);
    expect(() => policy([{ when: { actions: [] }, allow: false }])).toThrow(RangeError);
    expect(() => policy([{ when: {}, allow: "no" }])).toThrow(RangeError);
    expect(() => policy([{ when: { user: "x" }, allow: true }])).toThrow(RangeError);
    expect(() => parsePolicy({ rules: [], default: "maybe" })).toThrow(RangeError);
    expect(parsePolicy({ $schema: "./policy.schema.json", rules: [] }).rules).toEqual([]);
    const schema = policyJsonSchema() as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(["$schema", "rules", "default"]);
    // The file may leave the default out.
    expect(schema.required).toEqual(["rules"]);
  });
});
