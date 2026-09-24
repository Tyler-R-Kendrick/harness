import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

export interface HookEvent {
  readonly eventId: string;
  readonly offset: number;
  readonly type: string;
  readonly source: string;
  readonly sessionId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly depth: number;
  readonly at: number;
  readonly payload: unknown;
}

export interface PublishInput {
  readonly type: string;
  readonly source: string;
  readonly payload: unknown;
  readonly sessionId?: string;
  /** Event this one reacts to; propagates the saga correlation and causal depth. */
  readonly cause?: string;
  readonly correlationId?: string;
}

export interface Filter {
  /** Exact types, `prefix.*` wildcards, or `*`. */
  readonly types: readonly string[];
  readonly sessionId?: string;
}

export type HookError = "unknown_cause" | "depth_exceeded" | "unknown_plugin" | "invalid_ack";

interface Plugin {
  filter: Filter;
  cursor: number;
}

/**
 * Durable broadcast of hook events to plugin actors. Delivery is at-least-once from a
 * per-plugin cursor that only moves on acknowledgement, so a plugin (or the daemon)
 * can crash at any point and resume. Causal depth bounds reaction chains, and a plugin
 * never receives its own events.
 */
export class HookBus {
  readonly #maxDepth: number;
  #events: HookEvent[] = [];
  #byId = new Map<string, HookEvent>();
  #plugins = new Map<string, Plugin>();

  constructor(options: { maxDepth: number }) {
    this.#maxDepth = options.maxDepth;
  }

  head(): number {
    return this.#events.length;
  }

  publish(input: PublishInput, at: number): Result<HookEvent, HookError> {
    const cause = input.cause === undefined ? undefined : this.#byId.get(input.cause);
    if (input.cause !== undefined && !cause) return err("unknown_cause", `no event ${input.cause}`);
    const depth = cause ? cause.depth + 1 : 0;
    if (depth > this.#maxDepth) return err("depth_exceeded", `causal depth ${depth} exceeds ${this.#maxDepth}`);
    const offset = this.#events.length;
    const event: HookEvent = {
      eventId: `evt-${offset}`,
      offset,
      type: input.type,
      source: input.source,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      correlationId: cause?.correlationId ?? input.correlationId ?? `cor-${offset}`,
      ...(cause ? { causationId: cause.eventId } : {}),
      depth,
      at,
      payload: input.payload,
    };
    this.#events.push(event);
    this.#byId.set(event.eventId, event);
    return ok(event);
  }

  /** Subscribe or update a filter. New subscribers start at head unless `from` is given. */
  subscribe(pluginId: string, filter: Filter, from?: number): void {
    const existing = this.#plugins.get(pluginId);
    this.#plugins.set(pluginId, { filter, cursor: from ?? existing?.cursor ?? this.head() });
  }

  unsubscribe(pluginId: string): void {
    this.#plugins.delete(pluginId);
  }

  cursor(pluginId: string): number | undefined {
    return this.#plugins.get(pluginId)?.cursor;
  }

  /** Matching events after the cursor. Does not advance the cursor. */
  poll(pluginId: string, max = Number.POSITIVE_INFINITY): Result<HookEvent[], HookError> {
    const plugin = this.#plugins.get(pluginId);
    if (!plugin) return err("unknown_plugin", `no plugin ${pluginId}`);
    const out: HookEvent[] = [];
    for (let i = plugin.cursor; i < this.#events.length && out.length < max; i++) {
      const e = this.#events[i]!;
      if (delivers(pluginId, plugin.filter, e)) out.push(e);
    }
    return ok(out);
  }

  /** Mark everything up to and including `offset` as processed. */
  ack(pluginId: string, offset: number): Result<void, HookError> {
    const plugin = this.#plugins.get(pluginId);
    if (!plugin) return err("unknown_plugin", `no plugin ${pluginId}`);
    if (offset >= this.#events.length) return err("invalid_ack", `offset ${offset} is beyond head ${this.#events.length}`);
    plugin.cursor = Math.max(plugin.cursor, offset + 1);
    return ok(undefined);
  }

  /** Every event in a saga, and which plugins have processed each one. */
  saga(correlationId: string): { events: HookEvent[]; handledBy: Record<string, string[]> } {
    const events = this.#events.filter((e) => e.correlationId === correlationId);
    const handledBy: Record<string, string[]> = {};
    for (const e of events) {
      handledBy[e.eventId] = [...this.#plugins].filter(([id, p]) => delivers(id, p.filter, e) && p.cursor > e.offset).map(([id]) => id);
    }
    return { events, handledBy };
  }

  toJSON(): { events: HookEvent[]; plugins: [string, Plugin][] } {
    return { events: [...this.#events], plugins: [...this.#plugins].map(([id, p]) => [id, { filter: p.filter, cursor: p.cursor }]) };
  }

  static fromJSON(data: unknown, options: { maxDepth: number }): HookBus {
    if (typeof data !== "object" || data === null) throw new Error("invalid hook bus data");
    const d = data as { events?: unknown; plugins?: unknown };
    if (!Array.isArray(d.events) || !Array.isArray(d.plugins)) throw new Error("invalid hook bus data");
    const bus = new HookBus(options);
    for (const e of d.events as HookEvent[]) {
      bus.#events.push(e);
      bus.#byId.set(e.eventId, e);
    }
    for (const [id, p] of d.plugins as [string, Plugin][]) bus.#plugins.set(id, { filter: p.filter, cursor: p.cursor });
    return bus;
  }
}

function delivers(pluginId: string, filter: Filter, e: HookEvent): boolean {
  if (e.source === pluginId) return false;
  if (filter.sessionId !== undefined && e.sessionId !== filter.sessionId) return false;
  return filter.types.some((t) => t === "*" || t === e.type || (t.endsWith(".*") && e.type.startsWith(t.slice(0, -1))));
}

/** Plugin-side guard for at-least-once delivery: remembers the last `window` event ids. */
export class Deduper {
  readonly #window: number;
  #seen = new Set<string>();

  constructor(window: number) {
    if (!(window > 0)) throw new Error("window must be positive");
    this.#window = window;
  }

  seen(id: string): boolean {
    if (this.#seen.has(id)) return true;
    this.#seen.add(id);
    if (this.#seen.size > this.#window) this.#seen.delete(this.#seen.values().next().value!);
    return false;
  }
}
