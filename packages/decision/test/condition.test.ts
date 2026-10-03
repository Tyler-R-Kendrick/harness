import { describe, expect, it } from "vitest";
import { ConditionSchema, evaluateCondition, getPath } from "@harness/decision";
import type { Condition, Json } from "@harness/decision";

const facts = { tool: "bash", args: { command: "rm -rf build", flags: ["a", "b"] }, cost: 12, none: null, nested: { ok: true } };
const ev = (c: Condition) => evaluateCondition(c, facts);

describe("conditions", () => {
  it("CND1.1 a path reads own properties and array indexes, and nothing else", () => {
    expect(getPath(facts, "args.command")).toBe("rm -rf build");
    expect(getPath(facts, "args.flags.1")).toBe("b");
    expect(getPath(facts, "none")).toBeNull();
    for (const missing of ["args.nope", "args.flags.9", "tool.length", "toString", "__proto__", "constructor.name", "cost.x", ""]) expect(getPath(facts, missing)).toBeUndefined();
  });

  it("CND1.2 eq and in compare JSON values structurally", () => {
    expect(ev({ eq: ["tool", "bash"] })).toBe(true);
    expect(ev({ eq: ["tool", "edit"] })).toBe(false);
    expect(ev({ eq: ["args.flags", ["a", "b"]] })).toBe(true);
    expect(ev({ eq: ["nested", { ok: true }] })).toBe(true);
    expect(ev({ eq: ["none", null] })).toBe(true);
    expect(ev({ eq: ["absent", null] })).toBe(false);
    expect(ev({ in: ["tool", ["edit", "bash"]] })).toBe(true);
    expect(ev({ in: ["tool", ["edit"]] })).toBe(false);
  });

  it("CND1.3 gte and lte compare numbers and are false for anything else", () => {
    expect(ev({ gte: ["cost", 12] })).toBe(true);
    expect(ev({ gte: ["cost", 13] })).toBe(false);
    expect(ev({ lte: ["cost", 12] })).toBe(true);
    expect(ev({ lte: ["cost", 11] })).toBe(false);
    expect(ev({ gte: ["tool", 0] })).toBe(false);
    expect(ev({ lte: ["absent", 0] })).toBe(false);
  });

  it("CND1.4 prefix, suffix and contains test strings, and are false for non-strings", () => {
    expect(ev({ prefix: ["args.command", "rm "] })).toBe(true);
    expect(ev({ prefix: ["args.command", "ls"] })).toBe(false);
    expect(ev({ suffix: ["args.command", "build"] })).toBe(true);
    expect(ev({ suffix: ["args.command", "rm"] })).toBe(false);
    expect(ev({ contains: ["args.command", "-rf"] })).toBe(true);
    expect(ev({ contains: ["args.command", "-x"] })).toBe(false);
    expect(ev({ contains: ["cost", "1"] })).toBe(false);
    expect(ev({ prefix: ["absent", ""] })).toBe(false);
  });

  it("CND1.5 contains also finds an element of an array", () => {
    expect(ev({ contains: ["args.flags", "a"] })).toBe(true);
    expect(ev({ contains: ["args.flags", "z"] })).toBe(false);
  });

  it("CND1.6 exists is true for any value that is there, null included", () => {
    expect(ev({ exists: "none" })).toBe(true);
    expect(ev({ exists: "cost" })).toBe(true);
    expect(ev({ exists: "absent" })).toBe(false);
  });

  it("CND1.7 all, any and not combine conditions, and empty all is true, empty any false", () => {
    expect(ev({ all: [{ eq: ["tool", "bash"] }, { gte: ["cost", 1] }] })).toBe(true);
    expect(ev({ all: [{ eq: ["tool", "bash"] }, { gte: ["cost", 99] }] })).toBe(false);
    expect(ev({ any: [{ eq: ["tool", "x"] }, { gte: ["cost", 1] }] })).toBe(true);
    expect(ev({ any: [{ eq: ["tool", "x"] }, { gte: ["cost", 99] }] })).toBe(false);
    expect(ev({ not: { eq: ["tool", "x"] } })).toBe(true);
    expect(ev({ not: { eq: ["tool", "bash"] } })).toBe(false);
    expect(ev({ all: [] })).toBe(true);
    expect(ev({ any: [] })).toBe(false);
  });

  it("CND2.1 the schema accepts every form and refuses unknown or malformed ones", () => {
    const ok: Condition[] = [{ eq: ["a", 1] }, { in: ["a", [1, "x"]] }, { gte: ["a", 1] }, { lte: ["a", 1] }, { prefix: ["a", "x"] }, { suffix: ["a", "x"] }, { contains: ["a", "x"] }, { exists: "a" }, { not: { exists: "a" } }, { all: [{ exists: "a" }] }, { any: [{ exists: "a" }] }];
    for (const c of ok) expect(ConditionSchema.safeParse(c).success).toBe(true);
    for (const bad of [{}, { eq: ["a"] }, { eq: [1, 1] }, { gte: ["a", "1"] }, { in: ["a", 1] }, { exists: 1 }, { nope: 1 }, { all: [{ nope: 1 }] }, { eq: ["a", 1], exists: "a" }, { eq: ["", 1] }, "eq"]) {
      expect(ConditionSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("CND2.2 a condition nested too deep, or with too many parts, is refused", () => {
    let deep: unknown = { exists: "a" };
    for (let i = 0; i < 8; i++) deep = { not: deep };
    expect(ConditionSchema.safeParse(deep).success).toBe(true);
    expect(ConditionSchema.safeParse({ not: deep }).success).toBe(false);
    const wide = (n: number) => ({ all: Array.from({ length: n }, () => ({ exists: "a" })) });
    expect(ConditionSchema.safeParse(wide(63)).success).toBe(true);
    expect(ConditionSchema.safeParse(wide(64)).success).toBe(false);
  });

  it("CND2.3 an error names where a malformed condition is wrong", () => {
    const r = ConditionSchema.safeParse({ all: [{ exists: "a" }, { gte: ["a", "x"] }] });
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(/gte|all|1/);
  });

  it("CND3.1 an array index is canonical: no sign, no leading zero, no length, any size", () => {
    const list = Array.from({ length: 12 }, (_, i) => `v${i}`);
    const f = { list, s: "12", nested: { ok: true }, none: null };
    expect(getPath(f, "list.0")).toBe("v0");
    expect(getPath(f, "list.10")).toBe("v10");
    expect(getPath(f, "list.11")).toBe("v11");
    for (const bad of ["list.01", "list.-1", "list.1e1", "list.x1", "list.1x", "list.length", "list.1.5", "list. 1"]) expect(getPath(f, bad)).toBeUndefined();
    expect(getPath(f, "none.x")).toBeUndefined();
    expect(getPath(f, "list.0.x")).toBeUndefined();
  });

  it("CND3.2 equality compares arrays element by element and objects key by key", () => {
    const f = { flags: ["a", "b"], o: { x: 1, y: { z: [1, 2] } }, none: null, s: "a" };
    const eq = (path: string, v: Json) => evaluateCondition({ eq: [path, v] }, f);
    expect(eq("flags", ["a", "b"])).toBe(true);
    expect(eq("flags", ["a"])).toBe(false);
    expect(eq("flags", ["a", "b", "c"])).toBe(false);
    expect(eq("flags", ["a", "c"])).toBe(false);
    expect(eq("flags", ["b", "a"])).toBe(false);
    expect(eq("flags", { "0": "a", "1": "b" })).toBe(false);
    expect(eq("o", [])).toBe(false);
    expect(eq("o", { x: 1, y: { z: [1, 2] } })).toBe(true);
    expect(eq("o", { x: 1, y: { z: [1, 3] } })).toBe(false);
    expect(eq("o", { x: 1 })).toBe(false);
    expect(eq("o", { x: 1, y: { z: [1, 2] }, w: 0 })).toBe(false);
    expect(eq("o", { x: 1, w: { z: [1, 2] } })).toBe(false);
    expect(eq("o", null)).toBe(false);
    expect(eq("none", {})).toBe(false);
    expect(eq("none", null)).toBe(true);
    expect(eq("s", { a: 1 })).toBe(false);
    expect(eq("o", "o")).toBe(false);
    expect(eq("s", "a")).toBe(true);
  });

  it("CND3.3 gte and lte need a number, not a numeric string", () => {
    const f = { s: "12" };
    expect(evaluateCondition({ gte: ["s", 5] }, f)).toBe(false);
    expect(evaluateCondition({ lte: ["s", 50] }, f)).toBe(false);
  });

  it("CND3.4 prefix and suffix test the ends of a string, not anywhere in it", () => {
    expect(ev({ prefix: ["args.command", "-rf"] })).toBe(false);
    expect(ev({ suffix: ["args.command", "-rf"] })).toBe(false);
    expect(ev({ prefix: ["args.command", "rm -rf build"] })).toBe(true);
    expect(ev({ suffix: ["args.command", "rm -rf build"] })).toBe(true);
  });

  it("CND3.5 the depth limit counts any and not the same as all", () => {
    const nest = (kind: "all" | "any" | "not", depth: number): unknown => {
      let c: unknown = { exists: "a" };
      for (let i = 0; i < depth; i++) c = kind === "not" ? { not: c } : { [kind]: [c] };
      return c;
    };
    for (const kind of ["all", "any", "not"] as const) {
      expect(ConditionSchema.safeParse(nest(kind, 8)).success).toBe(true);
      expect(ConditionSchema.safeParse(nest(kind, 9)).success).toBe(false);
    }
    expect(ConditionSchema.safeParse({ any: Array.from({ length: 64 }, () => ({ exists: "a" })) }).success).toBe(false);
    expect(ConditionSchema.safeParse({ any: Array.from({ length: 63 }, () => ({ exists: "a" })) }).success).toBe(true);
  });

  it("CND3.6 a refused condition says which limit it broke", () => {
    let deep: unknown = { exists: "a" };
    for (let i = 0; i < 9; i++) deep = { not: deep };
    const tooDeep = ConditionSchema.safeParse(deep);
    const tooWide = ConditionSchema.safeParse({ all: Array.from({ length: 64 }, () => ({ exists: "a" })) });
    expect(tooDeep.success || tooDeep.error.issues.map((i) => `${i.code}:${i.message}`)).toEqual(["custom:a condition nests at most 8 deep"]);
    expect(tooWide.success || tooWide.error.issues.map((i) => `${i.code}:${i.message}`)).toEqual(["custom:a condition has at most 64 parts"]);
  });
});
