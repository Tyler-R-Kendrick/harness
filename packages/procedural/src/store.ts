import type { GraphId, RevisionId, RevisionRecord } from "./graph.ts";
import type { OverlayEvent } from "./overlay-types.ts";

/**
 * The stores behind procedural graphs (plan §4, ADR 0016): core revisions and heads,
 * each graph's overlay event log and dream event log, session pins, guidance texts,
 * and a lease per graph so one dream runs at a time. A port: memory and
 * `SnapshotStorage`-backed implementations share one contract suite (testkit).
 */

/** An append-only log. Offsets start at 0 and are dense. */
export interface AppendLog<E> {
  /** Append in order; resolves to the new head (the next offset). */
  append(events: readonly E[]): Promise<number>;
  /** Entries from `from` (inclusive), at most `limit` of them. */
  read(from: number, limit?: number): Promise<readonly { readonly offset: number; readonly event: E }[]>;
  head(): Promise<number>;
}

/** A session's pinned version pair and its exposure salt. */
export interface Pin {
  readonly graph: GraphId;
  readonly core: RevisionId;
  /** The overlay version the session reads (plan §5.1). */
  readonly overlay: number;
  /** Per-session salt for probation exposure, drawn once from the Entropy port. */
  readonly salt: string;
  /** Clock time of the pin, in milliseconds. */
  readonly at: number;
}

export interface Head {
  readonly revision: RevisionId;
  /** Earlier heads, most recent first (for revert). */
  readonly history: readonly RevisionId[];
}

export interface Lease {
  readonly epoch: number;
}

export interface ProceduralStore {
  /**
   * Revision records, keyed by graph and id: the same document in two graphs is two
   * records, each with its own origin, parents and decision. A put with a known key
   * replaces that record in place.
   */
  readonly revisions: {
    put(record: RevisionRecord): Promise<void>;
    get(graph: GraphId, id: RevisionId): Promise<RevisionRecord | undefined>;
    /** The graph's records in put order. */
    list(graph: GraphId): Promise<readonly RevisionRecord[]>;
  };
  readonly heads: {
    get(graph: GraphId): Promise<Head | undefined>;
    /** Compare-and-set: moves the head only when it is still `expected`. */
    set(graph: GraphId, expected: RevisionId | undefined, next: RevisionId): Promise<boolean>;
  };
  overlay(graph: GraphId): AppendLog<OverlayEvent>;
  dreams(graph: GraphId): AppendLog<unknown>;
  readonly pins: {
    get(session: string): Promise<Pin | undefined>;
    set(session: string, pin: Pin): Promise<void>;
  };
  readonly guidance: {
    put(id: string, text: string): Promise<void>;
    get(id: string): Promise<string | undefined>;
  };
  readonly lease: {
    /** A new epoch when the graph's lease is free or held by `holder`; undefined when another holder has it. */
    acquire(graph: GraphId, holder: string): Promise<Lease | undefined>;
    /** False for a stale epoch. */
    renew(graph: GraphId, holder: string, epoch: number): Promise<boolean>;
    release(graph: GraphId, holder: string, epoch: number): Promise<boolean>;
  };
  /**
   * Tombstones a revision's text in place; its id stays. Redaction is by content: every
   * graph's record of the id is redacted, and so is any record put under the id later.
   */
  redact(id: RevisionId): Promise<void>;
}
