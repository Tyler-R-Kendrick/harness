import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { quickjsCodeMode, runWorkflow } from "@harness/workflows";
import { MemoryStorage } from "@harness/testkit";
import { canonicalJson, compilePath, composeCandidate, NodeNameSchema, nodeById, outgoing, parseGraph, pathCandidates } from "@harness/procedural";
import type { NodeName, OverlayEvent, RecordedCall } from "@harness/procedural";
import { chainDoc, graphOf, observed, settings } from "./compose-fixtures.ts";

/** The chain fixture plus a cycle x → y → z → x whose interior nodes have one way out. */
const doc = chainDoc();
doc.nodes.push({ id: "x", type: "ACTION", description: "x" }, { id: "y", type: "ACTION", description: "y" }, { id: "z", type: "ACTION", description: "z" });
for (const [from, to] of [["Start", "x"], ["x", "y"], ["y", "z"], ["z", "x"], ["x", "End"]] as const) doc.edges.push({ from, relation: "LEADS_TO", to, condition: null, guidance: "", pitfalls: "" });
const g = graphOf(doc);
const NODES = [...g.nodes.map((n) => n.id), "Ghost"];

const events = fc.array(
  fc.record({
    session: fc.constantFrom("s1", "s2", "s3", "s4"),
    turn: fc.integer({ min: 1, max: 4 }),
    path: fc.array(fc.constantFrom(...NODES), { maxLength: 7 }),
    score: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
  }),
  { maxLength: 12 },
).map((es) => es.map((e) => observed(`${e.session}/${e.turn}`, e.path, e.score)));
const compositionSettings = fc.record({ support: fc.integer({ min: 1, max: 3 }), minScore: fc.double({ min: 0, max: 1, noNaN: true }), maxLength: fc.integer({ min: 2, max: 5 }) }).map((s) => settings(s));

const contains = (path: readonly string[], segment: readonly string[]) => path.some((_, i) => segment.every((n, k) => path[i + k] === n));

describe("composition properties", () => {
  test.prop([events, compositionSettings])("PC1.P1 every candidate is a chain of distinct action nodes, interior nodes forced, walked by enough distinct sessions scoring well enough", (es, s) => {
    const firsts = new Map<string, Extract<OverlayEvent, { kind: "observed" }>>();
    for (const e of es) if (e.kind === "observed" && !firsts.has(e.turnKey)) firsts.set(e.turnKey, e);
    for (const c of pathCandidates(g, es, s)) {
      expect(c.path.length).toBeGreaterThanOrEqual(2);
      expect(c.path.length).toBeLessThanOrEqual(s.maxLength);
      expect(new Set(c.path).size).toBe(c.path.length);
      for (const n of c.path) expect(nodeById(g, n)?.type).toBe("ACTION");
      c.path.slice(1).forEach((n, i) => expect(outgoing(g, c.path[i]!).some((e) => e.to === n && e.condition === null)).toBe(true));
      for (const n of c.path.slice(1, -1)) expect(outgoing(g, n)).toHaveLength(1);
      const walking = [...firsts.values()].filter((e) => contains(e.path, c.path));
      expect(c.turns).toBe(walking.length);
      expect(c.support).toBe(new Set(walking.map((e) => e.turnKey.split("/")[0])).size);
      expect(c.support).toBeGreaterThanOrEqual(s.support);
      const scored = walking.flatMap((e) => (e.score === null ? [] : [e.score]));
      expect(c.meanScore).toBeCloseTo(scored.reduce((a, b) => a + b, 0) / scored.length, 12);
      expect(c.meanScore).toBeGreaterThanOrEqual(s.minScore);
    }
  });

  test.prop([events, compositionSettings])("PC1.P2 redelivery changes nothing: every event delivered again, in any order after the first, gives the same candidates", (es, s) => {
    expect(pathCandidates(g, [...es, ...[...es].reverse()], s)).toEqual(pathCandidates(g, es, s));
  });

  test.prop([events, compositionSettings])("PC1.P3 binding any candidate keeps the whole core, and the candidate core parses", (es, s) => {
    for (const c of pathCandidates(g, es, s)) {
      const compiled = compilePath(c.path, [c.path.map(() => ({ name: "t", arguments: {} }))], { t: {} });
      if (!compiled.ok) throw new Error(compiled.error);
      const composed = composeCandidate(g, c.path, compiled.workflow);
      if (!composed.ok) throw new Error(composed.error);
      expect(parseGraph(composed.document).ok).toBe(true);
      for (const n of g.nodes) expect(composed.document.nodes).toContainEqual(n);
      for (const e of g.edges) expect(composed.document.edges).toContainEqual(e);
    }
  });

  // Recorded runs over three tools, with arguments drawn so that some are constant, some vary, and some are absent in some runs.
  const value = fc.constantFrom<unknown>(1, 2, "a", "b", null, true, { n: 1 }, [1, 2]);
  const args = fc.dictionary(fc.constantFrom("a", "b", "c"), value, { maxKeys: 3 });
  const runs = fc.integer({ min: 1, max: 3 }).chain((k) => fc.array(fc.array(args, { minLength: k, maxLength: k }), { minLength: 1, maxLength: 4 }));
  const path: NodeName[] = ["n0", "n1", "n2"].map((n) => NodeNameSchema.parse(n));
  const codeMode = quickjsCodeMode();

  test.prop([runs], { numRuns: 25 })("PC1.P4 data flow round trip: given a run's inputs, and the model answering with that run's varying arguments, the compiled workflow makes exactly that run's calls", async (drawn) => {
    const recorded: RecordedCall[][] = drawn.map((run) => run.map((a, i) => ({ name: `t${i}`, arguments: a })));
    const compiled = compilePath(path.slice(0, drawn[0]!.length), recorded, { t0: {}, t1: {}, t2: {} });
    if (!compiled.ok) throw new Error(compiled.error);
    const w = compiled.workflow;
    const inputKeys = Object.keys((w.inputs as { properties: Record<string, unknown> }).properties);
    for (const run of recorded) {
      const performed: RecordedCall[] = [];
      let step = 0;
      const result = await runWorkflow({
        name: w.name,
        code: w.code,
        input: Object.fromEntries(inputKeys.filter((k) => Object.hasOwn(run[0]!.arguments, k)).map((k) => [k, run[0]!.arguments[k]])),
        tools: { t0: {}, t1: {}, t2: {} },
        journal: new MemoryStorage(),
        codeMode,
        effects: {
          tool: async (name, a) => {
            performed.push({ name, arguments: a });
            step = performed.length;
            return { ok: name };
          },
          ask: async (_, constraint) => {
            if (constraint?.type !== "json-schema") throw new Error("a later call is asked with a JSON Schema constraint");
            const keys = Object.keys(constraint.schema["properties"] as Record<string, unknown>);
            const own = run[step]!.arguments;
            return JSON.stringify(Object.fromEntries(keys.filter((k) => Object.hasOwn(own, k)).map((k) => [k, own[k]])));
          },
        },
      });
      expect(result.status).toBe("completed");
      expect(performed.map((c) => canonicalJson(c))).toEqual(run.map((c) => canonicalJson(c)));
    }
  });
});
