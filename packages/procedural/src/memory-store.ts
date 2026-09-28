/**
 * The in-memory `ProceduralStore` (plan §4): the reference implementation of the store
 * contract, and the state `SnapshotProceduralStore` loads, changes and saves whole.
 * Every operation changes the state synchronously when it is called, so a
 * compare-and-set or a lease acquire cannot interleave with another operation.
 */
import type { GraphId, RevisionId, RevisionRecord } from "./graph.ts";
import type { OverlayEvent } from "./overlay-types.ts";
import type { AppendLog, Head, Lease, Pin, ProceduralStore } from "./store.ts";

/** What replaces every text of a redacted revision. */
export const TOMBSTONE = "[redacted]";

export const STORE_FORMAT = "harness.procedural-store/v1";

/** The whole store as plain JSON, in insertion order: what a snapshot saves and a store is rebuilt from. */
export interface ProceduralStoreDocument {
  readonly format: typeof STORE_FORMAT;
  readonly revisions: readonly RevisionRecord[];
  readonly heads: readonly { readonly graph: GraphId; readonly revision: RevisionId; readonly history: readonly RevisionId[] }[];
  readonly overlay: readonly { readonly graph: GraphId; readonly events: readonly OverlayEvent[] }[];
  readonly dreams: readonly { readonly graph: GraphId; readonly events: readonly unknown[] }[];
  readonly pins: readonly { readonly session: string; readonly pin: Pin }[];
  readonly guidance: readonly { readonly id: string; readonly text: string }[];
  /** `holder` is null when the lease is free; `epoch` is the last one granted. */
  readonly leases: readonly { readonly graph: GraphId; readonly holder: string | null; readonly epoch: number }[];
}

/** Every string in a JSON value becomes the tombstone; numbers, booleans, nulls, keys and shape stay. */
function scrub(value: unknown): unknown {
  if (typeof value === "string") return TOMBSTONE;
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
}

/**
 * A revision with its text tombstoned in place (plan §9): descriptions, conditions,
 * guidance, pitfalls, edit texts, decision reasons, diagnostic messages and every string
 * in its evidence. Ids, structure, vocabularies, bindings and numbers stay. The record
 * is marked `redacted`, so its id is no longer checked against its document.
 */
export function redactRecord(record: RevisionRecord): RevisionRecord {
  const { document, edits, decision } = record;
  return {
    ...record,
    document: {
      ...document,
      nodes: document.nodes.map((n) => ({ ...n, description: TOMBSTONE })),
      edges: document.edges.map((e) => ({ ...e, condition: e.condition === null ? null : TOMBSTONE, guidance: TOMBSTONE, pitfalls: TOMBSTONE })),
    },
    edits:
      edits === null
        ? null
        : {
            ...edits,
            add_nodes: edits.add_nodes.map((n) => ({ ...n, description: TOMBSTONE })),
            add_edges: edits.add_edges.map((e) => ({ ...e, condition: e.condition === null ? null : TOMBSTONE, guidance: TOMBSTONE, pitfalls: TOMBSTONE })),
          },
    decision:
      decision.kind === "rejected-gate"
        ? { ...decision, reason: TOMBSTONE }
        : decision.kind === "rejected-structure"
          ? { ...decision, diagnostics: decision.diagnostics.map((d) => ({ ...d, message: TOMBSTONE })) }
          : decision,
    evidence: Object.fromEntries(Object.entries(record.evidence).map(([k, v]) => [k, scrub(v)])),
    redacted: true,
  };
}

function checkNatural(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number of at least 0, not ${value}`);
}

/** A dense log per graph, over a map the store owns; a graph's array exists once an event is appended. */
function logOf<E>(logs: Map<GraphId, E[]>, graph: GraphId): AppendLog<E> {
  const entries = (): readonly E[] => logs.get(graph) ?? [];
  return {
    async append(events) {
      if (events.length === 0) return entries().length;
      const log = logs.get(graph) ?? [];
      log.push(...events);
      logs.set(graph, log);
      return log.length;
    },
    async read(from, limit) {
      checkNatural("from", from);
      if (limit !== undefined) checkNatural("limit", limit);
      return entries()
        .slice(from, limit === undefined ? undefined : from + limit)
        .map((event, i) => ({ offset: from + i, event }));
    },
    async head() {
      return entries().length;
    },
  };
}

interface LeaseState {
  readonly holder: string | null;
  readonly epoch: number;
}

export class MemoryProceduralStore implements ProceduralStore {
  readonly #revisions = new Map<RevisionId, RevisionRecord>();
  readonly #heads = new Map<GraphId, Head>();
  readonly #overlay = new Map<GraphId, OverlayEvent[]>();
  readonly #dreams = new Map<GraphId, unknown[]>();
  readonly #pins = new Map<string, Pin>();
  readonly #guidance = new Map<string, string>();
  readonly #leases = new Map<GraphId, LeaseState>();

  /** Empty, or the state a `document()` recorded. */
  constructor(document?: ProceduralStoreDocument) {
    if (document === undefined) return;
    for (const r of document.revisions) this.#revisions.set(r.id, r);
    for (const h of document.heads) this.#heads.set(h.graph, { revision: h.revision, history: h.history });
    for (const l of document.overlay) this.#overlay.set(l.graph, [...l.events]);
    for (const l of document.dreams) this.#dreams.set(l.graph, [...l.events]);
    for (const p of document.pins) this.#pins.set(p.session, p.pin);
    for (const g of document.guidance) this.#guidance.set(g.id, g.text);
    for (const l of document.leases) this.#leases.set(l.graph, { holder: l.holder, epoch: l.epoch });
  }

  /** The whole state as a new plain JSON value. */
  document(): ProceduralStoreDocument {
    return {
      format: STORE_FORMAT,
      revisions: [...this.#revisions.values()],
      heads: [...this.#heads].map(([graph, h]) => ({ graph, revision: h.revision, history: h.history })),
      overlay: [...this.#overlay].map(([graph, events]) => ({ graph, events: [...events] })),
      dreams: [...this.#dreams].map(([graph, events]) => ({ graph, events: [...events] })),
      pins: [...this.#pins].map(([session, pin]) => ({ session, pin })),
      guidance: [...this.#guidance].map(([id, text]) => ({ id, text })),
      leases: [...this.#leases].map(([graph, l]) => ({ graph, holder: l.holder, epoch: l.epoch })),
    };
  }

  readonly revisions: ProceduralStore["revisions"] = {
    put: async (record) => {
      // Redaction is sticky: putting the same document again must not bring its text back.
      this.#revisions.set(record.id, this.#revisions.get(record.id)?.redacted === true ? redactRecord(record) : record);
    },
    get: async (id) => this.#revisions.get(id),
    list: async (graph) => [...this.#revisions.values()].filter((r) => r.graph === graph),
  };

  readonly heads: ProceduralStore["heads"] = {
    get: async (graph) => this.#heads.get(graph),
    set: async (graph, expected, next) => {
      const head = this.#heads.get(graph);
      if (head?.revision !== expected) return false;
      if (head === undefined) this.#heads.set(graph, { revision: next, history: [] });
      else if (head.revision !== next) this.#heads.set(graph, { revision: next, history: [head.revision, ...head.history] });
      return true;
    },
  };

  /** Every graph with a head, in the order each got its first (for hosts that tend every graph, such as dream's schedule). */
  async graphs(): Promise<readonly GraphId[]> {
    return [...this.#heads.keys()];
  }

  overlay(graph: GraphId): AppendLog<OverlayEvent> {
    return logOf(this.#overlay, graph);
  }

  dreams(graph: GraphId): AppendLog<unknown> {
    return logOf(this.#dreams, graph);
  }

  readonly pins: ProceduralStore["pins"] = {
    get: async (session) => this.#pins.get(session),
    set: async (session, pin) => {
      this.#pins.set(session, pin);
    },
  };

  readonly guidance: ProceduralStore["guidance"] = {
    put: async (id, text) => {
      this.#guidance.set(id, text);
    },
    get: async (id) => this.#guidance.get(id),
  };

  readonly lease: ProceduralStore["lease"] = {
    acquire: async (graph, holder): Promise<Lease | undefined> => {
      const lease = this.#leases.get(graph);
      if (lease !== undefined && lease.holder !== null && lease.holder !== holder) return undefined;
      // Epochs only grow, even across releases, so no earlier epoch ever becomes current again.
      const epoch = (lease?.epoch ?? 0) + 1;
      this.#leases.set(graph, { holder, epoch });
      return { epoch };
    },
    renew: async (graph, holder, epoch) => this.#holds(graph, holder, epoch),
    release: async (graph, holder, epoch) => {
      if (!this.#holds(graph, holder, epoch)) return false;
      this.#leases.set(graph, { holder: null, epoch });
      return true;
    },
  };

  #holds(graph: GraphId, holder: string, epoch: number): boolean {
    const lease = this.#leases.get(graph);
    return lease !== undefined && lease.holder === holder && lease.epoch === epoch;
  }

  async redact(id: RevisionId): Promise<void> {
    const record = this.#revisions.get(id);
    if (record !== undefined) this.#revisions.set(id, redactRecord(record));
  }
}
