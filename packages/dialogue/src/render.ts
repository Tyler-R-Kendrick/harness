import { readTemplate } from "@harness/cognitive";
import type { TemplateConstraint } from "@harness/cognitive";
import { PATTERN_FLAGS } from "./schemas.ts";
import type { Path, Script, ToolResult } from "./schemas.ts";

/** What a script's holes are filled from: slot values, and the result step's tool call. */
export interface Fillers {
  readonly slots: Readonly<Record<string, string>>;
  readonly result?: ToolResult;
}

/** The text of a string, number or boolean at `path` in a JSON value; nothing for anything else. */
export function valueAt(json: unknown, path: Path): string | undefined {
  let at = json;
  for (const key of path) {
    if (typeof at !== "object" || at === null) return undefined;
    at = (at as Record<string | number, unknown>)[key];
  }
  return typeof at === "string" || typeof at === "number" || typeof at === "boolean" ? String(at) : undefined;
}

/** The slots a script's reply uses, in order. */
export const replySlots = (script: Script): string[] => script.reply.flatMap((p) => (typeof p === "object" && "slot" in p ? [p.slot] : []));

type TemplatePart = TemplateConstraint["parts"][number];

/**
 * A reply's parts with what the fillers have filled in: fixed text for slots and values,
 * holes for generated parts and for slots not yet known (listed); nothing when the result
 * lacks a value the reply reads.
 */
function resolve(script: Script, fillers: Fillers): { parts: TemplatePart[]; unknown: string[] } | undefined {
  const parts: TemplatePart[] = [];
  const unknown: string[] = [];
  for (const part of script.reply) {
    if (typeof part === "string") parts.push(part);
    else if ("slot" in part) {
      const value = fillers.slots[part.slot];
      if (value === undefined) unknown.push(part.slot);
      parts.push(value ?? { hole: part.slot });
    } else if ("generate" in part) parts.push(part.constraint ? { hole: part.generate, constraint: part.constraint } : { hole: part.generate });
    else if ("flow" in part) return undefined;
    else {
      const value = fillers.result && ("input" in part ? valueAt(fillers.result.input, part.input) : valueAt(fillers.result.output, part.output));
      if (value === undefined) return undefined;
      parts.push(value);
    }
  }
  return { parts, unknown };
}

/** A template of parts, adjacent text joined (a hole never neighbours another, so empty text always joins some). */
function templateOf(parts: readonly TemplatePart[]): TemplateConstraint {
  const joined: TemplatePart[] = [];
  for (const part of parts) {
    const last = joined[joined.length - 1];
    if (typeof part === "string" && typeof last === "string") joined[joined.length - 1] = last + part;
    else joined.push(part);
  }
  return { type: "template", parts: joined };
}

/** The flow a script's reply starts, if it is one. */
export const flowOf = (script: Script): string | undefined => {
  const [first] = script.reply;
  return typeof first === "object" && "flow" in first ? first.flow : undefined;
};

/**
 * A script's reply for these slots and this result: its text when every hole is filled
 * from them; a template (fixed text and generated holes) when the model must write some
 * holes; the flow it starts; or what is missing (the slots to ask for; none when a
 * result lacks a value).
 */
export function fill(
  script: Script,
  fillers: Fillers,
): { kind: "text"; text: string } | { kind: "template"; template: TemplateConstraint } | { kind: "flow"; flow: string } | { kind: "missing"; slots: string[] } {
  const flow = flowOf(script);
  if (flow !== undefined) return { kind: "flow", flow };
  const resolved = resolve(script, fillers);
  if (!resolved || resolved.unknown.length > 0) return { kind: "missing", slots: replySlots(script).filter((s) => fillers.slots[s] === undefined) };
  const { parts } = resolved;
  return parts.every((p) => typeof p === "string") ? { kind: "text", text: parts.join("") } : { kind: "template", template: templateOf(parts) };
}

/**
 * Whether the model's reply is what the script says, with these fillers: its fixed text
 * and filled holes exactly (whitespace around the reply aside), any text its constraint
 * allows in each generated hole, and in a slot not yet known a value the user said.
 */
export function fits(script: Script, reply: string, fillers: Fillers & { readonly utterance?: string }): boolean {
  const resolved = resolve(script, fillers);
  if (!resolved) return false;
  const template = templateOf(resolved.parts);
  let holes: Record<string, string>;
  try {
    holes = readTemplate(template, reply.trim());
  } catch {
    return false;
  }
  const said = fillers.utterance?.toLowerCase();
  return resolved.unknown.every((slot) => holes[slot] !== "" && said !== undefined && said.includes(holes[slot]!.toLowerCase()));
}

/**
 * The slots a pattern fills from a whole utterance (the pattern anchored at both ends,
 * ignoring case, whitespace around the utterance and closing punctuation), or nothing
 * when it does not match. Groups that took no part, or matched only whitespace, fill nothing.
 */
export function matchPattern(source: string, utterance: string): Record<string, string> | undefined {
  const match = new RegExp(`^\\s*(?:${source})[\\s.?!…]*$`, PATTERN_FLAGS).exec(utterance);
  if (!match) return undefined;
  return Object.fromEntries(Object.entries(match.groups ?? {}).flatMap(([slot, value]) => (value?.trim() ? [[slot, value.trim()]] : [])));
}

/** The first text in an utterance a slot's value pattern finds, if any. */
export function findValue(source: string, utterance: string): string | undefined {
  return new RegExp(source, PATTERN_FLAGS).exec(utterance)?.[0].trim() || undefined;
}
