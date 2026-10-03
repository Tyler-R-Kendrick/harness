/**
 * Loop A, compile (inference to decision): recorded decisions become labelled examples
 * with provenance and a deterministic holdout, disagreements between rungs are mined, and
 * frequent structured decisions are induced into rules that answer at rung 0 once they
 * have passed shadow (the dialogue's chunking idea, one level up; ADR 0030).
 *
 * What counts as the right answer. A record's outcome says (`label`, or `correct` and the
 * kinds that mean right); with no outcome, only a later rung's action that was taken is
 * taken as right (the judge accepted it, or the generator made it; not an action that
 * exploration or the authority's floor put in its place). Everything else teaches nothing.
 * Rules are induced from these, and enter service only through the lifecycle's shadow
 * evidence (`shadowRules`, `lifecycleRule`), which is three-valued: an outcome can show a
 * rule right, show it wrong, or say nothing about it (`ruleFits`).
 */
import { probability } from "@harness/cognitive";
import type { Probability } from "@harness/cognitive";
import { z } from "zod";
import { evaluateCondition, getPath } from "./condition.ts";
import type { Condition } from "./condition.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { tookVerdict } from "./records.ts";
import { DecisionIdSchema, ForkIdSchema, JsonSchema } from "./types.ts";
import type { DecisionRecord, Json } from "./types.ts";

// ---- hashing and the holdout ----------------------------------------------------------------------------

/** FNV-1a, 32 bits, over the UTF-16 code units of the text: a stable, dependency-free hash. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The MurmurHash3 finalizer: spreads every input bit over the output, which FNV alone does not for short, similar texts like `dec-1`, `dec-2`. */
function avalanche(hash: number): number {
  let h = hash;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function assertShare(share: number): void {
  if (!(share >= 0 && share <= 1)) throw new RangeError(`a holdout share is from 0 to 1, got ${share}`);
}

/**
 * Which side of the holdout a decision is on: a stable hash (FNV-1a, then avalanche mixing) of its id and a salt, so a
 * record never moves between the two, whatever else is in the log. A share held out at
 * one value is held out at every larger one.
 */
export function holdoutSplit(id: string, share: number, salt = ""): "train" | "holdout" {
  assertShare(share);
  return avalanche(fnv1a32(`${salt}\0${id}`)) / 2 ** 32 < share ? "holdout" : "train";
}

/** JSON as text with object keys in sorted order, so equal values have equal text. */
export function stableJson(value: Json): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as readonly Json[]).map(stableJson).join(",")}]`;
  const object = value as { readonly [key: string]: Json };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key]!)}`)
    .join(",")}}`;
}

// ---- what was right --------------------------------------------------------------------------------------

const RIGHT_KINDS: ReadonlySet<string> = new Set(["correct", "approved", "completed", "rated-good"]);

/**
 * The action that was right for a decision, when that is known: the outcome's `label`; else
 * the decision's own action when the outcome says it was right (its `correct` flag, or a
 * kind that means right); with no outcome, the action of a later rung (the judge accepted
 * it, or the generator made it) when that is what was taken: an action that exploration chose
 * at random or the authority's floor raised was not accepted or made by the rung, so it
 * teaches nothing. Undefined when it is not known.
 */
export function correctActionOf(record: DecisionRecord): Json | undefined {
  const outcome = record.outcome;
  if (outcome === undefined) return (record.rung === "judge" || record.rung === "generator") && tookVerdict(record) ? record.action : undefined;
  if (outcome.label !== undefined) return outcome.label;
  return (outcome.correct ?? RIGHT_KINDS.has(outcome.kind)) ? record.action : undefined;
}

/** Outcome kinds that say the decision was wrong when nothing else does (`correct`, `label`). */
const WRONG_KINDS: ReadonlySet<string> = new Set(["incorrect", "failed", "rated-bad", "overridden"]);
/** Outcome kinds that say what a person did and, with no `correct` or `label`, nothing about whether the decision was right (approving a request that needs a look is not a verdict on its level). */
const SILENT_KINDS: ReadonlySet<string> = new Set(["approved", "denied"]);

/**
 * What a decision says about a rule that answered with `action` for its input, in three
 * values. `true`: it fits, the right action is known and is the rule's. `false`: it misses,
 * the right action is known and is another, or the outcome says the action taken was wrong
 * and that was the rule's action (a denial that is marked wrong, with no label to name what
 * would have been right). `undefined`: no evidence, the right action is not known and the
 * outcome does not say the rule's action was wrong (or says nothing at all).
 */
export function ruleFits(record: DecisionRecord, action: Json): boolean | undefined {
  const { outcome } = record;
  if (outcome !== undefined && outcome.label === undefined && outcome.correct === undefined && SILENT_KINDS.has(outcome.kind)) return undefined;
  const correct = correctActionOf(record);
  if (correct !== undefined) return stableJson(action) === stableJson(correct);
  if (outcome === undefined) return undefined;
  // Stryker disable next-line ConditionalExpression: equivalent; here the outcome has no label, and no `correct` only for a kind that is neither right (it would name the action above) nor silent (returned above), so every such kind is in WRONG_KINDS and `!outcome.correct` says the same; the set names them for a kind added later (DST2.19)
  const wrong = outcome.correct === undefined ? WRONG_KINDS.has(outcome.kind) : !outcome.correct;
  return wrong && stableJson(action) === stableJson(record.action) ? false : undefined;
}

// ---- examples -----------------------------------------------------------------------------------------------

export const ExampleSchema = z.strictObject({
  /** The decision and the question: `dec-7:risk`. */
  id: z.string().min(1),
  fork: ForkIdSchema,
  question: z.string().min(1),
  /** What the model was shown (the record's input). */
  state: JsonSchema,
  /** The question's options as the record's answer had them. */
  options: z.array(z.string()),
  label: z.string(),
  /** Where the label comes from: what became of the decision, or a later rung that settled it. */
  source: z.enum(["outcome", "escalation"]),
  weight: z.number().finite().min(0),
  split: z.enum(["train", "holdout"]),
  provenance: z.strictObject({
    decision: DecisionIdSchema,
    member: z.string().exactOptional(),
    memberVersion: z.string().exactOptional(),
    policy: z.string(),
  }),
});
export type Example = z.output<typeof ExampleSchema>;

export interface ExampleWeights {
  readonly outcome: number;
  readonly escalation: number;
}

/** An example from an outcome counts in full; one from a later rung's action, which nobody confirmed, counts half. */
export const DEFAULT_EXAMPLE_WEIGHTS: ExampleWeights = { outcome: 1, escalation: 0.5 };

export interface ExampleOptions {
  /** The label of a question for a record, one of the question's options, or undefined when there is none. */
  readonly labelOf: (record: DecisionRecord, question: string) => string | undefined;
  /** The share of decisions held out (0 to 1), by a stable hash of the decision id. */
  readonly holdout: number;
  /** Changes which decisions are held out. */
  readonly salt?: string;
  readonly weights?: ExampleWeights;
}

function assertWeight(weight: number): void {
  if (!(Number.isFinite(weight) && weight >= 0)) throw new RangeError(`a weight is finite and not negative, got ${weight}`);
}

/**
 * Labelled examples from decisions, one for each question a decision answered. A decision
 * gives examples only with an outcome, or when a later rung settled it (the judge or the
 * generator); the labeller may still decline a question. The split follows the decision id,
 * so all of a decision's questions are on one side.
 */
export function toExamples(records: readonly DecisionRecord[], options: ExampleOptions): Example[] {
  assertShare(options.holdout);
  const weights = options.weights ?? DEFAULT_EXAMPLE_WEIGHTS;
  assertWeight(weights.outcome);
  assertWeight(weights.escalation);
  const examples: Example[] = [];
  for (const record of records) {
    const source = record.outcome !== undefined ? "outcome" : record.rung === "judge" || record.rung === "generator" ? "escalation" : undefined;
    if (source === undefined) continue;
    for (const [question, answer] of Object.entries(record.answers)) {
      const label = options.labelOf(record, question);
      const choices = Object.keys(answer.distribution);
      // Stryker disable next-line ConditionalExpression: equivalent; no option is undefined, so the second test turns it away as well
      if (label === undefined || !choices.includes(label)) continue;
      examples.push({
        id: `${record.id}:${question}`,
        fork: record.fork,
        question,
        state: record.input,
        options: choices,
        label,
        source,
        weight: weights[source],
        split: holdoutSplit(record.id, options.holdout, options.salt),
        provenance: { decision: record.id, ...(record.member === undefined ? {} : { member: record.member }), ...(record.memberVersion === undefined ? {} : { memberVersion: record.memberVersion }), policy: record.policy },
      });
    }
  }
  return examples;
}

// ---- disagreements ---------------------------------------------------------------------------------------------

export interface Disagreement {
  readonly record: DecisionRecord;
  /** Who overruled the decision: what became of it, or the generator after the judge rejected the candidate. */
  readonly by: "outcome" | "generator";
  /** The overruling action, which is the label to learn. */
  readonly label: Json;
}

/**
 * Decisions whose cheap rung was overruled, with the overruling action. Overruled by the
 * outcome: an outcome gave the action that was right and it differs from the decision's.
 * Overruled by a later rung: the judge rejected a model's candidate and the generator
 * settled it (a decision the judge accepted, or a generator's that no judge rejected, does
 * not show that the cheap rung was wrong).
 */
export function mineDisagreements(records: readonly DecisionRecord[]): Disagreement[] {
  const found: Disagreement[] = [];
  for (const record of records) {
    const correct = correctActionOf(record);
    if (correct === undefined) continue;
    // With no outcome the right action is the record's own, so only a record with an outcome can differ from it.
    if (stableJson(correct) !== stableJson(record.action)) found.push({ record, by: "outcome", label: correct });
    else if (record.rung === "generator" && record.trace.some((step) => step.rung === "judge" && step.outcome === "rejected")) found.push({ record, by: "generator", label: correct });
  }
  return found;
}

// ---- JSON lines --------------------------------------------------------------------------------------------------

/** One JSON line for each example. */
export function examplesToJsonl(examples: readonly Example[]): string {
  return examples.map((example) => `${JSON.stringify(example)}\n`).join("");
}

export interface BadLine {
  /** 1-based. */
  readonly line: number;
  readonly reason: string;
}

/**
 * Examples from JSON lines. A line that is not an example is reported and skipped, not
 * fatal; a last line with no newline after it that is not JSON is taken to be cut short
 * (an interrupted write) and reported so.
 */
export function parseExamplesJsonl(text: string): { examples: Example[]; bad: BadLine[] } {
  const examples: Example[] = [];
  const bad: BadLine[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    if (raw.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(raw); // a line ending in a carriage return parses: JSON allows it as white space
    } catch (e) {
      bad.push({ line: index + 1, reason: index === lines.length - 1 ? "the last line is cut short" : `not JSON: ${(e as Error).message}` });
      return;
    }
    const parsed = ExampleSchema.safeParse(json);
    if (parsed.success) examples.push(parsed.data);
    else bad.push({ line: index + 1, reason: `not an example: ${z.prettifyError(parsed.error)}` });
  });
  return { examples, bad };
}

// ---- rule induction ------------------------------------------------------------------------------------------------

export interface InduceOptions {
  /** Only conditions over these dot paths (all paths when omitted). */
  readonly fields?: readonly string[];
  /** A rule covers at least this many records. */
  readonly minSupport: number;
  /** At least this share of the records a rule covers have the rule's action as the right one. */
  readonly minPurity: number;
  readonly maxRules: number;
  readonly maxConditions: 1 | 2;
}

export interface InducedRule {
  /** Stable from the condition: the same condition is always the same id. */
  readonly id: string;
  readonly when: Condition;
  readonly action: Json;
  /** How many of the records the condition covers. */
  readonly support: number;
  /** The share of those whose right action is `action`. */
  readonly purity: Probability;
}

/** Bounds on the search: values per string kept for prefixes, atoms kept for conjunctions, values in a set, and how deep inputs are flattened. */
const MAX_PREFIXES = 8;
const MAX_ATOMS = 256;
const MAX_SET = 16;
const MAX_TEXT = 256;
const MAX_DEPTH = 6;
const MAX_ITEMS = 16;
const DELIMITERS = new Set([" ", "/", "-", "_", ".", ":", "=", ",", ";"]);

type Scalar = string | number | boolean;

function flatten(value: Json, path: string, out: Map<string, Scalar>, depth: number): void {
  if (typeof value === "string") {
    if (path !== "" && value.length <= MAX_TEXT) out.set(path, value);
  } else if (typeof value === "number" || typeof value === "boolean") {
    if (path !== "") out.set(path, value);
  } else if (value !== null && depth < MAX_DEPTH) {
    const entries: [string, Json][] = Array.isArray(value) ? (value as readonly Json[]).slice(0, MAX_ITEMS).map((item, i) => [String(i), item]) : Object.entries(value as { readonly [key: string]: Json });
    for (const [key, item] of entries) if (key !== "" && !key.includes(".")) flatten(item, path === "" ? key : `${path}.${key}`, out, depth + 1);
  }
}

interface Row {
  readonly action: Json;
  readonly key: string;
  /** The values the atoms are made from (bounded: long texts and deep or long structures are left out). */
  readonly flat: Map<string, Scalar>;
  /** The input as a rule meets it: what a rule covers is what it matches here, not only in `flat`. */
  readonly input: Json;
}

interface Atom {
  readonly path: string;
  readonly when: Condition;
  readonly text: string;
  /** Rows covered, ascending. */
  readonly cover: readonly number[];
}

const intersect = (a: readonly number[], b: readonly number[]): number[] => {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]! < b[j]!) i++;
    else if (a[i]! > b[j]!) j++;
    else {
      out.push(a[i]!);
      i++;
      j++;
    }
  }
  return out;
};

const union = (lists: readonly (readonly number[])[]): number[] => [...new Set(lists.flat())].sort((a, b) => a - b);

function assertOptions(o: InduceOptions): void {
  if (!Number.isInteger(o.minSupport) || o.minSupport < 1) throw new RangeError(`minSupport is a whole number from 1, got ${o.minSupport}`);
  if (!(o.minPurity >= 0 && o.minPurity <= 1)) throw new RangeError(`minPurity is from 0 to 1, got ${o.minPurity}`);
  if (!Number.isInteger(o.maxRules) || o.maxRules < 0) throw new RangeError(`maxRules is a whole number from 0, got ${o.maxRules}`);
  if (o.maxConditions !== 1 && o.maxConditions !== 2) throw new RangeError(`maxConditions is 1 or 2, got ${String(o.maxConditions)}`);
}

/**
 * The atoms (single tests) over one path: equalities on values that repeat, sets of such strings that agree on an
 * action, and prefixes at word boundaries. Only for a path where some value repeats. Atoms that cover the same rows
 * are one atom, the first made: an equality, else a set, else the shortest prefix.
 */
function atomsOf(path: string, rows: readonly Row[], options: InduceOptions): Atom[] {
  const byValue = new Map<string, { value: Scalar; rows: number[] }>();
  rows.forEach((row, index) => {
    const value = row.flat.get(path);
    if (value === undefined) return;
    const entry = byValue.get(JSON.stringify(value)) ?? { value, rows: [] };
    entry.rows.push(index);
    byValue.set(JSON.stringify(value), entry);
  });
  // Stryker disable next-line EqualityOperator: equivalent; the values are the distinct keys of a map, so two never have the same text
  const values = [...byValue.values()].sort((a, b) => b.rows.length - a.rows.length || (JSON.stringify(a.value) < JSON.stringify(b.value) ? -1 : 1));
  const repeating = values.filter((v) => v.rows.length >= 2);
  if (repeating.length === 0) return [];
  const atoms: Atom[] = [];
  const add = (when: Condition, cover: readonly number[]) => {
    if (cover.length >= Math.max(2, options.minSupport)) atoms.push({ path, when, text: stableJson(when as unknown as Json), cover });
  };
  for (const v of repeating) add({ eq: [path, v.value] }, v.rows);

  // Sets: strings that repeat and each mostly predict the same action. (A set of one covers what its equality does, and is not made twice.)
  const strings = repeating.filter((v): v is { value: string; rows: number[] } => typeof v.value === "string");
  for (const action of new Set(rows.map((r) => r.key))) {
    const agreeing = strings.filter((v) => v.rows.filter((i) => rows[i]!.key === action).length / v.rows.length >= options.minPurity).slice(0, MAX_SET);
    add({ in: [path, agreeing.map((v) => v.value).sort()] }, union(agreeing.map((v) => v.rows)));
  }

  // Texts at the path that are too long to be offered as values: an equality or a set cannot match them, but a prefix does, and a rule covers what it matches.
  const longs: { readonly index: number; readonly text: string }[] = [];
  rows.forEach((row, index) => {
    const text = row.flat.has(path) ? undefined : getPath(row.input, path);
    if (typeof text === "string") longs.push({ index, text });
  });

  // Prefixes at word boundaries, from every string at the path (also the ones that occur once), each covering every string that starts with it, however long.
  const prefixes = new Map<string, number[][]>();
  for (const v of values) {
    const text = v.value;
    // Stryker disable next-line ConditionalExpression: equivalent; a number or a boolean has no characters, so the loop below makes no prefix
    if (typeof text !== "string") continue;
    let kept = 0;
    for (const [k, character] of text.slice(1, -1).split("").entries()) {
      if (kept === MAX_PREFIXES) break;
      if (!DELIMITERS.has(character)) continue;
      const prefix = text.slice(0, k + 2);
      prefixes.set(prefix, [...(prefixes.get(prefix) ?? []), v.rows]);
      kept += 1;
    }
  }
  for (const [prefix, lists] of prefixes) {
    const own = byValue.get(JSON.stringify(prefix)); // a string that is the prefix itself starts with it too
    const reached = longs.filter((long) => long.text.startsWith(prefix)).map((long) => long.index);
    add({ prefix: [path, prefix] }, union([...lists, ...(own === undefined ? [] : [own.rows]), reached]));
  }

  const best = new Map<string, Atom>();
  for (const atom of atoms) if (!best.has(JSON.stringify(atom.cover))) best.set(JSON.stringify(atom.cover), atom);
  return [...best.values()];
}

const idOf = (when: Condition): string => {
  const text = stableJson(when as unknown as Json);
  return `rule-${fnv1a32(text).toString(16).padStart(8, "0")}${fnv1a32(`${text}\u0001`).toString(16).padStart(8, "0")}`;
};

/**
 * Rules induced from decisions whose right action is known: conditions over the inputs
 * (flattened to dot paths; equality on strings, numbers and booleans, sets and prefixes on
 * strings) with `support` records covered and `purity` of them agreeing on the action, at
 * least `minSupport` and `minPurity`. A test on a value that occurs once is never made
 * (an id or a timestamp cannot be a rule), simpler conditions and wider ones are preferred,
 * and ties go to the smaller id. Support and purity are what the rule's condition matches in
 * the inputs as they are (the search is over a bounded view of them: texts over `MAX_TEXT`
 * characters are not offered as values, but a prefix is matched against them in full).
 * A rule is a candidate: it enters service only through the lifecycle.
 */
export function induceRules(records: readonly DecisionRecord[], options: InduceOptions): InducedRule[] {
  assertOptions(options);
  const rows: Row[] = [];
  for (const record of records) {
    const action = correctActionOf(record);
    if (action === undefined) continue;
    const flat = new Map<string, Scalar>();
    flatten(record.input, "", flat, 0);
    rows.push({ action, key: stableJson(action), flat, input: record.input });
  }
  const wanted = options.fields === undefined ? undefined : new Set(options.fields);
  const paths = [...new Set(rows.flatMap((r) => [...r.flat.keys()]))].filter((p) => wanted === undefined || wanted.has(p));
  const everyAtom = paths.flatMap((path) => atomsOf(path, rows, options));
  // Stryker disable next-line EqualityOperator: equivalent; two atoms never have the same text (they differ in path, kind or value)
  everyAtom.sort((a, b) => b.cover.length - a.cover.length || (a.text < b.text ? -1 : 1));
  const pool = everyAtom.slice(0, MAX_ATOMS);

  interface Candidate {
    readonly when: Condition;
    readonly conditions: number;
    readonly cover: readonly number[];
    readonly key: string;
    readonly action: Json;
    readonly agree: number;
  }
  const candidates: Candidate[] = [];
  const consider = (when: Condition, conditions: number, cover: readonly number[]) => {
    if (cover.length < options.minSupport) return;
    const counts = new Map<string, number>();
    for (const i of cover) counts.set(rows[i]!.key, (counts.get(rows[i]!.key) ?? 0) + 1);
    // Stryker disable next-line EqualityOperator: equivalent; the actions are the distinct keys of a map, so two never have the same text
    const [key, agree] = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
    if (agree / cover.length < options.minPurity) return;
    candidates.push({ when, conditions, cover, key, action: rows.find((r) => r.key === key)!.action, agree });
  };
  for (const atom of pool) consider(atom.when, 1, atom.cover);
  if (options.maxConditions === 2) {
    for (const [i, a] of pool.entries()) {
      // Stryker disable next-line MethodExpression: equivalent; a pair met again the other way round is the same rule (its conditions are put in order), which the choice of rules drops
      for (const b of pool.slice(i + 1)) {
        // Stryker disable next-line ConditionalExpression: equivalent; two tests on one path, whose rows nest or are apart or are a set's values, only make a rule that a single test of that path (or the set) already makes
        if (a.path === b.path) continue;
        // Stryker disable next-line EqualityOperator: equivalent; the two atoms are on different paths, so their texts are never equal
        const [first, second] = a.text < b.text ? [a, b] : [b, a];
        consider({ all: [first.when, second.when] }, 2, intersect(a.cover, b.cover));
      }
    }
  }

  const ranked = candidates.map((c) => ({ ...c, id: idOf(c.when), support: c.cover.length, purity: c.agree / c.cover.length }));
  // Stryker disable next-line EqualityOperator: equivalent; a condition has one id, and two conditions that read the same are one
  ranked.sort((a, b) => a.conditions - b.conditions || b.support - a.support || b.purity - a.purity || (a.id < b.id ? -1 : 1));

  // One rule for each set of rows and action, and none that only repeats a wider rule with the same action.
  const chosen: ((typeof ranked)[number] & { readonly covered: ReadonlySet<number> })[] = [];
  for (const c of ranked) {
    if (chosen.length >= options.maxRules) break;
    if (!chosen.some((k) => k.key === c.key && c.cover.every((i) => k.covered.has(i)))) chosen.push({ ...c, covered: new Set(c.cover) });
  }
  return chosen.map((c) => ({ id: c.id, when: c.when, action: c.action, support: c.support, purity: probability(c.purity) }));
}

/** The rules as a function of the input: the action of the first rule whose condition holds, in order, or undefined. For `Fork.rule`. */
export function compileRules(rules: readonly InducedRule[]): (input: Json) => Json | undefined {
  return (input) => rules.find((rule) => evaluateCondition(rule.when, input))?.action;
}

// ---- rules and the lifecycle -----------------------------------------------------------------------------------------

/** The distinct sessions the records come from: what to pass as `builtFrom` for rules induced from them. */
export function sessionsOf(records: readonly DecisionRecord[]): string[] {
  return [...new Set(records.flatMap((r) => (r.session === undefined ? [] : [r.session])))];
}

/**
 * Shadow rules on decisions: each rule is added to the lifecycle as a candidate (a key
 * that is known is left as it is), and every decision whose input a rule covers and whose
 * right action is known is evidence, a fit when the rule's action is the right one. Pass
 * `builtFrom`, the sessions the rules were induced from: their evidence does not count; and
 * `builtFromDecisions`, the ids of decisions they were induced from that have no session
 * (a decision made over the wire has none, and so is nobody's training session): nor does
 * theirs. Evidence is three-valued (`ruleFits`): a decision that does not say, one way or
 * the other, whether the rule's action was right is not evidence. Returns how much
 * evidence was counted.
 */
export function shadowRules(
  lifecycle: Lifecycle<string>,
  rules: readonly InducedRule[],
  records: readonly DecisionRecord[],
  options: { readonly builtFrom: readonly string[]; readonly builtFromDecisions?: readonly string[] },
): { readonly observed: number } {
  for (const rule of rules) lifecycle.add(rule.id, { origin: "induced", builtFrom: options.builtFrom });
  const built = new Set(options.builtFromDecisions);
  let observed = 0;
  for (const record of records) {
    if (built.has(record.id)) continue;
    for (const rule of rules) {
      if (!evaluateCondition(rule.when, record.input)) continue;
      const fit = ruleFits(record, rule.action);
      if (fit === undefined) continue;
      const seen = lifecycle.observe(rule.id, { fit, session: record.session });
      if (seen.counted) observed += 1;
    }
  }
  return { observed };
}

/**
 * The rules that have earned it, as a function for `Fork.rule`: the action of the first
 * active rule that covers the input, in order. A use is counted, and every n-th use is an
 * audit, in which the rule does not answer, so that a model does and the decision can be
 * checked against the rule (`shadowRules` on the records). Shadowed and retired rules never answer.
 */
export function lifecycleRule(lifecycle: Lifecycle<string>, rules: readonly InducedRule[]): (input: Json) => Json | undefined {
  return (input) => {
    for (const rule of rules) {
      if (lifecycle.state(rule.id) !== "active" || !evaluateCondition(rule.when, input)) continue;
      return lifecycle.use(rule.id).answer ? rule.action : undefined;
    }
    return undefined;
  };
}
