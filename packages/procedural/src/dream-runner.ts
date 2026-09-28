/**
 * Runs a dream (plan §7.1): drives the pure reducer (`dream.ts`) through its ports,
 * appends every event to the graph's dream log, and holds the graph's lease.
 *
 * - **Replay.** The log holds a `started` entry (the references the input is rebuilt
 *   from: G₀, the overlay log offset, the remembered rejections, the training tasks and
 *   the stride) and one `event` entry per finished command. A run replays the last dream
 *   that has not finished and re-issues only its unfinished command.
 * - **Idempotent writes.** A re-issued commit finds the head already moved to its
 *   record; a re-issued rebase finds its `rebased` event already in the overlay log; a
 *   re-issued rejection puts the same record again.
 * - **The lease.** A run acquires the graph's lease and renews it before every command
 *   and before appending every event, so a run whose epoch went stale stops before it
 *   writes anything: a stale epoch cannot commit.
 * - **Commits** put the record, then move the head by compare-and-set. When another
 *   writer moved the head meanwhile, the record is put again as rejected by `head`, and
 *   the dream ends.
 */
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { ToolSpec, Workflow } from "@harness/workflows";
import { compilePath, composeCandidate, pathCandidates, recordedRuns } from "./compose.ts";
import type { CompositionSettings, WorkflowBinding } from "./compose.ts";
import { DreamEventSchema, dreamStart, dreamStep } from "./dream.ts";
import type { DreamCommand, DreamComposition, DreamEvent, DreamInput, DreamOutcome, DreamRefineRequest, DreamState, RolloutResult, Tokenizer } from "./dream.ts";
import { DreamIdSchema, parseGraph, revisionId, RevisionIdSchema } from "./graph.ts";
import type { DreamId, GraphId, ProceduralGraph, RevisionId, RevisionRecord } from "./graph.ts";
import { foldAll, rebaseOverlay } from "./overlay.ts";
import { refine } from "./refine.ts";
import type { RefineResult } from "./refine.ts";
import type { Preset, Settings } from "./settings.ts";
import type { ProceduralStore } from "./store.ts";
import type { ScoredTrajectory } from "./trajectory.ts";

/** Scores a graph on a replayable task set (plan §10): the paper's Rollout and Evaluate. */
export interface Evaluator {
  /** Per-task scores in [0, 1]; for training rollouts, with each task's query and steps when kept. */
  evaluate(graph: ProceduralGraph, split: "train" | "validation", batch?: readonly string[]): Promise<readonly RolloutResult[]>;
  /** The task ids of a split, in order (strides are taken from the training tasks). */
  tasks(split: "train" | "validation"): Promise<readonly string[]>;
}

export interface Refiner {
  refine(request: DreamRefineRequest): Promise<RefineResult>;
}

export interface Approver {
  /** Accept or decline a candidate (the daemon's permission flow, bound to the candidate's id). */
  approve(request: { graph: GraphId; candidate: RevisionRecord; tools: readonly string[] }): Promise<boolean>;
}

/**
 * Where candidates that need approval wait when there is no approver to ask during the
 * dream (the daemon, where the permission flow belongs to a session's turn): the runner
 * stores each as `pending-approval`, the approvals inbox, and tells the inbox, which
 * announces it (a hook event on the daemon). Deciding happens later, outside the dream.
 */
export interface ApprovalInbox {
  pending(request: { graph: GraphId; candidate: RevisionRecord; tools: readonly string[] }): Promise<void>;
}

/** Recorded trajectories under a revision, from the session log's projections. */
export interface TrajectorySource {
  select(request: { graph: GraphId; revision: RevisionId; limit: number }): Promise<readonly ScoredTrajectory[]>;
}

/**
 * What composition needs (plan §7.6): which paths qualify, the input schemas of the tools a
 * compiled path may call, and where a compiled workflow is staged (a `StagingLibrary`)
 * until a revision binds it.
 */
export interface Composer {
  settings: CompositionSettings;
  toolSpecs: Readonly<Record<string, ToolSpec>>;
  staging: { stage(workflow: Workflow): Promise<WorkflowBinding> };
  /** Recorded trajectories under the head that compiling reads its runs from (default `DEFAULT_SELECT`). */
  runs?: number;
}

export interface DreamPorts {
  refiner: Refiner;
  evaluator?: Evaluator;
  approver?: Approver;
  /** Without an approver, candidates that need approval wait here instead of being rejected. */
  inbox?: ApprovalInbox;
  /** With one, and `compose` in the dream settings, a dream ends with a composition round. */
  composer?: Composer;
  trajectories: TrajectorySource;
  clock: { now(): number };
  entropy: { bytes(length: number): Uint8Array };
}

export interface RunDreamOptions {
  store: ProceduralStore;
  graph: GraphId;
  /** The preset whose `dream` (and, with an overlay, `live`) settings the dream follows. */
  settings: Preset;
  ports: DreamPorts;
  /** `{task_description}` for the refiner. */
  task?: string;
  /** The tool catalog. */
  tools?: readonly string[];
  /** Tools declared free of side effects. */
  sideEffectFree?: readonly string[];
  /** Tasks per round with an evaluator, or trajectories selected per round; overrides the settings' `stride` (default: the training tasks once over the rounds, or `DEFAULT_SELECT`). */
  stride?: number;
  /** The refiner's tokenizer, so `contextTokens` counts its tokens (default: whitespace-separated words). */
  tokenizer?: Tokenizer;
  /** Who holds the lease; a restarted process resumes under the same holder. */
  holder?: string;
  /** The new dream's id; drawn from Entropy when omitted. */
  dream?: DreamId;
}

export type DreamResult = ({ status: "done" } & DreamOutcome) | { status: "busy"; graph: GraphId } | { status: "no-head"; graph: GraphId } | { status: "lease-lost"; dream: DreamId };

/** Trajectories selected per round without an evaluator, unless the caller says (the paper's MultiChallenge stride). */
export const DEFAULT_SELECT = 20;

const StartedSchema = z.strictObject({
  kind: z.literal("started"),
  dream: DreamIdSchema,
  head: RevisionIdSchema,
  /** The overlay log offset the dream's snapshot folds to. */
  overlay: z.int().min(0),
  rejections: z.array(RevisionIdSchema),
  train: z.array(z.string()),
  stride: z.int().positive(),
});
type Started = z.output<typeof StartedSchema>;
const EntrySchema = z.discriminatedUnion("kind", [StartedSchema, z.strictObject({ kind: z.literal("event"), dream: DreamIdSchema, event: DreamEventSchema })]);

const isRejection = (r: RevisionRecord): boolean => r.decision.kind === "rejected-structure" || r.decision.kind === "rejected-gate";

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The refiner port over a language model: the refiner prompt, or the dream prompt when there is consolidation, with the refiner's decoding. */
export function modelRefiner(deps: { model: LanguageModel; settings: Settings }): Refiner {
  const { model, settings } = deps;
  return {
    refine: (request) =>
      refine({
        model,
        template: request.consolidation === undefined ? settings.prompts.refiner : settings.prompts.dream,
        ...request,
        temperature: settings.decoding.temperature,
        topK: settings.decoding.topK,
        maxOutputTokens: settings.decoding.refinerMaxTokens,
      }),
  };
}

type Body = DreamEvent extends infer E ? (E extends DreamEvent ? Omit<E, "command" | "at"> : never) : never;

/** Run (or resume) a dream on a graph to its end. */
export async function runDream(options: RunDreamOptions): Promise<DreamResult> {
  const { store, graph, settings, ports } = options;
  const holder = options.holder ?? "dream";
  const lease = await store.lease.acquire(graph, holder);
  if (lease === undefined) return { status: "busy", graph };
  const holds = (): Promise<boolean> => store.lease.renew(graph, holder, lease.epoch);
  const log = store.dreams(graph);
  const overlayLog = store.overlay(graph);

  async function inputOf(started: Started): Promise<DreamInput> {
    const record = await store.revisions.get(started.head);
    const parsed = parseGraph(record?.document);
    if (!parsed.ok) throw new Error(`the dream's starting revision ${started.head} is missing or does not parse`);
    const rejections = (await Promise.all(started.rejections.map((id) => store.revisions.get(id)))).filter((r) => r !== undefined);
    // Stryker disable next-line ConditionalExpression: equivalent; reading no entries from offset 0 is the empty list
    const events = started.overlay === 0 ? [] : (await overlayLog.read(0, started.overlay)).map((e) => e.event);
    return {
      dream: started.dream,
      graph,
      head: parsed.graph,
      settings: settings.dream,
      evaluator: ports.evaluator !== undefined,
      approver: ports.approver !== undefined,
      inbox: ports.inbox !== undefined,
      train: started.train,
      stride: started.stride,
      task: options.task ?? "",
      tools: options.tools ?? [],
      // Stryker disable next-line ArrayDeclaration: equivalent; a placeholder string names no tool a candidate routes into
      sideEffectFree: options.sideEffectFree ?? [],
      rejections,
      compose: settings.dream.compose === true && ports.composer !== undefined,
      ...(options.tokenizer && { tokenizer: options.tokenizer }),
      ...(settings.overlay && settings.live && { overlay: { state: foldAll(started.head, events), live: settings.live } }),
    };
  }

  /**
   * The best path that compiles, composes and is not a known rejection, staged; or why
   * there is none. Paths come from the overlay log's observed turns, runs from recorded
   * trajectories under the head.
   */
  async function compose(command: Extract<DreamCommand, { kind: "compose" }>): Promise<DreamComposition | { none: string }> {
    const composer = ports.composer!;
    const events = (await overlayLog.read(0)).map((e) => e.event);
    const candidates = pathCandidates(command.graph, events, composer.settings);
    if (candidates.length === 0) return { none: "no path has the support and score to compile" };
    const trajectories = await ports.trajectories.select({ graph, revision: command.revision, limit: composer.runs ?? DEFAULT_SELECT });
    const reasons: string[] = [];
    for (const c of candidates) {
      const route = c.path.join(" → ");
      const compiled = compilePath(c.path, recordedRuns(command.graph, trajectories, c.path, settings.match), composer.toolSpecs);
      if (!compiled.ok) {
        reasons.push(`${route}: ${compiled.error}`);
        continue;
      }
      const composed = composeCandidate(command.graph, c.path, compiled.workflow);
      if (!composed.ok) {
        reasons.push(`${route}: ${composed.error}`);
        continue;
      }
      if (command.known.includes(revisionId(composed.document))) {
        reasons.push(`${route}: its candidate was rejected before`);
        continue;
      }
      const binding = await composer.staging.stage(compiled.workflow).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
      if (binding instanceof Error) {
        reasons.push(`${route}: ${binding.message}`);
        continue;
      }
      return { path: c.path, support: c.support, node: composed.node, binding, edits: composed.edits };
    }
    return { none: reasons.join("; ") };
  }

  /** Put a rejection, unless the id already holds a record that is not one (an older head, an import proposal): ids are content, and put replaces. */
  async function putRejection(record: RevisionRecord): Promise<void> {
    const existing = await store.revisions.get(record.id);
    if (existing === undefined || isRejection(existing)) await store.revisions.put(record);
  }

  /**
   * Store a candidate as waiting for approval and announce it, unless its id already holds
   * a record that is not a rejection: one already waiting (a replay, a later round, an
   * import) is not announced again, and a head's record stays.
   */
  async function propose(record: RevisionRecord, tools: readonly string[]): Promise<void> {
    const existing = await store.revisions.get(record.id);
    if (existing !== undefined && !isRejection(existing)) return;
    await store.revisions.put(record);
    await ports.inbox!.pending({ graph, candidate: record, tools });
  }

  async function begin(): Promise<Started | undefined> {
    const head = await store.heads.get(graph);
    if (head === undefined) return undefined;
    const train = ports.evaluator === undefined ? [] : [...(await ports.evaluator.tasks("train"))];
    const rejections = settings.dream.rejections.dedupe ? (await store.revisions.list(graph)).filter(isRejection).map((r) => r.id) : [];
    const started: Started = {
      kind: "started",
      dream: options.dream ?? DreamIdSchema.parse(hex(ports.entropy.bytes(8))),
      head: head.revision,
      overlay: settings.overlay ? await overlayLog.head() : 0,
      rejections,
      train,
      stride: options.stride ?? settings.dream.stride ?? (ports.evaluator === undefined ? DEFAULT_SELECT : Math.max(1, Math.ceil(train.length / settings.dream.rounds))),
    };
    await log.append([started]);
    return started;
  }

  async function perform(command: Exclude<DreamCommand, { kind: "done" }>, started: Started): Promise<Body> {
    switch (command.kind) {
      case "evaluate": {
        const scores = await ports.evaluator!.evaluate(command.graph, "validation");
        return { kind: "evaluated", scores: scores.map(({ task, score }) => ({ task, score })), seed: hex(ports.entropy.bytes(16)) };
      }
      case "rollout":
        return { kind: "rolled-out", results: [...(await ports.evaluator!.evaluate(command.graph, "train", command.batch))] };
      case "select":
        return { kind: "selected", trajectories: [...(await ports.trajectories.select({ graph, revision: command.revision, limit: command.limit }))] };
      case "refine":
        return { kind: "refined", result: await ports.refiner.refine(command.request) };
      case "approve":
        return { kind: "approved", approved: await ports.approver!.approve({ graph, candidate: command.candidate, tools: command.tools }) };
      case "commit": {
        const { record, expected } = command;
        // An id is its content: a candidate equal to an older revision replaces that record while it is the head.
        const earlier = await store.revisions.get(record.id);
        await store.revisions.put(record);
        // Stryker disable next-line OptionalChaining: equivalent; a head that a compare-and-set just saw is never removed
        const ok = (await store.heads.set(graph, expected, record.id)) || (await store.heads.get(graph))?.revision === record.id;
        if (!ok) await store.revisions.put(earlier !== undefined && earlier.dream !== record.dream ? earlier : { ...record, decision: { kind: "rejected-gate", gate: "head", reason: "the head moved during the dream" } });
        return { kind: "committed", ok };
      }
      case "reject":
        await putRejection(command.record);
        return { kind: "recorded" };
      case "propose":
        await propose(command.record, command.tools);
        return { kind: "proposed" };
      case "compose":
        return { kind: "composed", result: await compose(command) };
      case "rebase": {
        const core = revisionId(command.core);
        const events = (await overlayLog.read(0)).map((e) => e.event);
        // Stryker disable next-line ConditionalExpression,ArrayDeclaration: equivalent; only `rebased` events have a core, which the next line compares (a string has none)
        const rebases = events.flatMap((e) => (e.kind === "rebased" ? [e] : []));
        const done = rebases.find((e) => e.core === core);
        if (done !== undefined) return { kind: "rebased", event: done };
        const { event } = rebaseOverlay(foldAll(started.head, events), command.core, command.absorbed);
        await overlayLog.append([event]);
        return { kind: "rebased", event };
      }
    }
  }

  const entries = (await log.read(0)).map((e) => EntrySchema.parse(e.event));
  const lastStart = entries.map((e) => e.kind).lastIndexOf("started");
  let started = lastStart < 0 ? undefined : StartedSchema.parse(entries[lastStart]);
  let state: DreamState | undefined;
  if (started !== undefined) {
    const dream = started.dream;
    // Every entry after the last `started` one is an event.
    const events = entries.slice(lastStart + 1) as Extract<z.output<typeof EntrySchema>, { kind: "event" }>[];
    state = events.reduce((s, e) => (e.dream === dream ? dreamStep(s, e.event).state : s), dreamStart(await inputOf(started)));
  }
  // Stryker disable next-line OptionalChaining: equivalent; a dream always has a pending command
  if (state === undefined || state.pending[0]?.kind === "done") {
    started = await begin();
    if (started === undefined) {
      await store.lease.release(graph, holder, lease.epoch);
      return { status: "no-head", graph };
    }
    state = dreamStart(await inputOf(started));
  }
  const current = started!;
  for (;;) {
    const command = state.pending[0]!;
    if (command.kind === "done") {
      await store.lease.release(graph, holder, lease.epoch);
      return { status: "done", ...command.result };
    }
    if (!(await holds())) return { status: "lease-lost", dream: current.dream };
    const body = await perform(command, current);
    if (!(await holds())) return { status: "lease-lost", dream: current.dream };
    const event = DreamEventSchema.parse({ ...body, command: command.id, at: ports.clock.now() });
    await log.append([{ kind: "event", dream: current.dream, event }]);
    state = dreamStep(state, event).state;
  }
}
