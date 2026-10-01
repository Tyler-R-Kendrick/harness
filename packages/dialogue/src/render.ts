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
  // Stryker disable next-line ConditionalExpression: equivalent; a part without a flow has no flow property to read
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
 * Several rendered replies as one, in the order given. Fixed text is copied. A hole keeps
 * its constraint, and a hole name used again is renamed so the sections stay apart. A blank
 * line separates sections. Nothing here is generated.
 */
export function composeReplies(
  sections: readonly ({ kind: "text"; text: string } | { kind: "template"; template: TemplateConstraint })[],
): { kind: "text"; text: string } | { kind: "template"; template: TemplateConstraint } {
  const seen = new Map<string, number>();
  const hole = (name: string): string => {
    const used = seen.get(name) ?? 0;
    seen.set(name, used + 1);
    return used === 0 ? name : `${name}-${used + 1}`;
  };
  const parts: TemplatePart[] = [];
  sections.forEach((section, index) => {
    if (index > 0) parts.push("\n\n");
    if (section.kind === "text") parts.push(section.text);
    else for (const part of section.template.parts) parts.push(typeof part === "string" ? part : { ...part, hole: hole(part.hole) });
  });
  return parts.every((part) => typeof part === "string") ? { kind: "text", text: parts.join("") } : { kind: "template", template: templateOf(parts) };
}

type HolePart = Exclude<TemplatePart, string>;

/** Quoted pieces of an EBNF grammar. A sentence's only quoted pieces are spaces. */
function quotedLiterals(ebnf: string): string[] {
  return [...ebnf.matchAll(/"([^\"]*)"/g)].map((match) => match[1] ?? "");
}

function plainProse(ebnf: string): boolean {
  const literals = quotedLiterals(ebnf);
  return literals.length > 0 && literals.every((literal) => /^ *$/.test(literal));
}

/** A document grammar's sentence, when it defines the prose, spaces and word rules. */
function sentenceOf(ebnf: string): string | undefined {
  const lines = ["prose", "spaces", "word"].map((name) => ebnf.split("\n").find((line) => line.startsWith(`${name} ::=`)));
  if (lines.some((line) => line === undefined)) return undefined;
  return `root ::= prose\n${lines.join("\n")}`;
}

/** A one-hole template is already an answer: a sentence, or a grammar that is not built from one. */
function keepWhole(part: HolePart): boolean {
  const constraint = part.constraint;
  if (constraint === undefined || constraint.type !== "grammar") return true;
  if (plainProse(constraint.ebnf)) return true;
  return sentenceOf(constraint.ebnf) === undefined;
}

function sentenceHole(part: HolePart): HolePart | undefined {
  if (part.constraint?.type !== "grammar") return undefined;
  const ebnf = sentenceOf(part.constraint.ebnf);
  if (ebnf === undefined) return undefined;
  return { hole: "answer", constraint: { type: "grammar", ebnf } };
}

/**
 * One answer from a rendered section, so a stitch stays a few holes.
 * Fixed text is copied. One hole stays when it is prose, an equation, or
 * any grammar that has no prose rule inside it. A document becomes its plain
 * prose hole, or one prose answer taken from the prose rules inside it.
 * The prose rule has no word cap: a template may exceed the model's limits.
 */
export function stitchAnswer(
  section: { kind: "text"; text: string } | { kind: "template"; template: TemplateConstraint },
): { kind: "text"; text: string } | { kind: "template"; template: TemplateConstraint } {
  if (section.kind === "text") return section;
  const holes = section.template.parts.filter((part): part is HolePart => typeof part !== "string");
  const only = holes.length === 1 ? holes[0] : undefined;
  if (only !== undefined && keepWhole(only)) return section;
  const prose = holes.find((part) => part.constraint?.type === "grammar" && plainProse(part.constraint.ebnf));
  if (prose !== undefined) return { kind: "template", template: { type: "template", parts: [prose] } };
  for (const part of holes) {
    const answer = sentenceHole(part);
    if (answer !== undefined) return { kind: "template", template: { type: "template", parts: [answer] } };
  }
  const first = holes[0];
  return first !== undefined ? { kind: "template", template: { type: "template", parts: [first] } } : section;
}

/**
 * The holes of the model's reply read as the script's (see `fits`), or nothing when it is
 * not what the script says.
 */
export function readHoles(script: Script, reply: string, fillers: Fillers & { readonly utterance?: string }): Record<string, string> | undefined {
  const resolved = resolve(script, fillers);
  if (!resolved) return undefined;
  const template = templateOf(resolved.parts);
  let holes: Record<string, string>;
  try {
    holes = readTemplate(template, reply.trim());
  } catch {
    return undefined;
  }
  const said = fillers.utterance?.toLowerCase();
  return resolved.unknown.every((slot) => holes[slot] !== "" && said !== undefined && said.includes(holes[slot]!.toLowerCase())) ? holes : undefined;
}

/**
 * Whether the model's reply is what the script says, with these fillers: its fixed text
 * and filled holes exactly (whitespace around the reply aside), any text its constraint
 * allows in each generated hole, and in a slot not yet known a value the user said.
 */
export const fits = (script: Script, reply: string, fillers: Fillers & { readonly utterance?: string }): boolean => readHoles(script, reply, fillers) !== undefined;

/** Compiled regular expressions by source (patterns come from books, so there are few). */
const compiled = new Map<string, RegExp>();

// The cache only saves compiling again: what it keeps, and when it is cleared, changes no match.
// Stryker disable all
function regex(source: string): RegExp {
  let re = compiled.get(source);
  if (re === undefined) {
    if (compiled.size >= 1024) compiled.clear();
    re = new RegExp(source, PATTERN_FLAGS);
    compiled.set(source, re);
  }
  return re;
}
// Stryker restore all

/**
 * The slots a pattern fills from a whole utterance (the pattern anchored at both ends,
 * ignoring case, whitespace around the utterance and closing punctuation), or nothing
 * when it does not match. Groups that took no part, or matched only whitespace, fill nothing.
 */
export function matchPattern(source: string, utterance: string): Record<string, string> | undefined {
  const match = regex(`^\\s*(?:${source})[\\s.?!…]*$`).exec(utterance);
  if (!match) return undefined;
  return Object.fromEntries(Object.entries(match.groups ?? {}).flatMap(([slot, value]) => (value?.trim() ? [[slot, value.trim()]] : [])));
}

/** The first text in an utterance a slot's value pattern finds, if any. */
export function findValue(source: string, utterance: string): string | undefined {
  return regex(source).exec(utterance)?.[0].trim() || undefined;
}

/** Characters a class is tried on, to tell whether two classes can match the same one. */
const SAMPLES = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \t\n-.,@/_:;!?#*+()'\"$%&=<>[]{}|~^`\\", "é", "ß", "中", "😀"];

/** Whether two atoms (a character, an escape, a class) can match the same character, as far as the samples and the atoms' own characters tell; one that does not compile may match anything. */
function overlaps(a: string, b: string): boolean {
  const test = (atom: string) => {
    try {
      const re = new RegExp(`^(?:${atom})$`, PATTERN_FLAGS);
      return (ch: string) => re.test(ch);
    } catch {
      return () => true;
    }
  };
  const [x, y] = [test(a), test(b)];
  return [...SAMPLES, a, b, a.slice(1), b.slice(1)].some((ch) => x(ch) && y(ch));
}

/**
 * Whether a pattern can take exponential (or high-degree polynomial) time to fail: a group
 * that may repeat (`*`, `+`, `{n,}`, `{n}` or `{n,m}` past one) around a repetition or
 * alternatives of its own, as in `(a+)+`, `(a|aa)+` or `(a+){10}`; or three repeated atoms
 * in a row, each able to match what the one before it matches, as in `\d*\d*\d*` or
 * `.*a.*a.*` (an atom between them that the one before cannot match fixes where it ends,
 * as `-` does in `\d+-\d+-\d+`). Patterns a model wrote are refused when they are;
 * others run on bounded utterances only.
 */
export function exponential(source: string): boolean {
  // For each open group: whether it holds a repetition or alternatives.
  const groups: boolean[] = [];
  const quantifier = /^(?:[*+?]|\{\d+(?:,\d*)?\})/;
  /** Whether a quantifier lets its atom match more than once. */
  const repeats = (q: string | undefined) => {
    if (q === undefined || q === "?") return false;
    const bounds = /^\{(\d+)(,(\d*))?\}$/.exec(q);
    if (!bounds) return true;
    const most = bounds[2] === undefined ? bounds[1]! : bounds[3]!;
    return most === "" || Number(most) > 1;
  };
  // The repeated atoms in a row that can trade characters: the last one's class, and how many.
  let last: string | undefined;
  let chain = 0;
  /** An atom seen: a repeated one continues the row when it can match what the last one matches; another ends it unless the last one can match it. */
  const atom = (cls: string, repeated: boolean): boolean => {
    if (!repeated) {
      if (last !== undefined && !overlaps(last, cls)) [last, chain] = [undefined, 0];
      return false;
    }
    chain = last !== undefined && overlaps(last, cls) ? chain + 1 : 1;
    last = cls;
    return chain >= 3;
  };
  const mark = () => {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent; marking outside any group sets an index nothing reads
    if (groups.length > 0) groups[groups.length - 1] = true;
  };
  // Stryker disable next-line EqualityOperator: equivalent; one step past the end reads no character and no quantifier
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === "(") {
      groups.push(false);
      // A group's own syntax ((?:, (?=, (?<name>) is not an atom.
      i += /^\((?:\?(?:<[^>=!]*>|<?[=!]|:))?/.exec(source.slice(i))![0].length - 1;
      continue;
    }
    if (c === "|") {
      mark();
      [last, chain] = [undefined, 0];
      continue;
    }
    // The atom ends here: an escape is two characters, a class runs to its closing bracket.
    let end = i;
    if (c === "\\") end = i + 1;
    else if (c === "[") for (end = i + 1; end < source.length && source[end] !== "]"; end++) if (source[end] === "\\") end++;
    const q = quantifier.exec(source.slice(end + 1))?.[0];
    if (c === ")") {
      const inner = groups.pop() ?? false;
      if (inner && repeats(q)) return true;
      if (inner || q !== undefined) mark();
      // A repeated group may match anything, as far as the row goes.
      if (atom("[\\s\\S]", repeats(q))) return true;
    } else {
      if (q !== undefined) mark();
      if (atom(source.slice(i, end + 1), repeats(q))) return true;
    }
    // Stryker disable next-line LogicalOperator: equivalent; a quantifier read again as an atom can only mark a group its atom already marked
    i = end + (q?.length ?? 0);
  }
  return false;
}
