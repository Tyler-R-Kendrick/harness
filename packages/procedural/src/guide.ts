/**
 * Step guidance (plan §5.2, App. B.5): the guidance model reads the serialized graph
 * context, the query and the recent trajectory window, and advises the next step. The
 * answer is free text, so no constraint is sent. The harness preset caches guidance per
 * session under a key of everything the text depends on.
 */
import { generateText } from "ai";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import type { NodeName, RevisionId } from "./graph.ts";
import { renderPrompt } from "./prompt.ts";
import type { Decoding } from "./prompt.ts";

export interface GuideRequest extends Decoding {
  model: LanguageModel;
  /** The guidance prompt (`guidancePromptOf(settings, preset)`). */
  template: string;
  /** `{task_description}`. */
  task: string;
  /** `{subgraph_summary}`: the serialized neighborhood, or the whole graph as the fallback. */
  graphContext: string;
  /** `{graph_context_desc}` (settings `graphContext.local.desc` or `.full.desc`). */
  graphContextDesc: string;
  /** `{graph_source}` (settings `graphContext.local.source` or `.full.source`). */
  graphSource: string;
  /** `{query}`: the active query or observation. */
  query: string;
  /** `{recent_context}`: the serialized trajectory window. */
  recent: string;
}

/** Ask the guidance model for advice on the agent's next step. */
export async function guide(request: GuideRequest): Promise<{ text: string; usage: LanguageModelUsage }> {
  const { model, template, task, graphContext, graphContextDesc, graphSource, query, recent, ...decoding } = request;
  const prompt = renderPrompt(template, {
    task_description: task,
    graph_context_desc: graphContextDesc,
    subgraph_summary: graphContext,
    query,
    recent_context: recent,
    graph_source: graphSource,
  });
  const { text, usage } = await generateText({ model, prompt, ...decoding });
  return { text, usage };
}

/** What guidance for one step depends on. `node` is undefined when nothing matched (the full-graph fallback). */
export interface GuidanceKeyParts {
  core: RevisionId;
  overlay: number | null;
  node: NodeName | undefined;
  query: string;
  window: string;
  /** The guidance model, or its id. */
  model: LanguageModel;
}

const modelKey = (model: LanguageModel): string => (typeof model === "string" ? model : `${model.provider}:${model.modelId}`);

/**
 * Guidance texts for one session (an instance is per session), keyed by
 * `(core, overlay version, node, digest(query), digest(window), model)`: the query and
 * window are in the key, so two queries at `Start` never share guidance, and only their
 * digests are, so the key holds no session text. Gets are counted as hits and misses.
 */
export class GuidanceCache {
  readonly #texts = new Map<string, string>();
  #hits = 0;
  #misses = 0;

  key(parts: GuidanceKeyParts): string {
    return canonicalJson([parts.core, parts.overlay, parts.node ?? null, sha256Hex(parts.query), sha256Hex(parts.window), modelKey(parts.model)]);
  }

  get(key: string): string | undefined {
    const text = this.#texts.get(key);
    if (text === undefined) this.#misses++;
    else this.#hits++;
    return text;
  }

  set(key: string, text: string): void {
    this.#texts.set(key, text);
  }

  hits(): number {
    return this.#hits;
  }

  misses(): number {
    return this.#misses;
  }
}
