import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { coreView, DEFAULT_NODE_TYPES, DEFAULT_RELATIONS, exportGraph, exportMermaid, FORMAT, GraphIdSchema, importGraph, parseGraph } from "@harness/procedural";
import type { ProceduralGraph } from "@harness/procedural";
import { FakeStore } from "./store-fake.ts";

const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_.-]{0,8}$/).filter((n) => n !== "Start");
/** Any text, quotes, entities, pipes and line breaks included. */
const text = fc.string({ unit: fc.oneof(fc.constantFrom('"', "#", "<", ">", "|", "`", "\n", "\r\n", ";", "&"), fc.string({ minLength: 1, maxLength: 1, unit: "grapheme" })), maxLength: 16 });

/** Start, then a chain through the other nodes (so every node reaches the last), plus forward shortcuts. */
const graphs = fc
  .record({ others: fc.uniqueArray(name, { minLength: 1, maxLength: 6 }), texts: fc.array(text, { minLength: 30, maxLength: 30 }), shortcuts: fc.array(fc.tuple(fc.nat(6), fc.nat(6)), { maxLength: 4 }) })
  .map(({ others, texts, shortcuts }): ProceduralGraph => {
    const ids = ["Start", ...others];
    const say = (i: number) => texts[i % texts.length]!;
    const chain = ids.slice(1).map((to, i) => [ids[i]!, to] as const);
    const extra = shortcuts.map(([a, b]) => [Math.min(a, b) % ids.length, Math.max(a, b) % ids.length] as const).filter(([a, b]) => a < b).map(([a, b]) => [ids[a]!, ids[b]!] as const);
    const parsed = parseGraph({
      format: FORMAT,
      nodeTypes: DEFAULT_NODE_TYPES,
      relations: DEFAULT_RELATIONS,
      nodes: ids.map((id, i) => ({ id, type: DEFAULT_NODE_TYPES[i % 3]!, description: say(i) })),
      edges: [...chain, ...extra].map(([from, to], i) => ({ from, relation: DEFAULT_RELATIONS[i % 4]!, to, condition: i % 2 === 0 ? null : say(i + 7), guidance: say(i + 3), pitfalls: say(i + 5) })),
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    return parsed.graph;
  });

const graph = GraphIdSchema.parse("g");
const clock = { now: () => 0 };

describe("import and export", () => {
  test.prop([graphs])("PX2.P1 a graph exported as JSON imports back as the same revision: a fresh store makes it head, its own store knows it", async (g) => {
    const store = new FakeStore();
    const first = await importGraph({ store, graph, document: g, clock });
    const exported = await exportGraph({ store, graph, format: "json" });
    if (exported.status !== "ok") throw new Error(exported.reason);
    const again = await importGraph({ store: new FakeStore(), graph, document: JSON.parse(exported.text), clock });
    expect(again).toEqual(first);
    expect(await importGraph({ store, graph, document: JSON.parse(exported.text), clock })).toMatchObject({ status: "known" });
  });

  test.prop([graphs])("PX2.P2 Mermaid has one line per node and per edge whatever their text, and no label holds a raw quote", (g) => {
    const lines = exportMermaid(coreView(g)).split("\n");
    expect(lines).toHaveLength(2 + g.nodes.length + g.edges.length + 1);
    const nodeLines = lines.slice(2, 2 + g.nodes.length);
    const edgeLines = lines.slice(2 + g.nodes.length, -1);
    nodeLines.forEach((line, i) => expect(line).toMatch(new RegExp(`^  n${i}[[({]+"[^"]*"[\\])}]+$`)));
    edgeLines.forEach((line) => expect(line).toMatch(/^ {2}n\d+ -->\|"[^"]*"\| n\d+$/));
  });
});
