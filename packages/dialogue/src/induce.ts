import { align } from "./align.ts";
import type { Alignment } from "./align.ts";
import { fits } from "./render.ts";
import { ScriptSchema } from "./schemas.ts";
import type { Observation, Part, Path, Script, ScriptId, Settings } from "./schemas.ts";

const CLOSING = new Set([".", "?", "!", "…"]);

/** An utterance without whitespace around it and closing punctuation, as patterns match it (in time linear in its length). */
export function normalizeUtterance(utterance: string): string {
  const text = utterance.trim();
  let end = text.length;
  while (end > 0 && (CLOSING.has(text[end - 1]!) || /\s/.test(text[end - 1]!))) end--;
  return text.slice(0, end);
}

const EMAIL = /^[^@]+@[^@]+$/;
const LINK = /^https?:\/\//i;

/**
 * What people said, as an exemplar to keep: numbers, email addresses and links masked,
 * so a script does not carry them.
 */
export const maskExemplar = (utterance: string): string =>
  // Word by word, so masking takes time linear in the utterance's length.
  normalizeUtterance(utterance)
    .split(/(\s+)/)
    .map((w) => (LINK.test(w) ? "{link}" : EMAIL.test(w) ? "{email}" : w.replace(/\d+/g, "{number}")))
    .join("");

/** A gap of a pattern: a few words (`induce.words` at most), not anything (a bounded group cannot backtrack for long). */
const wordsGroup = (words: number) => String.raw`\S+(?:\s+\S+){0,${words - 1}}?`;

/** Text as a regular expression matching it, any run of whitespace matching any other. */
const literal = (text: string) =>
  text
    .replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&")
    .split(/\s+/)
    .join("\\s+");

/** Every string, number and boolean in a JSON value, with its path (array indexes as numbers), depth first. */
function* leaves(json: unknown, path: Path = []): Generator<[Path, string]> {
  if (typeof json === "object" && json !== null) for (const [k, v] of Object.entries(json)) yield* leaves(v, [...path, Array.isArray(json) ? Number(k) : k]);
  else if (json !== null) yield [path, String(json)];
}

/** Where every observation's tool call holds its value (input first), if they agree on a place. */
function valueSource(observations: readonly Observation[], values: readonly string[]): Part | undefined {
  const places = observations.map((o, j) => {
    const { input, output } = o.result!;
    const inputs = [...leaves(input)].flatMap(([path, v]) => (v === values[j] ? [{ input: path }] : []));
    const outputs = [...leaves(output)].flatMap(([path, v]) => (v === values[j] ? [{ output: path }] : []));
    return [...inputs, ...outputs].map((place) => JSON.stringify(place));
  });
  const shared = places[0]!.find((place) => places.every((p) => p.includes(place)));
  return shared === undefined ? undefined : (JSON.parse(shared) as Part);
}

/** The share of `a`'s texts that is fixed: its segments over segments and values. */
function fixedShare(a: Alignment): number {
  const fixed = a.segments.join("").length * a.values.length;
  const varying = a.values.flat().join("").length;
  return fixed / (fixed + varying);
}

/**
 * Aligned replies as a reply's parts: each gap is the hole `source` finds for its values,
 * or generated. With the share of the replies determined without the model: fixed text
 * and the values of found holes.
 */
function replyParts(replies: Alignment, source: (g: number, values: readonly string[]) => Part | undefined): { parts: Part[]; determined: number } {
  const parts: Part[] = [];
  let determined = replies.segments.join("").length * replies.values.length;
  let generated = 0;
  replies.segments.forEach((segment, g) => {
    if (segment !== "") parts.push(segment);
    if (g === replies.segments.length - 1) return;
    const values = replies.values.map((v) => v[g]!);
    const hole = source(g, values);
    parts.push(hole ?? { generate: `hole_${g + 1}` });
    if (hole) determined += values.join("").length;
    else generated += values.join("").length;
  });
  return { parts, determined: determined / (determined + generated) };
}

/**
 * A script from a cluster of steps the model answered, with no model: the replies are
 * aligned (fixed text and holes), and each hole's values are traced to where they came
 * from. In a result cluster (one tool's), a hole whose values sit at one path of every
 * call's input or output reads that path. In an utterance cluster, the utterances are
 * aligned too; when they share enough text they become a pattern whose gaps are slots,
 * and a hole repeating a slot in every observation is that slot. Every other hole is
 * generated. The script is a candidate with no evidence: the observations it was built
 * from are not fits. It is refused (with the reason) when the model ever acted on steps
 * like these, when they come from too few sessions (one person's replies are not
 * everyone's), when too little of the replies is determined without the model, when
 * they have too many holes, or when too few of them fit it.
 */
export function induce(
  cluster: { readonly context?: ScriptId; readonly tool?: string; readonly acted?: boolean; readonly observations: readonly Observation[] },
  settings: Settings["induce"],
  id: ScriptId,
): { script: Script } | { problem: string } {
  const { observations, tool } = cluster;
  if (cluster.acted) return { problem: "the model acted on steps like these" };
  if (observations.length < settings.support) return { problem: `${observations.length} observation(s), fewer than ${settings.support}` };
  const sessions = new Set(observations.flatMap((o) => (o.session === undefined ? [] : [o.session]))).size;
  if (sessions < settings.sessions) return { problem: `observations from ${sessions} session(s), fewer than ${settings.sessions}` };
  if (observations.every((o) => o.reply.trim() === "")) return { problem: "the replies are empty" };
  const replies = align(observations.map((o) => o.reply.trim()));
  const base = { id, status: "candidate", origin: "induced", ...(cluster.context === undefined ? {} : { context: cluster.context }) };

  let script: unknown;
  let parts: Part[];
  let determined: number;
  if (tool !== undefined) {
    ({ parts, determined } = replyParts(replies, (_, values) => valueSource(observations, values)));
    script = { ...base, intent: `Reply to a ${tool} result`, result: { tool }, reply: parts };
  } else {
    const utterances = align(
      observations.map((o) => normalizeUtterance(o.utterance)),
      { ignoreCase: true },
    );
    // Utterances are trimmed and whitespace between gaps joins them, so a segment is fixed words or nothing.
    const gaps = utterances.segments.length - 1;
    const patterned = utterances.segments.some((s) => s !== "") && gaps <= settings.holes && fixedShare(utterances) >= settings.determined;
    // A reply gap repeating one utterance gap in every observation is that gap's slot.
    const slotOf = (g: number): Part | undefined => {
      const i = utterances.values[0]!.findIndex((_, i) => observations.every((_, j) => replies.values[j]![g] === utterances.values[j]![i]));
      return patterned && i >= 0 ? { slot: `slot_${i + 1}` } : undefined;
    };
    ({ parts, determined } = replyParts(replies, slotOf));
    if (patterned) {
      const masked = utterances.segments.map((s, i) => (i < gaps ? `${s}{slot_${i + 1}}` : s)).join("");
      const digits = (i: number) => observations.every((_, j) => /^\d+$/.test(utterances.values[j]![i]!));
      // A gap is its values' kind of text (digits, or a few words); one some utterance leaves
      // empty may be left out, with the whitespace that would follow it.
      const group = (i: number) => {
        const body = `(?<slot_${i + 1}>${digits(i) ? "\\d+" : wordsGroup(settings.words)})`;
        if (!utterances.values.some((v) => v[i] === "")) return body;
        return /^\s/.test(utterances.segments[i + 1]!) ? `${body}?` : `(?:${body}\\s+)?`;
      };
      const pattern = utterances.segments.map((s, i) => (i < gaps ? `${literal(s)}${group(i)}` : literal(s))).join("");
      const slots = Object.fromEntries(Array.from({ length: gaps }, (_, i) => [`slot_${i + 1}`, digits(i) ? { pattern: "\\d+" } : {}]));
      script = { ...base, intent: masked, patterns: [pattern], exemplars: [masked], slots, reply: parts };
    } else {
      const said = [...new Set(observations.map((o) => maskExemplar(o.utterance)))];
      script = { ...base, intent: said[0], exemplars: said, reply: parts };
    }
  }
  if (determined < settings.determined) return { problem: `only ${determined.toFixed(2)} of the reply is determined, below ${settings.determined}` };
  const holes = replies.segments.length - 1;
  if (holes > settings.holes) return { problem: `${holes} holes, more than ${settings.holes}` };

  const induced = ScriptSchema.parse(script);
  const fitting = observations.filter((o) => fits(induced, o.reply, { slots: {}, ...(o.result ? { result: o.result } : {}), utterance: o.utterance })).length;
  if (fitting < settings.support) return { problem: `${fitting} observation(s) fit the script, fewer than ${settings.support}` };
  return { script: induced };
}
