/**
 * The runner: forks, the escalation ladder, and the factories for common forks.
 *
 * A decision climbs only as far as it must: a rule, then each member in preference order
 * (a question's options rotated and averaged against position bias, answers calibrated by
 * the injected `Calibrate`), then a judge that verifies the best verdict that was not
 * confident enough to act on, then a generator, then a person. A rung that cannot answer
 * (unreachable, unusable answer) passes the decision up and the trace says why: `decide`
 * never throws for a model's failure, only for programmer errors.
 *
 * Monotone authority: when a fork has a floor (the least restrictive action its authority
 * allows for this input) the action is raised to it if it is less restrictive, whichever
 * rung produced it, and exploration only chooses among actions at least as restrictive.
 *
 * Exploration applies to what a learned rung chose (model, judge, generator). A rule is
 * deterministic and a question to a person is not a choice of the policy's, so neither
 * carries a propensity other than 1.
 */
import { probability } from "@harness/cognitive";
import type { Entropy } from "@harness/core";
import { uniform } from "./explore.ts";
import { averageAnswers, rotations } from "./member.ts";
import { argmax, margin } from "./distribution.ts";
import { policyFor } from "./policy.ts";
import { canonicalJson } from "./records.ts";
import { DecisionError, forkId } from "./types.ts";
import type {
  Answer,
  Answers,
  Asked,
  Calibrate,
  Clock,
  DecisionId,
  DecisionLog,
  DecisionMade,
  DecisionRecord,
  Fork,
  ForkId,
  ForkPolicy,
  Json,
  Member,
  Outcome,
  Policy,
  Probability,
  Rung,
  State,
  TraceStep,
  Verdict,
} from "./types.ts";

const ONE = probability(1);
const ZERO = probability(0);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---- the registry --------------------------------------------------------------------------------

/** Forks by id, each with the parser that turns untrusted input (from a wire operation) into the fork's input. */
export class ForkRegistry {
  readonly #entries = new Map<string, { readonly fork: Fork<unknown, Json>; readonly parse: ((input: unknown) => unknown) | undefined }>();

  register<In, Act extends Json>(fork: Fork<In, Act>, parse?: (input: unknown) => In): void {
    if (this.#entries.has(fork.id)) throw new DecisionError("refused", `fork ${fork.id} is already registered`);
    this.#entries.set(fork.id, { fork, parse });
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  get(id: string): Fork<unknown, Json> {
    const entry = this.#entries.get(id);
    if (entry === undefined) throw new DecisionError("unknown-fork", `no fork is registered as ${id}`);
    return entry.fork;
  }

  /** Registered forks, in registration order. */
  list(): Fork<unknown, Json>[] {
    return [...this.#entries.values()].map((entry) => entry.fork);
  }

  /** The input as the fork takes it: through its parser (an invalid error with the parser's message when it refuses), or as it is when it has none. */
  parse(id: string, input: unknown): unknown {
    this.get(id);
    const { parse } = this.#entries.get(id)!;
    if (parse === undefined) return input;
    try {
      return parse(input);
    } catch (e) {
      throw new DecisionError("invalid", messageOf(e));
    }
  }
}

// ---- the decider ---------------------------------------------------------------------------------------

/** What an exploration policy is given and answers: `epsilonGreedy` (explore.ts) has this shape. */
export type Explorer = <Act>(args: {
  readonly options: readonly Act[];
  readonly greedy: Act;
  readonly epsilon: number;
  readonly rng: () => number;
}) => { readonly choice: Act; readonly propensity: number; readonly explored: boolean };

/** The generator rung: an action from a model that generates, or nothing. */
export type ForkGenerator = <In, Act>(fork: Fork<In, Act>, input: In, asked: Asked) => Promise<Verdict<Act> | undefined>;

export interface DecideContext {
  readonly session?: string | undefined;
  /** The hook-bus saga this decision belongs to. */
  readonly correlation?: string | undefined;
}

export interface DecisionEvent {
  readonly type: "decision.made";
  readonly payload: DecisionMade;
  readonly sessionId?: string;
}

export interface DeciderOptions {
  readonly log: DecisionLog;
  readonly clock: Clock;
  /** Only needed to explore, when no `rng` is given. */
  readonly entropy?: Entropy;
  readonly policy: Policy;
  /** In preference order: the first to be confident enough decides. */
  readonly members: readonly Member[];
  /** Verifies verdicts that were not confident enough to act on. */
  readonly judge?: Member;
  readonly generator?: ForkGenerator;
  /** Identity by default. */
  readonly calibrate?: Calibrate;
  readonly explorer?: Explorer;
  /** Uniform draws in [0, 1). */
  readonly rng?: () => number;
  readonly publish?: (event: DecisionEvent) => void;
  /** For `decideNamed`. */
  readonly registry?: ForkRegistry;
}

export interface Decision<Act> {
  readonly id: DecisionId;
  readonly action: Act;
  readonly rung: Rung;
  readonly confidence: Probability;
  readonly mode: "active" | "shadow";
  /** False in shadow mode: the decision is recorded and the caller does not act on it. */
  readonly active: boolean;
  readonly explored: boolean;
  /** The ladder ran out: `action` is the fork's fallback, taken while a person is asked. */
  readonly needsHuman: boolean;
  readonly record: DecisionRecord;
}

/** A decision made elsewhere (the tool cascade), to be recorded and published like any other. */
export interface ExternalDecision {
  readonly fork: { readonly id: ForkId; readonly version: string };
  /** The input as records keep it. */
  readonly input: Json;
  readonly action: Json;
  readonly rung: Rung;
  readonly confidence: Probability;
  readonly trace: readonly TraceStep[];
  readonly member?: string | undefined;
  readonly memberVersion?: string | undefined;
  readonly session?: string | undefined;
  readonly correlation?: string | undefined;
}

interface Identity {
  readonly id: string;
  readonly version: string;
}

/** What produced the verdict: the member (the model that answered) and its calibrated answers, with the raw ones when calibration changed them. */
interface Source {
  readonly member: Identity;
  readonly answers: Answers;
  readonly raw?: Answers;
}

interface Climbed<Act> {
  readonly verdict: Verdict<Act>;
  readonly rung: Rung;
  readonly source?: Source;
}

/** Whether two sets of answers are the same, question by question and option by option. */
const sameAnswers = (a: Answers, b: Answers): boolean => JSON.stringify(a) === JSON.stringify(b);

export class Decider {
  readonly #options: DeciderOptions;
  readonly #rng: (() => number) | undefined;

  constructor(options: DeciderOptions) {
    this.#options = options;
    this.#rng = options.rng ?? (options.entropy === undefined ? undefined : uniform(options.entropy));
  }

  /** Decide a fork on an input: climb the ladder, keep the authority's floor, maybe explore, record and publish. */
  async decide<In, Act extends Json>(fork: Fork<In, Act>, input: In, ctx: DecideContext = {}): Promise<Decision<Act>> {
    const policy = policyFor(this.#options.policy, fork.id);
    const trace: TraceStep[] = [];
    const climbed = await this.#climb(fork, input, policy, trace);
    let action = climbed.verdict.action;

    const verdict = action;
    const rank = fork.restrictiveness;
    const floor = fork.floor?.(input);
    if (rank !== undefined && floor !== undefined && rank(floor) > rank(action)) {
      action = floor;
      trace.push({ rung: climbed.rung, outcome: `authority raised to ${canonicalJson(floor)}` });
    }
    const greedy = action;

    let propensity = ONE;
    let explored = false;
    if (policy.mode === "active" && policy.explore > 0 && this.#options.explorer !== undefined && this.#rng !== undefined && fork.actions !== undefined && climbed.rung !== "rule" && climbed.rung !== "human") {
      const options = this.#optionsFor(fork, input, action, floor);
      const greedy = options.find((option) => canonicalJson(option) === canonicalJson(action))!;
      const result = this.#options.explorer({ options, greedy, epsilon: policy.explore, rng: this.#rng });
      propensity = probability(result.propensity);
      explored = result.explored;
      action = result.choice;
      if (explored) trace.push({ rung: climbed.rung, outcome: `explored: chose ${canonicalJson(action)} (propensity ${propensity})` });
    }

    const record = await this.#write({
      fork,
      input: fork.describe(input),
      action,
      verdict,
      greedy,
      rung: climbed.rung,
      confidence: climbed.verdict.confidence,
      trace,
      policy,
      ctx,
      propensity,
      explored,
      member: climbed.source?.member,
      answers: climbed.source?.answers,
      raw: climbed.source?.raw,
    });
    return this.#decision(record, action, policy.mode);
  }

  /** Decide a registered fork by id on untrusted input (parsed by the fork's own parser). */
  async decideNamed(id: string, input: unknown, ctx: DecideContext = {}): Promise<Decision<Json>> {
    const registry = this.#options.registry;
    if (registry === undefined) throw new DecisionError("unavailable", "this decider has no fork registry, so it cannot decide a fork by name");
    return this.decide(registry.get(id), registry.parse(id, input), ctx);
  }

  /** Record and publish a decision made elsewhere; the fork's policy decides its mode. */
  async recordExternal(external: ExternalDecision): Promise<Decision<Json>> {
    const policy = policyFor(this.#options.policy, external.fork.id);
    const record = await this.#write({
      fork: external.fork,
      input: external.input,
      action: external.action,
      verdict: external.action,
      greedy: external.action,
      rung: external.rung,
      confidence: external.confidence,
      trace: [...external.trace],
      policy,
      ctx: { session: external.session, correlation: external.correlation },
      propensity: ONE,
      explored: false,
      member: external.member === undefined ? undefined : { id: external.member, version: external.memberVersion },
    });
    return this.#decision(record, external.action, policy.mode);
  }

  /** Attach an outcome to a decision (a second one replaces the first); false for a decision the log does not have. */
  outcome(id: DecisionId, outcome: Outcome): Promise<boolean> {
    return this.#options.log.outcome(id, outcome);
  }

  // ---- the ladder ----------------------------------------------------------------------------------

  async #climb<In, Act extends Json>(fork: Fork<In, Act>, input: In, policy: ForkPolicy, trace: TraceStep[]): Promise<Climbed<Act>> {
    if (fork.rule !== undefined) {
      const ruled = fork.rule(input);
      if (ruled !== undefined) {
        trace.push({ rung: "rule", outcome: "decided by rule", confidence: ONE });
        return { verdict: { action: ruled, confidence: ONE }, rung: "rule" };
      }
      trace.push({ rung: "rule", outcome: "no rule applies" });
    }

    const asked = fork.ask(input);
    let candidate: { readonly verdict: Verdict<Act>; readonly source: Source } | undefined;
    for (const member of this.#options.members) {
      let raw: Answers;
      let who: Identity;
      try {
        ({ answers: raw, who } = await this.#askRotated(member, asked, policy.rotate));
      } catch (e) {
        trace.push({ rung: "model", member: member.id, outcome: `failed: ${messageOf(e)}` });
        continue;
      }
      let answers: Answers;
      let verdict: Verdict<Act> | undefined;
      try {
        answers = this.#calibrate(fork, who, raw);
        verdict = fork.interpret(answers, input);
      } catch (e) {
        trace.push({ rung: "model", member: who.id, outcome: `unusable answer: ${messageOf(e)}` });
        continue;
      }
      if (verdict === undefined) {
        trace.push({ rung: "model", member: who.id, outcome: "answers do not separate the options" });
        continue;
      }
      const source: Source = { member: who, answers, ...(sameAnswers(answers, raw) ? {} : { raw }) };
      const acts = verdict.confidence >= policy.act;
      const verifies = verdict.confidence >= policy.verify;
      trace.push({ rung: "model", member: who.id, outcome: acts ? "accepted" : verifies ? "to be verified" : "below verify", confidence: verdict.confidence });
      if (acts) return { verdict, rung: "model", source };
      if (verifies && (candidate === undefined || verdict.confidence > candidate.verdict.confidence)) candidate = { verdict, source };
    }

    if (candidate !== undefined) {
      const accepted = await this.#verify(fork, input, candidate.verdict.action, policy, trace);
      if (accepted !== undefined) return { verdict: { action: candidate.verdict.action, confidence: accepted }, rung: "judge", source: candidate.source };
    }

    if (this.#options.generator !== undefined) {
      try {
        const generated = await this.#options.generator(fork, input, asked);
        if (generated !== undefined) {
          trace.push({ rung: "generator", outcome: "generated", confidence: generated.confidence });
          return { verdict: generated, rung: "generator" };
        }
        trace.push({ rung: "generator", outcome: "gave no verdict" });
      } catch (e) {
        trace.push({ rung: "generator", outcome: `failed: ${messageOf(e)}` });
      }
    }

    trace.push({ rung: "human", outcome: "a person is asked", confidence: ZERO });
    return { verdict: { action: fork.fallback(input), confidence: ZERO }, rung: "human" };
  }

  /** The judge's probability when it accepts the candidate action, undefined when it does not (or cannot). */
  async #verify<In, Act extends Json>(fork: Fork<In, Act>, input: In, action: Act, policy: ForkPolicy, trace: TraceStep[]): Promise<Probability | undefined> {
    const judge = this.#options.judge;
    if (fork.verify === undefined) {
      trace.push({ rung: "judge", outcome: "the fork has no verify question" });
      return undefined;
    }
    if (judge === undefined) {
      trace.push({ rung: "judge", outcome: "no judge available" });
      return undefined;
    }
    const asked = fork.verify(input, action);
    let who: Identity = judge;
    let p: Probability;
    try {
      const asking = await this.#askOnce(judge, asked);
      who = asking.who;
      const correct = this.#calibrate(fork, who, asking.answers)["correct"];
      if (correct === undefined || correct.type !== "boolean") {
        trace.push({ rung: "judge", member: who.id, outcome: "unusable answer, taken as p=0", confidence: ZERO });
        return undefined;
      }
      p = correct.distribution["true"]!;
    } catch (e) {
      trace.push({ rung: "judge", member: who.id, outcome: `failed, taken as p=0: ${messageOf(e)}`, confidence: ZERO });
      return undefined;
    }
    const accepted = p >= policy.accept;
    trace.push({ rung: "judge", member: who.id, outcome: accepted ? "accepted" : "rejected", confidence: p });
    return accepted ? p : undefined;
  }

  /**
   * One ask of a member, with the model that answered it: what the member says of that very
   * call (`askWithIdentity`), else what it says of its latest one (`served`, read straight
   * after the ask), else the member itself.
   */
  async #askOnce(member: Member, asked: Asked): Promise<{ readonly answers: Answers; readonly who: Identity }> {
    if (member.askWithIdentity !== undefined) {
      const { answers, served } = await member.askWithIdentity(asked);
      return { answers, who: served ?? member };
    }
    const answers = await member.ask(asked);
    return { answers, who: member.served?.() ?? member };
  }

  #calibrate<In, Act>(fork: Fork<In, Act>, who: Identity, answers: Answers): Answers {
    const calibrate = this.#options.calibrate;
    return calibrate === undefined ? answers : calibrate({ fork: fork.id, member: who.id, version: who.version }, answers);
  }

  /**
   * Ask a member, and again with each further rotation of every choice question's options
   * (as many as the policy asks for, and the question has distinct ones), averaging the
   * answers to each question. Questions that cannot be rotated are asked once. A member that
   * fails over between models may not change model within the round (the average would be
   * of two models' answers, recorded and calibrated as one's): that is a failure of the
   * member, which the ladder passes over.
   */
  async #askRotated(member: Member, asked: Asked, rotate: number): Promise<{ readonly answers: Answers; readonly who: Identity }> {
    const { answers: first, who } = await this.#askOnce(member, asked);
    const rotated = Object.entries(asked.questions)
      .map(([id, question]) => [id, rotations(question, rotate)] as const)
      .filter(([, list]) => list.length > 1);
    const collected = new Map<string, Answer[]>(rotated.map(([id]) => [id, first[id] === undefined ? [] : [first[id]]]));
    // with nothing to rotate there are no rounds beyond the first: the maximum of no lengths is -Infinity
    const rounds = Math.max(...rotated.map(([, list]) => list.length));
    for (let k = 1; k < rounds; k++) {
      const questions = Object.fromEntries(rotated.filter(([, list]) => list.length > k).map(([id, list]) => [id, list[k]!]));
      const next = await this.#askOnce(member, { state: asked.state, questions });
      if (next.who.id !== who.id || next.who.version !== who.version) throw new Error(`the member changed models within a rotation round: ${who.id}@${who.version}, then ${next.who.id}@${next.who.version}`);
      for (const id of Object.keys(questions)) if (next.answers[id] !== undefined) collected.get(id)!.push(next.answers[id]);
    }
    return { answers: { ...first, ...Object.fromEntries([...collected].filter(([, list]) => list.length > 0).map(([id, list]) => [id, averageAnswers(list)])) }, who };
  }

  // ---- exploration and records -----------------------------------------------------------------------

  /** The actions exploration may choose among: at least as restrictive as the floor, each once, the greedy one included. */
  #optionsFor<In, Act extends Json>(fork: Fork<In, Act>, input: In, greedy: Act, floor: Act | undefined): Act[] {
    const rank = fork.restrictiveness;
    const allowed = fork.actions!(input).filter((option) => floor === undefined || rank === undefined || rank(option) >= rank(floor));
    const options: Act[] = [];
    for (const option of [...allowed, greedy]) if (!options.some((seen) => canonicalJson(seen) === canonicalJson(option))) options.push(option);
    return options;
  }

  async #write(entry: {
    readonly fork: { readonly id: ForkId; readonly version: string };
    readonly input: Json;
    readonly action: Json;
    /** The ladder's verdict, and the action after the floor and before exploration (see the record's fields). */
    readonly verdict: Json;
    readonly greedy: Json;
    readonly rung: Rung;
    readonly confidence: Probability;
    readonly trace: TraceStep[];
    readonly policy: ForkPolicy;
    readonly ctx: DecideContext;
    readonly propensity: Probability;
    readonly explored: boolean;
    /** The model behind the action, when one made it (a decision made elsewhere may not know its version). */
    readonly member: { readonly id: string; readonly version?: string | undefined } | undefined;
    /** That model's calibrated answers, and its raw ones when calibration changed them. */
    readonly answers?: Answers | undefined;
    readonly raw?: Answers | undefined;
  }): Promise<DecisionRecord> {
    const { member, ctx } = entry;
    const record: DecisionRecord = {
      id: await this.#options.log.next(),
      fork: entry.fork.id,
      forkVersion: entry.fork.version,
      at: this.#options.clock.now(),
      ...(ctx.session === undefined ? {} : { session: ctx.session }),
      ...(ctx.correlation === undefined ? {} : { correlation: ctx.correlation }),
      input: entry.input,
      rung: entry.rung,
      ...(member === undefined ? {} : { member: member.id, ...(member.version === undefined ? {} : { memberVersion: member.version }) }),
      policy: this.#options.policy.version,
      answers: entry.answers ?? {},
      ...(entry.raw === undefined ? {} : { raw: entry.raw }),
      action: entry.action,
      verdict: entry.verdict,
      greedy: entry.greedy,
      confidence: entry.confidence,
      propensity: entry.propensity,
      explored: entry.explored,
      mode: entry.policy.mode,
      trace: entry.trace,
    };
    await this.#options.log.append(record);
    this.#options.publish?.({
      type: "decision.made",
      payload: { id: record.id, fork: record.fork, rung: record.rung, action: record.action, confidence: record.confidence, mode: record.mode },
      ...(ctx.session === undefined ? {} : { sessionId: ctx.session }),
    });
    return record;
  }

  #decision<Act>(record: DecisionRecord, action: Act, mode: "active" | "shadow"): Decision<Act> {
    return { id: record.id, action, rung: record.rung, confidence: record.confidence, mode, active: mode === "active", explored: record.explored, needsHuman: record.rung === "human", record };
  }
}

// ---- factories for common forks ---------------------------------------------------------------------------

export interface ChooseOneOptions<In> {
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
  /** Option key to what it means. */
  readonly options: Readonly<Record<string, string>>;
  /** A "none of these" option: when it is the top, the action is its key. */
  readonly none?: { readonly key: string; readonly description: string };
  readonly describe: (input: In) => Json;
  /** What the model is shown. */
  readonly text: (input: In) => State;
  readonly fallback: (input: In) => string;
}

/**
 * A fork that picks one of a set of options (or none of them): one choice question named
 * `choice`. The verdict is the top option, with its probability as confidence, and only
 * when it leads the runner-up at all (a tie says nothing).
 */
export function chooseOne<In>(options: ChooseOneOptions<In>): Fork<In, string> {
  const criteria: Record<string, string> = { ...options.options };
  if (options.none !== undefined) {
    if (Object.hasOwn(criteria, options.none.key)) throw new DecisionError("invalid", `the none option "${options.none.key}" is also one of the options`);
    criteria[options.none.key] = options.none.description;
  }
  const keys = Object.keys(criteria);
  if (keys.length < 2) throw new DecisionError("invalid", `a choice needs at least two options, got ${keys.length}`);
  return {
    id: forkId(options.id),
    version: options.version,
    ask: (input) => ({ state: options.text(input), questions: { choice: { type: "choice", instructions: options.instructions, criteria } } }),
    interpret: (answers) => {
      const answer = answers["choice"];
      if (answer === undefined || answer.type !== "choice" || !(margin(answer.distribution) > 0)) return undefined;
      const top = argmax(answer.distribution);
      return { action: top, confidence: answer.distribution[top]! };
    },
    describe: options.describe,
    fallback: options.fallback,
    actions: () => keys,
  };
}

export interface BooleanGateOptions<In, Act> {
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
  readonly criteria?: { readonly true?: string | null; readonly false?: string | null };
  /** What the model is shown. */
  readonly state: (input: In) => State;
  readonly whenTrue: Act;
  readonly whenFalse: Act;
  readonly describe: (input: In) => Json;
  readonly fallback: (input: In) => Act;
  readonly floor?: (input: In) => Act | undefined;
  readonly restrictiveness?: (action: Act) => number;
}

/** A fork over one yes/no question named `gate`: `whenTrue` above one half and `whenFalse` below, at confidence max(p, 1-p). */
export function booleanGate<In, Act extends Json>(options: BooleanGateOptions<In, Act>): Fork<In, Act> {
  if (options.floor !== undefined && options.restrictiveness === undefined) throw new DecisionError("invalid", "a floor needs a restrictiveness to rank actions by");
  return {
    id: forkId(options.id),
    version: options.version,
    ask: (input) => ({
      state: options.state(input),
      questions: { gate: { type: "boolean", instructions: options.instructions, ...(options.criteria === undefined ? {} : { criteria: options.criteria }) } },
    }),
    interpret: (answers) => {
      const answer = answers["gate"];
      if (answer === undefined || answer.type !== "boolean") return undefined;
      const p = answer.distribution["true"]!;
      return p >= 0.5 ? { action: options.whenTrue, confidence: p } : { action: options.whenFalse, confidence: answer.distribution["false"]! };
    },
    describe: options.describe,
    fallback: options.fallback,
    actions: () => [options.whenTrue, options.whenFalse],
    ...(options.floor === undefined ? {} : { floor: options.floor }),
    ...(options.restrictiveness === undefined ? {} : { restrictiveness: options.restrictiveness }),
  };
}
