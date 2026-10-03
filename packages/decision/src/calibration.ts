import { probability } from "@harness/cognitive";
import { z } from "zod";
import { answerOfDistribution, logit, PROBABILITY_FLOOR, scaleProbabilities, sigmoid } from "./distribution.ts";
import { CalibrationBookSchema, CalibrationEntrySchema, temperature } from "./types.ts";
import type { Answer, Answers, Calibrate, CalibrationBook, CalibrationEntry, CalibrationKey, Calibrator, DecisionRecord, Distribution, ForkId, Temperature } from "./types.ts";

// ---- samples and measures ------------------------------------------------------------------------

/** What a member said and what turned out to be right: one point of calibration data. */
export interface CalibrationSample {
  readonly distribution: Distribution;
  /** The option that was right: one of the distribution's options. */
  readonly label: string;
}

/** A sample as numbers: the options in order, their probabilities, and the index of the right one. */
interface Prepared {
  readonly keys: readonly string[];
  readonly probs: readonly number[];
  readonly label: number;
}
/** Probabilities (possibly calibrated) and the index of the right option. */
interface Scored {
  readonly probs: readonly number[];
  readonly label: number;
}

function parseWith<S extends z.ZodType>(schema: S, what: string, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RangeError(`not ${what}: ${JSON.stringify(value)}\n${z.prettifyError(result.error)}`);
  return result.data;
}

function prepare(samples: readonly CalibrationSample[]): Prepared[] {
  if (samples.length < 1) throw new RangeError("fitting and measuring need at least one sample");
  return samples.map(({ distribution, label }, i) => {
    const keys = Object.keys(distribution);
    const at = keys.indexOf(label);
    if (at < 0) throw new RangeError(`sample ${i}: the label "${label}" is not among the options (${keys.join(", ")})`);
    return { keys, probs: Object.values(distribution), label: at };
  });
}

const isBooleanOptions = (keys: readonly string[]): boolean => keys.length === 2 && keys.includes("true") && keys.includes("false");

const BOOLEAN_OPTIONS = 'a boolean has exactly the options "true" and "false"';

/** The index of the largest probability: the first of equals. */
function topIndex(probs: readonly number[]): number {
  let best = 0;
  probs.forEach((p, i) => {
    if (p > probs[best]!) best = i;
  });
  return best;
}

function assertBins(bins: number): void {
  if (!Number.isInteger(bins) || bins < 1) throw new RangeError(`bins must be a whole number of at least 1, got ${bins}`);
}

/** One bin of a reliability diagram. */
export interface ReliabilityRow {
  readonly lo: number;
  readonly hi: number;
  /** How many samples' top-label confidence fell in the bin: [lo, hi), with 1 in the last bin. */
  readonly n: number;
  /** Their mean confidence and the share of them whose top label was right (0 for an empty bin: read `n`). */
  readonly confidence: number;
  readonly accuracy: number;
}

function reliabilityOf(scored: readonly Scored[], bins: number): ReliabilityRow[] {
  assertBins(bins);
  const cells = Array.from({ length: bins }, () => ({ n: 0, confidence: 0, correct: 0 }));
  for (const { probs, label } of scored) {
    const top = topIndex(probs);
    const cell = cells[Math.min(bins - 1, Math.floor(probs[top]! * bins))]!;
    cell.n += 1;
    cell.confidence += probs[top]!;
    if (top === label) cell.correct += 1;
  }
  return cells.map((cell, bin) => ({
    lo: bin / bins,
    hi: (bin + 1) / bins,
    n: cell.n,
    confidence: cell.n === 0 ? 0 : cell.confidence / cell.n,
    accuracy: cell.n === 0 ? 0 : cell.correct / cell.n,
  }));
}

function eceOf(scored: readonly Scored[], bins: number): number {
  const total = scored.length;
  const gap = reliabilityOf(scored, bins).reduce((sum, row) => sum + row.n * Math.abs(row.accuracy - row.confidence), 0);
  return Math.min(1, gap / total);
}

function brierOf(scored: readonly Scored[]): number {
  const total = scored.reduce((sum, { probs, label }) => sum + probs.reduce((inner, p, i) => inner + (p - (i === label ? 1 : 0)) ** 2, 0), 0);
  return Math.min(2, total / scored.length);
}

/** The reliability diagram of a member's top-label confidence, in `bins` equal-width bins. */
export const reliability = (samples: readonly CalibrationSample[], bins = 10): ReliabilityRow[] => reliabilityOf(prepare(samples), bins);

/**
 * Expected calibration error: the mean gap between the top option's confidence and how
 * often it was right, weighted by bin size (top-label confidence in equal-width bins).
 */
export const ece = (samples: readonly CalibrationSample[], bins = 10): number => eceOf(prepare(samples), bins);

/** The multiclass Brier score: the mean over samples of the summed squared errors across options (0 is perfect, 2 the worst). */
export const brier = (samples: readonly CalibrationSample[]): number => brierOf(prepare(samples));

// ---- applying calibrators ---------------------------------------------------------------------------

const IDENTITY: Calibrator = { kind: "identity" };

/** Calibrated probabilities of options in order; Platt needs the boolean options. */
function calibrateProbs(calibrator: Calibrator, keys: readonly string[], probs: readonly number[]): readonly number[] {
  switch (calibrator.kind) {
    case "identity":
      return probs;
    case "temperature":
      return scaleProbabilities(probs, calibrator.temperature);
    case "platt": {
      const yes = sigmoid(calibrator.a * logit(probs[keys.indexOf("true")]!) + calibrator.b);
      return keys.map((key) => (key === "true" ? yes : 1 - yes));
    }
  }
}

/**
 * The answer as the calibrator would have had the member say it. Temperature applies to
 * any question; Platt scaling to booleans only. The top option and a score's expected
 * level are recomputed from the new probabilities.
 */
export function applyCalibrator(calibrator: Calibrator, answer: Answer): Answer {
  if (calibrator.kind === "identity") return answer;
  const keys = Object.keys(answer.distribution);
  if (calibrator.kind === "platt") {
    if (answer.type !== "boolean") throw new RangeError(`a platt calibrator applies to boolean answers only, not ${answer.type}`);
    if (!isBooleanOptions(keys)) throw new RangeError(`a platt calibrator needs a boolean answer with the options "true" and "false", got ${keys.join(", ")}`);
  }
  const probs = calibrateProbs(calibrator, keys, Object.values(answer.distribution));
  const distribution = Object.fromEntries(keys.map((key, i) => [key, probability(Math.min(1, Math.max(0, probs[i]!)))]));
  return answerOfDistribution(answer.type, distribution);
}

// ---- fitting ---------------------------------------------------------------------------------------

const negLog = (p: number): number => -Math.log(Math.max(p, PROBABILITY_FLOOR));

const LN_T_MIN = Math.log(0.05);
const LN_T_MAX = Math.log(20);
const INV_PHI = (Math.sqrt(5) - 1) / 2;

function nllAtTemperature(prepared: readonly Prepared[], t: number): number {
  return prepared.reduce((sum, { probs, label }) => sum + negLog(scaleProbabilities(probs, t)[label]!), 0) / prepared.length;
}

/** Golden-section search of the mean negative log likelihood over ln T in [ln 0.05, ln 20]. */
function fitTemperatureOn(prepared: readonly Prepared[]): { readonly t: number; readonly nll: number } {
  const f = (u: number) => nllAtTemperature(prepared, Math.exp(u));
  let lo = LN_T_MIN;
  let hi = LN_T_MAX;
  let c = hi - INV_PHI * (hi - lo);
  let d = lo + INV_PHI * (hi - lo);
  let fc = f(c);
  let fd = f(d);
  // Stryker disable next-line EqualityOperator: equivalent; an interval of exactly 1e-7 is not reachable, and either side of it is converged
  while (hi - lo > 1e-7) {
    // On a flat likelihood (equal values) the search moves toward the higher temperature: the softer, more conservative one.
    if (fc < fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - INV_PHI * (hi - lo);
      fc = f(c);
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + INV_PHI * (hi - lo);
      fd = f(d);
    }
  }
  const t = Math.exp((lo + hi) / 2);
  return { t, nll: nllAtTemperature(prepared, t) };
}

export interface TemperatureFit {
  readonly temperature: Temperature;
  /** The mean negative log likelihood (nats) of the labels at that temperature. */
  readonly nll: number;
}

/**
 * The temperature that minimizes the negative log likelihood of the labels, by golden-section
 * search over ln T between ln 0.05 and ln 20 (the likelihood is unimodal in T, so this finds the minimum).
 */
export function fitTemperature(samples: readonly CalibrationSample[]): TemperatureFit {
  const { t, nll } = fitTemperatureOn(prepare(samples));
  return { temperature: temperature(t), nll };
}

/** Platt scaling is pulled toward the identity (a = 1, b = 0) with this weight, so separable data gives finite parameters. */
const PLATT_RIDGE = 1e-2;
const PLATT_ITERATIONS = 100;
/** Newton stops when a step moves neither parameter by more than this. */
const PLATT_TOLERANCE = 1e-9;

interface Point {
  readonly x: number;
  readonly y: 0 | 1;
}

function toPoints(prepared: readonly Prepared[]): Point[] {
  return prepared.map(({ keys, probs, label }, i) => {
    if (!isBooleanOptions(keys)) throw new RangeError(`sample ${i}: ${BOOLEAN_OPTIONS}, got ${keys.join(", ")}`);
    return { x: logit(probs[keys.indexOf("true")]!), y: keys[label] === "true" ? 1 : 0 };
  });
}

/** ln(1 + eᶻ), without overflow. */
const softplus = (z: number): number => Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z)));

/** The summed negative log likelihood of the labels at p' = σ(a·logit(p) + b). */
function plattLoss(points: readonly Point[], a: number, b: number): number {
  return points.reduce((sum, { x, y }) => sum + softplus(a * x + b) - y * (a * x + b), 0);
}

const plattObjectiveOf = (points: readonly Point[], a: number, b: number): number => plattLoss(points, a, b) + (PLATT_RIDGE / 2) * ((a - 1) ** 2 + b ** 2);

/**
 * What `fitPlatt` minimizes: the summed negative log likelihood of the labels after scaling,
 * plus a ridge that pulls (a, b) toward the identity (1, 0).
 */
export function plattObjective(samples: readonly CalibrationSample[], a: number, b: number): number {
  return plattObjectiveOf(toPoints(prepare(samples)), a, b);
}

export interface PlattFit {
  readonly a: number;
  readonly b: number;
  /** The mean negative log likelihood (nats) of the labels after scaling. */
  readonly nll: number;
  /** How many Newton steps it took (`PLATT_ITERATIONS` would mean it did not settle). */
  readonly iterations: number;
}

/** Regularized Newton (iteratively reweighted least squares) with a backtracking line search. */
function fitPlattOn(prepared: readonly Prepared[]): PlattFit {
  const points = toPoints(prepared);
  let a = 1;
  let b = 0;
  let iterations = 0;
  // Stryker disable next-line EqualityOperator: equivalent; every data set settles within a dozen steps, far below the limit
  while (iterations < PLATT_ITERATIONS) {
    iterations += 1;
    let ga = PLATT_RIDGE * (a - 1);
    let gb = PLATT_RIDGE * b;
    let haa = PLATT_RIDGE;
    let hab = 0;
    let hbb = PLATT_RIDGE;
    for (const { x, y } of points) {
      const p = 1 / (1 + Math.exp(-(a * x + b)));
      const w = p * (1 - p);
      ga += (p - y) * x;
      gb += p - y;
      haa += w * x * x;
      hab += w * x;
      hbb += w;
    }
    const det = haa * hbb - hab * hab;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    // The objective is convex and the Newton direction descends (the Hessian is positive definite), so halving the step
    // ends at a step that does not raise the objective (at worst one too small to move a and b).
    const here = plattObjectiveOf(points, a, b);
    let step = 1;
    while (plattObjectiveOf(points, a - step * da, b - step * db) > here) step /= 2;
    a -= step * da;
    b -= step * db;
    // Stryker disable next-line EqualityOperator: equivalent; a step of exactly the tolerance is not reachable, and either side of it is converged
    if (Math.max(Math.abs(step * da), Math.abs(step * db)) < PLATT_TOLERANCE) break;
  }
  return { a, b, nll: plattLoss(points, a, b) / points.length, iterations };
}

/**
 * Platt scaling of a boolean member: p' = σ(a·logit(p) + b), by regularized Newton steps
 * (a small ridge toward a = 1, b = 0 keeps the parameters finite on separable data).
 */
export function fitPlatt(samples: readonly CalibrationSample[]): PlattFit {
  return fitPlattOn(prepare(samples));
}

// ---- entries ---------------------------------------------------------------------------------------

const FOLDS = 5;
const BINS = 10;

export interface FitEntryInput {
  readonly fork: ForkId;
  readonly member: string;
  readonly version: string;
  readonly question: string;
  readonly type: Answer["type"];
  readonly samples: readonly CalibrationSample[];
  /** When the fit was made (ms), recorded in the entry. */
  readonly at: number;
  /** Fewer samples than this give no entry (default 30). */
  readonly minSamples?: number;
}

interface Candidate {
  readonly fit: (train: readonly Prepared[]) => Calibrator;
}

const CANDIDATES: Readonly<Record<"temperature" | "platt", Candidate>> = {
  temperature: { fit: (train) => ({ kind: "temperature", temperature: temperature(fitTemperatureOn(train).t) }) },
  platt: { fit: (train) => ({ kind: "platt", ...(({ a, b }) => ({ a, b }))(fitPlattOn(train)) }) },
};

/** Pooled out-of-fold predictions: folds by index, each predicted by a calibrator fitted on the others. */
function outOfFold(prepared: readonly Prepared[], candidate: Candidate): Scored[] {
  const folds = Math.min(FOLDS, prepared.length);
  const calibrators = Array.from({ length: folds }, (_, fold) => {
    const train = prepared.filter((_sample, i) => i % folds !== fold);
    return train.length === 0 ? IDENTITY : candidate.fit(train);
  });
  return calibratedWith((i) => calibrators[i % folds]!, prepared);
}

const calibratedWith = (calibratorOf: (i: number) => Calibrator, prepared: readonly Prepared[]): Scored[] =>
  prepared.map(({ keys, probs, label }, i) => ({ probs: calibrateProbs(calibratorOf(i), keys, probs), label }));


/**
 * A member's calibration for one question, fitted on outcomes: temperature scaling (and, for
 * booleans, Platt scaling) is fitted on all samples; the candidate is judged on out-of-fold
 * predictions (5 folds, by index). Of the candidates that improve cross-validated ECE, the one
 * with the lowest cross-validated Brier is chosen (the first on a tie); if none improves it the
 * identity stands. `fitted` reports ECE and Brier before and after, measured on the samples.
 * Undefined when there are fewer than `minSamples` samples.
 */
export function fitEntry({ fork, member, version, question, type, samples, at, minSamples = 30 }: FitEntryInput): CalibrationEntry | undefined {
  if (samples.length === 0 || samples.length < minSamples) return undefined;
  const prepared = prepare(samples);
  const raw: Scored[] = prepared.map(({ probs, label }) => ({ probs, label }));
  const baseEce = eceOf(raw, BINS);
  const baseBrier = brierOf(raw);
  const kinds = type === "boolean" ? (["temperature", "platt"] as const) : (["temperature"] as const);
  let chosen: { readonly calibrator: Calibrator; readonly brier: number } | undefined;
  for (const kind of kinds) {
    const candidate = CANDIDATES[kind];
    const held = outOfFold(prepared, candidate);
    if (eceOf(held, BINS) >= baseEce) continue;
    const heldBrier = brierOf(held);
    // Stryker disable next-line EqualityOperator: equivalent; two candidates score the same cross-validated Brier only when they predict the same
    if (chosen === undefined || heldBrier < chosen.brier) chosen = { calibrator: candidate.fit(prepared), brier: heldBrier };
  }
  const calibrator = chosen?.calibrator ?? IDENTITY;
  const after = calibratedWith(() => calibrator, prepared);
  return parseWith(CalibrationEntrySchema, "a calibration entry", {
    fork,
    member,
    version,
    question,
    calibrator,
    fitted: { n: samples.length, at, eceBefore: baseEce, eceAfter: eceOf(after, BINS), brierBefore: baseBrier, brierAfter: brierOf(after) },
  });
}

// ---- books -----------------------------------------------------------------------------------------

const keyOf = (e: CalibrationKey & { readonly question: string }): string => JSON.stringify([e.fork, e.member, e.version, e.question]);

/** Parses a calibration book (JSON), refusing one that lists a fork, member, version and question twice. */
export function parseCalibration(json: unknown): CalibrationBook {
  const book = parseWith(CalibrationBookSchema, "a calibration book", json);
  const seen = new Set<string>();
  for (const e of book.entries) {
    const key = keyOf(e);
    if (seen.has(key)) throw new RangeError(`not a calibration book: more than one entry for fork "${e.fork}", member "${e.member}", version "${e.version}", question "${e.question}"`);
    seen.add(key);
  }
  return book;
}

/** JSON Schema for calibration books, for editors (data/calibration.schema.json). */
// Stryker disable next-line ObjectLiteral,StringLiteral: equivalent; the book has no defaults or transforms, so its input and output schemas coincide
export const calibrationJsonSchema = (): object => z.toJSONSchema(CalibrationBookSchema, { io: "input" });

/**
 * A calibration book with lookup, and the `Calibrate` a fork runner is given: an entry
 * applies to the answers of exactly its fork, member, version and question, and never to
 * a member's other version (calibration belongs to the version it was fitted on).
 */
export class CalibrationIndex {
  readonly #book: CalibrationBook;
  readonly #byKey: ReadonlyMap<string, CalibrationEntry>;

  constructor(book: CalibrationBook = { entries: [] }) {
    this.#book = parseCalibration(book);
    this.#byKey = new Map(this.#book.entries.map((e) => [keyOf(e), e]));
  }

  get book(): CalibrationBook {
    return this.#book;
  }

  entry(key: CalibrationKey & { readonly question: string }): CalibrationEntry | undefined {
    return this.#byKey.get(keyOf(key));
  }

  /** A new index with the entry for that fork, member, version and question replaced (in place) or added (last). */
  with(entry: CalibrationEntry): CalibrationIndex {
    const parsed = parseWith(CalibrationEntrySchema, "a calibration entry", entry);
    const key = keyOf(parsed);
    const at = this.#book.entries.findIndex((e) => keyOf(e) === key);
    const entries = at < 0 ? [...this.#book.entries, parsed] : this.#book.entries.map((e, i) => (i === at ? parsed : e));
    return new CalibrationIndex({ ...this.#book, entries });
  }

  /** Answers with each question's entry applied; a question with no entry for exactly this key, or one Platt cannot apply to, is unchanged. */
  readonly calibrate: Calibrate = (key, answers) =>
    Object.fromEntries(
      Object.entries(answers).map(([question, answer]) => {
        const entry = this.entry({ ...key, question });
        const usable = entry !== undefined && (entry.calibrator.kind !== "platt" || (answer.type === "boolean" && isBooleanOptions(Object.keys(answer.distribution))));
        return [question, usable ? applyCalibrator(entry.calibrator, answer) : answer];
      }),
    ) as Answers;
}

export interface FitBookInput {
  readonly records: readonly DecisionRecord[];
  /** The option that was right for a record's question, when it is known. */
  readonly labelOf: (record: DecisionRecord, question: string) => string | undefined;
  readonly at: number;
  readonly minSamples?: number;
  /** Entries fitted here replace those of the same key in this index; the others are kept. */
  readonly index?: CalibrationIndex;
}

interface Group {
  readonly key: CalibrationKey & { readonly question: string };
  readonly type: Answer["type"];
  readonly samples: CalibrationSample[];
}

/**
 * Fits a book from recorded decisions. Records are grouped by fork, member, member version and
 * question, and use the member's own answers before calibration (`raw`, else `answers`). A
 * record without a member, version or label is skipped, so is a label that is not one of the
 * options and an answer of another type than the group's first (or a boolean without
 * the options true and false). Returns the index's book with every entry that had enough samples.
 */
export function fitBook({ records, labelOf, at, minSamples = 30, index = new CalibrationIndex() }: FitBookInput): CalibrationBook {
  const groups = new Map<string, Group>();
  for (const record of records) {
    const { member, memberVersion } = record;
    if (member === undefined || memberVersion === undefined) continue;
    for (const question of new Set([...Object.keys(record.answers), ...Object.keys(record.raw ?? {})])) {
      const answer = record.raw?.[question] ?? record.answers[question]!;
      const label = labelOf(record, question);
      if (label === undefined || !Object.hasOwn(answer.distribution, label)) continue;
      if (answer.type === "boolean" && !isBooleanOptions(Object.keys(answer.distribution))) continue;
      const key = { fork: record.fork, member, version: memberVersion, question };
      const group = groups.get(keyOf(key)) ?? { key, type: answer.type, samples: [] };
      groups.set(keyOf(key), group);
      if (group.type === answer.type) group.samples.push({ distribution: answer.distribution, label });
    }
  }
  const entries = new Map(index.book.entries.map((e) => [keyOf(e), e]));
  for (const { key, type, samples } of groups.values()) {
    const entry = fitEntry({ ...key, type, samples, at, minSamples });
    if (entry !== undefined) entries.set(keyOf(key), entry);
  }
  return new CalibrationIndex({ ...index.book, entries: [...entries.values()] }).book;
}
