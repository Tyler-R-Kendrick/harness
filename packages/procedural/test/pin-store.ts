/**
 * A small in-memory `ProceduralStore` for pinning tests, over a plain `disk` record so a
 * test can reopen it (a new store over a copy of what the old one wrote), as a restart
 * would. Revisions, graphs and overlay events are built from the hotpot fixture.
 */
import { foldAll, GraphIdSchema, OverlayEventSchema, parseGraph, revisionId, RevisionRecordSchema } from "@harness/procedural";
import type { AppendLog, GraphId, Head, Lease, OverlayEvent, Pin, ProceduralStore, RevisionId, RevisionRecord } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";

export interface Disk {
  revisions: Record<string, RevisionRecord>;
  heads: Record<string, Head>;
  overlay: Record<string, OverlayEvent[]>;
  dreams: Record<string, unknown[]>;
  pins: Record<string, Pin>;
  guidance: Record<string, string>;
}

const emptyDisk = (): Disk => ({ revisions: {}, heads: {}, overlay: {}, dreams: {}, pins: {}, guidance: {} });

function log<E>(entries: E[]): AppendLog<E> {
  return {
    append: (events) => {
      entries.push(...events);
      return Promise.resolve(entries.length);
    },
    read: (from, limit = Number.POSITIVE_INFINITY) => Promise.resolve(entries.slice(from, from + limit).map((event, i) => ({ offset: from + i, event }))),
    head: () => Promise.resolve(entries.length),
  };
}

export class FakeStore implements ProceduralStore {
  /** How many times a pin was written. */
  pinWrites = 0;
  readonly disk: Disk;

  constructor(disk: Disk = emptyDisk()) {
    this.disk = disk;
  }

  /** A new store over a copy of this one's disk, as after a restart. */
  reopen(): FakeStore {
    return new FakeStore(structuredClone(this.disk));
  }

  readonly revisions = {
    put: (record: RevisionRecord) => {
      this.disk.revisions[record.id] = record;
      return Promise.resolve();
    },
    get: (id: RevisionId) => Promise.resolve(this.disk.revisions[id]),
    list: (graph: GraphId) => Promise.resolve(Object.values(this.disk.revisions).filter((r) => r.graph === graph)),
  };

  readonly heads = {
    get: (graph: GraphId) => Promise.resolve(this.disk.heads[graph]),
    set: (graph: GraphId, expected: RevisionId | undefined, next: RevisionId) => {
      const current = this.disk.heads[graph];
      if (current?.revision !== expected) return Promise.resolve(false);
      this.disk.heads[graph] = { revision: next, history: current === undefined ? [] : [current.revision, ...current.history] };
      return Promise.resolve(true);
    },
  };

  overlay(graph: GraphId): AppendLog<OverlayEvent> {
    return log((this.disk.overlay[graph] ??= []));
  }

  dreams(graph: GraphId): AppendLog<unknown> {
    return log((this.disk.dreams[graph] ??= []));
  }

  readonly pins = {
    get: (session: string) => Promise.resolve(this.disk.pins[session]),
    set: (session: string, pin: Pin) => {
      this.pinWrites += 1;
      this.disk.pins[session] = pin;
      return Promise.resolve();
    },
  };

  readonly guidance = {
    put: (id: string, text: string) => {
      this.disk.guidance[id] = text;
      return Promise.resolve();
    },
    get: (id: string) => Promise.resolve(this.disk.guidance[id]),
  };

  readonly lease = {
    acquire: (): Promise<Lease | undefined> => Promise.resolve({ epoch: 1 }),
    renew: () => Promise.resolve(true),
    release: () => Promise.resolve(true),
  };

  redact(): Promise<void> {
    return Promise.resolve();
  }
}

export const GRAPH: GraphId = GraphIdSchema.parse("g");

/** A distinct core revision `n` (the hotpot graph with a marked Start), with its parents and origin. */
export function revision(n: number, parents: readonly RevisionId[] = [], origin: RevisionRecord["origin"] = "dream", graph: GraphId = GRAPH): RevisionRecord {
  const input = hotpot();
  input.nodes[0]!.description = `The task begins (v${n}).`;
  const parsed = parseGraph(input);
  if (!parsed.ok) throw new Error("fixture");
  return RevisionRecordSchema.parse({ id: revisionId(parsed.graph), graph, parents, document: parsed.graph, edits: null, origin, evidence: {}, decision: { kind: "head" }, at: 0 });
}

/** A turn observed on the overlay. */
export const turn = (key: string): OverlayEvent => OverlayEventSchema.parse({ kind: "observed", turnKey: key, path: ["Start"], unmatched: [], score: null, exposure: [] });

/** The overlay version the graph's log has reached. */
export async function version(store: ProceduralStore, graph: GraphId = GRAPH): Promise<number> {
  const events = (await store.overlay(graph).read(0)).map((e) => e.event);
  return foldAll(await headOf(store, graph), events).version;
}

async function headOf(store: ProceduralStore, graph: GraphId): Promise<RevisionId> {
  const head = await store.heads.get(graph);
  if (head === undefined) throw new Error("no head");
  return head.revision;
}

/** Record a revision and move the graph's head to it. */
export async function commit(store: ProceduralStore, record: RevisionRecord): Promise<void> {
  await store.revisions.put(record);
  const head = await store.heads.get(record.graph);
  if (!(await store.heads.set(record.graph, head?.revision, record.id))) throw new Error("head moved");
}

/** Append the rebase of the overlay onto `core`, frozen at the current version. */
export async function rebase(store: ProceduralStore, core: RevisionId, graph: GraphId = GRAPH): Promise<number> {
  const frozenAt = await version(store, graph);
  await store.overlay(graph).append([OverlayEventSchema.parse({ kind: "rebased", core, absorbed: [], dropped: [], frozenAt })]);
  return frozenAt;
}

/** Append `n` observed turns with fresh keys. */
export async function observe(store: ProceduralStore, n: number, graph: GraphId = GRAPH): Promise<void> {
  const at = await store.overlay(graph).head();
  await store.overlay(graph).append(Array.from({ length: n }, (_, i) => turn(`s/${at + i}`)));
}
