/**
 * The System One wire: `POST /v1/systemone` and `GET /v1/models` over any AI SDK
 * evaluation model (`Experimental_EvaluationModelV4`), as JSON in and JSON out. TypeSafe's
 * AI SDK provider (`@ai-sdk/typesafe-ai`, used by `typesafeApiEvaluationModel` in
 * `@harness/models`) is the client; a host serves this over HTTP.
 *
 * Where each rule comes from (ADR 0030):
 *
 * - The request and response fields: TypeSafe's documentation (docs.typesafe.ai:
 *   quickstart, primitives/choice, /score, /noul) and the client's own parser
 *   (`node_modules/@ai-sdk/typesafe-ai/src/typesafe-ai-evaluation-api.ts`, which reads
 *   `noul: number`, `choice` and `score` with `probabilities`, optional `confidence`).
 *   The client sends a boolean question as `noul`; here `noul` becomes the AI SDK's
 *   `boolean` and the answer is `{ type: "noul", noul: P(true) }`.
 * - Limits (a choice has at most 255 options, a score 2 to 10 levels, descriptions may be
 *   text, an object, an array or null), the alias `jev-latest`, ids of any characters,
 *   422 `detail[]` errors, `{ detail: { error_type, message } }` for the rest, never a 5xx
 *   for a bad request: the `jevcompat` conformance spec 0.1 (github.com/mandu5/jevcompat,
 *   SPEC.md), rule ids `request.*`, `noul.*`, `choice.*`, `score.*`, `response.*`,
 *   `errors.*`, `semantics.*`.
 * - Probabilities: keyed exactly by the options (a score's levels by "0".."n-1"), sum to
 *   1 (renormalised here: models that round report sums of 0.99 or 1.01), a choice is the
 *   option with the largest probability, a score is the sum of level times probability
 *   (documented; `score.expectation`).
 * - Confidence: TypeSafe documents it only as "a statistic computed from the probability
 *   distribution" with `(3 * largest - 1) / 2` for three options (docs.typesafe.ai/confidence).
 *   The reference formulas of jevcompat 4.5 generalise that and reproduce every documented
 *   example: a choice's `(n * m - 1) / (n - 1)`, and a score's distance from the most
 *   likely level. Here it is always derived from the probabilities, never read from a
 *   model or a server (ADR 0030).
 * - The upstream failure status (502, `upstream_error`) and a model set with aliases are
 *   this layer's own choices; the spec is silent.
 *
 * Every question of a request is asked of the model in a call of its own, under a fixed
 * question id: the client's ids never reach the model, and what the other questions are,
 * how many there are and in what order they come cannot change an answer (jevcompat
 * `semantics.question-id`, `.batching`, `.question-order` hold for any evaluation model,
 * however it treats several questions at once). Up to four run at a time.
 */
import { InvalidArgumentError } from "@ai-sdk/provider";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4, Experimental_EvaluationModelV4Answer as ModelAnswer, Experimental_EvaluationModelV4Question as ModelQuestion } from "@ai-sdk/provider";
import { experimental_evaluate } from "ai";
import { MODEL_HEADER, probability } from "@harness/cognitive";
import type { Ensemble, Probability, TaskCategory } from "@harness/cognitive";
import { z } from "zod";
import { ProbabilitySchema } from "./types.ts";
import type { State } from "./types.ts";

// ---- limits ----------------------------------------------------------------------------------

/** A choice has 1 to 255 options (documented maximum) and a score 2 to 10 levels. */
export const SYSTEMONE_LIMITS = { options: 255, minLevels: 2, maxLevels: 10 } as const;
/** Questions in one request unless the host says otherwise. */
export const SYSTEMONE_MAX_QUESTIONS = 128;
/** Questions asked of the model at the same time unless the host says otherwise. */
export const SYSTEMONE_CONCURRENCY = 4;
/** Validation problems reported in one 422. */
const MAX_PROBLEMS = 100;
/** A distribution summing to 1 within this is passed through as the model gave it (floating-point error is not a rounding). */
const ALREADY_ONE = 2 ** -30;
/** The id every question is asked under: the client's ids never reach the model. */
const QUESTION_ID = "q";

// ---- request ---------------------------------------------------------------------------------

/** Nesting of a JSON input beyond this is refused: it bounds every later walk of the value (and rules out cycles). */
const MAX_DEPTH = 64;

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v) as unknown;
  return prototype === Object.prototype || prototype === null;
};

/** What is wrong with a JSON value at `at`, if anything. Keys are read as they are, `__proto__` included. */
function jsonProblem(value: unknown, at: string, depth: number): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : `${at} is not a finite number`;
  if (depth > MAX_DEPTH) return `${at} is nested more than ${MAX_DEPTH} levels deep`;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const problem = jsonProblem(item, `${at}[${i}]`, depth + 1);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  if (isPlain(value)) {
    for (const key of Object.keys(value)) {
      const problem = jsonProblem(value[key], `${at}.${key}`, depth + 1);
      if (problem !== undefined) return problem;
    }
    return undefined;
  }
  return `${at} is not JSON (${typeof value})`;
}

/** The schemas of the wire, built where they are used: cheap next to a model call, and no state in the module. */
function buildSchemas() {
  /**
   * Text, an object or an array of JSON: what a state, an instruction, a description and a
   * legend entry may be. Checked here, not by zod's `json()`, which drops a key named
   * `__proto__`, overflows the stack on deep values and takes cycles: the value reaches the
   * model exactly as it was sent.
   */
  const structured = z.custom<State>().superRefine((value, ctx) => {
    const problem = typeof value === "string" ? undefined : Array.isArray(value) || isPlain(value) ? jsonProblem(value, "value", 1) : "expected text, an object or an array";
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
  });
  const description = structured.nullable();
  const instructions = structured.default("");

  /**
   * A map with any string keys, each value parsed by `value`. Zod's `record` drops a key
   * named `__proto__`; a question id or option name is any string (jevcompat `request.question-ids`).
   */
  const keyed = <V extends z.ZodType>(value: V, key: z.ZodType<string>) =>
    z.custom<Record<string, unknown>>(isPlain, "expected an object").transform((record, ctx) => {
      const entries: [string, z.output<V>][] = [];
      for (const name of Object.keys(record)) {
        const named = key.safeParse(name);
        const parsed = value.safeParse(record[name]);
        if (!named.success) for (const issue of named.error.issues) ctx.issues.push({ ...issue, input: name, path: [name, ...issue.path] } as never);
        if (parsed.success) entries.push([name, parsed.data]);
        else for (const issue of parsed.error.issues) ctx.issues.push({ ...issue, input: record[name], path: [name, ...issue.path] } as never);
      }
      return Object.fromEntries(entries) as Record<string, z.output<V>>;
    });

  const noul = z.looseObject({
    type: z.literal("noul"),
    instructions,
    criteria: z.strictObject({ true: description.exactOptional(), false: description.exactOptional() }).nullish(),
  });
  const choice = z.looseObject({
    type: z.literal("choice"),
    instructions,
    criteria: keyed(description, z.string()).refine((c) => Object.keys(c).length >= 1 && Object.keys(c).length <= SYSTEMONE_LIMITS.options, `a choice has 1 to ${SYSTEMONE_LIMITS.options} options`),
  });
  const score = z.looseObject({
    type: z.literal("score"),
    instructions,
    criteria: z.array(description).min(SYSTEMONE_LIMITS.minLevels).max(SYSTEMONE_LIMITS.maxLevels),
  });
  const question = z.discriminatedUnion("type", [noul, choice, score]);

  /** The body of `POST /v1/systemone`. Unknown fields are ignored. */
  const request = z.looseObject({
    model: z.string().min(1).exactOptional(),
    state: structured,
    questions: keyed(question, z.string().min(1)).refine((q) => Object.keys(q).length >= 1, "at least one question"),
  });

  const probabilities = z.record(z.string(), ProbabilitySchema);
  const answer = z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("noul"), noul: ProbabilitySchema }),
    z.strictObject({ type: z.literal("choice"), choice: z.string(), probabilities, confidence: ProbabilitySchema }),
    z.strictObject({ type: z.literal("score"), score: z.number().finite().min(0), legend: z.record(z.string(), z.unknown()), probabilities, confidence: ProbabilitySchema }),
  ]);
  const tokens = z.int().nonnegative();
  const response = z.strictObject({ model: z.string(), answers: z.record(z.string(), answer), usage: z.strictObject({ input_tokens: tokens, output_tokens: tokens }) });
  return { question, request, answer, response };
}

export type SystemOneQuestion = z.output<ReturnType<typeof buildSchemas>["question"]>;
export type SystemOneRequest = z.output<ReturnType<typeof buildSchemas>["request"]>;
export type SystemOneAnswer = z.output<ReturnType<typeof buildSchemas>["answer"]>;
export type SystemOneResponse = z.output<ReturnType<typeof buildSchemas>["response"]>;

/** The wire's zod schemas: `question`, `request` (the body of `POST /v1/systemone`), `answer` and `response`. */
export function systemOneSchemas(): ReturnType<typeof buildSchemas> {
  return buildSchemas();
}

// ---- response --------------------------------------------------------------------------------

/** A status and a JSON body: what a host writes to the wire. */
export interface SystemOneReply {
  readonly status: number;
  readonly body: unknown;
}

/** `{ detail: { error_type, message } }`, the shape of every error that is not a validation problem (jevcompat `errors.shape`). */
export function systemOneError(status: number, errorType: string, message: string): SystemOneReply {
  return { status, body: { detail: { error_type: errorType, message } } };
}

/** A body that is not JSON: a 422 in the validation shape, located at the body (jevcompat `errors.validation-shape`). */
export function systemOneInvalidJson(message: string): SystemOneReply {
  return { status: 422, body: { detail: [{ loc: ["body"], msg: message, type: "json_invalid" }] } };
}

// ---- confidence ------------------------------------------------------------------------------

/** The index of the largest value; the first of equals. */
const argmax = (p: readonly number[]): number => p.reduce((best, x, i) => (x > p[best]! ? i : best), 0);

const unit = (x: number): Probability => probability(Math.min(1, Math.max(0, x)));

/**
 * A choice's confidence: `(n * m - 1) / (n - 1)` for n options and largest probability m.
 * All on one option is 1, an even spread 0; for three options it is the documented
 * `(3 * m - 1) / 2`. One option is certain.
 */
export function choiceConfidence(p: readonly number[]): Probability {
  const n = p.length;
  return n < 2 ? probability(1) : unit((n * p[argmax(p)]! - 1) / (n - 1));
}

/**
 * A score's confidence: one minus the probability-weighted distance from the most likely
 * level, over the same distance of a uniform distribution measured from the scale's
 * middle (jevcompat 4.5, TypeSafe's adapter formula). Mass on levels next to the mode
 * costs less than mass at the far end; one level is certain.
 */
export function scoreConfidence(p: readonly number[]): Probability {
  const n = p.length;
  if (n < 2) return probability(1);
  const mode = argmax(p);
  const middle = (n - 1) / 2;
  const uniform = p.reduce((sum, _, i) => sum + Math.abs(i - middle), 0) / n;
  const spread = p.reduce((sum, pi, i) => sum + pi * Math.abs(i - mode), 0);
  return unit(1 - spread / uniform);
}

// ---- models ----------------------------------------------------------------------------------

/** What answered, as the model reported it: the model's own id and the response headers. */
export interface SystemOneResponseInfo {
  readonly modelId: string;
  readonly headers: Readonly<Record<string, string>> | undefined;
}

/** A model a host serves under a concrete id. */
export interface SystemOneServed {
  /** The concrete id reported in the response's `model`. */
  readonly id: string;
  readonly model: EvaluationModelV4;
  /** The concrete model that answered a call, when the model says so (an ensemble names its member). */
  answeredBy?(response: SystemOneResponseInfo): string | undefined;
}

/** One line of `GET /v1/models`. */
export interface SystemOneModelInfo {
  readonly id: string;
  readonly description: string;
  /** `YYYY-MM-DD`. */
  readonly releaseDate: string;
}

/** The models a host serves. */
export interface SystemOneModels {
  list(): readonly SystemOneModelInfo[];
  /** The model for a requested id, including a `latest` alias; undefined for an id not served. */
  resolve(requested: string): SystemOneServed | undefined;
}

export interface SystemOneModelEntry {
  readonly id: string;
  readonly model: EvaluationModelV4;
  readonly description?: string | undefined;
  readonly releaseDate?: string | undefined;
  readonly answeredBy?: SystemOneServed["answeredBy"] | undefined;
}

/** `latest`, `jev-latest`, `anything-latest`: clients send these and expect a concrete model back (jevcompat `request.model-alias`). */
const LATEST = /^(?:.+-)?latest$/i;
/** Used when a model has no known release date. */
const UNKNOWN_DATE = "1970-01-01";

function isCalendarDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m === null) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  // A month that does not exist has no days.
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day >= 1 && day <= days;
}

/**
 * A set of served models. The first is the default and what `latest` aliases resolve to.
 * Throws on no models, an empty or repeated id, or a release date that is not a date.
 */
export function systemOneModels(entries: readonly SystemOneModelEntry[]): SystemOneModels {
  if (entries.length === 0) throw new RangeError("a System One model set needs at least one model");
  const byId = new Map<string, SystemOneModelEntry>();
  for (const entry of entries) {
    if (entry.id === "") throw new RangeError("a System One model id is not empty");
    if (byId.has(entry.id)) throw new RangeError(`duplicate model id ${entry.id}`);
    if (entry.releaseDate !== undefined && !isCalendarDate(entry.releaseDate)) throw new RangeError(`the release date of ${entry.id} is not a YYYY-MM-DD date: ${entry.releaseDate}`);
    byId.set(entry.id, entry);
  }
  return {
    list: () => entries.map((e) => ({ id: e.id, description: e.description ?? e.id, releaseDate: e.releaseDate ?? UNKNOWN_DATE })),
    resolve(requested) {
      const entry = byId.get(requested) ?? (LATEST.test(requested) ? entries[0] : undefined);
      return entry === undefined ? undefined : { id: entry.id, model: entry.model, ...(entry.answeredBy ? { answeredBy: entry.answeredBy } : {}) };
    },
  };
}

/**
 * The harness's ensemble as a System One provider under a stable id. Each answer reports
 * the ensemble member that gave it (the `x-harness-model` header) as the served model.
 */
export function ensembleSystemOneModels(ensemble: Ensemble, id = "harness-ensemble", options: { readonly description?: string; readonly releaseDate?: string; readonly task?: TaskCategory } = {}): SystemOneModels {
  return systemOneModels([
    {
      id,
      model: ensemble.evaluationModel(options.task),
      description: options.description ?? "The harness's judgment ensemble: the best reachable evaluation model, with failover",
      releaseDate: options.releaseDate,
      answeredBy: (response) => response.headers?.[MODEL_HEADER],
    },
  ]);
}

/** `GET /v1/models`. */
export function handleModels(models: SystemOneModels): SystemOneReply {
  return { status: 200, body: { models: models.list().map((m) => ({ name: m.id, description: m.description, release_date: m.releaseDate })) } };
}

// ---- answering -------------------------------------------------------------------------------

/** experimental_evaluate has checked the answer's type against the question's. */
function ofType<K extends ModelAnswer["type"]>(answer: ModelAnswer): Extract<ModelAnswer, { type: K }> {
  return answer as Extract<ModelAnswer, { type: K }>;
}

/** Weights to probabilities that sum to 1, leaving alone a distribution that already does. A model that reports none has no answer to give. */
function normalise(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) throw new Error("the model reported no probability for the question");
  return Math.abs(total - 1) <= ALREADY_ONE ? [...weights] : weights.map((w) => w / total);
}

/** A score's weight on each level when the model gave only the score: the two levels around it. */
function levelWeights(levels: number, score: number): number[] {
  const low = Math.floor(score);
  const fraction = score - low;
  return Array.from({ length: levels }, (_, i) => (i === low ? 1 - fraction : i === low + 1 ? fraction : 0));
}

interface Prepared {
  readonly question: ModelQuestion;
  readonly finish: (answer: ModelAnswer) => SystemOneAnswer;
}

function prepare(q: SystemOneQuestion): Prepared {
  switch (q.type) {
    case "noul":
      return {
        question: { type: "boolean", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) },
        finish: (answer) => ({ type: "noul", noul: probability(ofType<"boolean">(answer).probability) }),
      };
    case "choice": {
      const options = Object.keys(q.criteria);
      return {
        question: { type: "choice", instructions: q.instructions, criteria: q.criteria },
        finish(answer) {
          const { choice, probabilities } = ofType<"choice">(answer);
          const p = normalise(options.map((o) => (probabilities === undefined ? (o === choice ? 1 : 0) : probabilities[o]!)));
          return { type: "choice", choice: options[argmax(p)]!, probabilities: Object.fromEntries(options.map((o, i) => [o, probability(p[i]!)])), confidence: choiceConfidence(p) };
        },
      };
    }
    case "score": {
      const levels = q.criteria.length;
      return {
        question: { type: "score", instructions: q.instructions, criteria: q.criteria },
        finish(answer) {
          const { score, probabilities } = ofType<"score">(answer);
          const p = normalise(probabilities === undefined ? levelWeights(levels, score) : q.criteria.map((_, i) => probabilities[String(i)]!));
          return {
            type: "score",
            score: p.reduce((sum, pi, i) => sum + i * pi, 0),
            legend: Object.fromEntries(q.criteria.map((level, i) => [String(i), level ?? String(i)])),
            probabilities: Object.fromEntries(p.map((pi, i) => [String(i), probability(pi)])),
            confidence: scoreConfidence(p),
          };
        },
      };
    }
  }
}

/** The signal a host passes to end a request's work early (an `AbortSignal`, as `experimental_evaluate` takes it): a port, not a global. */
export type SystemOneSignal = NonNullable<Parameters<typeof experimental_evaluate>[0]["abortSignal"]>;

/** Runs `fn` over `items`, `limit` at a time, keeping their order; no batch starts once `signal` has aborted. */
async function inBatches<T, R>(items: readonly T[], limit: number, signal: SystemOneSignal | undefined, fn: (item: T) => Promise<R>): Promise<R[]> {
  const waiting = [...items];
  const results: R[] = [];
  while (waiting.length > 0) {
    signal?.throwIfAborted();
    results.push(...(await Promise.all(waiting.splice(0, limit).map(fn))));
  }
  return results;
}

const tokens = (n: number | undefined): number => (Number.isFinite(n) ? Math.max(0, Math.round(n!)) : 0);

function problems(error: z.ZodError): SystemOneReply {
  const detail = error.issues.slice(0, MAX_PROBLEMS).map((issue) => ({ loc: ["body", ...(issue.path as (string | number)[])], msg: issue.message, type: issue.code }));
  return { status: 422, body: { detail } };
}

function parseRequest(body: unknown): { readonly request: SystemOneRequest } | { readonly reply: SystemOneReply } {
  const parsed = systemOneSchemas().request.safeParse(body);
  return parsed.success ? { request: parsed.data } : { reply: problems(parsed.error) };
}

export interface SystemOneHandling {
  /** The parsed JSON body of the request. */
  readonly body: unknown;
  readonly models: SystemOneModels;
  /** Questions in one request (default {@link SYSTEMONE_MAX_QUESTIONS}). */
  readonly maxQuestions?: number;
  /** Questions asked of the model at the same time (default {@link SYSTEMONE_CONCURRENCY}). */
  readonly concurrency?: number;
  /** Aborts when the caller is gone (the connection closed): no model call starts after it, and one in flight is cut short. */
  readonly signal?: SystemOneSignal;
}

/**
 * `POST /v1/systemone`: validates the request (422 with `detail[]`), asks the model each
 * question, and derives the answers from the probabilities it reports. A model that fails
 * or gives an unusable answer is a 502 `upstream_error`; a request can never cause a 5xx
 * of its own.
 */
export async function handleSystemOne(handling: SystemOneHandling): Promise<SystemOneReply> {
  const { body, models, maxQuestions = SYSTEMONE_MAX_QUESTIONS, concurrency = SYSTEMONE_CONCURRENCY, signal } = handling;
  if (!Number.isInteger(maxQuestions) || maxQuestions < 1) throw new RangeError(`maxQuestions must be a positive whole number, not ${maxQuestions}`);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`concurrency must be a positive whole number, not ${concurrency}`);
  const parsed = parseRequest(body);
  if ("reply" in parsed) return parsed.reply;
  const { request } = parsed;
  const entries = Object.entries(request.questions);
  if (entries.length > maxQuestions) return { status: 422, body: { detail: [{ loc: ["body", "questions"], msg: `at most ${maxQuestions} questions in a request`, type: "too_big" }] } };
  try {
    const requested = request.model ?? "latest";
    const served = models.resolve(requested);
    if (served === undefined) return systemOneError(404, "model_not_found", `no model ${requested} is served`);
    for (const [, q] of entries) {
      const kind = q.type === "noul" ? "boolean" : q.type;
      if (!served.model.supportedQuestionTypes.includes(kind)) return systemOneError(422, "unsupported_question_type", `${served.id} does not answer ${q.type} questions`);
    }
    const asked = await inBatches(entries, concurrency, signal, async ([, q]) => {
      const prepared = prepare(q);
      const result = await experimental_evaluate({ model: served.model, state: request.state, questions: { [QUESTION_ID]: prepared.question }, maxRetries: 0, ...(signal ? { abortSignal: signal } : {}) });
      return { answer: prepared.finish(result.answers[QUESTION_ID]!), usage: result.usage, response: { modelId: result.response.modelId, headers: result.response.headers } };
    });
    const who = [...new Set(asked.flatMap((a) => served.answeredBy?.(a.response) ?? []))].sort();
    const response: SystemOneResponse = {
      model: who.length === 0 ? served.id : who.join("+"),
      answers: Object.fromEntries(entries.map(([id], i) => [id, asked[i]!.answer])),
      usage: { input_tokens: asked.reduce((sum, a) => sum + tokens(a.usage.inputTokens), 0), output_tokens: asked.reduce((sum, a) => sum + tokens(a.usage.outputTokens), 0) },
    };
    return { status: 200, body: response };
  } catch (error) {
    // Nobody is left to read an answer, whatever the model made of being cut short.
    if (signal?.aborted) return systemOneError(499, "client_closed_request", "the client closed the request before it was answered");
    // The model refused the request itself (a limit of its own): the caller's problem, not an upstream failure.
    if (InvalidArgumentError.isInstance(error)) return systemOneError(422, "invalid_request", error.message);
    return systemOneError(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
