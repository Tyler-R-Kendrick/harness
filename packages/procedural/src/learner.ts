/**
 * The live learner (plan §6.1-6.3): a hook-bus actor that turns each finished turn into
 * one `observed` overlay event, then appends what the policy makes of it (proposals from
 * statistics, status changes from randomized exposure). It never writes the core (I1).
 *
 * - Evidence. On `turn.ended` (from the daemon only) it reads the turn from the session
 *   log, projects it (`projection.ts`) and scores it with the deployment's scorer, if any.
 * - Localization. Actions are matched in the graph the session saw: the turn's core
 *   revision with the overlay folded to the version its step records name, as that
 *   session's salt exposed it.
 * - Exposure. The arm of the randomized comparison comes from the pin's salt alone: the
 *   entries on probation at that version that the salt exposes. What a log entry claims
 *   was shown is not trusted, and a session is in an entry's arm whether or not its path
 *   reached the entry (intent to treat; the fold credits only entries it reached).
 * - At-least-once delivery (I4). A turn already in the overlay log is not observed again,
 *   and deliveries are handled one at a time, so a redelivered or concurrent event is one
 *   observation. Support is by distinct session (the fold counts sessions).
 * - Feedback. A score that arrives later is a re-observation of the folded turn: the
 *   fold moves the turn's score, and nothing is traversed again.
 */
import { z } from "zod";
import { match } from "./locate.ts";
import { editFilter } from "./filter.ts";
import { effectiveGraph, emptyOverlay, entryId, exposed, foldOverlay } from "./overlay.ts";
import { proposals, statusChanges, structure } from "./overlay-policy.ts";
import { coreView, OverlayEventSchema } from "./overlay-types.ts";
import type { EffectiveGraph, OverlayEntry, OverlayEvent, OverlayState } from "./overlay-types.ts";
import { EntryIdSchema, parseGraph, ScoreSchema } from "./graph.ts";
import type { EntryId, GraphId, NodeName, ProceduralGraph, RevisionId, Score } from "./graph.ts";
import { turnProjection } from "./projection.ts";
import type { Reflector } from "./reflect.ts";
import { serializeGraph, serializeWindow } from "./serialize.ts";
import type { LogEntryLike, LogGap, ScoreSource, TurnProjection, VersionPair } from "./projection.ts";
import type { LiveSettings, Preset } from "./settings.ts";
import type { AppendLog, ProceduralStore } from "./store.ts";
import type { ScoredTrajectory } from "./trajectory.ts";

/** A hook event as the bus delivers it (core's `HookEvent` is one). */
export interface LearnerEvent {
  readonly type: string;
  readonly source: string;
  readonly sessionId?: string;
  readonly payload: unknown;
}

export interface LiveLearnerDeps {
  readonly store: ProceduralStore;
  /** The preset in force: its overlay switch, live settings and match mode. */
  readonly settings: Preset;
  /** Entries of a session's log from offset `from` (inclusive) to `to` (exclusive, or the head when omitted). */
  readonly readLog: (sessionId: string, from: number, to?: number) => Promise<readonly LogEntryLike[]>;
  /** The deployment's score for a turn (a judge, an outcome), or null when it has none. */
  readonly score?: (trajectory: ScoredTrajectory) => Promise<{ readonly score: Score; readonly source: ScoreSource } | null>;
  /** Accepted for the contract; the fold counts overlay versions, not time. */
  readonly clock?: { now(): number };
  /** Live reflection's model call (`modelReflector`), used when the preset's `live.reflection` is not `off`. */
  readonly reflect?: Reflector;
}

/** An entry reflection proposed, with the sessions of the turns it reflected on. */
interface Reflected {
  readonly entry: Reflectable;
  readonly sessions: readonly string[];
}

/** A scored turn as reflection reads it: its score, query and steps. */
const reflectionText = (t: ScoredTrajectory): string =>
  [`Score: ${t.score!.toFixed(2)}`, `Query: ${t.query}`, serializeWindow(t.steps, t.steps.length)].filter((line) => line !== "").join("\n");

/** What reflection may propose: notes and edges (nodes come with templated edges, cautions only from statistics). */
type Reflectable = Extract<OverlayEntry, { kind: "note" | "edge" }>;
const reflectable = (e: OverlayEntry): e is Reflectable => e.kind === "note" || e.kind === "edge";

/** The text an entry would put in front of later sessions. */
const entryTexts = (e: Reflectable): string[] => (e.kind === "edge" ? [e.condition, e.guidance, e.pitfalls].filter((t) => t !== null) : [e.text]);

/** The nodes an entry names, which must exist for it to be anchored (I6). */
const anchorsOf = (e: Reflectable): string[] => (e.kind === "edge" ? [e.from, e.to] : [e.on.from, e.on.to]);

export type LearnerResult =
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "duplicate"; readonly turnKey: string }
  | { readonly kind: "unchanged"; readonly turnKey: string }
  | { readonly kind: "observed"; readonly turnKey: string; readonly graph: GraphId; readonly trajectory: ScoredTrajectory; readonly gaps: LogGap[]; readonly appended: OverlayEvent[] }
  | { readonly kind: "rescored"; readonly turnKey: string; readonly graph: GraphId; readonly appended: OverlayEvent[] };

type Observed = Extract<OverlayEvent, { kind: "observed" }>;

/** An overlay log folded, with the state at one version and what it holds about one turn. */
interface Replay {
  readonly state: OverlayState;
  readonly pinned: OverlayState | undefined;
  readonly turn: { readonly original: Observed; readonly observedAt: number; readonly score: Score | null; readonly rescores: number } | undefined;
}

function replay(base: RevisionId, events: readonly OverlayEvent[], version: number | null, turnKey: string): Replay {
  let state = emptyOverlay(base);
  // At version 0 there is nothing to view but the core, which is what no pinned state gives.
  let pinned: OverlayState | undefined;
  let turn: Replay["turn"];
  for (const event of events) {
    state = foldOverlay(state, event);
    if (state.version === version) pinned = state;
    // Stryker disable next-line ConditionalExpression: equivalent; other kinds have no turn key, so they never equal one
    if (event.kind !== "observed" || event.turnKey !== turnKey) continue;
    if (event.rescore === undefined) turn ??= { original: event, observedAt: state.version, score: event.score, rescores: 0 };
    else if (turn !== undefined) turn = { ...turn, score: event.score, rescores: turn.rescores + 1 };
  }
  return { state, pinned, turn };
}

/** What the daemon's turn.ended carries that the learner reads. */
const TurnEndedSchema = z.object({ turnId: z.string().min(1) });

const ignored = (reason: string): LearnerResult => ({ kind: "ignored", reason });
const skipped = (reason: string): LearnerResult => ({ kind: "skipped", reason });

export class LiveLearner {
  readonly #deps: LiveLearnerDeps;
  /** Per session, the offset after the last turn observed: the next read starts there. */
  readonly #cursors = new Map<string, number>();
  /** Per graph, the scored turns waiting for a batch reflection. */
  readonly #batches = new Map<GraphId, ScoredTrajectory[]>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: LiveLearnerDeps) {
    this.#deps = deps;
  }

  /** The live settings, when the preset learns an overlay. */
  get #live(): LiveSettings | undefined {
    const { settings } = this.#deps;
    return settings.overlay ? settings.live : undefined;
  }

  /** Handle a hook event: a daemon `turn.ended` becomes one observation; everything else is ignored. */
  onHookEvent(event: LearnerEvent): Promise<LearnerResult> {
    if (event.type !== "turn.ended" || event.source !== "daemon") return Promise.resolve(ignored("not a daemon turn.ended"));
    const payload = TurnEndedSchema.safeParse(event.payload);
    const sessionId = event.sessionId;
    if (sessionId === undefined || sessionId === "" || !payload.success) return Promise.resolve(ignored("no session or turn"));
    return this.#serial((live) => this.#observe(live, sessionId, payload.data.turnId, undefined));
  }

  /**
   * A score for a turn after the fact (`procedural.feedback`). An observed turn gets a
   * re-observation that moves its score; a turn not yet observed is observed now with
   * this score (source `feedback`), so its `turn.ended` is then a duplicate.
   */
  feedback(sessionId: string, turnId: string, score: number): Promise<LearnerResult> {
    return this.#serial(async (live) => {
      const parsed = ScoreSchema.safeParse(score);
      if (!parsed.success) return skipped("a score is a probability in [0, 1]");
      const pin = await this.#deps.store.pins.get(sessionId);
      if (pin === undefined) return skipped("the session has no pin, so no graph");
      const turnKey = `${sessionId}/${turnId}`;
      const log = this.#deps.store.overlay(pin.graph);
      const { state, turn } = replay(pin.core, await events(log), null, turnKey);
      if (turn === undefined) return this.#observe(live, sessionId, turnId, { score: parsed.data, source: "feedback" });
      if (turn.score === parsed.data) return { kind: "unchanged", turnKey };
      const { path, unmatched, exposure } = turn.original;
      const event: OverlayEvent = { kind: "observed", turnKey, path, unmatched, score: parsed.data, exposure, rescore: { seq: turn.rescores + 1, previous: turn.score, observedAt: turn.observedAt } };
      const appended = await this.#append(live, log, pin.graph, state, event, await this.#graph(pin.graph, pin.core));
      return { kind: "rescored", turnKey, graph: pin.graph, appended };
    });
  }

  /** Run one delivery at a time, so a concurrent redelivery sees the first one's events. */
  #serial(run: (live: LiveSettings) => Promise<LearnerResult>): Promise<LearnerResult> {
    const live = this.#live;
    if (live === undefined) return Promise.resolve(ignored("the preset has no overlay"));
    const next = this.#queue.then(() => run(live));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #observe(live: LiveSettings, sessionId: string, turnId: string, forced: { score: Score; source: ScoreSource } | undefined): Promise<LearnerResult> {
    const turnKey = `${sessionId}/${turnId}`;
    if (sessionId.includes("/")) return skipped("a session id with '/' cannot key a turn");
    const pin = await this.#deps.store.pins.get(sessionId);
    const fallback = pin === undefined ? undefined : { graph: pin.graph, core: pin.core, overlay: pin.overlay };
    const cursor = this.#cursors.get(sessionId) ?? 0;
    let read = await this.#read(sessionId, turnId, cursor, fallback);
    if (read === undefined && cursor > 0) read = await this.#read(sessionId, turnId, 0, fallback);
    if (read === undefined) return skipped("the log does not hold the turn, or it names no graph");
    const { entries, from, projection: first } = read;
    const { graph, core, overlay } = first.trajectory;
    const log = this.#deps.store.overlay(graph);
    const history = replay(core, await events(log), overlay, turnKey);
    if (history.turn !== undefined) return { kind: "duplicate", turnKey };

    const coreGraph = await this.#graph(graph, core);
    // The session's exposure draw; without a pin no probationary entry was drawn for it.
    // Stryker disable next-line StringLiteral: equivalent; with share 0 no salt exposes anything
    const draw = { salt: pin?.salt ?? "", probationShare: pin === undefined ? 0 : live.probationShare };
    const pinned = history.pinned;
    const view: EffectiveGraph | undefined = coreGraph === undefined ? undefined : pinned === undefined ? coreView(coreGraph) : effectiveGraph(coreGraph, pinned, draw);
    const locate = view === undefined ? undefined : (action: string): NodeName | undefined => match(action, view, this.#deps.settings.match);
    const context = { sessionId, turnId, from, pin: fallback, locate };
    // Defined: the first projection found the turn and a pair in these same entries.
    const projection = turnProjection(entries, context)!;
    const scored = forced ?? (await this.#score(projection.trajectory));
    const trajectory: ScoredTrajectory = { ...projection.trajectory, score: scored?.score ?? null, scoreSource: scored?.source ?? null };
    const exposure: EntryId[] = [];
    if (pinned !== undefined) {
      for (const [id, r] of Object.entries(pinned.entries)) if (r.status === "probation" && exposed(draw.salt, id, draw.probationShare)) exposure.push(EntryIdSchema.parse(id));
    }
    const event = OverlayEventSchema.parse({ kind: "observed", turnKey, path: projection.path, unmatched: projection.unmatched, score: trajectory.score, exposure });
    const reflected = view === undefined ? [] : await this.#reflect(live, graph, view, trajectory);
    const appended = await this.#append(live, log, graph, history.state, event, coreGraph, reflected);
    if (projection.next !== undefined) this.#cursors.set(sessionId, Math.max(cursor, projection.next));
    return { kind: "observed", turnKey, graph, trajectory, gaps: projection.gaps, appended };
  }

  async #read(sessionId: string, turnId: string, from: number, pin: VersionPair | undefined): Promise<{ entries: readonly LogEntryLike[]; from: number; projection: TurnProjection } | undefined> {
    const entries = await this.#deps.readLog(sessionId, from);
    const projection = turnProjection(entries, { sessionId, turnId, from, pin });
    return projection === undefined ? undefined : { entries, from, projection };
  }

  /**
   * Live reflection (plan §6.2.4): after a scored turn (`turn`), or once `reflectionBatch`
   * scored turns of a graph have gathered (`batch`), the reflector proposes notes and
   * edges over the graph the turn saw. Every entry passes the edit filter against the
   * reflected turns' tool observations, or is dropped. A failing reflector proposes nothing.
   */
  async #reflect(live: LiveSettings, graph: GraphId, view: EffectiveGraph, trajectory: ScoredTrajectory): Promise<Reflected[]> {
    const reflector = this.#deps.reflect;
    if (live.reflection === "off" || reflector === undefined || trajectory.score === null) return [];
    const batch = [...(this.#batches.get(graph) ?? []), trajectory];
    if (live.reflection === "batch" && batch.length < live.reflectionBatch!) {
      this.#batches.set(graph, batch);
      return [];
    }
    this.#batches.delete(graph);
    // Stryker disable next-line ArrayDeclaration: equivalent; a placeholder string is no note or edge, so it is dropped with the rest
    const entries = await reflector({ graphContext: serializeGraph(view), trajectory: batch.map(reflectionText).join("\n\n") }).catch((): readonly OverlayEntry[] => []);
    // Turns projected from the log carry tool results as `tool` steps (never `observation` ones).
    const observations = batch.flatMap((t) => t.steps.filter((s) => s.role === "tool").map((s) => s.content));
    const sessions = [...new Set(batch.map((t) => t.session))];
    return entries.filter(reflectable).filter((entry) => editFilter(entryTexts(entry), observations).length === 0).map((entry) => ({ entry, sessions }));
  }

  /** The scorer's score; a scorer that fails leaves the turn unscored (feedback can score it later). */
  async #score(trajectory: ScoredTrajectory): Promise<{ score: Score; source: ScoreSource } | null> {
    const scorer = this.#deps.score;
    if (scorer === undefined) return null;
    // Stryker disable next-line ArrowFunction: equivalent; undefined and null both leave the turn unscored
    return scorer(trajectory).catch(() => null);
  }

  /** A graph's revision, when the store has it and it parses. */
  async #graph(graph: GraphId, id: RevisionId): Promise<ProceduralGraph | undefined> {
    const record = await this.#deps.store.revisions.get(graph, id);
    if (record === undefined) return undefined;
    const parsed = parseGraph(record.document);
    // Stryker disable next-line ConditionalExpression: equivalent; a failed parse has no graph, so it gives undefined either way
    return parsed.ok ? parsed.graph : undefined;
  }

  /**
   * Append the events with what the policy makes of them, in one append: proposals from
   * the folded state against the head core (the overlay's base), then reflection's
   * entries that are new and anchored in that core or live overlay nodes (I6), then
   * status changes.
   */
  async #append(live: LiveSettings, log: AppendLog<OverlayEvent>, graph: GraphId, state: OverlayState, event: OverlayEvent, turnCore: ProceduralGraph | undefined, reflected: readonly Reflected[] = []): Promise<OverlayEvent[]> {
    const head = await this.#deps.store.heads.get(graph);
    const policyCore = (head === undefined ? undefined : await this.#graph(graph, head.revision)) ?? turnCore;
    const out: OverlayEvent[] = [event];
    if (policyCore !== undefined) {
      let folded = foldOverlay(state, event);
      const proposed = proposals(folded, policyCore, live);
      folded = proposed.reduce(foldOverlay, folded);
      const { nodes } = structure(folded, policyCore);
      const fresh = reflected.filter(({ entry }) => folded.entries[entryId(entry)] === undefined && anchorsOf(entry).every((n) => nodes.has(n)));
      const byReflection = fresh.map(({ entry, sessions }): OverlayEvent => ({ kind: "proposed", entry, source: { sessions: [...sessions], by: "reflection" } }));
      folded = byReflection.reduce(foldOverlay, folded);
      out.push(...proposed, ...byReflection, ...statusChanges(folded, live));
    }
    await log.append(out);
    return out;
  }
}

async function events(log: AppendLog<OverlayEvent>): Promise<OverlayEvent[]> {
  return (await log.read(0)).map((e) => e.event);
}
