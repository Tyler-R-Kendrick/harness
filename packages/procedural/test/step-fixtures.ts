/** Fixtures for the step hook: the settings file, a resolver, the hotpot graph and its variants, and seeding a store. */
import { readFileSync } from "node:fs";
import { GraphIdSchema, parseGraph, parseResolver, parseSettings, revisionId, RevisionRecordSchema } from "@harness/procedural";
import type { GraphId, ProceduralGraph, ProceduralStore, Resolver, RevisionId, RevisionRecord, Settings } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";

export const settingsFile: Settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));

export const GRAPH: GraphId = GraphIdSchema.parse("team/retrieval");

/** Every session resolves to GRAPH, unless its meta says `procedural: "off"`. */
export const resolver: Resolver = parseResolver({
  rules: [
    { when: { meta: { procedural: "off" } }, graph: null },
    { when: {}, graph: GRAPH },
  ],
});

export function hotpotGraph(): ProceduralGraph {
  const parsed = parseGraph(hotpot());
  if (!parsed.ok) throw new Error("fixture");
  return parsed.graph;
}

/** The hotpot graph with every description suffixed: another core revision. */
export function variant(suffix: string): ProceduralGraph {
  const parsed = parseGraph({ ...hotpot(), nodes: hotpot().nodes.map((n) => ({ ...n, description: `${n.description}${suffix}` })) });
  if (!parsed.ok) throw new Error("fixture");
  return parsed.graph;
}

/** Seed (or move, as a dream commit would) a graph's head to `g`. */
export async function seed(store: ProceduralStore, g: ProceduralGraph, graph: GraphId = GRAPH, origin: RevisionRecord["origin"] = "seed"): Promise<RevisionId> {
  const id = revisionId(g);
  const head = await store.heads.get(graph);
  await store.revisions.put(RevisionRecordSchema.parse({ id, graph, parents: head ? [head.revision] : [], document: g, edits: null, origin, evidence: {}, decision: { kind: "head" }, at: 0 }));
  await store.heads.set(graph, head?.revision, id);
  return id;
}
