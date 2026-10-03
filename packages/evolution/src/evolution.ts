import type { Entropy } from "@harness/core";
import { compare, noiseBand } from "./compare.ts";
import type { Comparison } from "./compare.ts";
import { isFutile, permute, prefixSize } from "./futility.ts";
import { holdoutLevel, holdoutRemaining } from "./holdout.ts";
import { leaks } from "./leakage.ts";
import type { Task } from "./leakage.ts";
import { componentYield, paperStall, render, stalled, tried, verdictOf } from "./ledger.ts";
import type { LedgerRecord, Row } from "./ledger.ts";
import { measure, pool } from "./measure.ts";
import type { Measurement, TaskInfo, TaskRun } from "./measure.ts";
import { editBudget, minimumGroups, roundLevel } from "./schedule.ts";
import { DocumentsSchema, errorControlDifferences, errorControlKey, parse, parseSettings, StateSchema } from "./schemas.ts";
import type { Mechanism, Settings, State } from "./schemas.ts";
import { advance, calibratedDecision, choose, paperDecision } from "./select.ts";
import type { Decision, Measured } from "./select.ts";
import { applyProposal, ProposalSchema, revert } from "./surface.ts";
import type { AppliedEdit, Documents, Proposal, Surface } from "./surface.ts";

/** What the proposer is asked: the incumbent, the evidence, and this round's constraints. */
export interface ProposalRequest {
  readonly round: number;
  readonly candidate: string;
  /** b_t: at most this many independent edits. */
  readonly budget: number;
  readonly components: readonly string[];
  /** A reserved exploration slot: at least one edit must change one of these components. */
  readonly reserved?: readonly string[];
  readonly documents: Documents;
  /** The incumbent's score, its worst tasks (with what the verifier said) and its best (habits not to break). */
  readonly analysis: { readonly score: number; readonly failures: readonly TaskView[]; readonly successes: readonly TaskView[] };
  readonly history: readonly Row[];
  /** The accepted mechanisms the incumbent carries. */
  readonly mechanisms: readonly { readonly id: string; readonly round: number; readonly hypothesis: string; readonly components: readonly string[] }[];
  /** The paper's prune set B_t, under its rule: components whose recent edits all failed, with their accepted machinery. */
  readonly prune?: readonly { readonly component: string; readonly mechanisms: readonly string[] }[];
  /** Why the last proposal for this candidate was refused, to repair it. */
  readonly problems?: readonly string[];
  readonly previous?: unknown;
}

export interface TaskView {
  readonly task: string;
  readonly text: string;
  readonly score: number;
  readonly feedback?: string;
}

export interface CriticRequest {
  readonly edits: readonly AppliedEdit[];
  /** Some evolve tasks, so the critic can tell general practice from what only these tasks need. */
  readonly examples: readonly Task[];
}

export interface CriticVerdict {
  readonly accept: boolean;
  readonly reasons: readonly string[];
}

export interface EvolutionPorts {
  /** Run the harness these documents describe on the tasks, k trials each. */
  readonly evaluate: (documents: Documents, tasks: readonly Task[], k: number) => Promise<readonly TaskRun[]>;
  /** Draft a candidate: answers a Proposal (or, when it could not, a string saying why). */
  readonly propose: (request: ProposalRequest) => Promise<unknown>;
  readonly critic?: (request: CriticRequest) => Promise<CriticVerdict>;
  /** Non-compensatory domain criteria a candidate violates against the incumbent. */
  readonly guards?: (candidate: Measurement, incumbent: Measurement) => readonly string[];
  readonly entropy: Entropy;
}

/**
 * A task of the task set. `group` and `weight` are decided here, by whoever built the
 * split, and not by the evaluator: a run that reports another group or weight is refused,
 * and a task that has no run (a crash) keeps them. The weight (default 1) is the task's
 * share of the score (Harvey LAB weighs a task by its rubric criteria); the group (default:
 * the task itself) is the unit of generalization the tests flip.
 */
export type EvolveTask = Task & { readonly weight?: number };

export interface Split {
  readonly evolve: readonly EvolveTask[];
  /** Tasks the proposer never sees, queried only to confirm a winner (see holdout.ts). */
  readonly holdout?: readonly EvolveTask[];
}

export interface RoundReport {
  readonly round: number;
  readonly budget: number;
  readonly stalled: boolean;
  /** The per-test error level (calibrated rule). */
  readonly level?: number;
  readonly records: readonly LedgerRecord[];
  readonly accepted?: string;
}

interface Drafted {
  readonly label: string;
  readonly kind: "change" | "prune";
  readonly documents: Documents;
  readonly edits: readonly AppliedEdit[];
  readonly target?: Mechanism;
}

const LABELS = "ABCDEFGHIJKLMNOQRSTUVWXYZ";
const FORMAT = "harness.evolution/v1";

const describeEdits = (edits: readonly AppliedEdit[]): LedgerRecord["edits"] => edits.map((e) => ({ id: e.id, hypothesis: e.hypothesis, targets: e.targets, components: e.components, footprint: e.footprint, predicted: e.predicted }));

/** The fields of `fields` that have a value: an absent one is left out, not kept as a key holding undefined. */
function present<K extends string>(fields: Readonly<Record<K, number | undefined>>): { [P in K]?: number } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as { [P in K]?: number };
}

/** A drafted candidate's measurement and comparison, as selection sees it. */
function measuredOf(d: Drafted, m: Measurement, c: Comparison, guards: readonly string[]): Measured {
  return {
    label: d.label,
    kind: d.kind,
    score: m.score,
    ...present({ cost: m.cost }),
    gain: c.gain,
    lower: c.lower,
    upper: c.upper,
    ...present({ costChange: c.costChange, costLower: c.costLower, costUpper: c.costUpper }),
    components: [...new Set(d.edits.flatMap((e) => e.components))],
    guards,
  };
}

function checkDocuments(surface: Surface, documents: Documents): void {
  for (const [name, spec] of Object.entries(surface.documents)) {
    const result = spec.schema.safeParse(documents[name]);
    if (!result.success) throw new Error(`the base harness's ${name} does not parse: ${result.error.message}`);
    const problem = "kind" in spec && spec.kind === "text" ? spec.check?.(String(documents[name])) : undefined;
    if (problem !== undefined) throw new Error(`the base harness's ${name} fails its check: ${problem}`);
  }
}

/** What the task set says of each task (group and weight), refusing a weight that is not positive and finite and a task listed twice. */
function knownTasks(split: Split): ReadonlyMap<string, TaskInfo> {
  const known = new Map<string, TaskInfo>();
  // Stryker disable next-line ArrayDeclaration: equivalent; the extra element is a string with no id, so it is entered under the key undefined, which no task id (only ids are looked up) can ever match
  const held = split.holdout ?? [];
  for (const t of [...split.evolve, ...held]) {
    if (known.has(t.id)) throw new RangeError(`task ${t.id} is in the task set twice`);
    if (t.weight !== undefined && !(t.weight > 0 && Number.isFinite(t.weight))) throw new RangeError(`the weight of task ${t.id} must be positive and finite, not ${t.weight}`);
    known.set(t.id, { group: t.group ?? t.id, weight: t.weight ?? 1 });
  }
  return known;
}

/** The number of groups of tasks in an evolve set, a task with no group being its own. */
export function evolveGroups(tasks: readonly Task[]): number {
  return new Set(tasks.map((t) => t.group ?? t.id)).size;
}

/**
 * Under the calibrated rule a run whose evolve set has fewer groups than its smallest test
 * level can resolve would run to its end and accept nothing: refused up front instead. The
 * same holds for the holdout at its confirmation level. Groups are counted as given: which
 * of them the harnesses will differ on cannot be known up front, and a group on which they
 * never differ counts here but adds nothing that can certify a change, so this is a
 * necessary condition for certifying anything, not a sufficient one.
 */
function checkPower(settings: Settings, split: Split): void {
  const rule = settings.select;
  if (rule.rule !== "calibrated") return;
  let level = 1;
  for (let t = 0; t < settings.rounds; t++) level = Math.min(level, roundLevel(rule.alpha, t, settings.rounds, settings.candidates + 1, rule.spending));
  const needed = minimumGroups(level);
  const groups = evolveGroups(split.evolve);
  if (groups < needed) throw new Error(`the evolve set has ${groups} groups, and a run whose smallest test is at level ${Number(level.toPrecision(2))} needs at least ${needed} for any change to be certifiable: use more tasks, more groups, fewer rounds or candidates, or a larger alpha (groups are counted as given: a group on which the harnesses never differ counts here and certifies nothing)`);
  if (split.holdout?.length) {
    const beta = holdoutLevel(settings.holdout);
    const wanted = minimumGroups(beta);
    const held = evolveGroups(split.holdout);
    if (held < wanted) throw new Error(`the holdout has ${held} groups, and confirming at level ${Number(beta.toPrecision(2))} needs at least ${wanted}: use more holdout tasks or groups, a larger holdout.alpha or a smaller holdout.budget (groups are counted as given)`);
  }
}

/**
 * Regularized self-improvement of the harness's data: RRSI (Xia et al., 2026) on a
 * surface of JSON documents, with its proposal side as published (annealed edit budget,
 * the edit history in the proposer's context, exploration of unexercised components when
 * the run stalls, a leakage screen before evaluation) and its selection side either as
 * published (`select.rule: "paper"`) or calibrated (the default; see select.ts and ADR
 * 0014). A round draws candidates, screens them, measures them with the incumbent in the
 * same window on the evolve set, and accepts at most one; under the calibrated rule it
 * also tries removing one accepted mechanism (pruning by ablation), and confirms the winner
 * on the holdout (holdout.ts). State changes only when a round completes, so a round that
 * fails (an unreachable evaluator, an invalid evaluation) can be run again; every
 * evaluation of a failed round has settled by the time it throws.
 *
 * What the calibrated rule guarantees and what it does not. Every claim a candidate makes
 * (a gain, a saving, a removal's price, non-inferiority) is tested by a paired
 * randomization test on the evolve set at a level fixed in advance from (rounds,
 * candidates, alpha, spending), so that the probability, over the run, of accepting a
 * change for which some claim is false is at most alpha under the sharp null of each test:
 * "this harness and the incumbent are the same, and the two measurements are fresh noise on
 * the same tasks". That is a guarantee about the measurement, and it is what alpha means.
 * It is NOT a guarantee that a certified gain transfers to new tasks: the proposer reads the
 * failures of the evolve tasks, so the candidates are chosen by looking at the very data
 * they are tested on, and a change fitted to those tasks can be certified on them. Transfer
 * is addressed only by the holdout, which confirms the winner on tasks the proposer never
 * saw, within its own budget and error level; the leakage screen catches only copying. The
 * loss a run may take in total is bounded by the margin (a CUSUM of lower bounds, select.ts),
 * the cost by the certified gain; both hold at the same alpha. The settings that fix these
 * levels are kept in the state, and a restore with different ones is refused (the run's
 * alpha is spent against them). A state saved before that adopts the settings it is
 * restored with, and holds them from then on.
 */
export class Evolution {
  readonly #surface: Surface;
  readonly #settings: Settings;
  readonly #split: Split;
  readonly #known: ReadonlyMap<string, TaskInfo>;
  #state: State;

  constructor(options: { readonly surface: Surface; readonly settings: Settings; readonly split: Split; readonly saved: unknown }) {
    this.#surface = options.surface;
    this.#settings = parseSettings(options.settings);
    this.#split = options.split;
    this.#known = knownTasks(options.split);
    checkPower(this.#settings, options.split);
    const state = parse(StateSchema, "saved evolution", options.saved);
    // A run keeps the settings its error control was paid for with. A state saved before they were kept adopts the current ones.
    const key = errorControlKey(this.#settings);
    if (state.errorControl === undefined) this.#state = { ...state, errorControl: key };
    else {
      const different = errorControlDifferences(state.errorControl, key);
      if (different.length) throw new Error(`the saved run was made with different error-control settings (${different.join("; ")}): a run's alpha is spent against the levels of its tests, so these are kept to its end; start a new run to change them`);
      this.#state = state;
    }
  }

  /** Measure the base harness H_0 (twice, to calibrate the paper's delta when it is not given) and begin a run. */
  static async start(options: { readonly surface: Surface; readonly settings: Settings; readonly split: Split; readonly documents: Documents; readonly ports: Pick<EvolutionPorts, "evaluate" | "entropy"> }): Promise<Evolution> {
    const { surface, split, documents, ports } = options;
    const settings = parseSettings(options.settings);
    checkDocuments(surface, documents);
    const known = knownTasks(split);
    checkPower(settings, split);
    const k = settings.trials;
    const measureOn = async (tasks: readonly Task[]) => {
      const m = measure(await ports.evaluate(jsonCopy(documents), tasks, k), ids(tasks), k, known);
      if (m.missing > settings.invalid * m.expected) throw new Error(`the base harness's evaluation is invalid: ${m.missing} of ${m.expected} trials missing`);
      return m;
    };
    const base = await measureOn(split.evolve);
    const rule = settings.select;
    const delta = rule.rule === "paper" ? (rule.delta ?? noiseBand([base, await measureOn(split.evolve)], { z: rule.z ?? 2, resamples: 2000, entropy: ports.entropy }).delta) : undefined;
    const saved = {
      format: FORMAT,
      round: 0,
      documents: jsonCopy(documents),
      base,
      incumbent: [base],
      observed: base,
      ...(split.holdout?.length ? { holdout: { queries: 0 } } : {}),
      errorControl: errorControlKey(settings),
      ...(delta === undefined ? {} : { delta }),
      best: base.score,
      trajectory: [base.score],
      drift: 0,
      certified: 0,
      mechanisms: [],
      records: [],
    };
    return new Evolution({ surface, settings, split, saved });
  }

  /** Rounds completed. */
  get completed(): number {
    return this.#state.round;
  }

  get done(): boolean {
    return this.#state.round >= this.#settings.rounds;
  }

  /** The incumbent's documents: a copy, so what a caller does to it cannot corrupt the run. */
  get documents(): Documents {
    return jsonCopy(this.#state.documents);
  }

  get records(): readonly LedgerRecord[] {
    return this.#state.records;
  }

  get mechanisms(): readonly Mechanism[] {
    return this.#state.mechanisms;
  }

  /** The incumbent's evidence on the evolve set: its pooled fresh measurements (calibrated; none right after it was chosen), or the one it was chosen on (paper). */
  get incumbent(): Measurement | undefined {
    return this.#state.incumbent.length ? pool(this.#state.incumbent) : undefined;
  }

  get trajectory(): readonly number[] {
    return this.#state.trajectory;
  }

  save(): unknown {
    return this.#state;
  }

  /** One round: Algorithm 1 (proposal side), then selection. */
  async round(ports: EvolutionPorts): Promise<RoundReport> {
    if (this.done) throw new Error(`the run is over: ${this.#settings.rounds} rounds`);
    const state = this.#state;
    const settings = this.#settings;
    const rule = settings.select;
    const paper = rule.rule === "paper";
    const t = state.round;
    const k = settings.trials;
    const evolveIds = ids(this.#split.evolve);
    const known = this.#known;
    const budget = editBudget(t, settings.rounds, settings.budget.min, settings.budget.max);
    const isStalled = paper ? paperStall(state.trajectory, t, settings.explore.window, state.delta!) : stalled(state.records, t, settings.explore.window);
    const exercised = tried(state.records);
    const untried = this.#surface.components.filter((c) => !exercised.has(c));
    const reservedSlots = isStalled && untried.length ? settings.explore.reserved : 0;
    const records: LedgerRecord[] = [];

    // ---- proposal side ----------------------------------------------------------------
    const request = {
      round: t,
      budget,
      components: this.#surface.components,
      documents: state.documents,
      analysis: this.#analysis(state.observed),
      history: render(state.records, settings.analysis.history),
      mechanisms: state.mechanisms.map((m) => ({ id: m.id, round: m.round, hypothesis: m.hypothesis, components: m.components })),
      ...(paper ? { prune: this.#paperPrune(t, rule.prune) } : {}),
    };
    const drafted: Drafted[] = [];
    for (let v = 0; v < settings.candidates; v++) {
      const label = LABELS[v]!;
      const reserved = v >= settings.candidates - reservedSlots ? untried : undefined;
      const result = await this.#draft(ports, { ...request, candidate: label, ...(reserved ? { reserved } : {}) });
      if ("problems" in result) records.push({ round: t, candidate: label, kind: "change", edits: describeEdits(result.edits), outcome: "screened", reason: result.problems.join("; ") });
      else drafted.push({ label, kind: "change", documents: result.documents, edits: result.edits });
    }
    const ablation = paper ? undefined : this.#ablation(t);
    if (ablation && "documents" in ablation) drafted.push(ablation);

    // ---- measurement, in one window --------------------------------------------------
    // Under futility staging (calibrated rule) a drafted change is first evaluated on a
    // prefix of a random permutation of the evolve tasks, and only finished when it is not
    // clearly worse there; the incumbent is measured in full in the same window either way,
    // and ablations are never staged (see futility.ts for why this cannot add acceptances).
    const evolve = this.#split.evolve;
    // Only the calibrated rule has a futility and a margin (the paper rule's schema is strict): the defaults stand for the paper rule, which stages nothing and never reads the margin.
    const { futility, margin } = { futility: undefined, margin: 0, ...rule };
    const stage = futility === undefined ? evolve.length : prefixSize(futility.fraction, evolve.length);
    // Without a futility `stage` is evolve.length, so this is false then on its own.
    const staging = stage < evolve.length;
    const order = staging ? permute(evolve, ports.entropy) : evolve;
    const first = order.slice(0, stage);
    const later = order.slice(stage);
    const firstIds = ids(first);
    const jobs = [...(paper ? [] : [{ documents: state.documents, staged: false }]), ...drafted.map((d) => ({ documents: d.documents, staged: staging && d.kind === "change" }))];
    const firstRuns = await settled(jobs.map((j) => ports.evaluate(jsonCopy(j.documents), j.staged ? first : evolve, k)));
    const freshRuns = paper ? undefined : firstRuns.shift();
    const fresh = freshRuns && measure(freshRuns, evolveIds, k, known);
    if (fresh && fresh.missing > settings.invalid * fresh.expected) throw new Error(`the incumbent's evaluation is invalid: ${fresh.missing} of ${fresh.expected} trials missing; run the round again`);
    // A candidate is compared with the incumbent measured in the same window with as many
    // trials (which the randomization test needs to be exact); earlier measurements of the
    // incumbent are pooled only into its reported estimate.
    const reference = fresh ?? pool(state.incumbent);
    const estimate = pool(fresh ? [...state.incumbent, fresh] : state.incumbent);
    const level = rule.rule === "paper" ? 0.025 : roundLevel(rule.alpha, t, settings.rounds, settings.candidates + 1, rule.spending);
    const resamples = paper ? 400 : rule.resamples;
    const invalid = (m: Measurement) => m.missing > settings.invalid * m.expected;

    // First stage of the staged candidates: stop those clearly worse (upper bound below -margin) on the prefix.
    const stopped = new Map<number, { measurement: Measurement; against: Measurement; comparison: Comparison }>();
    const prefixed = new Map<number, Measurement>();
    const finishing: number[] = [];
    if (staging && futility) {
      const inPrefix = new Set(firstIds);
      const prefixReference = measure(
        freshRuns!.filter((r) => inPrefix.has(r.task)),
        firstIds,
        k,
        known,
      );
      drafted.forEach((d, i) => {
        if (d.kind !== "change") return;
        const m = measure(firstRuns[i]!, firstIds, k, known);
        prefixed.set(i, m);
        if (invalid(m)) return;
        const comparison = compare(m, prefixReference, { alpha: futility.alpha, resamples, entropy: ports.entropy });
        if (isFutile(comparison.upper, margin)) stopped.set(i, { measurement: m, against: prefixReference, comparison });
        else finishing.push(i);
      });
    }
    const secondRuns = new Map(await settled(finishing.map(async (i) => [i, await ports.evaluate(jsonCopy(drafted[i]!.documents), later, k)] as const)));
    // Each candidate's measurement on all the evolve tasks (its one evaluation, or its two stages merged: measure() counts a
    // task with no run as all its trials missing), or, for one that stopped or was invalid at the prefix, the prefix's.
    const evaluated = drafted.map((_, i) => (secondRuns.has(i) ? measure([...firstRuns[i]!, ...secondRuns.get(i)!], evolveIds, k, known) : (prefixed.get(i) ?? measure(firstRuns[i]!, evolveIds, k, known))));

    // ---- selection ---------------------------------------------------------------------
    const judged: { draft: Drafted; measurement: Measurement; against: Measurement; alpha: number; abandoned: boolean; candidate: Measured; decision: Decision }[] = [];
    drafted.forEach((d, i) => {
      const m = evaluated[i]!;
      const early = stopped.get(i);
      if (early) {
        const c = early.comparison;
        // Stryker disable next-line ArrayDeclaration: equivalent; an abandoned candidate's decision is fixed (inadmissible) just below, and its guards are read by nothing else (they are not in its record)
        const candidate = measuredOf(d, m, c, []);
        const reason = `abandoned for futility after ${stage} of ${evolve.length} evolve tasks: the gain's upper bound ${c.upper.toFixed(4)} (level ${c.alpha}) is below -${margin.toFixed(4)}, so it can be neither a supported gain nor non-inferior; the other ${later.length} tasks were not evaluated`;
        judged.push({ draft: d, measurement: m, against: early.against, alpha: c.alpha, abandoned: true, candidate, decision: { admissible: false, reason, verdict: verdictOf(candidate) } });
        return;
      }
      if (invalid(m)) {
        records.push({ round: t, candidate: d.label, kind: d.kind, edits: describeEdits(d.edits), outcome: "screened", reason: `evaluation invalid: ${m.missing} of ${m.expected} trials missing` });
        return;
      }
      const c = compare(m, reference, { alpha: level, resamples, entropy: ports.entropy });
      const candidate = measuredOf(d, m, c, ports.guards?.(m, reference) ?? []);
      const anchor = present({ cost: state.base.cost });
      const decision =
        rule.rule === "paper"
          ? paperDecision(candidate, { ...rule, delta: state.delta! }, { best: state.best, accepted: this.#acceptedComponents(), structural: this.#surface.structural })
          : calibratedDecision(candidate, rule, { drift: state.drift, certified: state.certified, anchor });
      judged.push({ draft: d, measurement: m, against: reference, alpha: level, abandoned: false, candidate, decision });
    });
    const chosen = choose(
      judged.map((j) => ({ candidate: j.candidate, decision: j.decision })),
      paper
        ? "score"
        : // Stryker disable next-line StringLiteral: equivalent; choose() reads anything but "score" as the lower bound
          "lower",
    );
    let winner = judged.find((j) => j.candidate === chosen);
    // The winner is put to the holdout: measured with the incumbent, fresh and in one window, and confirmed by the same test at the holdout's level (holdout.ts).
    let holdout: NonNullable<LedgerRecord["measured"]>["holdout"];
    const holdoutTasks = this.#split.holdout;
    let queries = state.holdout?.queries ?? 0;
    if (winner && !paper && holdoutTasks?.length) {
      const hs = settings.holdout;
      let confirmed = false;
      let why: string;
      if (queries >= hs.budget) {
        holdout = { confirmed, exhausted: true, remaining: 0 };
        why = "the holdout is spent: no change can be confirmed any more";
      } else {
        const level = holdoutLevel(hs);
        const both = await settled([ports.evaluate(jsonCopy(winner.draft.documents), holdoutTasks, k), ports.evaluate(jsonCopy(state.documents), holdoutTasks, k)]);
        const hIds = ids(holdoutTasks);
        const heldWinner = measure(both[0]!, hIds, k, known);
        const heldIncumbent = measure(both[1]!, hIds, k, known);
        // An invalid measurement is an outage, not evidence: it throws before anything is kept, and no query is spent.
        if (invalid(heldWinner)) throw new Error(`the holdout evaluation of candidate ${winner.draft.label} is invalid: ${heldWinner.missing} of ${heldWinner.expected} trials missing; run the round again`);
        if (invalid(heldIncumbent)) throw new Error(`the holdout evaluation of the incumbent is invalid: ${heldIncumbent.missing} of ${heldIncumbent.expected} trials missing; run the round again`);
        const answer = compare(heldWinner, heldIncumbent, { alpha: level, resamples, entropy: ports.entropy });
        // The claim being confirmed: a supported gain needs a holdout lower bound above zero; a saving or a removal, the same non-inferiority as on the evolve set (strictly above -margin).
        confirmed = winner.draft.kind === "change" && winner.candidate.lower > 0 ? answer.lower > 0 : answer.lower > -margin;
        queries++;
        holdout = { gain: answer.gain, lower: answer.lower, upper: answer.upper, level, confirmed, exhausted: false, remaining: holdoutRemaining({ queries }, hs) };
        // Not the holdout's numbers: the reason is what the proposer reads, and it may learn one bit of a query.
        why = "not confirmed on the holdout";
      }
      if (!confirmed) winner = { ...winner, decision: { ...winner.decision, admissible: false, reason: `${winner.decision.reason}; ${why}` } };
    }
    const accepted = winner?.decision.admissible ? winner : undefined;

    for (const j of judged) {
      const isWinner = winner !== undefined && j.draft.label === winner.draft.label;
      const decision = isWinner ? winner!.decision : j.decision;
      // An abandoned candidate was measured on a prefix only: a task it never ran is neither a hit nor a miss.
      const measuredTasks = new Set(j.measurement.tasks.map((x) => x.task));
      const predicted = [...new Set(j.draft.edits.flatMap((e) => e.predicted))].filter((p) => !j.abandoned || measuredTasks.has(p));
      // A task a measurement has no mean for (a predicted task that is no evolve task) has NaN, which no comparison holds for: it did not improve.
      const meanOf = (m: Measurement, task: string) => m.tasks.find((x) => x.task === task)?.mean ?? Number.NaN;
      const improved = (task: string) => meanOf(j.measurement, task) > meanOf(j.against, task);
      records.push({
        round: t,
        candidate: j.draft.label,
        kind: j.draft.kind,
        edits: describeEdits(j.draft.edits),
        outcome: accepted && isWinner ? "accepted" : decision.admissible ? "admissible" : "rejected",
        reason: decision.reason,
        measured: {
          score: j.measurement.score,
          ...present({ cost: j.measurement.cost }),
          gain: j.candidate.gain,
          lower: j.candidate.lower,
          upper: j.candidate.upper,
          alpha: j.alpha,
          // costUpper is absent while a cost change is present when it is unbounded (too few tasks reported tokens on both sides; JSON has no infinity).
          ...present({ costChange: j.candidate.costChange, costLower: j.candidate.costLower, costUpper: Number.isFinite(j.candidate.costUpper) ? j.candidate.costUpper : undefined }),
          verdict: verdictOf(j.candidate),
          hits: predicted.filter(improved),
          misses: predicted.filter((p) => !improved(p)),
          ...(isWinner && holdout ? { holdout } : {}),
        },
      });
    }

    // ---- the next state ------------------------------------------------------------------
    let mechanisms = state.mechanisms;
    if (ablation && "entangled" in ablation) mechanisms = mechanisms.map((m) => (m.id === ablation.entangled ? { ...m, entangled: true } : m));
    const target = drafted.find((d) => d.kind === "prune")?.target;
    // The accepted removal's own mechanism is marked too: the block below takes it out of the list.
    if (target) mechanisms = mechanisms.map((m) => (m.id === target.id ? { ...m, ablated: t } : m));
    let next: State;
    if (accepted) {
      const c = accepted.candidate;
      if (accepted.draft.kind === "prune") mechanisms = mechanisms.filter((m) => m.id !== accepted.draft.target!.id);
      else mechanisms = [...mechanisms, ...accepted.draft.edits.map((e) => ({ id: `r${t}${accepted.draft.label}.${e.id}`, round: t, hypothesis: e.hypothesis, components: e.components, changes: e.changes, lower: c.lower }))];
      next = {
        ...state,
        documents: jsonCopy(accepted.draft.documents),
        // The winner's own measurement is the luckiest of its round: under the calibrated rule it is not its evidence.
        incumbent: paper ? [accepted.measurement] : [],
        observed: accepted.measurement,
        best: Math.max(state.best, c.score),
        trajectory: [...state.trajectory, paper ? c.score : estimate.score],
        ...(paper ? {} : advance(state, c.lower)),
      };
    } else {
      next = { ...state, incumbent: fresh ? [...state.incumbent, fresh] : state.incumbent, observed: fresh ?? state.observed, trajectory: [...state.trajectory, estimate.score] };
    }
    this.#state = { ...next, ...(state.holdout || holdoutTasks?.length ? { holdout: { queries } } : {}), round: t + 1, mechanisms, records: [...state.records, ...records] };
    return { round: t, budget, stalled: isStalled, ...(paper ? {} : { level }), records, ...(accepted ? { accepted: accepted.draft.label } : {}) };
  }

  /** Ask for a candidate, and send it back with the reasons it was refused, up to `repair` times. */
  async #draft(ports: EvolutionPorts, request: ProposalRequest): Promise<{ documents: Documents; edits: readonly AppliedEdit[] } | { problems: readonly string[]; edits: readonly AppliedEdit[] }> {
    // Stryker disable next-line ArrayDeclaration: equivalent; the loop runs at least once, and every pass that does not return assigns problems before anything reads it
    let problems: readonly string[] = [];
    let previous: unknown;
    // Stryker disable next-line ArrayDeclaration: equivalent; the loop runs at least once, and every pass that does not return assigns edits before anything reads it
    let edits: readonly AppliedEdit[] = [];
    for (let attempt = 0; attempt <= this.#settings.repair; attempt++) {
      // Every call gets its own copy of the documents: a proposer that edits them in place must not change the state, nor what the next candidate is shown.
      const raw = await ports.propose({ ...(attempt === 0 ? request : { ...request, problems, previous }), documents: jsonCopy(request.documents) });
      previous = raw;
      const checked = await this.#screen(ports, request, raw);
      if (!("problems" in checked)) return checked;
      ({ problems } = checked);
      edits = checked.edits;
    }
    return { problems, edits };
  }

  async #screen(ports: EvolutionPorts, request: ProposalRequest, raw: unknown): Promise<{ documents: Documents; edits: readonly AppliedEdit[] } | { problems: readonly string[]; edits: readonly AppliedEdit[] }> {
    if (typeof raw === "string") return { problems: [`the proposer gave no proposal: ${raw}`], edits: [] };
    const parsed = ProposalSchema.safeParse(raw);
    if (!parsed.success) return { problems: [`the proposal is not one: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`], edits: [] };
    const proposal: Proposal = parsed.data;
    const applied = applyProposal(this.#surface, this.#state.documents, proposal, request.budget);
    if (applied.kind === "refused") return { problems: applied.problems, edits: [] };
    const problems: string[] = [];
    if (request.reserved && !applied.edits.some((e) => e.components.some((c) => request.reserved!.includes(c)))) problems.push(`this candidate holds a reserved exploration slot: at least one edit must change a component the run never exercised (${request.reserved.join(", ")}), judged by the paths it changes`);
    for (const e of applied.edits) for (const reason of leaks(e.changes, this.#split.evolve, this.#settings.leakage)) problems.push(`edit ${e.id} leaks the evolve set: ${reason}`);
    if (problems.length === 0 && ports.critic) {
      const verdict = await ports.critic({ edits: applied.edits, examples: this.#split.evolve.slice(0, this.#settings.critic.examples) });
      if (!verdict.accept) problems.push(...(verdict.reasons.length ? verdict.reasons : ["the critic refused it"]).map((r) => `critic: ${r}`));
    }
    return problems.length ? { problems, edits: applied.edits } : applied;
  }

  /** The removal of the accepted mechanism with the weakest evidence that is due an ablation, if it can still be removed on its own. */
  #ablation(t: number): Drafted | { entangled: string } | undefined {
    const { after, every } = this.#settings.prune;
    const due = this.#state.mechanisms
      .filter((m) => !m.entangled && t - m.round >= after && (m.ablated === undefined || t - m.ablated >= every))
      .sort((a, b) => a.lower - b.lower || a.round - b.round || a.id.localeCompare(b.id));
    const target = due[0];
    if (!target) return undefined;
    const reverted = revert(this.#surface, this.#state.documents, target.changes);
    if (reverted.kind === "refused") return { entangled: target.id };
    return { label: "P", kind: "prune", documents: reverted.documents, edits: [{ id: target.id, hypothesis: `prune: ${target.hypothesis}`, targets: "a mechanism that may no longer earn its place", predicted: [], changes: target.changes, components: target.components, footprint: 0 }], target };
  }

  #analysis(m: Measurement): ProposalRequest["analysis"] {
    const text = new Map(this.#split.evolve.map((t) => [t.id, t.text]));
    const view = (x: Measurement["tasks"][number]): TaskView => ({ task: x.task, text: text.get(x.task)!, score: x.mean, ...(x.feedback === undefined ? {} : { feedback: x.feedback }) });
    const ranked = [...m.tasks].sort((a, b) => a.mean - b.mean || a.task.localeCompare(b.task));
    const { failures, successes } = this.#settings.analysis;
    const worst = ranked.slice(0, failures).filter((x) => x.mean < 1);
    const best = ranked
      .slice(ranked.length - successes)
      .filter((x) => x.mean > 0 && !worst.includes(x))
      .reverse();
    return { score: m.score, failures: worst.map(view), successes: best.map(view) };
  }

  /** The paper's B_t, with the accepted mechanisms of each component. */
  #paperPrune(t: number, window: number): NonNullable<ProposalRequest["prune"]> {
    const g = componentYield(this.#state.records, t, window);
    return Object.keys(g)
      .filter((c) => g[c]! <= 0)
      .sort()
      .map((component) => ({ component, mechanisms: this.#state.mechanisms.filter((m) => m.components.includes(component)).map((m) => m.id) }));
  }

  #acceptedComponents(): Set<string> {
    return new Set(this.#state.records.filter((r) => r.outcome === "accepted" && r.kind === "change").flatMap((r) => r.edits.flatMap((e) => e.components)));
  }
}

const ids = (tasks: readonly Task[]) => tasks.map((t) => t.id);

/**
 * Promise.all, except that it waits for every promise to settle before it throws the
 * first rejection: when a round fails no evaluator keeps running in the background (they
 * are external processes and cost money), and a retry does not overlap the failed attempt.
 */
async function settled<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((r) => (r as PromiseFulfilledResult<T>).value);
}

/** Documents as the state keeps them: a copy, parsed as JSON. */
const jsonCopy = (documents: Documents): State["documents"] => parse(DocumentsSchema, "documents", JSON.parse(JSON.stringify(documents)));
