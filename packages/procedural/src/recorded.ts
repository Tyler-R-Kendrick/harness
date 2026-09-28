/**
 * Recorded trajectories for dream (plan §7.2): the turns of session logs projected
 * (`projection.ts`) and kept when guidance read the revision dream asks about, scored by
 * the overlay log's observations of them (the latest, so feedback counts), and selected
 * balanced between high and low scores. This is the `TrajectorySource` a host gives
 * `runDream` from the logs it can read.
 */
import type { TrajectorySource } from "./dream-runner.ts";
import type { Score } from "./graph.ts";
import { turnProjection } from "./projection.ts";
import type { LogEntryLike } from "./projection.ts";
import type { ProceduralStore } from "./store.ts";
import type { ScoredTrajectory } from "./trajectory.ts";

/** One session's log entries. */
export interface SessionLog {
  readonly id: string;
  readonly entries: readonly LogEntryLike[];
}

/** The turns a log holds whole, by their `turn.ended` events, in log order. */
function endedTurns(entries: readonly LogEntryLike[]): Set<string> {
  const turns = new Set<string>();
  for (const { payload } of entries) {
    const p = payload as { event?: unknown; data?: { turnId?: unknown } } | null;
    const turnId = p?.event === "turn.ended" ? p.data?.turnId : undefined;
    if (typeof turnId === "string") turns.add(turnId);
  }
  return turns;
}

/** Highest and lowest scores alternating inward (equal scores in log order), then the unscored, up to `limit`. */
function balanced(trajectories: readonly ScoredTrajectory[], limit: number): ScoredTrajectory[] {
  const scored = trajectories.filter((t) => t.score !== null).sort((a, b) => b.score! - a.score!);
  const out: ScoredTrajectory[] = [];
  for (let i = 0, j = scored.length - 1; i <= j; i += 1, j -= 1) {
    out.push(scored[i]!);
    if (i < j) out.push(scored[j]!);
  }
  return [...out, ...trajectories.filter((t) => t.score === null)].slice(0, limit);
}

/**
 * Trajectories from session logs. A turn's version pair is its first step record's, or the
 * session's pin; its score is the latest `observed` event for it in the graph's overlay
 * log (a re-observation is feedback), or null. The overlay log keeps a turn's score and
 * not its source, so an observed score's source is null unless feedback moved it.
 */
export function logTrajectories(options: { readonly store: ProceduralStore; readonly sessions: () => Promise<readonly SessionLog[]> }): TrajectorySource {
  const { store } = options;
  return {
    async select({ graph, revision, limit }) {
      const scores = new Map<string, { score: Score | null; feedback: boolean }>();
      for (const { event } of await store.overlay(graph).read(0)) {
        // Stryker disable next-line ConditionalExpression: equivalent; other kinds have no turn key, and no turn is keyed undefined
        if (event.kind !== "observed") continue;
        scores.set(event.turnKey, { score: event.score, feedback: event.rescore !== undefined });
      }
      const found: ScoredTrajectory[] = [];
      for (const session of await options.sessions()) {
        const pin = await store.pins.get(session.id);
        const fallback = pin === undefined ? undefined : { graph: pin.graph, core: pin.core, overlay: pin.overlay };
        for (const turnId of endedTurns(session.entries)) {
          const t = turnProjection(session.entries, { sessionId: session.id, turnId, pin: fallback })?.trajectory;
          if (t === undefined || t.graph !== graph || t.core !== revision) continue;
          const s = scores.get(`${session.id}/${turnId}`);
          found.push({ ...t, score: s?.score ?? null, scoreSource: s?.feedback === true ? "feedback" : null });
        }
      }
      return balanced(found, limit);
    },
  };
}
