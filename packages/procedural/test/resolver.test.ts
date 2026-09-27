import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { explainResolve, GraphIdSchema, matches, parseResolver, resolveGraph, resolverJsonSchema } from "@harness/procedural";

const file = JSON.parse(readFileSync(new URL("../data/resolver.json", import.meta.url), "utf8")) as Record<string, unknown>;

/** A resolver from rules written as untrusted JSON. */
const resolver = (...rules: unknown[]) => parseResolver({ rules });
const rule = (when: unknown, graph: string | null) => ({ when, graph });
const id = (text: string) => GraphIdSchema.parse(text);

describe("the graph resolver (plan §5.1, §8.1)", () => {
  it("PX1.1 the shipped resolver parses and names its JSON Schema, which is generated from the parser", async () => {
    expect(parseResolver(file).rules).toEqual([{ when: {}, graph: "default" }]);
    expect(file["$schema"]).toBe("./resolver.schema.json");
    await expect(`${JSON.stringify(resolverJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/resolver.schema.json");
  });

  it("PX1.2 the shipped resolver sends every session to the graph 'default'", () => {
    const shipped = parseResolver(file);
    expect(resolveGraph(shipped, {})).toBe("default");
    expect(resolveGraph(shipped, { meta: { a: "b" }, cwd: "/x", principal: "prn_1" })).toBe("default");
  });

  it("PX1.3 the first matching rule wins", () => {
    const r = resolver(rule({ cwdUnder: "/nope" }, "zero"), rule({}, "first"), rule({}, "second"));
    expect(explainResolve(r, { cwd: "/work" })).toEqual({ graph: "first", rule: 1, reason: "rule 1 names graph first" });
  });

  it("PX1.4 a meta condition matches the value named, as a string, and nothing else", () => {
    const r = resolver(rule({ meta: { project: "alpha" } }, "alpha"));
    expect(resolveGraph(r, { meta: { project: "alpha" } })).toBe("alpha");
    expect(resolveGraph(r, { meta: { project: "beta" } })).toBeUndefined();
    expect(resolveGraph(r, { meta: { other: "alpha" } })).toBeUndefined();
    expect(resolveGraph(r, {})).toBeUndefined();
    expect(resolveGraph(r, { meta: { project: { name: "alpha" } } })).toBeUndefined();
    const numeric = resolver(rule({ meta: { n: "7", on: "true" } }, "ok"));
    expect(resolveGraph(numeric, { meta: { n: 7, on: true } })).toBe("ok");
  });

  it("PX1.5 a '*' meta condition matches any present value, but not a missing or null one", () => {
    const r = resolver(rule({ meta: { tag: "*" } }, "tagged"));
    expect(resolveGraph(r, { meta: { tag: "x" } })).toBe("tagged");
    expect(resolveGraph(r, { meta: { tag: { deep: 1 } } })).toBe("tagged");
    expect(resolveGraph(r, { meta: { tag: null } })).toBeUndefined();
    expect(resolveGraph(r, { meta: {} })).toBeUndefined();
  });

  it("PX1.6 a dotted meta key names a flat key or a path into nested session meta", () => {
    const r = resolver(rule({ meta: { "procedural.graph": "*" } }, "${meta.procedural.graph}"));
    expect(resolveGraph(r, { meta: { procedural: { graph: "nested" } } })).toBe("nested");
    expect(resolveGraph(r, { meta: { "procedural.graph": "flat" } })).toBe("flat");
    expect(resolveGraph(r, { meta: { "procedural.x": { graph: "no" } } })).toBeUndefined();
    expect(resolveGraph(r, { meta: { procedural: "not-an-object" } })).toBeUndefined();
    expect(resolveGraph(r, { meta: { procedural: null } })).toBeUndefined();
    const deeper = resolver(rule({ meta: { "a.b.c": "v" } }, "deep"));
    expect(resolveGraph(deeper, { meta: { a: { "b.c": "v" } } })).toBe("deep");
    expect(resolveGraph(deeper, { meta: { "a.b": { c: "v" } } })).toBe("deep");
    expect(resolveGraph(deeper, { meta: { a: { b: { c: "w" } } } })).toBeUndefined();
  });

  it("PX1.7 cwdUnder matches the directory and anything below it, on a path boundary", () => {
    const r = resolver(rule({ cwdUnder: "/work/harness" }, "repo"));
    expect(resolveGraph(r, { cwd: "/work/harness" })).toBe("repo");
    expect(resolveGraph(r, { cwd: "/work/harness/packages/core" })).toBe("repo");
    expect(resolveGraph(r, { cwd: "/work/harness/" })).toBe("repo");
    expect(resolveGraph(r, { cwd: "/work/harness2" })).toBeUndefined();
    expect(resolveGraph(r, { cwd: "/work" })).toBeUndefined();
    expect(resolveGraph(r, {})).toBeUndefined();
    const slashed = resolver(rule({ cwdUnder: "/work/" }, "work"));
    expect(resolveGraph(slashed, { cwd: "/work/a" })).toBe("work");
    expect(resolveGraph(slashed, { cwd: "/work" })).toBe("work");
    expect(resolveGraph(slashed, { cwd: "/workshop" })).toBeUndefined();
    const windows = resolver(rule({ cwdUnder: "C:\\work" }, "win"));
    expect(resolveGraph(windows, { cwd: "C:\\work\\a" })).toBe("win");
    expect(resolveGraph(windows, { cwd: "C:\\workshop" })).toBeUndefined();
    const root = resolver(rule({ cwdUnder: "/" }, "root"));
    expect(resolveGraph(root, { cwd: "/anything" })).toBe("root");
  });

  it("PX1.8 a principal condition matches that principal exactly, and '*' matches any", () => {
    const r = resolver(rule({ principal: "prn_1" }, "one"), rule({ principal: "*" }, "any"));
    expect(resolveGraph(r, { principal: "prn_1" })).toBe("one");
    expect(resolveGraph(r, { principal: "prn_2" })).toBe("any");
    expect(resolveGraph(r, { principal: "prn_10" })).toBe("any");
    expect(resolveGraph(r, {})).toBeUndefined();
  });

  it("PX1.9 every condition of a rule must hold", () => {
    const when = { meta: { a: "1", b: "*" }, cwdUnder: "/w", principal: "p" };
    const r = resolver(rule(when, "all"));
    const context = { meta: { a: "1", b: "x" }, cwd: "/w/x", principal: "p" };
    expect(resolveGraph(r, context)).toBe("all");
    expect(resolveGraph(r, { ...context, meta: { a: "1" } })).toBeUndefined();
    expect(resolveGraph(r, { ...context, cwd: "/v" })).toBeUndefined();
    expect(resolveGraph(r, { ...context, principal: "q" })).toBeUndefined();
    expect(matches({}, {})).toBe(true);
    expect(matches({ meta: {} }, {})).toBe(true);
  });

  it("PX1.10 a graph template fills ${meta.x}, ${principal} and ${cwd}", () => {
    const r = resolver(rule({}, "g/${meta.team}/${principal}/${meta.n}${cwd}"));
    expect(resolveGraph(r, { meta: { team: "blue", n: 3 }, principal: "prn_1", cwd: "/x" })).toBe("g/blue/prn_1/3/x");
    const twice = resolver(rule({}, "${principal}.${principal}"));
    expect(resolveGraph(twice, { principal: "a" })).toBe("a.a");
    expect(resolveGraph(resolver(rule({}, "p-${cwd}")), { cwd: "abc" })).toBe("p-abc");
  });

  it("PX1.11 a result that is not a graph id resolves to no graph, with the reason, and stops there", () => {
    const r = resolver(rule({ cwdUnder: "/" }, "${cwd}"), rule({}, "fallback"));
    expect(explainResolve(r, { cwd: "/work/harness" })).toEqual({ graph: undefined, rule: 0, reason: 'rule 0 gives "/work/harness", which is not a graph id' });
    expect(resolveGraph(resolver(rule({}, "Upper")), {})).toBeUndefined();
    expect(resolveGraph(resolver(rule({}, "${meta.x}")), { meta: { x: "" } })).toBeUndefined();
    expect(resolveGraph(resolver(rule({}, "${meta.x}")), { meta: { x: "a".repeat(201) } })).toBeUndefined();
    expect(resolveGraph(resolver(rule({}, "${meta.x}")), { meta: { x: "a".repeat(200) } })).toBe("a".repeat(200));
  });

  it("PX1.12 a template value that is missing or not a scalar resolves to no graph, with the reason", () => {
    const r = resolver(rule({}, "g/${meta.team}"));
    expect(explainResolve(r, { meta: {} })).toEqual({ graph: undefined, rule: 0, reason: "rule 0 needs meta.team, which the session does not have" });
    expect(explainResolve(r, { meta: { team: { a: 1 } } }).graph).toBeUndefined();
    expect(explainResolve(r, { meta: { team: null } }).graph).toBeUndefined();
    expect(explainResolve(resolver(rule({}, "${principal}")), {}).reason).toBe("rule 0 needs principal, which the session does not have");
    expect(explainResolve(resolver(rule({}, "x${cwd}")), {}).reason).toBe("rule 0 needs cwd, which the session does not have");
  });

  it("PX1.13 a rule whose graph is null resolves the session to no graph", () => {
    const r = resolver(rule({ principal: "p" }, null), rule({}, "default"));
    expect(explainResolve(r, { principal: "p" })).toEqual({ graph: undefined, rule: 0, reason: "rule 0 names no graph" });
    expect(resolveGraph(r, { principal: "q" })).toBe(id("default"));
  });

  it("PX1.14 a session no rule matches resolves to no graph", () => {
    expect(explainResolve(resolver(rule({ principal: "p" }, "g")), {})).toEqual({ graph: undefined, rule: undefined, reason: "no rule matches" });
    expect(explainResolve(resolver(), {})).toEqual({ graph: undefined, rule: undefined, reason: "no rule matches" });
  });

  it("PX1.15 parsing refuses unknown template variables, unterminated templates and unknown conditions, naming where", () => {
    expect(() => resolver(rule({}, "${user}"))).toThrow(/rules\[0\]\.graph|rules\.0\.graph/);
    expect(() => resolver(rule({}, "${user}"))).toThrow(/unknown template variable \$\{user\}/);
    expect(() => resolver(rule({}, "${meta.}"))).toThrow(/unknown template variable/);
    expect(() => resolver(rule({}, "${meta}"))).toThrow(/unknown template variable/);
    expect(() => resolver(rule({}, "a${cwd"))).toThrow(/unterminated/);
    expect(() => resolver(rule({ team: "x" }, "g"))).toThrow(RangeError);
    expect(() => parseResolver({ rules: [], extra: 1 })).toThrow(/invalid procedural resolver/);
    expect(() => resolver(rule({ meta: { a: 1 } }, "g"))).toThrow(RangeError);
    expect(() => resolver(rule({}, "${xcwd}"))).toThrow(/unknown template variable/);
    expect(() => resolver(rule({}, "${cwdx}"))).toThrow(/unknown template variable/);
    expect(() => resolver(rule({}, "${a${cwd}"))).toThrow(/unknown template variable/);
    expect(() => resolver(rule({}, "${cwd}${"))).toThrow(/unterminated/);
    expect(() => resolver(rule({ cwdUnder: "" }, "g"))).toThrow(RangeError);
    expect(() => resolver(rule({ principal: "" }, "g"))).toThrow(RangeError);
    expect(resolver(rule({}, "${meta.a.b}-${principal}-${cwd}")).rules).toHaveLength(1);
  });

  it("PX1.16 a meta path never reaches inherited keys, and tries every split of a dotted key", () => {
    expect(resolveGraph(resolver(rule({ meta: { "__proto__.hasOwnProperty": "*" } }, "leak")), { meta: {} })).toBeUndefined();
    expect(resolveGraph(resolver(rule({ meta: { "toString": "*" } }, "leak")), { meta: {} })).toBeUndefined();
    const split = resolver(rule({ meta: { "a.b.c": "v" } }, "found"));
    expect(resolveGraph(split, { meta: { a: { x: 1 }, "a.b": { c: "v" } } })).toBe("found");
    expect(resolveGraph(resolver(rule({ meta: { "a.b": "v" } }, "g")), { meta: { "": { ".b": "v" } } })).toBeUndefined();
  });

  it("PX1.17 cwdUnder needs the whole prefix, and an empty cwd is under nothing", () => {
    expect(resolveGraph(resolver(rule({ cwdUnder: "/" }, "root")), { cwd: "" })).toBeUndefined();
    expect(resolveGraph(resolver(rule({ cwdUnder: "/w" }, "w")), { cwd: "/v/x" })).toBeUndefined();
  });
});
