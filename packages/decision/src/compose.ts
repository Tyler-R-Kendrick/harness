/**
 * The decision layer, composed: one object a host builds from its ports and data, that owns
 * the runner (`Decider`), the registry of built-in forks, the calibration it keeps current,
 * the lifecycle of learned rules, the criteria archive, the attention inbox, and the
 * reports and loops that run over the log.
 *
 * What the layer does with what it owns:
 *
 * - **Forks.** `permission.risk`, `attention`, `stuck` and `dispatch` are registered with
 *   zod parsers for their inputs (so a wire operation can decide them by name). Each is
 *   wrapped twice: induced rules that have been promoted to `active` answer at rung 0 (the
 *   fork's own rule wins; an induced rule can never be less restrictive than the fork's
 *   floor, because the decider raises every verdict to the floor), and the active version
 *   of the fork's criteria text from the archive (when an evolution was accepted) is what
 *   its questions say.
 * - **Calibration.** The decider calibrates through an index that `calibrate` / `install`
 *   replace; `onCalibration` is told after every install so a host can persist the book.
 * - **Evidence.** Outcomes attached through `outcome` are evidence for every shadowed or
 *   active rule that covers the decision's input: a fit, a miss, or (when the outcome does
 *   not say whether the rule's action was right) nothing. It counts once per decision, however
 *   many outcomes arrive together (they are taken one at a time for a decision), and a
 *   replaced outcome does not count again. `induce` adds new rules as shadow candidates and
 *   feeds the outcomes already in the log to them once, leaving out the decisions the rules
 *   were induced from (sessionless ones too).
 *
 * Which records count as a confidence claim. `report` and `thresholds` look at decisions made
 * by a model or by the judge that took their verdict: a rule is certain by construction, a
 * person asked has no confidence (`0`), a generator's is not a probability, and the action
 * of an exploring decision, or one the authority's floor raised, is not the one the
 * confidence was given for. `estimate` takes the same decisions and weighs them by their
 * propensity, counting a floor-raised one at its raised action.
 *
 * Everything is pure: time and randomness come from the ports, persistence from callbacks.
 */
import type { Entropy } from "@harness/core";
import { z } from "zod";
import { ConditionSchema, evaluateCondition } from "./condition.ts";
import { fitBook, CalibrationIndex } from "./calibration.ts";
import { riskCoverageCurve, selectiveThreshold } from "./conformal.ts";
import type { RiskCoverageRow, SelectiveResult } from "./conformal.ts";
import { correctActionOf, induceRules, lifecycleRule, ruleFits, sessionsOf, shadowRules, stableJson, toExamples } from "./distill.ts";
import type { Example, InducedRule, InduceOptions } from "./distill.ts";
import { attentionFork, AttentionItemSchema, rankInbox } from "./attention.ts";
import type { AttentionItem, AttentionKind, AttentionSettings, RankedItem } from "./attention.ts";
import { dispatchFork } from "./dispatch.ts";
import type { DispatchSettings } from "./dispatch.ts";
import { epsilonGreedy, snips, uniform } from "./explore.ts";
import type { OffPolicyEstimate, OffPolicySample } from "./explore.ts";
import { criteriaFromFork, CriteriaArchive, evolve, withCriteria } from "./evolve.ts";
import type { CriteriaBook, EvolveResult, EvolveSettings, Proposer } from "./evolve.ts";
import { Decider, ForkRegistry } from "./fork.ts";
import type { DecideContext, Decision, DecisionEvent, ForkGenerator } from "./fork.ts";
import { Lifecycle, LIFECYCLE_STATES } from "./lifecycle.ts";
import type { Artefact, LifecycleSettings, LifecycleState } from "./lifecycle.ts";
import { permissionRiskFork } from "./permission.ts";
import type { PermissionRiskSettings } from "./permission.ts";
import { policyFor } from "./policy.ts";
import { canonicalJson, tookGreedy, tookVerdict } from "./records.ts";
import { stuckFork } from "./stuck.ts";
import type { StuckInput, StuckSettings } from "./stuck.ts";
import { DecisionError, ForkIdSchema, JsonSchema, ProbabilitySchema, RUNGS } from "./types.ts";
import type { Authority } from "./authority.ts";
import type {
  CalibrationBook,
  CalibrationEntry,
  Clock,
  DecisionFilter,
  DecisionId,
  DecisionLog,
  DecisionRecord,
  Fork,
  ForkId,
  ForkPolicy,
  Json,
  Member,
  Outcome,
  Policy,
  Rung,
} from "./types.ts";

// ---- parsing ----------------------------------------------------------------------------------------

/** A value through a schema, or a `DecisionError` (code `invalid`) that says what is wrong with it. */
function parseWith<T>(schema: z.ZodType<T>, what: string, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DecisionError("invalid", `invalid ${what}\n${z.prettifyError(result.error)}`);
  return result.data;
}

// ---- the built-in forks' inputs -----------------------------------------------------------------------

/** What `permission.risk` takes: the facts of a permission request. */
export const PermissionFactsSchema = z.strictObject({
  tool: z.string().min(1),
  kind: z.string().exactOptional(),
  command: z.string().exactOptional(),
  path: z.string().exactOptional(),
  url: z.string().exactOptional(),
  cwd: z.string().exactOptional(),
  session: z.string().exactOptional(),
  input: z.record(z.string(), JsonSchema).exactOptional(),
});

/** What `stuck` takes: the goal and the steps taken, oldest first. */
export const StuckInputSchema = z.strictObject({
  goal: z.string(),
  steps: z.array(z.strictObject({ action: z.string(), state: z.string().exactOptional(), progress: z.number().finite().exactOptional() })),
});

/** What `dispatch` takes: the context size, the tier the session is on, and what the task is. */
export const DispatchInputSchema = z.strictObject({
  context: z.number().finite().min(0),
  current: z.enum(["small", "large"]),
  task: z.string(),
  facts: z.record(z.string(), JsonSchema).exactOptional(),
});

// ---- induced rules on a fork --------------------------------------------------------------------------

/**
 * The fork with a second source of rung-0 answers: `induced`, asked about the fork's
 * description of the input, after the fork's own rule (which wins). An answer that is not
 * one of the actions the fork lists for the input (when it lists any) is ignored.
 */
export function withRules<In, Act extends Json>(fork: Fork<In, Act>, induced: (facts: Json) => Json | undefined): Fork<In, Act> {
  return {
    ...fork,
    rule: (input) => {
      const own = fork.rule?.(input);
      if (own !== undefined) return own;
      const answer = induced(fork.describe(input));
      // Stryker disable next-line ConditionalExpression: equivalent; an undefined answer is none of the listed actions, and is what is returned when none are listed
      if (answer === undefined) return undefined;
      const allowed = fork.actions?.(input);
      return allowed === undefined || allowed.some((action) => canonicalJson(action) === canonicalJson(answer)) ? (answer as Act) : undefined;
    },
  };
}

// ---- the standard label -------------------------------------------------------------------------------

/**
 * The option of a question that was right for a decision, from its outcome:
 *
 * 1. the outcome's `label`, when it is an object keyed by question id (a string, a number
 *    or a boolean, as the option's name);
 * 2. else, when the outcome says the decision was `correct`, the top option of the answer
 *    the verdict was taken from;
 * 3. else, when it says the decision was not correct and the question is a boolean, the
 *    other option;
 * 4. else undefined (a wrong choice or score says only that the top was not right).
 *
 * Rules 2 and 3 speak of the answers' own verdict, so they apply only to a decision that
 * took it: when the authority's floor raised the action or exploration replaced it, `correct`
 * is about another action than the one the answers were given for, and the decision has no
 * label (unless the outcome names one). A decision with no outcome, or no answer to the
 * question, has no label.
 */
export function standardLabelOf(record: DecisionRecord, question: string): string | undefined {
  const { outcome } = record;
  if (outcome === undefined) return undefined;
  const { label } = outcome;
  if (typeof label === "object" && label !== null && !Array.isArray(label) && Object.hasOwn(label, question)) {
    const named = (label as { readonly [key: string]: Json })[question];
    return typeof named === "string" ? named : typeof named === "number" || typeof named === "boolean" ? String(named) : undefined;
  }
  const answer = record.answers[question];
  if (answer === undefined || !tookVerdict(record)) return undefined;
  if (outcome.correct === true) return answer.top;
  if (outcome.correct === false && answer.type === "boolean") return answer.top === "true" ? "false" : "true";
  return undefined;
}

// ---- the attention inbox ---------------------------------------------------------------------------------

/**
 * What waits for a person's attention, across sessions: items by id (adding an id again
 * updates the item and keeps the earlier `since`, so adding is safe to repeat), resolved
 * when they are dealt with, ranked by `rankInbox`.
 */
export class AttentionInbox {
  readonly #settings: AttentionSettings;
  readonly #items = new Map<string, AttentionItem>();

  constructor(settings: AttentionSettings) {
    this.#settings = settings;
  }

  get size(): number {
    return this.#items.size;
  }

  /** Add an item, or update the one with its id (it keeps the earlier `since`). Returns the item as held. */
  add(item: AttentionItem): AttentionItem {
    const parsed = parseWith(AttentionItemSchema, "attention item", item);
    const known = this.#items.get(parsed.id);
    const held = known === undefined ? parsed : { ...parsed, since: Math.min(known.since, parsed.since) };
    this.#items.set(held.id, held);
    return { ...held };
  }

  get(id: string): AttentionItem | undefined {
    const held = this.#items.get(id);
    return held === undefined ? undefined : { ...held };
  }

  /** Take an item off the inbox; false when there was none. */
  resolve(id: string): boolean {
    return this.#items.delete(id);
  }

  /** Take off every item of a session (of the given kinds, when given); returns how many. */
  clearSession(session: string, kinds?: readonly AttentionKind[]): number {
    let cleared = 0;
    for (const [id, item] of this.#items) {
      if (item.session !== session || (kinds !== undefined && !kinds.includes(item.kind))) continue;
      this.#items.delete(id);
      cleared += 1;
    }
    return cleared;
  }

  /** The items, in the order added. */
  list(): AttentionItem[] {
    return [...this.#items.values()].map((item) => ({ ...item }));
  }

  /** The items, most in need of a person first, as of `now` (ms). */
  rank(now: number): RankedItem[] {
    return rankInbox(this.list(), this.#settings, now);
  }
}

// ---- options and results -----------------------------------------------------------------------------------

/** The data the built-in forks and loops are made from; a host loads each file and parses it (`parse…Settings`). */
export interface LayerSettings {
  readonly attention: AttentionSettings;
  readonly stuck: StuckSettings;
  readonly dispatch: DispatchSettings;
  readonly lifecycle: LifecycleSettings;
  readonly evolve: EvolveSettings;
  /** The permission-risk questions; the fork's minimal ones when absent. */
  readonly permission?: PermissionRiskSettings;
}

const StoredRuleSchema = z.strictObject({
  fork: ForkIdSchema,
  rule: z.strictObject({ id: z.string().min(1), when: ConditionSchema, action: JsonSchema, support: z.int().min(0), purity: ProbabilitySchema }),
});
/** A rule induced for a fork, as the layer keeps it next to its lifecycle entry (`<fork>:<rule id>`). */
export type StoredRule = z.output<typeof StoredRuleSchema>;

/** What the layer persists about learned rules: the lifecycle's snapshot and the rules it is about. */
export interface LayerLifecycleState {
  readonly lifecycle: ReturnType<Lifecycle["snapshot"]>;
  readonly rules: readonly StoredRule[];
}

const LayerLifecycleStateSchema = z.strictObject({ lifecycle: z.unknown(), rules: z.array(StoredRuleSchema) });

export interface DecisionLayerOptions {
  readonly log: DecisionLog;
  readonly clock: Clock;
  readonly entropy: Entropy;
  readonly policy: Policy;
  readonly settings: LayerSettings;
  /** The permission authority (nothing permitted, nothing forbidden when absent). */
  readonly authority?: Authority;
  /** The calibration to start from. */
  readonly calibration?: CalibrationBook;
  /** Told the book after every install, for persistence. */
  readonly onCalibration?: (book: CalibrationBook) => void | Promise<void>;
  /** In preference order. */
  readonly members: readonly Member[];
  readonly judge?: Member;
  readonly generator?: ForkGenerator;
  /** Where `decision.made` goes (the hook bus). */
  readonly publish?: (event: DecisionEvent) => void;
  /** Learned rules to start from (a state `onLifecycle` was given earlier). */
  readonly lifecycle?: LayerLifecycleState;
  /** Told the state whenever rules or their evidence change, for persistence. */
  readonly onLifecycle?: (state: LayerLifecycleState) => void | Promise<void>;
  /** The criteria archive to start from (`archive.snapshot()` of an earlier layer). */
  readonly archive?: unknown;
  /** Told the archive's snapshot whenever an evolution changed it, for persistence. */
  readonly onArchive?: (snapshot: ReturnType<CriteriaArchive["snapshot"]>) => void | Promise<void>;
  /** Fixed salt of the holdout split (default `harness`): not the evolver's to change. */
  readonly holdoutSalt?: string;
}

/** A member as the layer reports it: its own identity, and the model that answered its last call when that is another. */
export interface MemberInfo {
  readonly id: string;
  readonly version: string;
  readonly served?: { readonly id: string; readonly version: string };
}

export interface ForkInfo {
  readonly id: ForkId;
  readonly version: string;
  readonly policy: ForkPolicy;
  /** The criteria version in force when an evolution was accepted for the fork. */
  readonly criteria?: string;
  /** Induced rules of the fork by lifecycle state. */
  readonly rules: Readonly<Record<LifecycleState, number>>;
}

export interface LayerStatus {
  readonly policy: string;
  readonly forks: readonly ForkInfo[];
  readonly members: readonly MemberInfo[];
  readonly judge?: MemberInfo;
  readonly decisions: number;
  readonly calibration: { readonly entries: number };
  readonly lifecycle: Readonly<Record<LifecycleState, number>>;
  readonly inbox: number;
}

export interface ForkReport {
  readonly fork: ForkId;
  readonly decisions: number;
  readonly byRung: Readonly<Record<Rung, number>>;
  readonly byMode: Readonly<Record<"active" | "shadow", number>>;
  readonly explored: number;
  readonly withOutcome: number;
  /** Decisions whose outcome says whether they were right. */
  readonly judged: number;
  /** The share of those that were right; null when there are none. */
  readonly accuracy: number | null;
  /** The mean confidence over every decision of the fork (a report is made only for a fork that has some). */
  readonly meanConfidence: number;
  /** Decisions of a model or the judge that did not explore and were judged: what the next three are measured on. */
  readonly calibrated: number;
  /** Expected calibration error of their confidence against being right; null when there are none. */
  readonly ece: number | null;
  /** Ten equal bins of confidence (empty bins have n 0). */
  readonly reliability: readonly ReliabilityBin[];
  /** The risk of acting from the most confident down, at each distinct confidence. */
  readonly riskCoverage: readonly RiskCoverageRow[];
}

export interface ReliabilityBin {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  readonly confidence: number;
  readonly accuracy: number;
}

export interface ThresholdsResult extends SelectiveResult {
  readonly fork: ForkId;
  /** How many decisions it was worked out from. */
  readonly samples: number;
  /** The act threshold the fork has now. */
  readonly currentAct: number;
}

export interface PolicyValue extends OffPolicyEstimate {
  /** The act threshold this was estimated for. */
  readonly act: number;
  /** The share of the logged decisions the policy would have acted on. */
  readonly coverage: number;
}

export interface EstimateResult {
  readonly fork: ForkId;
  /** Logged decisions the estimate is from. */
  readonly samples: number;
  /** The accuracy of acted-on decisions under the target threshold. */
  readonly target: PolicyValue;
  /** ... and under the fork's current one. */
  readonly current: PolicyValue;
  /**
   * Whether the target's value is identified by the log. It is not when the target acts on
   * confidences below the fork's current `act` and verdicts the judge rejected were dropped
   * from the log's samples (a candidate the judge rejected ends at another rung and is not a
   * model verdict that can be valued): the target value is then the accuracy of the verdicts
   * the judge let through, which is higher than acting on them all would give.
   */
  readonly identifiable: boolean;
}

export interface InducedEntry {
  readonly key: string;
  readonly rule: InducedRule;
  /** False when the rule was already known (in any state) and so was left as it was. */
  readonly added: boolean;
  readonly state: LifecycleState;
}

export interface InduceResult {
  readonly fork: ForkId;
  /** Decisions of the fork the rules were induced from. */
  readonly records: number;
  readonly rules: readonly InducedEntry[];
  /** How much evidence the new rules took from the outcomes already in the log. */
  readonly observed: number;
}

export interface RuleEntry extends Artefact {
  readonly fork: ForkId;
  readonly rule: InducedRule;
}

export interface RulesResult {
  readonly rules: readonly RuleEntry[];
  readonly counts: Readonly<Record<LifecycleState, number>>;
}

export interface DecisionLayer {
  readonly settings: LayerSettings;
  readonly policy: Policy;
  readonly clock: Clock;
  /** The runner, for decisions made elsewhere (`recordExternal`) and the tool cascade. */
  readonly decider: Decider;
  readonly registry: ForkRegistry;
  readonly inbox: AttentionInbox;
  readonly archive: CriteriaArchive;
  readonly lifecycle: Lifecycle;

  decide<In, Act extends Json>(fork: Fork<In, Act>, input: In, ctx?: DecideContext): Promise<Decision<Act>>;
  decideNamed(fork: string, input: unknown, ctx?: DecideContext): Promise<Decision<Json>>;
  /** Register a fork of the host's own, wrapped like the built-in ones (induced rules, active criteria); `parse` turns a wire input into the fork's input. */
  register<In, Act extends Json>(fork: Fork<In, Act>, parse?: (input: unknown) => In): void;
  /** Attach an outcome; the evidence it gives rules is counted once per decision. False for a decision the log does not have. */
  outcome(id: DecisionId, outcome: Outcome): Promise<boolean>;
  record(id: DecisionId): Promise<DecisionRecord | undefined>;
  records(filter?: DecisionFilter): Promise<DecisionRecord[]>;

  members(): MemberInfo[];
  forks(): ForkInfo[];
  status(): Promise<LayerStatus>;

  report(fork?: ForkId, filter?: Omit<DecisionFilter, "fork">): Promise<ForkReport[]>;
  calibration(): CalibrationBook;
  /** Use this book from now on, and tell `onCalibration`. */
  install(book: CalibrationBook): Promise<void>;
  /** Fit a book from the outcomes in the log (see `standardLabelOf`), install it, and return the entries fitted now. */
  calibrate(options?: { readonly at?: number; readonly minSamples?: number }): Promise<CalibrationEntry[]>;
  thresholds(options: { readonly fork: ForkId; readonly targetRisk: number; readonly delta: number; readonly bound: "hoeffding" | "clopper-pearson" }): Promise<ThresholdsResult>;
  /**
   * Value of acting at a target `act` threshold, estimated off-policy (self-normalised IPS)
   * from the fork's judged model decisions, beside the value at the fork's current one. An
   * estimate for a target below the current threshold is identified only when the log holds
   * every verdict in between: the verdicts the judge rejected are not in the sample (they
   * end at the generator or a person), so there it is the accuracy of judge-filtered
   * verdicts, biased upward, and `identifiable` says so (false when the target is below the
   * current threshold and the log has candidates that were dropped after being put to the
   * judge, or that no judge could verify).
   */
  estimate(options: { readonly fork: ForkId; readonly target: Partial<ForkPolicy> }): Promise<EstimateResult>;
  distill(options: { readonly fork?: ForkId; readonly holdout: number; readonly salt?: string }): Promise<Example[]>;
  induce(options: { readonly fork: ForkId } & InduceOptions): Promise<InduceResult>;
  rules(fork?: ForkId): RulesResult;
  evolve(options: { readonly fork: ForkId; readonly proposer: Proposer; readonly member?: string; readonly initial?: CriteriaBook }): Promise<EvolveResult>;
  /** Make an earlier version of a fork's criteria the active one again. */
  rollback(fork: ForkId, version: string): Promise<void>;
}

// ---- statistics over records ---------------------------------------------------------------------------------------

const BINS = 10;
const ACTING_RUNGS: readonly Rung[] = ["model", "judge"];

interface Scored {
  readonly confidence: number;
  readonly correct: boolean;
}

/** Decisions that claimed a confidence and were judged: by a model or the judge, that took their verdict (no exploring, no floor raising it) and have an outcome that says right or wrong. */
function scoredOf(records: readonly DecisionRecord[]): Scored[] {
  return records.flatMap((r) => (ACTING_RUNGS.includes(r.rung) && !r.explored && tookVerdict(r) && r.outcome?.correct !== undefined ? [{ confidence: r.confidence, correct: r.outcome.correct }] : []));
}

function binsOf(samples: readonly Scored[]): ReliabilityBin[] {
  const cells = Array.from({ length: BINS }, () => ({ n: 0, confidence: 0, correct: 0 }));
  for (const { confidence, correct } of samples) {
    const cell = cells[Math.min(BINS - 1, Math.floor(confidence * BINS))]!;
    cell.n += 1;
    cell.confidence += confidence;
    if (correct) cell.correct += 1;
  }
  return cells.map((cell, bin) => ({ lo: bin / BINS, hi: (bin + 1) / BINS, n: cell.n, confidence: cell.n === 0 ? 0 : cell.confidence / cell.n, accuracy: cell.n === 0 ? 0 : cell.correct / cell.n }));
}

const zeroCounts = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;

function reportOf(fork: ForkId, records: readonly DecisionRecord[]): ForkReport {
  const byRung = zeroCounts(RUNGS);
  const byMode = zeroCounts(["active", "shadow"] as const);
  let explored = 0;
  let withOutcome = 0;
  let judged = 0;
  let right = 0;
  let confidence = 0;
  for (const r of records) {
    byRung[r.rung] += 1;
    byMode[r.mode] += 1;
    if (r.explored) explored += 1;
    if (r.outcome !== undefined) withOutcome += 1;
    if (r.outcome?.correct !== undefined) {
      judged += 1;
      if (r.outcome.correct) right += 1;
    }
    confidence += r.confidence;
  }
  const scored = scoredOf(records);
  const reliability = binsOf(scored);
  return {
    fork,
    decisions: records.length,
    byRung,
    byMode,
    explored,
    withOutcome,
    judged,
    accuracy: judged === 0 ? null : right / judged,
    meanConfidence: confidence / records.length,
    calibrated: scored.length,
    ece: scored.length === 0 ? null : reliability.reduce((sum, bin) => sum + bin.n * Math.abs(bin.accuracy - bin.confidence), 0) / scored.length,
    reliability,
    riskCoverage: riskCoverageCurve(scored),
  };
}

/** The probability of the decision's model verdict, when the record says it: a model's own confidence, or the best candidate the judge was asked about. */
function verdictConfidence(record: DecisionRecord): number | undefined {
  if (record.rung === "model") return record.confidence;
  if (record.rung !== "judge") return undefined;
  const candidates = record.trace.flatMap((step) => (step.rung === "model" && step.outcome === "to be verified" && step.confidence !== undefined ? [step.confidence] : []));
  return candidates.length === 0 ? undefined : Math.max(...candidates);
}

/** A model's verdict was good enough to be put to the judge (or would have been) and the decision did not end with the judge accepting it: the verdict is not a sample of any estimate. */
const droppedCandidate = (record: DecisionRecord): boolean => record.rung !== "judge" && record.trace.some((step) => step.rung === "model" && step.outcome === "to be verified");

function valueOf(samples: readonly { readonly record: DecisionRecord; readonly confidence: number }[], act: number): PolicyValue {
  const offPolicy: OffPolicySample[] = samples.map(({ record, confidence }) => ({
    reward: record.outcome!.correct === true ? 1 : 0,
    propensity: record.propensity,
    targetProbability: tookGreedy(record) && confidence >= act ? 1 : 0,
  }));
  const estimate = snips(offPolicy);
  const acted = offPolicy.filter((s) => s.targetProbability > 0).length;
  return { ...estimate, act, coverage: acted / samples.length };
}

// ---- the layer ---------------------------------------------------------------------------------------------------------

const keyOf = (fork: ForkId, rule: { readonly id: string }): string => `${fork}:${rule.id}`;

class Layer implements DecisionLayer {
  readonly settings: LayerSettings;
  readonly policy: Policy;
  readonly clock: Clock;
  readonly decider: Decider;
  readonly registry = new ForkRegistry();
  readonly inbox: AttentionInbox;
  readonly archive = new CriteriaArchive();
  readonly lifecycle: Lifecycle;

  readonly #options: DecisionLayerOptions;
  readonly #base = new Map<string, Fork<unknown, Json>>();
  readonly #rules = new Map<string, StoredRule>();
  /** The last outcome call of each decision still being attached, so that the next waits for it. */
  readonly #outcomes = new Map<DecisionId, Promise<undefined>>();
  #index: CalibrationIndex;

  constructor(options: DecisionLayerOptions) {
    this.#options = options;
    this.settings = options.settings;
    this.policy = options.policy;
    this.clock = options.clock;
    this.inbox = new AttentionInbox(options.settings.attention);
    this.lifecycle = new Lifecycle(options.settings.lifecycle);
    this.#index = new CalibrationIndex(options.calibration ?? { entries: [] });
    if (options.lifecycle !== undefined) this.#restoreLifecycle(options.lifecycle);
    if (options.archive !== undefined) this.archive.restore(options.archive);
    this.decider = new Decider({
      log: options.log,
      clock: options.clock,
      entropy: options.entropy,
      policy: options.policy,
      members: options.members,
      // Stryker disable next-line ConditionalExpression: equivalent; an option that is undefined is an option that is absent, to the decider
      ...(options.judge === undefined ? {} : { judge: options.judge }),
      // Stryker disable next-line ConditionalExpression: equivalent; as above
      ...(options.generator === undefined ? {} : { generator: options.generator }),
      // Stryker disable next-line ConditionalExpression: equivalent; as above
      ...(options.publish === undefined ? {} : { publish: options.publish }),
      calibrate: (key, answers) => this.#index.calibrate(key, answers),
      explorer: epsilonGreedy,
      rng: uniform(options.entropy),
      registry: this.registry,
    });
    this.register(permissionRiskFork(options.authority, options.settings.permission), (input) => parseWith(PermissionFactsSchema, "permission facts", input));
    this.register(attentionFork(options.settings.attention), (input) => parseWith(AttentionItemSchema, "attention item", input));
    this.register(stuckFork(options.settings.stuck), (input) => parseWith(StuckInputSchema, "stuck input", input) as StuckInput);
    this.register(dispatchFork(options.settings.dispatch), (input) => parseWith(DispatchInputSchema, "dispatch input", input));
  }

  // ---- forks: registered with induced rules and the active criteria applied ---------------------------------------

  register<In, Act extends Json>(fork: Fork<In, Act>, parse?: (input: unknown) => In): void {
    this.#base.set(fork.id, fork as unknown as Fork<unknown, Json>);
    const ruled = withRules(fork, (facts) => this.#induced(fork.id, facts));
    const archive = this.archive;
    /** The active criteria of the fork, when an evolution replaced the ones it started with. */
    const criteria = (): CriteriaBook | undefined => {
      const active = archive.active(fork.id);
      return active?.parent === undefined ? undefined : active.criteria;
    };
    const live: Fork<In, Act> = {
      ...ruled,
      ask: (input) => {
        const book = criteria();
        // Stryker disable next-line ConditionalExpression: equivalent; withCriteria(fork, undefined) throws, and the catch below asks the fork's own questions
        if (book === undefined) return fork.ask(input);
        try {
          return withCriteria(fork, book).ask(input);
        } catch {
          // criteria that no longer fit the questions (a corrupt archive) never stop a decision: the fork asks its own
          return fork.ask(input);
        }
      },
      get version() {
        const book = criteria();
        return book === undefined ? fork.version : withCriteria(fork, book).version;
      },
    };
    this.registry.register(live, parse);
  }

  /** The answer of the fork's active induced rules to its input as records describe it. */
  #induced(fork: ForkId, facts: Json): Json | undefined {
    const rules = [...this.#rules].filter(([, stored]) => stored.fork === fork).map(([key, stored]) => ({ ...stored.rule, id: key }));
    return lifecycleRule(this.lifecycle, rules)(facts);
  }

  #restoreLifecycle(state: LayerLifecycleState): void {
    const parsed = parseWith(LayerLifecycleStateSchema, "layer lifecycle state", state);
    try {
      this.lifecycle.restore(parsed.lifecycle);
    } catch (e) {
      throw new DecisionError("invalid", (e as Error).message);
    }
    for (const stored of parsed.rules) {
      const key = keyOf(stored.fork, stored.rule);
      if (this.lifecycle.state(key) === undefined) throw new DecisionError("invalid", `invalid layer lifecycle state\nthe rule ${key} has no lifecycle entry`);
      this.#rules.set(key, stored);
    }
  }

  async #saveLifecycle(): Promise<void> {
    await this.#options.onLifecycle?.({ lifecycle: this.lifecycle.snapshot(), rules: [...this.#rules.values()] });
  }

  // ---- deciding ----------------------------------------------------------------------------------------------------

  decide<In, Act extends Json>(fork: Fork<In, Act>, input: In, ctx?: DecideContext): Promise<Decision<Act>> {
    return this.decider.decide(fork, input, ctx);
  }

  decideNamed(fork: string, input: unknown, ctx?: DecideContext): Promise<Decision<Json>> {
    return this.decider.decideNamed(fork, input, ctx);
  }

  outcome(id: DecisionId, outcome: Outcome): Promise<boolean> {
    // One at a time for a decision: whether an outcome is the first is read from the log and then the outcome is attached, and two together would both read an empty one.
    const turn = (this.#outcomes.get(id) ?? Promise.resolve()).then(() => this.#attach(id, outcome));
    const settled = turn.then(
      () => undefined,
      () => undefined,
    );
    this.#outcomes.set(id, settled);
    // Stryker disable next-line ConditionalExpression,BlockStatement,ArrowFunction: equivalent; forgetting a settled decision only bounds the map's size (DCO10.12 kills `!==`, which forgets a decision whose outcome is still being attached)
    void settled.then(() => (this.#outcomes.get(id) === settled ? this.#outcomes.delete(id) : undefined));
    return turn;
  }

  async #attach(id: DecisionId, outcome: Outcome): Promise<boolean> {
    const before = await this.#options.log.get(id);
    const attached = await this.decider.outcome(id, outcome);
    // A first outcome is evidence for the rules that covered the decision; one that replaces another is not counted twice.
    const first = before !== undefined && before.outcome === undefined;
    if (attached && first) await this.#observe({ ...before, outcome });
    return attached;
  }

  /** What the outcome of a decision says to each rule that covers its input: a fit, a miss, or (when it does not say whether the rule's action was right) nothing. */
  async #observe(record: DecisionRecord): Promise<void> {
    let counted = false;
    for (const [key, stored] of this.#rules) {
      if (stored.fork !== record.fork || !evaluateCondition(stored.rule.when, record.input)) continue;
      const fit = ruleFits(record, stored.rule.action);
      if (fit === undefined) continue;
      // Stryker disable next-line ConditionalExpression: equivalent; evidence with an undefined session is evidence with none
      const seen = this.lifecycle.observe(key, { fit, ...(record.session === undefined ? {} : { session: record.session }) });
      if (seen.counted) counted = true;
    }
    if (counted) await this.#saveLifecycle();
  }

  record(id: DecisionId): Promise<DecisionRecord | undefined> {
    return this.#options.log.get(id);
  }

  records(filter?: DecisionFilter): Promise<DecisionRecord[]> {
    return this.#options.log.query(filter);
  }

  // ---- what the layer is made of ---------------------------------------------------------------------------------------

  members(): MemberInfo[] {
    return this.#options.members.map(infoOf);
  }

  forks(): ForkInfo[] {
    return this.registry.list().map((fork) => {
      const rules = zeroCounts(LIFECYCLE_STATES);
      for (const [key, stored] of this.#rules) if (stored.fork === fork.id) rules[this.lifecycle.state(key)!] += 1;
      const active = this.archive.active(fork.id);
      return { id: fork.id, version: fork.version, policy: policyFor(this.policy, fork.id), ...(active?.parent === undefined ? {} : { criteria: active.version }), rules };
    });
  }

  async status(): Promise<LayerStatus> {
    const lifecycle = zeroCounts(LIFECYCLE_STATES);
    for (const artefact of this.lifecycle.list()) lifecycle[artefact.state] += 1;
    return {
      policy: this.policy.version,
      forks: this.forks(),
      members: this.members(),
      ...(this.#options.judge === undefined ? {} : { judge: infoOf(this.#options.judge) }),
      decisions: await this.#options.log.size(),
      calibration: { entries: this.#index.book.entries.length },
      lifecycle,
      inbox: this.inbox.size,
    };
  }

  // ---- reports and thresholds -------------------------------------------------------------------------------------------------

  async report(fork?: ForkId, filter: Omit<DecisionFilter, "fork"> = {}): Promise<ForkReport[]> {
    // Stryker disable next-line ConditionalExpression: equivalent; a filter with an undefined fork is a filter without one
    const records = await this.#options.log.query({ ...filter, ...(fork === undefined ? {} : { fork }) });
    const byFork = new Map<ForkId, DecisionRecord[]>();
    for (const r of records) byFork.set(r.fork, [...(byFork.get(r.fork) ?? []), r]);
    return [...byFork].map(([id, forkRecords]) => reportOf(id, forkRecords));
  }

  calibration(): CalibrationBook {
    return this.#index.book;
  }

  async install(book: CalibrationBook): Promise<void> {
    this.#index = new CalibrationIndex(book);
    await this.#options.onCalibration?.(this.#index.book);
  }

  async calibrate(options: { readonly at?: number; readonly minSamples?: number } = {}): Promise<CalibrationEntry[]> {
    const at = options.at ?? this.clock.now();
    const records = await this.#options.log.query();
    // Stryker disable next-line ConditionalExpression: equivalent; fitBook takes an undefined minimum as it takes none
    const book = fitBook({ records, labelOf: standardLabelOf, at, ...(options.minSamples === undefined ? {} : { minSamples: options.minSamples }), index: this.#index });
    await this.install(book);
    return this.#index.book.entries.filter((entry) => entry.fitted.at === at);
  }

  async thresholds(options: { readonly fork: ForkId; readonly targetRisk: number; readonly delta: number; readonly bound: "hoeffding" | "clopper-pearson" }): Promise<ThresholdsResult> {
    const { fork, ...selective } = options;
    const samples = scoredOf(await this.#options.log.query({ fork }));
    return { ...selectiveThreshold(samples, selective), fork, samples: samples.length, currentAct: policyFor(this.policy, fork).act };
  }

  /** See `DecisionLayer.estimate`: below the current threshold the log does not identify the value (`identifiable`). */
  async estimate(options: { readonly fork: ForkId; readonly target: Partial<ForkPolicy> }): Promise<EstimateResult> {
    const { fork, target } = options;
    if (target.act === undefined) throw new DecisionError("invalid", "estimate needs the target act threshold: target.act");
    const records = await this.#options.log.query({ fork });
    const samples = records.flatMap((record) => {
      const confidence = verdictConfidence(record);
      return confidence === undefined || record.outcome?.correct === undefined ? [] : [{ record, confidence }];
    });
    if (samples.length === 0) throw new DecisionError("invalid", `no judged decisions of ${fork} to estimate from`);
    const currentAct = policyFor(this.policy, fork).act;
    // Below the current threshold the verdicts that were put to the judge and dropped would be acted on, and they are not in the sample.
    const identifiable = !(target.act < currentAct && records.some(droppedCandidate));
    return { fork, samples: samples.length, target: valueOf(samples, target.act), current: valueOf(samples, currentAct), identifiable };
  }

  // ---- the loops ----------------------------------------------------------------------------------------------------------------

  async distill(options: { readonly fork?: ForkId; readonly holdout: number; readonly salt?: string }): Promise<Example[]> {
    // Stryker disable next-line ConditionalExpression: equivalent; a filter with an undefined fork is a filter without one
    const records = await this.#options.log.query(options.fork === undefined ? {} : { fork: options.fork });
    return toExamples(records, { labelOf: standardLabelOf, holdout: options.holdout, salt: options.salt ?? this.#salt });
  }

  async induce(options: { readonly fork: ForkId } & InduceOptions): Promise<InduceResult> {
    const { fork, ...induceOptions } = options;
    this.registry.get(fork);
    const records = await this.#options.log.query({ fork });
    const induced = induceRules(records, induceOptions);
    const fresh = induced.filter((rule) => this.lifecycle.state(keyOf(fork, rule)) === undefined);
    for (const rule of fresh) this.#rules.set(keyOf(fork, rule), { fork, rule });
    const { observed } = shadowRules(
      this.lifecycle,
      fresh.map((rule) => ({ ...rule, id: keyOf(fork, rule) })),
      // A decision with no outcome says nothing but through a later rung's action, and those decisions are among the ones the rules were built from.
      records,
      // The rules fit what they were induced from: the sessions it came from, and the decisions of no session (a wire decision has none) whose right action is known, are not evidence.
      { builtFrom: sessionsOf(records), builtFromDecisions: records.filter((r) => correctActionOf(r) !== undefined).map((r) => r.id) },
    );
    await this.#saveLifecycle();
    return {
      fork,
      records: records.length,
      rules: induced.map((rule) => ({ key: keyOf(fork, rule), rule, added: fresh.includes(rule), state: this.lifecycle.state(keyOf(fork, rule))! })),
      observed,
    };
  }

  rules(fork?: ForkId): RulesResult {
    const rules = this.lifecycle.list().flatMap((artefact): RuleEntry[] => {
      const stored = this.#rules.get(artefact.key);
      return stored === undefined || (fork !== undefined && stored.fork !== fork) ? [] : [{ ...artefact, fork: stored.fork, rule: stored.rule }];
    });
    const counts = zeroCounts(LIFECYCLE_STATES);
    for (const entry of rules) counts[entry.state] += 1;
    return { rules, counts };
  }

  async evolve(options: { readonly fork: ForkId; readonly proposer: Proposer; readonly member?: string; readonly initial?: CriteriaBook }): Promise<EvolveResult> {
    const { fork: id, proposer } = options;
    const base = this.#base.get(id);
    if (base === undefined) throw new DecisionError("unknown-fork", `no fork is registered as ${id}`);
    const member = options.member === undefined ? this.#options.members[0] : this.#options.members.find((m) => m.id === options.member);
    if (member === undefined) throw new DecisionError("no-member", options.member === undefined ? "there is no member to replay decisions with" : `no member is named ${options.member}`);
    // Only decisions whose recorded input is the fork's input again can be replayed.
    const isInput = (state: Json): boolean => {
      try {
        this.registry.parse(id, state);
      } catch {
        return false;
      }
      return true;
    };
    const records = (await this.#options.log.query({ fork: id })).filter((r) => isInput(r.input));
    const before = JSON.stringify(this.archive.snapshot());
    try {
      if (this.archive.active(id) === undefined && options.initial !== undefined) {
        // The fork asks its own text until an attempt is accepted, so the incumbent that attempts are measured against must be that text.
        const sample = records[0];
        if (options.initial.fork !== id) throw new DecisionError("invalid", `the initial criteria are for "${options.initial.fork}", not for "${id}"`);
        if (sample === undefined) throw new DecisionError("invalid", `there are no decisions of ${id} to check the initial criteria against`);
        const asked = criteriaFromFork(base, this.registry.parse(id, sample.input), options.initial.version);
        if (stableJson(asked.questions as unknown as Json) !== stableJson(options.initial.questions as unknown as Json)) throw new DecisionError("invalid", `the initial criteria are not what ${id} asks now: evolution is measured against the text in use`);
      }
      if (this.archive.active(id) === undefined && options.initial === undefined) {
        const sample = records[0];
        if (sample === undefined) throw new DecisionError("invalid", `there are no decisions of ${id} to take its criteria from: pass the initial criteria`);
        this.archive.seed(criteriaFromFork(base, this.registry.parse(id, sample.input), "v0"));
      }
      return await evolve({
        fork: base,
        records,
        labelOf: (record) => correctActionOf(record),
        member,
        proposer,
        archive: this.archive,
        settings: this.settings.evolve,
        holdoutSalt: this.#salt,
        inputOf: (state) => this.registry.parse(id, state),
        // Stryker disable next-line ConditionalExpression: equivalent; evolve takes an undefined starting criteria as none
        ...(options.initial === undefined ? {} : { initial: options.initial }),
      });
    } finally {
      if (JSON.stringify(this.archive.snapshot()) !== before) await this.#options.onArchive?.(this.archive.snapshot());
    }
  }

  async rollback(fork: ForkId, version: string): Promise<void> {
    this.archive.rollback(fork, version);
    await this.#options.onArchive?.(this.archive.snapshot());
  }

  get #salt(): string {
    return this.#options.holdoutSalt ?? "harness";
  }
}

function infoOf(member: Member): MemberInfo {
  const served = member.served?.();
  return { id: member.id, version: member.version, ...(served === undefined ? {} : { served: { id: served.id, version: served.version } }) };
}

/** Build the decision layer from its ports, data and members. */
export function createDecisionLayer(options: DecisionLayerOptions): DecisionLayer {
  return new Layer(options);
}
