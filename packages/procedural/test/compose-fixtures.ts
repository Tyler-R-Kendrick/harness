/** Fixtures for composition (PC1): a chain of tools, observed turns, recorded runs and tool specs. */
import { OverlayEventSchema, parseCompositionSettings, parseGraph, revisionId, ScoredTrajectorySchema } from "@harness/procedural";
import type { CompositionSettings, OverlayEvent, ProceduralGraph, RecordedCall, ScoredTrajectory } from "@harness/procedural";
import type { ToolSpec } from "@harness/workflows";
import { edge } from "./fixtures.ts";
import type { DocInput } from "./fixtures.ts";

/**
 * Start → search → Fetch_Page → summarize → End, and summarize → review (conditional) → End.
 * `Fetch_Page` binds the tool `fetch`; `plan` is a reasoning node off the chain.
 */
export function chainDoc(): DocInput {
  return {
    format: "harness.procedural-graph/v1",
    nodeTypes: ["ACTION", "REASONING", "STATUS"],
    relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
    nodes: [
      { id: "Start", type: "STATUS", description: "The task begins." },
      { id: "plan", type: "REASONING", description: "Plan the search." },
      { id: "search", type: "ACTION", description: "Search the web." },
      { id: "Fetch_Page", type: "ACTION", description: "Fetch the best hit.", binding: { kind: "tool", name: "fetch" } },
      { id: "summarize", type: "ACTION", description: "Summarize the page." },
      { id: "review", type: "ACTION", description: "Ask for a review." },
      { id: "End", type: "STATUS", description: "Done." },
    ],
    edges: [
      edge("Start", "plan"),
      edge("plan", "search", "TRIGGERS"),
      edge("Start", "search"),
      edge("search", "Fetch_Page", "PROVIDES_INPUT_FOR"),
      edge("Fetch_Page", "summarize"),
      edge("summarize", "End", "CONVERGES_TO"),
      edge("summarize", "review", "LEADS_TO", "when a reviewer is needed"),
      edge("review", "End"),
    ],
  };
}

export function graphOf(doc: DocInput): ProceduralGraph {
  const parsed = parseGraph(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.graph;
}

export const chain = (): ProceduralGraph => graphOf(chainDoc());

export const observed = (turnKey: string, path: readonly string[], score: number | null): OverlayEvent =>
  OverlayEventSchema.parse({ kind: "observed", turnKey, path, unmatched: [], score, exposure: [] });

export const settings = (over: Record<string, unknown> = {}): CompositionSettings => parseCompositionSettings({ support: 2, minScore: 0.5, maxLength: 6, ...over });

export const SPECS: Record<string, ToolSpec> = {
  search: { inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" }, site: { type: "string" } }, required: ["query"] } },
  fetch: { inputSchema: { type: "object", properties: { url: { type: "string", format: "uri" }, format: { enum: ["md", "html"] } }, required: ["url"] } },
  summarize: { inputSchema: { type: "object", properties: { text: { type: "string" }, words: { type: "integer" } } } },
};

/** Two recorded runs of search → fetch → summarize: `limit`, `format` and `words` are constant. */
export const RUNS: RecordedCall[][] = [
  [
    { name: "search", arguments: { site: "wiki", query: "ada lovelace", limit: 5 } },
    { name: "fetch", arguments: { url: "https://a.example/ada", format: "md" } },
    { name: "summarize", arguments: { text: "Ada wrote the first program.", words: 50 } },
  ],
  [
    { name: "search", arguments: { query: "alan turing", limit: 5 } },
    { name: "fetch", arguments: { url: "https://a.example/turing", format: "md" } },
    { name: "summarize", arguments: { text: "Turing defined computability.", words: 50 } },
  ],
];

export const PATH = ["search", "Fetch_Page", "summarize"] as const;

/** A scored turn whose steps are these calls, each followed by its tool result. */
export function turn(g: ProceduralGraph, session: string, calls: readonly RecordedCall[], extra: { role: "user" | "assistant"; content: string }[] = []): ScoredTrajectory {
  return ScoredTrajectorySchema.parse({
    id: `${session}-t`,
    graph: "g",
    core: revisionId(g),
    overlay: null,
    session,
    turn: "t1",
    query: "Who?",
    steps: [...extra, ...calls.flatMap((c) => [{ role: "assistant", content: "", call: { name: c.name, arguments: c.arguments } }, { role: "tool", content: `${c.name} done` }])],
    score: 1,
    scoreSource: "outcome",
    localization: { matched: 0, fallback: 0, inert: 0 },
    usage: { steps: 0, inputTokens: 0, outputTokens: 0, guidanceTokens: 0 },
  });
}
