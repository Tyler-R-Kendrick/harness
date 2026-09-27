/**
 * A small in-memory ProceduralStore for the extension's tests: enough of the port to
 * drive import, export, revert and history, with hooks to interleave a concurrent
 * writer. It is a test double, not an implementation of the store contract.
 */
import type { AppendLog, GraphId, Head, OverlayEvent, Pin, ProceduralStore, RevisionId, RevisionRecord } from "@harness/procedural";

class Log<E> implements AppendLog<E> {
  readonly events: E[] = [];
  async append(events: readonly E[]): Promise<number> {
    this.events.push(...events);
    return this.events.length;
  }
  async read(from: number, limit = Infinity) {
    return this.events.slice(from, from + limit).map((event, i) => ({ offset: from + i, event }));
  }
  async head(): Promise<number> {
    return this.events.length;
  }
}

export class FakeStore implements ProceduralStore {
  readonly records = new Map<string, RevisionRecord>();
  readonly headOf = new Map<string, Head>();
  readonly overlays = new Map<string, Log<OverlayEvent>>();
  readonly dreamLogs = new Map<string, Log<unknown>>();
  readonly pinOf = new Map<string, Pin>();
  /** Runs before each head compare-and-set, e.g. to move the head under the caller. */
  beforeSet: (() => Promise<void>) | undefined;

  readonly revisions = {
    put: async (r: RevisionRecord) => void this.records.set(r.id, r),
    get: async (id: RevisionId) => this.records.get(id),
    list: async (graph: GraphId) => [...this.records.values()].filter((r) => r.graph === graph),
  };
  readonly heads = {
    get: async (graph: GraphId) => this.headOf.get(graph),
    set: async (graph: GraphId, expected: RevisionId | undefined, next: RevisionId) => {
      const hook = this.beforeSet;
      this.beforeSet = undefined;
      await hook?.();
      const current = this.headOf.get(graph);
      if (current?.revision !== expected) return false;
      this.headOf.set(graph, { revision: next, history: current ? [current.revision, ...current.history] : [] });
      return true;
    },
  };
  overlay(graph: GraphId): Log<OverlayEvent> {
    return this.overlays.get(graph) ?? this.overlays.set(graph, new Log()).get(graph)!;
  }
  dreams(graph: GraphId): Log<unknown> {
    return this.dreamLogs.get(graph) ?? this.dreamLogs.set(graph, new Log()).get(graph)!;
  }
  readonly pins = {
    get: async (session: string) => this.pinOf.get(session),
    set: async (session: string, pin: Pin) => void this.pinOf.set(session, pin),
  };
  readonly guidance = { put: async () => {}, get: async () => undefined };
  readonly lease = { acquire: async () => ({ epoch: 1 }), renew: async () => true, release: async () => true };
  async redact(id: RevisionId): Promise<void> {
    const r = this.records.get(id);
    if (r) this.records.set(id, { ...r, redacted: true });
  }
}
