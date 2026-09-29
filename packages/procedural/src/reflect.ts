/**
 * Live reflection (plan §6.2): after a scored turn, a small model call proposes overlay
 * notes and edges under a JSON Schema constraint. Entries carry no binding (I5): the
 * schema has none, and an entry that carries one anyway, or is otherwise malformed, is
 * dropped. A malformed answer proposes nothing. The live learner runs the edit filter
 * over what is returned before proposing it.
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { constrain, ConstraintSchema } from "@harness/cognitive";
import { OverlayEntrySchema } from "./overlay-types.ts";
import type { OverlayEntry } from "./overlay-types.ts";
import { readJsonBlock, renderPrompt } from "./prompt.ts";
import type { Decoding } from "./prompt.ts";
import type { Settings } from "./settings.ts";

// Reflection proposes edges and notes only: nodes come with templated edges, and cautions
// only from statistics (plan §6.2). PGR4.33 checks that these are the edge and note options.
const [edgeEntry, , noteEntry] = OverlayEntrySchema.options;

/** One entry reflection may propose. */
const ReflectionEntrySchema = z.discriminatedUnion("kind", [noteEntry, edgeEntry]);

/** Reflection's answer, as the reflection prompt asks for it. */
const ReflectionSchema = z.strictObject({ entries: z.array(ReflectionEntrySchema) });

/** The constraint sent with every reflection request. */
export const reflectionJsonSchema = (): Record<string, unknown> => z.toJSONSchema(ReflectionSchema);

/** An answer's entries, each still to be checked. */
const EntriesSchema = z.object({ entries: z.array(z.unknown()) });

export interface ReflectRequest extends Decoding {
  model: LanguageModel;
  /** The reflection prompt. */
  template: string;
  /** `{graph_context}`: the part of the graph the turn was guided by. */
  graphContext: string;
  /** `{trajectory}`: the turn's trajectory and its score. */
  trajectory: string;
}

/** What the live learner asks a reflector: the graph the turns were guided by, and the scored turns as text. */
export type Reflector = (request: { graphContext: string; trajectory: string }) => Promise<readonly OverlayEntry[]>;

/** The reflector over a language model: the reflection prompt, with the refiner's decoding. */
export function modelReflector(deps: { model: LanguageModel; settings: Settings }): Reflector {
  const { model, settings } = deps;
  return (request) =>
    reflect({ model, template: settings.prompts.reflection, ...request, temperature: settings.decoding.temperature, topK: settings.decoding.topK, maxOutputTokens: settings.decoding.refinerMaxTokens });
}

/** Ask for overlay entries a finished turn suggests; the well-formed ones, in order. */
export async function reflect(request: ReflectRequest): Promise<OverlayEntry[]> {
  const { model, template, graphContext, trajectory, ...decoding } = request;
  const prompt = renderPrompt(template, { graph_context: graphContext, trajectory });
  const constraint = ConstraintSchema.parse({ type: "json-schema", schema: reflectionJsonSchema() });
  const { text } = await generateText({ model, prompt, ...decoding, ...constrain(constraint) });
  const block = readJsonBlock(text);
  const answer = block.ok ? EntriesSchema.safeParse(block.value) : undefined;
  if (!answer?.success) return [];
  return answer.data.entries.flatMap((entry) => {
    const parsed = ReflectionEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
