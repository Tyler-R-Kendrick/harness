import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { GuidanceCache, NodeNameSchema, renderPrompt, RevisionIdSchema, START } from "@harness/procedural";
import type { NodeName, RevisionId } from "@harness/procedural";

const revision = fc.stringMatching(/^[0-9a-f]{64}$/).map((hex): RevisionId => RevisionIdSchema.parse(hex));
const node = fc.option(fc.stringMatching(/^[A-Za-z][A-Za-z0-9_.-]{0,8}$/).map((n): NodeName => NodeNameSchema.parse(n)), { nil: undefined });
const parts = fc.record({
  core: revision,
  overlay: fc.option(fc.nat(), { nil: null }),
  node,
  query: fc.string(),
  window: fc.string(),
  model: fc.string({ minLength: 1 }),
});
const start = NodeNameSchema.parse(START);

describe("GuidanceCache keys (properties)", () => {
  test.prop([parts, fc.string(), fc.string()])("PG4.P1 two different queries at Start never share an entry", (p, q1, q2) => {
    fc.pre(q1 !== q2);
    const cache = new GuidanceCache();
    const first = cache.key({ ...p, node: start, query: q1 });
    const second = cache.key({ ...p, node: start, query: q2 });
    expect(first).not.toBe(second);
    cache.set(first, "guidance");
    expect(cache.get(second)).toBeUndefined();
  });

  test.prop([parts, parts])("PG4.P2 two steps share a key exactly when core, overlay, node, query, window and model all agree", (a, b) => {
    const cache = new GuidanceCache();
    const same = a.core === b.core && a.overlay === b.overlay && a.node === b.node && a.query === b.query && a.window === b.window && a.model === b.model;
    expect(cache.key(a) === cache.key(b)).toBe(same);
  });
});

describe("renderPrompt (properties)", () => {
  const slot = fc.constantFrom("a", "b", "query");
  const piece = fc.oneof(slot.map((s) => ({ slot: s })), fc.stringMatching(/^[^{}]*$/).map((text) => ({ text })));
  test.prop([fc.array(piece), fc.record({ a: fc.string(), b: fc.string(), query: fc.string() })])(
    "PG4.P3 a template of text and slots renders as its text with each slot's value inserted verbatim, once",
    (pieces, vars) => {
      const template = pieces.map((p) => ("slot" in p ? `{${p.slot}}` : p.text)).join("");
      const expected = pieces.map((p) => ("slot" in p ? vars[p.slot as keyof typeof vars] : p.text)).join("");
      expect(renderPrompt(template, vars)).toBe(expected);
    },
  );
});
