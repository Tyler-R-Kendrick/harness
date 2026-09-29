/**
 * Dream on a schedule (plan §7.1): a host calls `tick()` from its runtime's tick, and
 * every graph whose preset schedule is due dreams, under the lease `runDream` holds.
 *
 * - **Due.** `every` has passed since the last dream (the latest time in the graph's
 *   dream log: a dream's start or its last event; before any dream, since the head's
 *   record), or the live learner has observed `afterTurns` turns since the overlay offset
 *   the last dream started from (re-observations are not turns). Whichever comes first.
 * - **Restarts.** Everything due reads is in the store, so a new process picks up where
 *   the last left off. The schedule also remembers, in memory, when it last started each
 *   graph's dream, so a dream that fails before it logs anything waits until it is due again.
 * - **One at a time.** A graph whose dream this schedule started is skipped until it ends,
 *   and a tick while another is still checking does nothing. `exclusiveDream` keeps
 *   on-demand and scheduled dreams in one process apart; another process's dream holds
 *   the graph's lease, so `runDream` answers `busy`.
 */
import { DreamLogEntrySchema } from "./dream-runner.ts";
import type { DreamResult } from "./dream-runner.ts";
import type { GraphId } from "./graph.ts";
import type { Preset } from "./settings.ts";
import type { ProceduralStore } from "./store.ts";

/** A dream of one graph, run to its end (the host's `runDream` under its lease holder). */
export type DreamRun = (graph: GraphId) => Promise<DreamResult>;

export type ScheduleReason = "every" | "afterTurns";

/** Whether a graph's dream is due, and what the schedule read to decide. */
export interface DreamDue {
  readonly due: boolean;
  /** The first condition that holds, when due. */
  readonly reason?: ScheduleReason;
  /** When the last dream ran (or the head was set, before any), by the Clock. */
  readonly last: number;
  /** Observed turns since the last dream's overlay offset (0 when the schedule does not count turns). */
  readonly turns: number;
  /** The overlay log's head when checked. */
  readonly overlay: number;
}

/** What a tick did for a graph it found due, or why it could not tell (a dream log that does not parse). */
export type ScheduledDream =
  | { readonly graph: GraphId; readonly reason: ScheduleReason; readonly result: DreamResult }
  | { readonly graph: GraphId; readonly reason?: ScheduleReason; readonly error: string };

export interface DreamScheduleOptions {
  readonly store: ProceduralStore;
  /** The preset whose `dream.every` and `dream.afterTurns` are the schedule. */
  readonly settings: Preset;
  /** The graphs to tend (a host's store names every graph with a head). */
  readonly graphs: () => Promise<readonly GraphId[]>;
  readonly dream: DreamRun;
  readonly clock: { now(): number };
}

/** What the dream log says of the last dream, read incrementally. */
interface LogMark {
  /** The next dream-log offset to read. */
  offset: number;
  /** The latest time in the log. */
  at: number | undefined;
  /** The overlay offset the last dream started from. */
  overlay: number;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One dream per graph at a time in this process: a call for a graph whose dream is
 * running answers `busy` at once, leaving the lease to the running dream (a lease holder
 * may take its own lease again, which would strand the running dream).
 */
export function exclusiveDream(run: DreamRun): DreamRun {
  const running = new Set<GraphId>();
  return async (graph) => {
    if (running.has(graph)) return { status: "busy", graph };
    running.add(graph);
    try {
      return await run(graph);
    } finally {
      running.delete(graph);
    }
  };
}

export class DreamSchedule {
  readonly #options: DreamScheduleOptions;
  readonly #marks = new Map<GraphId, LogMark>();
  /** When this schedule last started each graph's dream, and the overlay head then. */
  readonly #started = new Map<GraphId, { at: number; overlay: number }>();
  readonly #running = new Set<GraphId>();
  #checking = false;

  constructor(options: DreamScheduleOptions) {
    this.#options = options;
  }

  /** Whether the preset has a schedule at all. */
  get enabled(): boolean {
    const { every, afterTurns } = this.#options.settings.dream;
    return every !== undefined || afterTurns !== undefined;
  }

  /** Whether a graph's dream is due now; a graph with no head never is. */
  async due(graph: GraphId): Promise<DreamDue> {
    const { store, settings, clock } = this.#options;
    const { every, afterTurns } = settings.dream;
    const overlayLog = store.overlay(graph);
    const overlay = await overlayLog.head();
    const head = await store.heads.get(graph);
    if (head === undefined) return { due: false, last: 0, turns: 0, overlay };
    const mark = await this.#mark(graph);
    const started = this.#started.get(graph);
    const last = Math.max(mark.at ?? (await store.revisions.get(graph, head.revision))?.at ?? 0, started?.at ?? 0);
    const since = Math.max(mark.overlay, started?.overlay ?? 0);
    const turns = afterTurns === undefined ? 0 : (await overlayLog.read(since)).filter(({ event }) => event.kind === "observed" && event.rescore === undefined).length;
    // An unset condition never holds.
    const reason: ScheduleReason | undefined = clock.now() - last >= (every ?? Infinity) ? "every" : turns >= (afterTurns ?? Infinity) ? "afterTurns" : undefined;
    return { due: reason !== undefined, ...(reason === undefined ? {} : { reason }), last, turns, overlay };
  }

  /**
   * Check every graph and dream those due, each once at a time; resolves when the dreams
   * this tick started have ended. A failing dream is reported, never thrown.
   */
  async tick(): Promise<readonly ScheduledDream[]> {
    if (!this.enabled || this.#checking) return [];
    this.#checking = true;
    const started: Promise<ScheduledDream>[] = [];
    try {
      for (const graph of await this.#options.graphs()) {
        if (this.#running.has(graph)) continue;
        const due = await this.due(graph).catch((e: unknown) => ({ error: messageOf(e) }));
        if ("error" in due) started.push(Promise.resolve({ graph, error: due.error }));
        else if (due.reason !== undefined) started.push(this.#run(graph, due.reason, due.overlay));
      }
    } finally {
      this.#checking = false;
    }
    return Promise.all(started);
  }

  async #run(graph: GraphId, reason: ScheduleReason, overlay: number): Promise<ScheduledDream> {
    this.#started.set(graph, { at: this.#options.clock.now(), overlay });
    this.#running.add(graph);
    try {
      return { graph, reason, result: await this.#options.dream(graph) };
    } catch (e) {
      return { graph, reason, error: messageOf(e) };
    } finally {
      this.#running.delete(graph);
    }
  }

  /** The dream log read past what was read before: its latest time and the last dream's overlay offset. */
  async #mark(graph: GraphId): Promise<LogMark> {
    const mark = this.#marks.get(graph) ?? { offset: 0, at: undefined, overlay: 0 };
    for (const { offset, event } of await this.#options.store.dreams(graph).read(mark.offset)) {
      const entry = DreamLogEntrySchema.parse(event);
      const at = entry.kind === "started" ? entry.at : entry.event.at;
      if (at !== undefined) mark.at = Math.max(mark.at ?? at, at);
      if (entry.kind === "started") mark.overlay = entry.overlay;
      mark.offset = offset + 1;
    }
    this.#marks.set(graph, mark);
    return mark;
  }
}
