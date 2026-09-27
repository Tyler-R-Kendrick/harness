/**
 * The refiner (App. B.5, plan §7.3): proposes an edit set for the core. Its answer has a
 * known shape, so the request carries the edit-set JSON Schema as its constraint. An
 * answer that is not an edit set is a value (`{error, raw}`) for dream's rejection
 * memory, never an exception.
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { constrain, ConstraintSchema } from "@harness/cognitive";
import { EditSetSchema, editSetJsonSchema } from "./graph.ts";
import type { EditSet } from "./graph.ts";
import { readJsonBlock, renderPrompt } from "./prompt.ts";
import type { Decoding } from "./prompt.ts";

export interface RefineRequest extends Decoding {
  model: LanguageModel;
  /** The refiner prompt, or dream's (the refiner's plus its consolidation section). */
  template: string;
  /** `{task_description}`. */
  task: string;
  /** `{mode}`: `static_onetime`, `static_incremental`, `scratch_onetime` or `scratch_incremental` in the paper. */
  mode: string;
  /** `{available_tools_list}`: the tool names the agent can execute. */
  tools: readonly string[];
  /** `{attempts_block}`: the trajectory context. */
  attempts: string;
  /** `{current_graph_json}`. */
  graphJson: string;
  /** `{rejected_block}`: the serialized rejection memory. */
  rejected: string;
  /** Dream's consolidation blocks (plan §7.3), for the dream prompt. */
  consolidation?: { overlayEntries: string; cautionedEdges: string; rejectionReasons: string };
}

export type RefineResult = { edits: EditSet; raw: string } | { error: string; raw: string };

/** Ask the refiner for an edit set, under the edit-set JSON Schema constraint. */
export async function refine(request: RefineRequest): Promise<RefineResult> {
  const { model, template, task, mode, tools, attempts, graphJson, rejected, consolidation, ...decoding } = request;
  const prompt = renderPrompt(template, {
    task_description: task,
    mode,
    available_tools_list: tools.join(", "),
    attempts_block: attempts,
    current_graph_json: graphJson,
    rejected_block: rejected,
    ...(consolidation && {
      overlay_entries_block: consolidation.overlayEntries,
      cautioned_edges_block: consolidation.cautionedEdges,
      rejection_reasons_block: consolidation.rejectionReasons,
    }),
  });
  const constraint = ConstraintSchema.parse({ type: "json-schema", schema: editSetJsonSchema() });
  const { text: raw } = await generateText({ model, prompt, ...decoding, ...constrain(constraint) });
  const block = readJsonBlock(raw);
  if (!block.ok) return { error: `the refiner's answer is not JSON (${block.error})`, raw };
  const edits = EditSetSchema.safeParse(block.value);
  if (!edits.success) return { error: `the refiner's answer is not an edit set\n${z.prettifyError(edits.error)}`, raw };
  return { edits: edits.data, raw };
}
