/**
 * A small in-memory `ProceduralStore` for dream runner tests, with hooks to simulate a
 * crash (an append that throws) and to count calls. It follows the store contract's
 * semantics: put is an upsert, heads move by compare-and-set, leases grant growing epochs.
 */
import type { AppendLog, GraphId, Head, Lease, OverlayEvent, ProceduralStore, RevisionId, RevisionRecord } from "@harness/procedural";

function log<E>(entries: E[], hooks: { beforeAppend?: (events: readonly E[]) => void }): AppendLog<E> {
  return {
    async append(events) {
      hooks.beforeAppend?.(events);
      entries.push(...events);
      return entries.length;
    },
    async read(from, limit) {
      return entries.slice(from, limit === undefined ? undefined : from + limit).map((event, i) => ({ offset: from + i, event }));
    },
    async head() {
      return entries.length;
    },
  };
}

export class FakeStore implements ProceduralStore {
  readonly records = new Map<RevisionId, RevisionRecord>();
  readonly headOf = new Map<GraphId, Head>();
  readonly overlayLog = new Map<GraphId, OverlayEvent[]>();
  readonly dreamLog = new Map<GraphId, unknown[]>();
  readonly leases = new Map<GraphId, { holder: string | null; epoch: number }>();
  /** Called before every dream-log append; throw to simulate a crash. */
  beforeDreamAppend?: (events: readonly unknown[]) => void;
  /** Called before every head compare-and-set. */
  beforeHeadSet?: () => void;

  readonly revisions: ProceduralStore["revisions"] = {
    put: async (r) => {
      this.records.set(r.id, r);
    },
    get: async (id) => this.records.get(id),
    list: async (graph) => [...this.records.values()].filter((r) => r.graph === graph),
  };

  readonly heads: ProceduralStore["heads"] = {
    get: async (graph) => this.headOf.get(graph),
    set: async (graph, expected, next) => {
      this.beforeHeadSet?.();
      const head = this.headOf.get(graph);
      if (head?.revision !== expected) return false;
      this.headOf.set(graph, { revision: next, history: head === undefined ? [] : [head.revision, ...head.history] });
      return true;
    },
  };

  overlay(graph: GraphId): AppendLog<OverlayEvent> {
    if (!this.overlayLog.has(graph)) this.overlayLog.set(graph, []);
    return log(this.overlayLog.get(graph)!, {});
  }

  dreams(graph: GraphId): AppendLog<unknown> {
    if (!this.dreamLog.has(graph)) this.dreamLog.set(graph, []);
    return log(this.dreamLog.get(graph)!, { beforeAppend: (events) => this.beforeDreamAppend?.(events) });
  }

  readonly pins: ProceduralStore["pins"] = { get: async () => undefined, set: async () => {} };
  readonly guidance: ProceduralStore["guidance"] = { put: async () => {}, get: async () => undefined };

  readonly lease: ProceduralStore["lease"] = {
    acquire: async (graph, holder): Promise<Lease | undefined> => {
      const lease = this.leases.get(graph);
      if (lease !== undefined && lease.holder !== null && lease.holder !== holder) return undefined;
      const epoch = (lease?.epoch ?? 0) + 1;
      this.leases.set(graph, { holder, epoch });
      return { epoch };
    },
    renew: async (graph, holder, epoch) => this.#holds(graph, holder, epoch),
    release: async (graph, holder, epoch) => {
      if (!this.#holds(graph, holder, epoch)) return false;
      this.leases.set(graph, { holder: null, epoch });
      return true;
    },
  };

  #holds(graph: GraphId, holder: string, epoch: number): boolean {
    const lease = this.leases.get(graph);
    return lease?.holder === holder && lease.epoch === epoch;
  }

  async redact(): Promise<void> {}
}
