/**
 * Loop E, meta: the questions a fork asks are data (their instructions and the criteria
 * text of each option), a proposer edits that text, and an edit is kept only if replaying
 * recorded decisions shows it is better on decisions the proposer never saw.
 *
 * The outer layer is frozen. The evolver's inputs do not include the authority, the
 * policy's thresholds, the holdout split (its share and salt come from the host) or the
 * evaluation (a paired sign-flip test, exact up to `EXACT_LIMIT` non-zero differences and sampled beyond, which each archived summary says, and a lower confidence bound); an `Edit` can
 * only name a question's instructions or one criterion's text, and anything else a
 * proposer returns is screened out. A candidate is accepted only if the paired test on the
 * held-out decisions is significant and the lower bound of the mean gain clears a minimum;
 * every attempt, kept or not, is archived so that any accepted version can be rolled back to.
 */
import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { z } from "zod";
import { fnv1a32, holdoutSplit, stableJson } from "./distill.ts";
import { DecisionError, ForkIdSchema } from "./types.ts";
import type { DecisionRecord, Fork, ForkId, Json, JudgeQuestion, Member, Verdict } from "./types.ts";

// ---- criteria: the text a fork's questions are made of ---------------------------------------------------------

const text = z.string().min(1);
const described = z.string().nullable();

/** One question's text: its instructions and the criteria (what each option, level or truth value means). */
export const QuestionCriteriaSchema = z.union([
  z.strictObject({ type: z.literal("boolean"), instructions: text, criteria: z.strictObject({ true: described.exactOptional(), false: described.exactOptional() }) }),
  z.strictObject({ type: z.literal("choice"), instructions: text, criteria: z.record(z.string(), described) }),
  z.strictObject({ type: z.literal("score"), instructions: text, criteria: z.array(described) }),
]);
export type QuestionCriteria = z.output<typeof QuestionCriteriaSchema>;

/** The text of every question of a fork, at a version. */
export const CriteriaBookSchema = z.strictObject({
  $schema: z.string().exactOptional(),
  fork: ForkIdSchema,
  version: text,
  questions: z.record(z.string(), QuestionCriteriaSchema),
});
export type CriteriaBook = z.output<typeof CriteriaBookSchema>;

/** The criteria a fork's questions have now, read from what it asks about a sample input. */
export function criteriaFromFork<In, Act>(fork: Fork<In, Act>, sample: In, version: string): CriteriaBook {
  const questions = Object.fromEntries(
    Object.entries(fork.ask(sample).questions).map(([id, q]): [string, QuestionCriteria] => {
      if (q.type === "boolean") return [id, { type: "boolean", instructions: q.instructions, criteria: { ...(q.criteria?.true === undefined ? {} : { true: q.criteria.true }), ...(q.criteria?.false === undefined ? {} : { false: q.criteria.false }) } }];
      if (q.type === "choice") return [id, { type: "choice", instructions: q.instructions, criteria: { ...q.criteria } }];
      return [id, { type: "score", instructions: q.instructions, criteria: [...q.criteria] }];
    }),
  );
  return CriteriaBookSchema.parse({ fork: fork.id, version, questions });
}

function substitute(id: string, question: JudgeQuestion, criteria: QuestionCriteria): JudgeQuestion {
  if (question.type === "choice" && criteria.type === "choice") {
    const options = Object.keys(question.criteria);
    const named = Object.keys(criteria.criteria);
    if (options.length !== named.length || !options.every((o) => named.includes(o))) throw new RangeError(`criteria for "${id}" name the options [${named.join(", ")}] but the question has [${options.join(", ")}]`);
    return { type: "choice", instructions: criteria.instructions, criteria: Object.fromEntries(options.map((o) => [o, criteria.criteria[o]!])) };
  }
  if (question.type === "score" && criteria.type === "score") {
    if (criteria.criteria.length !== question.criteria.length) throw new RangeError(`criteria for "${id}" have ${criteria.criteria.length} levels but the question has ${question.criteria.length}`);
    return { type: "score", instructions: criteria.instructions, criteria: [...criteria.criteria] };
  }
  if (question.type === "boolean" && criteria.type === "boolean") return { type: "boolean", instructions: criteria.instructions, criteria: { ...criteria.criteria } };
  throw new RangeError(`criteria for "${id}" are for a ${criteria.type} question but the fork asks a ${question.type} one`);
}

/**
 * The fork with the questions' instructions and criteria text replaced by the book's, for
 * the questions the book names. Everything else about the fork (how answers become an
 * action, its floor, rule and verify, its records) is the fork's own, untouched. A book
 * that does not fit the question (another type, other options, another number of levels)
 * is refused: what the options are is not for the evolver to change.
 */
export function withCriteria<In, Act>(fork: Fork<In, Act>, criteria: CriteriaBook): Fork<In, Act> {
  if (criteria.fork !== fork.id) throw new RangeError(`criteria are for "${criteria.fork}", not for "${fork.id}"`);
  return {
    ...fork,
    version: `${fork.version}+criteria-${criteria.version}`,
    ask: (input) => {
      const asked = fork.ask(input);
      return { state: asked.state, questions: Object.fromEntries(Object.entries(asked.questions).map(([id, q]) => [id, criteria.questions[id] === undefined ? q : substitute(id, q, criteria.questions[id])])) };
    },
  };
}

// ---- edits ---------------------------------------------------------------------------------------------------------

/** A change to one question's text: its instructions, or the criterion of one option, level or truth value. Nothing else can be said. */
export const EditSchema = z.strictObject({ question: text, target: z.string().regex(/^(?:instructions|criteria:.+)$/, "instructions, or criteria: and an option, level or true or false"), text });
export type Edit = z.output<typeof EditSchema>;

/** Why an edit cannot be applied to the book, or undefined when it can. */
function problemWith(book: CriteriaBook, edit: Edit): string | undefined {
  const question = book.questions[edit.question];
  if (question === undefined) return `no question "${edit.question}" in the criteria`;
  if (edit.target === "instructions") return undefined;
  const key = edit.target.slice("criteria:".length);
  if (question.type === "boolean") return key === "true" || key === "false" ? undefined : `a boolean question's criteria are true and false, not "${key}"`;
  if (question.type === "score") return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < question.criteria.length ? undefined : `no level "${key}": the question has levels 0 to ${question.criteria.length - 1}`;
  return Object.hasOwn(question.criteria, key) ? undefined : `no option "${key}" in the question`;
}

/** The book with the edits applied in order (a later edit to the same text wins). The edits must fit the book. */
export function applyEdits(book: CriteriaBook, edits: readonly Edit[], version: string): CriteriaBook {
  const questions: Record<string, QuestionCriteria> = copyBook(book).questions;
  for (const edit of edits) {
    const problem = problemWith(book, edit);
    if (problem !== undefined) throw new RangeError(problem);
    const question = questions[edit.question]!;
    // The copy is the edit's own to change. A score's criteria are an array, which takes a level written as text just as it takes a number.
    if (edit.target === "instructions") question.instructions = edit.text;
    else (question.criteria as Record<string, string | null | undefined>)[edit.target.slice("criteria:".length)] = edit.text;
  }
  return { ...book, version, questions };
}

function copyQuestion(q: QuestionCriteria): QuestionCriteria {
  return q.type === "score" ? { ...q, criteria: [...q.criteria] } : { ...q, criteria: { ...q.criteria } };
}

/** A book that shares nothing with the one given. */
function copyBook(book: CriteriaBook): CriteriaBook {
  return { ...book, questions: Object.fromEntries(Object.entries(book.questions).map(([id, q]) => [id, copyQuestion(q)])) };
}

// ---- screening edits --------------------------------------------------------------------------------------------------

// Stryker disable next-line MethodExpression: equivalent; upper case is as good as lower case when both sides are folded the same way
const wordsOf = (t: string): string[] => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Every string inside a JSON value, at any depth (not the keys). */
const stringsOf = (value: Json): string[] => (typeof value === "string" ? [value] : value === null ? [] : Object.values(value).flatMap(stringsOf));

/** Every run of `words` consecutive words in the text (lower case, punctuation ignored), each as one string (none when the text has fewer). */
function runsOf(t: string, words: number): string[] {
  const all = wordsOf(t);
  return Array.from({ length: Math.max(0, all.length - words + 1) }, (_, i) => all.slice(i, i + words).join(" "));
}

export interface ScreenOptions {
  readonly book: CriteriaBook;
  /**
   * What the held-out decisions showed the model: an edit may not repeat a run of `leakWords`
   * of their words, nor all the words of a string of theirs that has fewer than that (but at
   * least two: one word is vocabulary, and criteria must be able to name a kind of input).
   */
  readonly heldOut: readonly Json[];
  readonly maxEdits: number;
  readonly maxEditChars: number;
  readonly leakWords: number;
}

export interface Screened {
  readonly kept: Edit[];
  readonly rejected: { readonly edit: unknown; readonly reason: string }[];
}

/**
 * What of a proposer's answer may be applied: edits of the shape `Edit` (nothing else can
 * be said, so nothing about the authority, the policy, the holdout or the evaluation), that
 * name a question and a criterion the book has, that are not empty or long, that do not
 * repeat a verbatim run of `leakWords` words from a held-out input (or all of a shorter
 * string of two words or more), and no more than `maxEdits` of them.
 */
export function screenEdits(proposed: readonly unknown[], options: ScreenOptions): Screened {
  // A run is kept with its length: a short string leaks as a whole, a long one by any run of `leakWords` words. One word is vocabulary, not a leak (unless a single word is all the leak size asks): runs shorter than `shortest` are kept but never looked up.
  const shortest = Math.min(2, options.leakWords);
  const seen = new Set(
    options.heldOut.flatMap((input) =>
      stringsOf(input).flatMap((t) => {
        const n = Math.min(options.leakWords, wordsOf(t).length);
        return runsOf(t, n).map((run) => `${n}:${run}`);
      }),
    ),
  );
  /** The length of a run of the text's words that a held-out string leaked, or undefined. */
  const leakedRun = (t: string): number | undefined => {
    for (let n = shortest; n <= options.leakWords; n++) if (runsOf(t, n).some((run) => seen.has(`${n}:${run}`))) return n;
    return undefined;
  };
  const kept: Edit[] = [];
  const rejected: { edit: unknown; reason: string }[] = [];
  for (const candidate of proposed) {
    const parsed = EditSchema.safeParse(candidate);
    const reject = (reason: string) => void rejected.push({ edit: candidate, reason });
    if (!parsed.success) reject(`not an edit of a question's instructions or criteria: ${z.prettifyError(parsed.error)}`);
    else if (kept.length >= options.maxEdits) reject(`more than ${options.maxEdits} edits`);
    else if (parsed.data.text.length > options.maxEditChars) reject(`longer than ${options.maxEditChars} characters`);
    else if (problemWith(options.book, parsed.data) !== undefined) reject(problemWith(options.book, parsed.data)!);
    else if (leakedRun(parsed.data.text) !== undefined) reject(`repeats ${leakedRun(parsed.data.text)} words in a row from a held-out input`);
    else kept.push(parsed.data);
  }
  return { kept, rejected };
}

// ---- statistics ---------------------------------------------------------------------------------------------------------

/** A small deterministic generator (Mulberry32): uniform draws in [0, 1) from a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** The most non-zero differences the test enumerates: 2^20 sign patterns. */
export const EXACT_LIMIT = 20;
/** Resamples of the Monte Carlo test, unless given. */
export const DEFAULT_RESAMPLES = 10_000;

export interface SignFlipOptions {
  /** The significance level: the test is `significant` when the p-value is at most this. */
  readonly alpha: number;
  /** Uniform draws in [0, 1) for the Monte Carlo test; by default a generator seeded from the data. */
  readonly rng?: () => number;
  readonly resamples?: number;
}

export interface SignFlipResult {
  /** The chance, if the sign of each difference were random, of a sum at least as large as the one seen (one-sided: better than 0). */
  readonly pValue: number;
  /** The mean of all the differences, zeros included. */
  readonly meanDiff: number;
  readonly significant: boolean;
  /** How many differences were not zero. */
  readonly n: number;
  /** Whether every sign pattern was counted (up to `EXACT_LIMIT` non-zero differences) or the p-value was sampled. */
  readonly exact: boolean;
}

/**
 * The paired sign-flip randomization test that the paired differences are better than
 * zero. Under the null each difference is as likely to be positive as negative, so the p-value
 * is the share of the 2^n sign patterns (of the n non-zero differences) whose sum is at
 * least the observed sum: counted exactly for up to 20, and beyond that estimated from
 * random patterns with a generator seeded from the data (so the same data always gives
 * the same answer): (1 + patterns at least as large) / (1 + resamples).
 */
export function pairedSignFlipTest(diffs: readonly number[], options: SignFlipOptions): SignFlipResult {
  const { alpha } = options;
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha is between 0 and 1, got ${alpha}`);
  for (const d of diffs) if (!Number.isFinite(d)) throw new RangeError(`a difference is a finite number, got ${d}`);
  const meanDiff = diffs.length === 0 ? 0 : diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const magnitudes = diffs.filter((d) => d !== 0).map(Math.abs);
  const n = magnitudes.length;
  const observed = diffs.reduce((a, b) => a + b, 0);
  const total = magnitudes.reduce((a, b) => a + b, 0);
  const slack = 1e-9 * Math.max(1, total);
  // Stryker disable next-line EqualityOperator: equivalent; the bound is the observed sum less a slack above zero, so a sum exactly at it cannot be told from one just above
  const reaches = (sum: number): boolean => sum >= observed - slack;
  let pValue: number;
  let exact = true;
  if (n <= EXACT_LIMIT) {
    // Every sign pattern: bit k of the mask set flips the sign of the k-th magnitude.
    const patterns = 2 ** n;
    let atLeast = 0;
    for (let mask = 0; mask < patterns; mask++) {
      let flipped = 0;
      for (let k = 0; k < n; k++) flipped += magnitudes[k]! * ((mask >> k) & 1);
      if (reaches(total - 2 * flipped)) atLeast += 1;
    }
    pValue = atLeast / patterns;
  } else {
    exact = false;
    const rng = options.rng ?? mulberry32(fnv1a32(stableJson([...diffs])));
    const resamples = options.resamples ?? DEFAULT_RESAMPLES;
    let atLeast = 0;
    for (let r = 0; r < resamples; r++) {
      let sum = 0;
      for (const m of magnitudes) sum += rng() < 0.5 ? m : -m;
      if (reaches(sum)) atLeast += 1;
    }
    pValue = (1 + atLeast) / (1 + resamples);
  }
  return { pValue, meanDiff, significant: pValue <= alpha, n, exact };
}

const ACKLAM_A = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239] as const;
const ACKLAM_B = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572] as const;
const ACKLAM_C = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783] as const;
const ACKLAM_D = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416] as const;

/** The standard normal quantile (Acklam's rational approximation, relative error about 1e-9). */
export function standardNormalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`a quantile is of a probability strictly between 0 and 1, got ${p}`);
  const [a1, a2, a3, a4, a5, a6] = ACKLAM_A;
  const [b1, b2, b3, b4, b5] = ACKLAM_B;
  const [c1, c2, c3, c4, c5, c6] = ACKLAM_C;
  const [d1, d2, d3, d4] = ACKLAM_D;
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) / ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) / ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q) / (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
}

/**
 * The lower end of a one-sided (1 - alpha) confidence interval for the mean of the paired
 * differences (normal approximation: mean minus z standard errors); null with fewer than two,
 * where there is no spread to go by.
 */
export function gainLowerBound(diffs: readonly number[], alpha: number): number | null {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha is between 0 and 1, got ${alpha}`);
  const n = diffs.length;
  if (n < 2) return null;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1);
  return mean - standardNormalQuantile(1 - alpha) * Math.sqrt(variance / n);
}

// ---- replaying decisions ------------------------------------------------------------------------------------------------

export interface LabelledExample<In> {
  readonly input: In;
  /** The action that was right. */
  readonly expected: Json;
}

export interface Replayed {
  readonly correct: boolean;
  /** The action the fork came to, or null when it did not (the member or interpretation failed, or the answers did not separate the options). */
  readonly got: Json | null;
}

/**
 * Replay labelled examples through a member with the fork's questions (its criteria
 * replaced by the book's) and interpretation, applying the fork's floor as a decision does.
 * An example is correct when the action it comes to is the expected one; a member,
 * question or interpretation that fails is incorrect.
 */
export async function replayCriteria<In, Act extends Json>(options: { readonly fork: Fork<In, Act>; readonly criteria: CriteriaBook; readonly member: Member; readonly examples: readonly LabelledExample<In>[] }): Promise<Replayed[]> {
  const fork = withCriteria(options.fork, options.criteria);
  const decide = async (input: In): Promise<Act | undefined> => {
    let verdict: Verdict<Act> | undefined;
    // Stryker disable BlockStatement: equivalent; without the handler's return the verdict is still undefined and the next line gives the same answer
    try {
      verdict = fork.interpret(await options.member.ask(fork.ask(input)), input);
    } catch {
      return undefined;
    }
    // Stryker restore BlockStatement
    if (verdict === undefined) return undefined;
    const floor = fork.floor?.(input);
    return floor !== undefined && fork.restrictiveness !== undefined && fork.restrictiveness(floor) > fork.restrictiveness(verdict.action) ? floor : verdict.action;
  };
  const replayed: Replayed[] = [];
  for (const example of options.examples) {
    const action = await decide(example.input);
    replayed.push(action === undefined ? { correct: false, got: null } : { correct: stableJson(action) === stableJson(example.expected), got: action });
  }
  return replayed;
}

/** Whether each labelled example comes out right (see `replayCriteria`). */
export async function evaluateCriteria<In, Act extends Json>(options: { readonly fork: Fork<In, Act>; readonly criteria: CriteriaBook; readonly member: Member; readonly examples: readonly LabelledExample<In>[] }): Promise<boolean[]> {
  return (await replayCriteria(options)).map((r) => r.correct);
}

// ---- the archive ------------------------------------------------------------------------------------------------------------------

export const EvaluationSummarySchema = z.strictObject({
  /** Held-out decisions the two were compared on. */
  n: z.int().min(0),
  /** The share of them each got right. */
  incumbent: z.number().min(0).max(1),
  candidate: z.number().min(0).max(1),
  meanDiff: z.number().min(-1).max(1),
  /** The lower confidence bound of the mean gain; null when it could not be worked out. */
  lower: z.number().nullable(),
  pValue: z.number().min(0).max(1),
  /** Whether the p-value counts every sign pattern (up to `EXACT_LIMIT` non-zero differences) or was sampled; absent in a summary saved before this was kept. */
  exact: z.boolean().exactOptional(),
  accepted: z.boolean(),
  reason: z.string(),
});
export type EvaluationSummary = z.output<typeof EvaluationSummarySchema>;

export const ArchiveEntrySchema = z.strictObject({
  fork: ForkIdSchema,
  version: text,
  /** The version this was made from; none for the first. */
  parent: text.exactOptional(),
  criteria: CriteriaBookSchema,
  /** The edits that made it from its parent. */
  edits: z.array(EditSchema),
  /** How it compared with its parent; none for a version that was not made by an attempt. */
  summary: EvaluationSummarySchema.exactOptional(),
  status: z.enum(["active", "retired"]),
});
export type ArchiveEntry = z.output<typeof ArchiveEntrySchema>;

const FORMAT = "harness.decision.criteria/v1";
const ArchiveSnapshotSchema = z.strictObject({ format: z.literal(FORMAT), entries: z.array(ArchiveEntrySchema) });

/** What is wrong with a saved archive's versions, each with where: a version twice, a parent that is not an earlier version of the fork, a fork without exactly one active version. */
function archiveProblems(entries: readonly ArchiveEntry[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    const key = `${e.fork}@${e.version}`;
    if (seen.has(key)) problems.push(`entries[${i}].version: version ${e.version} of ${e.fork} appears twice`);
    seen.add(key);
    if (e.parent !== undefined && !entries.slice(0, i).some((p) => p.fork === e.fork && p.version === e.parent)) problems.push(`entries[${i}].parent: parent ${e.parent} is not an earlier version of ${e.fork}`);
  });
  for (const fork of new Set(entries.map((e) => e.fork))) {
    const active = entries.filter((e) => e.fork === fork && e.status === "active").length;
    if (active !== 1) problems.push(`entries: ${fork} has ${active} active versions, not one`);
  }
  return problems;
}

/** The past of an attempt, for a proposer: what was tried and how it fared. */
export interface LedgerEntry {
  readonly version: string;
  readonly parent: string | undefined;
  readonly edits: readonly Edit[];
  readonly accepted: boolean;
  readonly meanDiff: number;
  readonly pValue: number;
  readonly reason: string;
}

/**
 * The criteria of each fork, versioned: every attempt to improve them (kept or not) with its
 * edits and how it compared with its parent, one version active at a time, and rollback to any
 * version that was ever active.
 */
export class CriteriaArchive {
  #entries: ArchiveEntry[] = [];

  /** The first version of a fork's criteria, active. Refused when the fork already has versions. */
  seed(criteria: CriteriaBook): ArchiveEntry {
    if (this.history(criteria.fork).length > 0) throw new DecisionError("invalid", `${criteria.fork} already has criteria versions`);
    const entry: ArchiveEntry = { fork: criteria.fork, version: criteria.version, criteria, edits: [], status: "active" };
    this.#entries.push(entry);
    return entry;
  }

  /** The next version name for a fork: `v` and the number of versions it has, or the next number up if that name is taken. */
  nextVersion(fork: ForkId): string {
    let n = this.history(fork).length;
    while (this.#find(fork, `v${n}`) !== undefined) n += 1;
    return `v${n}`;
  }

  /**
   * Record an attempt: a version made from the active one by edits, and how it compared. An
   * accepted attempt becomes the active version (the one it replaces is retired); one that was
   * not accepted is kept, retired, so that it is not tried again.
   */
  attempt(entry: { readonly criteria: CriteriaBook; readonly edits: readonly Edit[]; readonly summary: EvaluationSummary }): ArchiveEntry {
    const { criteria } = entry;
    const parent = this.active(criteria.fork);
    if (parent === undefined) throw new DecisionError("invalid", `${criteria.fork} has no criteria to make an attempt from`);
    if (this.#find(criteria.fork, criteria.version) !== undefined) throw new DecisionError("invalid", `version ${criteria.version} of ${criteria.fork} exists`);
    const made: ArchiveEntry = { fork: criteria.fork, version: criteria.version, parent: parent.version, criteria, edits: [...entry.edits], summary: entry.summary, status: entry.summary.accepted ? "active" : "retired" };
    if (entry.summary.accepted) this.#entries = this.#entries.map((e) => (e.fork === criteria.fork ? { ...e, status: "retired" as const } : e));
    this.#entries.push(made);
    return made;
  }

  /** The active version of a fork's criteria. */
  active(fork: ForkId): ArchiveEntry | undefined {
    return this.#entries.find((e) => e.fork === fork && e.status === "active");
  }

  /** Every version of a fork's criteria, in the order made, attempts that were not accepted included. */
  history(fork: ForkId): ArchiveEntry[] {
    return this.#entries.filter((e) => e.fork === fork);
  }

  /** The attempts on a fork's criteria, oldest first, as a proposer is shown them. */
  ledger(fork: ForkId): LedgerEntry[] {
    return this.history(fork).flatMap((e) => (e.summary === undefined ? [] : [{ version: e.version, parent: e.parent, edits: e.edits, accepted: e.summary.accepted, meanDiff: e.summary.meanDiff, pValue: e.summary.pValue, reason: e.summary.reason }]));
  }

  /** Make an earlier version the active one again. Only a version that was active before (the first, or an accepted attempt) can be. */
  rollback(fork: ForkId, toVersion: string): ArchiveEntry {
    const target = this.#find(fork, toVersion);
    if (target === undefined) throw new DecisionError("invalid", `${fork} has no version ${toVersion}`);
    if (target.summary !== undefined && !target.summary.accepted) throw new DecisionError("invalid", `version ${toVersion} of ${fork} was never accepted, so there is nothing to roll back to`);
    this.#entries = this.#entries.map((e) => (e.fork === fork ? { ...e, status: e.version === toVersion ? ("active" as const) : ("retired" as const) } : e));
    return this.#find(fork, toVersion)!;
  }

  /** Everything, as JSON (`restore` reads it). */
  snapshot(): { readonly format: typeof FORMAT; readonly entries: readonly ArchiveEntry[] } {
    return { format: FORMAT, entries: this.#entries.map((e) => ArchiveEntrySchema.parse(e)) };
  }

  /** Replace what is held with a snapshot, validated first: one that is not valid is refused and nothing changes. */
  restore(snapshot: unknown): void {
    const parsed = ArchiveSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) throw new DecisionError("invalid", `invalid criteria archive\n${z.prettifyError(parsed.error)}`);
    const problems = archiveProblems(parsed.data.entries);
    if (problems.length > 0) throw new DecisionError("invalid", `invalid criteria archive\n${problems.join("\n")}`);
    this.#entries = parsed.data.entries;
  }

  #find(fork: ForkId, version: string): ArchiveEntry | undefined {
    return this.#entries.find((e) => e.fork === fork && e.version === version);
  }
}

// ---- the proposer -------------------------------------------------------------------------------------------------------------------

/** A decision the fork got wrong: what it was shown, what was right, what it said. */
export interface Failure {
  readonly input: Json;
  readonly expected: Json;
  readonly got: Json | null;
}

export interface ProposalInput {
  readonly fork: { readonly id: ForkId; readonly version: string };
  /** The criteria as they are now. */
  readonly current: CriteriaBook;
  /** Decisions the current criteria got wrong, from the training side of the holdout only. */
  readonly failures: readonly Failure[];
  /** Earlier attempts and how they fared. */
  readonly ledger: readonly LedgerEntry[];
}

/** Proposes edits to a book's text. What it returns is untrusted: `evolve` screens it. */
export type Proposer = (input: ProposalInput) => Promise<unknown[]>;

const ProposalSchema = z.strictObject({ edits: z.array(EditSchema) });

/** What the proposer's model is told and allowed (see `proposer` in data/evolve.json). */
export interface LlmProposerOptions {
  readonly system: string;
  readonly maxTokens: number;
}

/**
 * A proposer that asks a language model: the request as JSON, and an answer constrained to
 * the shape `{ edits: [...] }` (a JSON Schema set on the call, and the answer parsed with
 * the same schema). An answer that does not have that shape is refused, not guessed at.
 */
export function llmProposer(model: LanguageModelV4, options: LlmProposerOptions): Proposer {
  return async (input) => {
    try {
      const { output } = await generateText({ model, instructions: options.system, prompt: JSON.stringify(input), maxOutputTokens: options.maxTokens, maxRetries: 0, output: Output.object({ schema: ProposalSchema }) });
      return output.edits;
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e) || NoOutputGeneratedError.isInstance(e)) throw new DecisionError("invalid", `the proposer's answer was not a list of edits: ${e.message}${e.cause instanceof Error ? `\n${e.cause.message}` : ""}`);
      throw e;
    }
  };
}

// ---- one generation ------------------------------------------------------------------------------------------------------------------------

/** Settings of the loop, as data (see data/evolve.json). None of them is the proposer's to change. */
export const EvolveSettingsSchema = z.strictObject({
  $schema: z.string().exactOptional(),
  /** The share of decisions held out from the proposer and used to compare versions. */
  holdout: z.number().gt(0).lt(1),
  /** The paired test must be significant at this level ... */
  alpha: z.number().gt(0).lt(1),
  /** ... and the lower confidence bound of the mean gain (in the share right) must be above this. */
  minGain: z.number().min(0).max(1),
  /** Fewer held-out decisions than this and nothing is tried. */
  minHoldout: z.int().min(2),
  /** How many failures the proposer is shown. */
  maxFailures: z.int().min(1),
  maxEdits: z.int().min(1),
  maxEditChars: z.int().min(1),
  /** An edit may not repeat this many words in a row from a held-out input (nor all of a string of theirs that has fewer, from two words). */
  leakWords: z.int().min(2),
  /** Resamples of the test when there are more differences than can be counted. */
  resamples: z.int().min(100),
  proposer: z.strictObject({ system: z.string().min(1), maxTokens: z.int().min(1) }),
});
export type EvolveSettings = z.output<typeof EvolveSettingsSchema>;

/** Parse the evolution settings file (see data/evolve.json). */
export function parseEvolveSettings(input: unknown): EvolveSettings {
  const result = EvolveSettingsSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid evolve settings\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for the settings file, for editors (data/evolve.schema.json). */
// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent; this schema's input and output JSON Schemas are the same
export const evolveSettingsJsonSchema = (): object => z.toJSONSchema(EvolveSettingsSchema, { io: "input" });

export type EvolveStatus = "accepted" | "rejected" | "no-failures" | "insufficient-holdout" | "no-valid-edits" | "proposal-failed";

export interface EvolveResult {
  readonly status: EvolveStatus;
  /** The version of the attempt made (an attempt is archived, accepted or not). */
  readonly version?: string;
  readonly summary?: EvaluationSummary;
  /** The edits applied in the attempt. */
  readonly edits: readonly Edit[];
  /** What the proposer said that was not applied, and why. */
  readonly rejectedEdits: readonly { readonly edit: unknown; readonly reason: string }[];
  readonly reason: string;
}

export interface EvolveOptions<In, Act extends Json> {
  readonly fork: Fork<In, Act>;
  readonly records: readonly DecisionRecord[];
  /** The action that was right for a record, or undefined when it is not known. */
  readonly labelOf: (record: DecisionRecord) => Act | undefined;
  /** What answers the questions, in every replay. */
  readonly member: Member;
  readonly proposer: Proposer;
  readonly archive: CriteriaArchive;
  readonly settings: EvolveSettings;
  /** The host's salt for the holdout: fixed, and not the evolver's to change. */
  readonly holdoutSalt: string;
  /** The fork's input from a record's input (the JSON the fork's `describe` gave); by default the record's input as it is. */
  readonly inputOf?: (state: Json) => In;
  /** The criteria to start from when the archive has none for the fork. */
  readonly initial?: CriteriaBook;
}

/** Refuse criteria that are not for the fork or that its questions do not take for a sample input: they would be the incumbent everything is measured against. */
function assertFits<In, Act>(fork: Fork<In, Act>, criteria: CriteriaBook, sample: In): void {
  if (criteria.fork !== fork.id) throw new DecisionError("invalid", `the initial criteria are for "${criteria.fork}", not for "${fork.id}"`);
  const asked = Object.keys(fork.ask(sample).questions);
  const unknown = Object.keys(criteria.questions).filter((id) => !asked.includes(id));
  if (unknown.length > 0) throw new DecisionError("invalid", `the initial criteria name questions ${fork.id} does not ask: ${unknown.join(", ")}`);
  try {
    withCriteria(fork, criteria).ask(sample);
  } catch (e) {
    throw new DecisionError("invalid", `the initial criteria do not fit the questions of ${fork.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const accuracy = (correct: readonly boolean[]): number => correct.filter(Boolean).length / Math.max(1, correct.length);

/**
 * One generation. Decisions are split by the deterministic holdout; the proposer sees the
 * failures of the active criteria on the training side only; its edits are screened; the
 * active criteria and the candidate are replayed on the same held-out decisions; and the
 * candidate becomes active only if the paired sign-flip test is significant at `alpha` and
 * the lower bound of the mean gain is above `minGain`. The attempt is archived either way.
 */
export async function evolve<In, Act extends Json>(options: EvolveOptions<In, Act>): Promise<EvolveResult> {
  const { fork, settings, archive } = options;
  const inputOf = options.inputOf ?? ((state: Json) => state as unknown as In);
  if (options.initial !== undefined && archive.active(fork.id) === undefined) {
    const sample = options.records.find((record) => record.fork === fork.id);
    if (sample === undefined) throw new DecisionError("invalid", `there are no decisions of ${fork.id} to check the initial criteria against`);
    assertFits(fork, options.initial, inputOf(sample.input));
    archive.seed(options.initial);
  }
  const incumbent = archive.active(fork.id);
  if (incumbent === undefined) throw new DecisionError("invalid", `there are no criteria for ${fork.id}: seed the archive or pass the initial criteria`);
  const stop = (status: EvolveStatus, reason: string, extra: Partial<EvolveResult> = {}): EvolveResult => ({ status, edits: [], rejectedEdits: [], reason, ...extra });

  const train: { record: DecisionRecord; example: LabelledExample<In> }[] = [];
  const held: { record: DecisionRecord; example: LabelledExample<In> }[] = [];
  for (const record of options.records) {
    if (record.fork !== fork.id) continue;
    const expected = options.labelOf(record);
    if (expected === undefined) continue;
    // By the input, not the decision: the same input in several decisions (the same command, run again) is on one side, so the proposer is never shown a held-out input as a training failure.
    (holdoutSplit(stableJson(record.input), settings.holdout, options.holdoutSalt) === "holdout" ? held : train).push({ record, example: { input: inputOf(record.input), expected } });
  }
  if (held.length < settings.minHoldout) return stop("insufficient-holdout", `${held.length} held-out decisions, ${settings.minHoldout} are needed`);

  const replayed = await replayCriteria({ fork, criteria: incumbent.criteria, member: options.member, examples: train.map((t) => t.example) });
  const failures: Failure[] = train
    .flatMap((t, i) => (replayed[i]!.correct ? [] : [{ input: t.record.input, expected: t.example.expected, got: replayed[i]!.got }]))
    .slice(0, settings.maxFailures);
  if (failures.length === 0) return stop("no-failures", "the current criteria got every training decision right");

  let proposed: unknown[];
  try {
    // The proposer is handed copies: whatever it does to them, the archive and the records are as they were.
    const shown = JSON.parse(JSON.stringify(failures)) as Failure[];
    const ledger = archive.ledger(fork.id).map((entry) => ({ ...entry, edits: entry.edits.map((edit) => ({ ...edit })) }));
    proposed = await options.proposer({ fork: { id: fork.id, version: fork.version }, current: copyBook(incumbent.criteria), failures: shown, ledger });
  } catch (e) {
    return stop("proposal-failed", e instanceof Error ? e.message : String(e));
  }
  if (!Array.isArray(proposed)) return stop("proposal-failed", "the proposer did not return a list of edits");
  const screened = screenEdits(proposed, { book: incumbent.criteria, heldOut: held.map((h) => h.record.input), maxEdits: settings.maxEdits, maxEditChars: settings.maxEditChars, leakWords: settings.leakWords });
  if (screened.kept.length === 0) return stop("no-valid-edits", "none of the proposed edits could be applied", { rejectedEdits: screened.rejected });

  const version = archive.nextVersion(fork.id);
  const candidate = applyEdits(incumbent.criteria, screened.kept, version);
  const examples = held.map((h) => h.example);
  const before = await evaluateCriteria({ fork, criteria: incumbent.criteria, member: options.member, examples });
  const after = await evaluateCriteria({ fork, criteria: candidate, member: options.member, examples });
  const diffs = after.map((ok, i) => Number(ok) - Number(before[i]!));
  const test = pairedSignFlipTest(diffs, { alpha: settings.alpha, resamples: settings.resamples });
  const lower = gainLowerBound(diffs, settings.alpha);
  const accepted = test.significant && (lower ?? -Infinity) > settings.minGain;
  const how = test.exact ? "exact" : `sampled from ${settings.resamples} resamples`;
  const reason = accepted
    ? `significant (p = ${test.pValue}, ${how}) and the mean gain is at least ${lower} with confidence`
    : !test.significant
      ? `not significant (p = ${test.pValue}, ${how}, needed ${settings.alpha})`
      : lower === null
        ? "too few held-out decisions to bound the gain"
        : `the mean gain's lower bound ${lower} is not above ${settings.minGain}`;
  const summary: EvaluationSummary = { n: diffs.length, incumbent: accuracy(before), candidate: accuracy(after), meanDiff: test.meanDiff, lower, pValue: test.pValue, exact: test.exact, accepted, reason };
  archive.attempt({ criteria: candidate, edits: screened.kept, summary });
  return { status: accepted ? "accepted" : "rejected", version, summary, edits: screened.kept, rejectedEdits: screened.rejected, reason };
}
