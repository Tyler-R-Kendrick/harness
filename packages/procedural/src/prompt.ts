/**
 * Prompts in, answers out, for the procedural model calls (guide, refine, reflect):
 * filling a template's `{slots}`, the decoding settings a caller may pass through, and
 * reading the JSON block out of a constrained answer.
 */
import type { LanguageModelCallOptions, RequestOptions } from "ai";

/** Decoding settings passed through to `generateText` (the paper decodes greedily: temperature 0, top-k 1). */
export type Decoding = Pick<LanguageModelCallOptions, "temperature" | "topK" | "maxOutputTokens"> & Pick<RequestOptions, "abortSignal">;

const SLOT = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Fill a template's `{identifier}` slots in one pass. Values go in verbatim and are never
 * filled again, so text from a query or a trajectory cannot open a slot of its own.
 * Anything else in braces (the refiner prompt's literal JSON) and slots with no value
 * stay as they are.
 */
export function renderPrompt(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(SLOT, (slot, name: string) => (Object.hasOwn(vars, name) ? vars[name]! : slot));
}

/**
 * The JSON an answer holds: the whole text, or else its block from the first `{` to the
 * last `}` (a model that fences its answer or talks around it despite the constraint).
 */
export function readJsonBlock(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    try {
      return { ok: true, value: JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) };
    } catch {
      return { ok: false, error: String(error) };
    }
  }
}
