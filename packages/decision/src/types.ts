/**
 * The decision layer's shared vocabulary: the values every module and host agrees on.
 *
 * The layer sits between the chat layer (people, sessions, consent) and the inference
 * layer (generators, tools, workflows). It never generates text. It asks typed questions
 * (choice, score, boolean) of models that answer with probabilities, turns calibrated
 * answers into actions with code, and keeps a record of every decision so the layer can
 * be calibrated, audited and improved from its own outcomes.
 *
 * Values with invariants are refined types made only by parsing (ADR 0003).
 */
import type { Clock, Entropy } from "@harness/core";
import { ProbabilitySchema } from "@harness/cognitive";
import type { JudgeQuestion, Probability } from "@harness/cognitive";
import { z } from "zod";

export type { Clock, Entropy, JudgeQuestion, Probability };
export { ProbabilitySchema };

function refine<S extends z.ZodType>(schema: S, what: string): (value: unknown) => z.output<S> {
  return (value) => {
    const result = schema.safeParse(value);
    if (!result.success) throw new RangeError(`not ${what}: ${JSON.stringify(value)}\n${z.prettifyError(result.error)}`);
    return result.data;
  };
}

// ---- refined units ------------------------------------------------------------------------

/** Where a decision is made, e.g. `permission.risk`: lower-case words joined by dots or dashes. */
export const ForkIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/, "lower-case words joined by dots or dashes")
  .brand<"ForkId">();
export type ForkId = z.output<typeof ForkIdSchema>;
export const forkId = refine(ForkIdSchema, "a fork id");

/** A decision's id in its log: `dec-0`, `dec-1`, ... (never reused). */
// Stryker disable next-line Regex: equivalent; the template literal already anchors both ends, the pattern only rejects a sign or leading zeros
export const DecisionIdSchema = z.templateLiteral(["dec-", z.int().nonnegative()]).refine((id) => /^dec-(?:0|[1-9]\d*)$/.test(id), "dec- and a whole number with no sign or leading zeros");
export type DecisionId = z.output<typeof DecisionIdSchema>;

/** What being wrong (or asking, or waiting) costs, in whatever unit the loss matrix uses: finite and not negative. */
export const CostSchema = z.number().finite().min(0).brand<"Cost">();
export type Cost = z.output<typeof CostSchema>;
export const cost = refine(CostSchema, "a cost");

/** A calibration temperature: finite and positive (above 1 softens a distribution, below 1 sharpens it). */
export const TemperatureSchema = z.number().finite().positive().brand<"Temperature">();
export type Temperature = z.output<typeof TemperatureSchema>;
export const temperature = refine(TemperatureSchema, "a temperature");

/** Probabilities over one question's options sum to 1 within this. */
export const SUM_TOLERANCE = 1e-6;

// ---- JSON --------------------------------------------------------------------------------

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
export const JsonSchema: z.ZodType<Json> = z.json();

// ---- questions, states and answers ---------------------------------------------------------

/** What a decision model is shown: text, or JSON. */
export type State = string | { readonly [key: string]: Json } | readonly Json[];
export const StateSchema: z.ZodType<State> = z.union([z.string(), z.record(z.string(), JsonSchema), z.array(JsonSchema)]);

/** The AI SDK's evaluation questions (`experimental_evaluate`), by their id. */
export type Questions = Readonly<Record<string, JudgeQuestion>>;
/** A fork's ask: the state and the questions put about it. */
export interface Asked {
  readonly state: State;
  readonly questions: Questions;
}

// Stryker disable next-line EqualityOperator: equivalent; a sum exactly one tolerance from 1 cannot be built in floating point
const sumsToOne = (d: Readonly<Record<string, number>>): boolean => Math.abs(Object.values(d).reduce<number>((sum, p) => sum + p, 0) - 1) <= SUM_TOLERANCE;

/**
 * Probabilities over a question's options: the choices' names, `true` and `false` for a
 * boolean, or the score levels' indexes (`"0"`, `"1"`, ...). They sum to 1.
 */
export const DistributionSchema = z
  .record(z.string(), ProbabilitySchema)
  .refine((d) => Object.keys(d).length >= 2, "a question has at least two options")
  .refine(sumsToOne, "probabilities sum to 1");
export type Distribution = z.output<typeof DistributionSchema>;

/** One answered question, whatever its type: the distribution, its most probable option, and for scores the expected level. */
export const AnswerSchema = z.strictObject({
  type: z.enum(["choice", "score", "boolean"]),
  distribution: DistributionSchema,
  /** The option with the highest probability (the first of equals, in option order). */
  top: z.string(),
  /** A score's expected level: the sum of level × probability. */
  score: z.number().finite().exactOptional(),
});
export type Answer = z.output<typeof AnswerSchema>;
export type Answers = Readonly<Record<string, Answer>>;

// ---- members: where answers come from ------------------------------------------------------

/**
 * A source of answers with an identity: any AI SDK evaluation model wrapped with the
 * name and version that calibration and records are keyed by. The version is pinned
 * (never `latest`): calibration belongs to one version of one model.
 */
export interface Member {
  readonly id: string;
  readonly version: string;
  ask(asked: Asked): Promise<Answers>;
  /**
   * For a member that fails over between models (the ensemble): the answers to one ask
   * together with the id and version of the model that gave them (undefined when the member
   * cannot say), so that records and calibration name that model. The identity belongs to
   * the call and is not state of the member, so concurrent asks cannot mix them up. Absent
   * for a member that is always the same model.
   */
  askWithIdentity?(asked: Asked): Promise<{ readonly answers: Answers; readonly served: ModelIdentity | undefined }>;
  /**
   * The model that answered the member's most recent call, for status displays. It is
   * shared between calls, so a decision never reads its identity from here when the member
   * has `askWithIdentity`; for a member that has only this, the decider reads it after every
   * ask and abandons a rotation round when it changes.
   */
  served?(): ModelIdentity | undefined;
}

/** A model's id and the version its calibration belongs to. */
export interface ModelIdentity {
  readonly id: string;
  readonly version: string;
}

// ---- the escalation ladder -------------------------------------------------------------------

/** Cheapest first: code, a decision model, a verifier, a generator, a person. */
export const RUNGS = ["rule", "model", "judge", "generator", "human"] as const;
export type Rung = (typeof RUNGS)[number];
export const RungSchema = z.enum(RUNGS);

/** An action and the probability that it is right. */
export interface Verdict<Act> {
  readonly action: Act;
  readonly confidence: Probability;
}

/**
 * One place in a loop where a decision is needed. A fork is data plus pure functions:
 * what to ask, how calibrated answers become an action, and what a rule can decide
 * without any model. Actions the fork can take are ordered by restrictiveness when the
 * fork has an authority: a learned verdict may tighten what the authority allows, never
 * relax it (monotone authority).
 */
export interface Fork<In, Act> {
  readonly id: ForkId;
  /** Changes whenever the questions, criteria or interpretation do; recorded with every decision. */
  readonly version: string;
  /** What models are shown and asked about this input. */
  ask(input: In): Asked;
  /** Calibrated answers to an action and its confidence; undefined when they do not separate the options. */
  interpret(answers: Answers, input: In): Verdict<Act> | undefined;
  /** The input as records keep it: JSON, with anything private removed. */
  describe(input: In): Json;
  /** The safe action when no rung could decide: taken as the record's action while a person is asked. */
  fallback(input: In): Act;
  /** Rung 0: an action that needs no model, when the input decides itself. */
  rule?(input: In): Act | undefined;
  /** Puts an action to the judge rung as a boolean question named `correct`; without it the fork has no judge rung. */
  verify?(input: In, action: Act): Asked;
  /** Every action available for this input, for exploration (at random among those at least as restrictive as the floor). */
  actions?(input: In): readonly Act[];
  /** The least restrictive action the authority allows for this input; a verdict never goes below it. */
  floor?(input: In): Act | undefined;
  /** How restrictive an action is (higher is more restrictive); required with `floor`. */
  restrictiveness?(action: Act): number;
}

// ---- calibration -------------------------------------------------------------------------------

// A mutant of the discriminator or of a variant's fields makes zod refuse the union when this module loads, so nothing runs for a test to fail (Stryker's vitest runner counts that as survived); TYP2.13 holds what each variant parses.
// Stryker disable StringLiteral,ObjectLiteral: unobservable; see above
export const CalibratorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("identity") }),
  /** p_i ∝ p_i^(1/T): any question type. */
  z.strictObject({ kind: z.literal("temperature"), temperature: TemperatureSchema }),
  /** Platt scaling of a boolean's logit: p' = σ(a·logit(p) + b). */
  z.strictObject({ kind: z.literal("platt"), a: z.number().finite(), b: z.number().finite() }),
]);
// Stryker restore StringLiteral,ObjectLiteral
export type Calibrator = z.output<typeof CalibratorSchema>;

/** One member's calibration for one question of one fork, fitted on outcomes. */
export const CalibrationEntrySchema = z.strictObject({
  fork: ForkIdSchema,
  member: z.string().min(1),
  /** The member version this was fitted on; calibration is never applied to another. */
  version: z.string().min(1),
  question: z.string().min(1),
  calibrator: CalibratorSchema,
  fitted: z.strictObject({
    n: z.int().nonnegative(),
    at: z.int().nonnegative(),
    eceBefore: z.number().min(0).max(1),
    eceAfter: z.number().min(0).max(1),
    brierBefore: z.number().min(0).max(2),
    brierAfter: z.number().min(0).max(2),
  }),
});
export type CalibrationEntry = z.output<typeof CalibrationEntrySchema>;

export const CalibrationBookSchema = z.strictObject({
  $schema: z.string().exactOptional(),
  entries: z.array(CalibrationEntrySchema),
});
export type CalibrationBook = z.output<typeof CalibrationBookSchema>;

/** Which member's answers to which fork are being calibrated. */
export interface CalibrationKey {
  readonly fork: ForkId;
  readonly member: string;
  readonly version: string;
}
/** Calibrates a member's answers (unchanged when nothing was fitted for the key). */
export type Calibrate = (key: CalibrationKey, answers: Answers) => Answers;

// ---- policy: thresholds and modes, as data -----------------------------------------------------

export const ForkPolicySchema = z
  .strictObject({
    /** Calibrated confidence at or above which a model's verdict is taken as is. */
    act: ProbabilitySchema,
    /** At or above this (and below `act`) the judge is asked; below it the decision escalates. */
    verify: ProbabilitySchema,
    /** The judge's probability at or above which a verified verdict is accepted. */
    accept: ProbabilitySchema,
    /** How many rotations of a question's options are asked and averaged (position bias); 1 asks once. */
    rotate: z.int().min(1).max(16),
    /** The share of decisions taken at random among the options, with the propensity recorded. */
    explore: ProbabilitySchema,
    /** `shadow` decides and records but the caller does not act on it. */
    mode: z.enum(["active", "shadow"]),
  })
  .refine((p) => p.verify <= p.act, "verify must not be above act");
export type ForkPolicy = z.output<typeof ForkPolicySchema>;

export const PolicySchema = z.strictObject({
  $schema: z.string().exactOptional(),
  /** Recorded with every decision so a record says which thresholds produced it. */
  version: z.string().min(1),
  default: ForkPolicySchema,
  forks: z.record(ForkIdSchema, z.object({ act: ProbabilitySchema, verify: ProbabilitySchema, accept: ProbabilitySchema, rotate: z.int().min(1).max(16), explore: ProbabilitySchema, mode: z.enum(["active", "shadow"]) }).partial().strict()),
});
export type Policy = z.output<typeof PolicySchema>;

// ---- records -------------------------------------------------------------------------------------

export const TraceStepSchema = z.strictObject({
  rung: RungSchema,
  member: z.string().exactOptional(),
  outcome: z.string(),
  confidence: ProbabilitySchema.exactOptional(),
});
export type TraceStep = z.output<typeof TraceStepSchema>;

/** What became of a decision, said by whoever knows: a person, a verifier, a judge, the system. */
export const OutcomeSchema = z.strictObject({
  at: z.int().nonnegative(),
  source: z.enum(["human", "verifier", "judge", "system"]),
  kind: z.enum(["correct", "incorrect", "approved", "denied", "completed", "failed", "rated-good", "rated-bad", "overridden"]),
  /** Whether the decision was right, when that is known. */
  correct: z.boolean().exactOptional(),
  /** The action that would have been right, when it is known and differs. */
  label: JsonSchema.exactOptional(),
  by: z.string().exactOptional(),
});
export type Outcome = z.output<typeof OutcomeSchema>;

export const DecisionRecordSchema = z.strictObject({
  id: DecisionIdSchema,
  fork: ForkIdSchema,
  forkVersion: z.string(),
  at: z.int().nonnegative(),
  session: z.string().exactOptional(),
  /** The hook-bus saga this decision belongs to. */
  correlation: z.string().exactOptional(),
  input: JsonSchema,
  /** The rung that decided. */
  rung: RungSchema,
  member: z.string().exactOptional(),
  memberVersion: z.string().exactOptional(),
  /** The policy version whose thresholds applied. */
  policy: z.string(),
  /** Calibrated answers by question id (what the verdict was taken from). */
  answers: z.record(z.string(), AnswerSchema),
  /** The member's answers before calibration, when calibration changed them. */
  raw: z.record(z.string(), AnswerSchema).exactOptional(),
  /** The action the record is about: what was taken. It differs from `verdict` when the authority's floor raised it or exploration replaced it. */
  action: JsonSchema,
  /**
   * The action the ladder came to before the authority's floor and exploration: the one
   * `answers` and `confidence` are about, and the one a `correct` outcome vouches for only
   * when it is also the action. Absent in a record made without it, which is taken to have
   * acted on its verdict unless it explored.
   */
  verdict: JsonSchema.exactOptional(),
  /**
   * The action the policy takes without exploring (the verdict raised to the floor): what
   * an exploring draw has to land on to be the policy's own choice. Absent: as `verdict`.
   */
  greedy: JsonSchema.exactOptional(),
  confidence: ProbabilitySchema,
  /** The probability with which this action was chosen under the exploration policy; 1 when not exploring. */
  propensity: ProbabilitySchema,
  explored: z.boolean(),
  mode: z.enum(["active", "shadow"]),
  trace: z.array(TraceStepSchema),
  outcome: OutcomeSchema.exactOptional(),
});
export type DecisionRecord = z.output<typeof DecisionRecordSchema>;

/** The payload of the hook event `decision.made`. */
export const DecisionMadeSchema = z.strictObject({
  id: DecisionIdSchema,
  fork: ForkIdSchema,
  rung: RungSchema,
  action: JsonSchema,
  confidence: ProbabilitySchema,
  mode: z.enum(["active", "shadow"]),
});
export type DecisionMade = z.output<typeof DecisionMadeSchema>;

export interface DecisionFilter {
  readonly fork?: ForkId;
  readonly session?: string;
  readonly mode?: "active" | "shadow";
  /** Only records with (true) or without (false) an outcome. */
  readonly hasOutcome?: boolean;
  /** At or after / before this time (ms). */
  readonly since?: number;
  readonly until?: number;
  /** Only records after this id (paging, in id order). */
  readonly after?: DecisionId;
  readonly limit?: number;
}

/**
 * Where decisions are kept. Ids are assigned in append order and never reused. Every
 * backend (memory, a file, IndexedDB) meets one contract suite (`decisionLogContract`).
 */
export interface DecisionLog {
  /** The next id: strictly greater than every id appended before. */
  next(): Promise<DecisionId>;
  append(record: DecisionRecord): Promise<void>;
  /** Attach an outcome; a second outcome replaces the first. False when the decision is unknown. */
  outcome(id: DecisionId, outcome: Outcome): Promise<boolean>;
  get(id: DecisionId): Promise<DecisionRecord | undefined>;
  /** Matching records in id order. */
  query(filter?: DecisionFilter): Promise<DecisionRecord[]>;
  size(): Promise<number>;
}

export type DecisionErrorCode = "invalid" | "unknown-fork" | "no-member" | "refused" | "unavailable";

export class DecisionError extends Error {
  readonly code: DecisionErrorCode;
  constructor(code: DecisionErrorCode, message: string) {
    super(message);
    this.name = "DecisionError";
    this.code = code;
  }
}
