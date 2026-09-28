/**
 * The graph router over a model (a resolver's route rule; plan §8.1): the cognitive
 * core's tool router (`route`, with its calibrated confidence) is offered one tool,
 * `choose_graph`, whose input schema admits only the candidate graphs, so a constrained
 * router spends tokens on the choice alone. The tool carries the route prompt (settings
 * data) with the candidates listed; calling nothing chooses no graph.
 */
import type { LanguageModel } from "ai";
import { route } from "@harness/cognitive";
import type { ToolSpec } from "@harness/cognitive";
import { renderPrompt } from "./prompt.ts";
import type { GraphRouter, RouteCandidate } from "./resolver.ts";
import type { Settings } from "./settings.ts";

/** The one tool the graph router is offered. */
export const GRAPH_TOOL = "choose_graph";

/** `choose_graph`: the route prompt with the candidates, and a schema that admits only them. */
function graphTool(template: string, candidates: readonly RouteCandidate[]): ToolSpec {
  const graphs = candidates.map((c) => (c.description === undefined ? `- ${c.graph}` : `- ${c.graph}: ${c.description}`)).join("\n");
  return {
    name: GRAPH_TOOL,
    description: renderPrompt(template, { graphs }),
    parameters: { type: "object", properties: { graph: { type: "string", enum: candidates.map((c) => c.graph) } }, required: ["graph"], additionalProperties: false },
  };
}

/** A `GraphRouter` on a routing model (the ensemble's `tool-calling` router): its valid `choose_graph` call and its confidence. */
export function modelGraphRouter(deps: { readonly model: LanguageModel; readonly settings: Settings }): GraphRouter {
  const { model, settings } = deps;
  return async ({ prompt, candidates }) => {
    const routing = await route(model, { input: prompt, tools: [graphTool(settings.prompts.route, candidates)] });
    // The schema admits only candidates, so a valid call names one.
    const chosen = candidates.find((c) => routing.valid.some((call) => call.arguments["graph"] === c.graph));
    return { graph: chosen?.graph, confidence: routing.confidence };
  };
}
