import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { authorize, explainResolve, globMatches, GraphIdSchema, matches, parsePolicy, parseResolver, resolveGraph } from "@harness/procedural";
import type { ResolveContext } from "@harness/procedural";

const word = fc.constantFrom("a", "b", "x/y", "A", "", "1", "/w", "/w/a", "/wa", "p");
const meta = fc.dictionary(fc.constantFrom("k", "team", "procedural.graph"), fc.oneof(word, fc.integer({ min: 0, max: 3 }), fc.constant(null)), { maxKeys: 3 });
const context: fc.Arbitrary<ResolveContext> = fc.record({ meta, cwd: fc.constantFrom("/w", "/w/a", "/wa", "/"), principal: fc.constantFrom("p", "q") }, { requiredKeys: [] });
const when = fc.record(
  {
    meta: fc.dictionary(fc.constantFrom("k", "team", "procedural.graph"), fc.constantFrom("*", "a", "b", "1"), { maxKeys: 2 }),
    cwdUnder: fc.constantFrom("/w", "/", "/wa"),
    principal: fc.constantFrom("p", "q", "*"),
  },
  { requiredKeys: [] },
);
const template = fc.oneof(fc.constant(null), fc.constantFrom("default", "g/${meta.k}", "${principal}", "${cwd}", "t-${meta.team}", "Bad", "${meta.procedural.graph}"));
const rules = fc.array(fc.record({ when, graph: template }), { maxLength: 5 });

describe("resolver and policy properties", () => {
  test.prop([rules, context])("PX1.P1 the first matching rule decides, and a resolution is no graph or a valid graph id", (list, ctx) => {
    const resolution = explainResolve(parseResolver({ rules: list }), ctx);
    const first = list.findIndex((r) => matches(r.when, ctx));
    expect(resolution.rule).toBe(first === -1 ? undefined : first);
    if (resolution.graph !== undefined) expect(GraphIdSchema.safeParse(resolution.graph).success).toBe(true);
    if (first === -1 || list[first]!.graph === null) expect(resolution.graph).toBeUndefined();
  });

  test.prop([rules, rules, context])("PX1.P2 rules that do not match the session never change where it resolves", (before, after, ctx) => {
    const misses = before.filter((r) => !matches(r.when, ctx));
    expect(resolveGraph(parseResolver({ rules: [...misses, ...after] }), ctx)).toBe(resolveGraph(parseResolver({ rules: after }), ctx));
  });

  test.prop([fc.array(fc.constantFrom("a", "b", "/", ""), { maxLength: 4 }), fc.array(fc.constantFrom("a", "b", "ab", ""), { maxLength: 5 })])(
    "PX1.P3 a pattern matches every text made by filling its stars, and a pattern without stars only itself",
    (literals, fills) => {
      const pattern = literals.join("*");
      let text = literals[0] ?? "";
      for (let i = 1; i < literals.length; i += 1) text += (fills[i] ?? "") + literals[i]!;
      expect(globMatches(pattern, text)).toBe(true);
      expect(globMatches("*", text)).toBe(true);
      expect(globMatches(text.replaceAll("*", ""), text + "a")).toBe(false);
    },
  );

  test.prop([fc.array(fc.record({ when, allow: fc.boolean() }), { maxLength: 4 }), fc.boolean(), context])(
    "PX1.P4 access is the first matching rule's answer, else the default",
    (list, deny, ctx) => {
      const policy = parsePolicy({ rules: list, default: deny ? "deny" : "allow" });
      const first = list.find((r) => matches(r.when, ctx));
      expect(authorize(policy, "read", GraphIdSchema.parse("g"), ctx)).toBe(first === undefined ? !deny : first.allow);
    },
  );
});
