import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

/** One event from an external source. */
export interface SourceEvent {
  readonly id: string;
  readonly body: string;
}

/** A page from a durable source read. A closed page delivers nothing and does not move the cursor. */
export type SourcePage =
  | { readonly open: false }
  | { readonly open: true; readonly cursor: string; readonly events: readonly SourceEvent[] };

/**
 * The port a host uses to pull a source. The queue stores the cursor and which event ids
 * it already delivered, so a drop and a later redelivery are the host's to perform.
 */
export interface SourceConnection {
  read(cursor: string | undefined): SourcePage;
}

/** An item to implement. `outcome` is the description a later check steers against. */
export interface WorkItem {
  readonly id: string;
  readonly outcome: string;
}

/** Decides whether a result meets the item's stored outcome description. */
export type OutcomeVerifier = (outcome: string, result: string) => boolean;

export type QueueError =
  | "duplicate_item"
  | "unknown_item"
  | "duplicate_source"
  | "unknown_source"
  | "detached";

/** Snapshot of items, the inbox, and per-source cursors. Connections and filters are ports, reattached by the host. */
export interface WorkQueueData {
  readonly items: readonly WorkItem[];
  readonly inbox: readonly string[];
  readonly sources: readonly { readonly id: string; readonly cursor: string | null; readonly delivered: readonly string[] }[];
}

interface SourceBinding {
  connection: SourceConnection | undefined;
  filter: (event: SourceEvent) => boolean;
  cursor: string | undefined;
  readonly delivered: Set<string>;
}

/** A work queue and the filtered pseudo inbox its sources fill. */
export class WorkQueue {
  readonly #items = new Map<string, WorkItem>();
  readonly #inbox: WorkItem[] = [];
  readonly #sources = new Map<string, SourceBinding>();

  add(item: WorkItem): Result<WorkItem, QueueError> {
    if (this.#items.has(item.id)) return err("duplicate_item", `work item ${item.id} already exists`);
    const stored = { id: item.id, outcome: item.outcome };
    this.#items.set(stored.id, stored);
    return ok(stored);
  }

  item(id: string): WorkItem | undefined {
    return this.#items.get(id);
  }

  /** Runs `verifier` on the item's stored outcome and the candidate result. */
  check(id: string, result: string, verifier: OutcomeVerifier): Result<boolean, QueueError> {
    const item = this.#items.get(id);
    if (item === undefined) return err("unknown_item", `no work item ${id}`);
    return ok(verifier(item.outcome, result));
  }

  connect(
    sourceId: string,
    connection: SourceConnection,
    filter?: (event: SourceEvent) => boolean,
  ): Result<true, QueueError> {
    if (this.#sources.has(sourceId)) return err("duplicate_source", `source ${sourceId} is already connected`);
    this.#sources.set(sourceId, {
      connection,
      filter: filter ?? (() => true),
      cursor: undefined,
      delivered: new Set(),
    });
    return ok(true);
  }

  /** Binds a port back onto a source restored from a snapshot, without moving its cursor. */
  attach(
    sourceId: string,
    connection: SourceConnection,
    filter?: (event: SourceEvent) => boolean,
  ): Result<true, QueueError> {
    const source = this.#sources.get(sourceId);
    if (source === undefined) return err("unknown_source", `no source ${sourceId}`);
    if (source.connection !== undefined) return err("duplicate_source", `source ${sourceId} is already attached`);
    source.connection = connection;
    source.filter = filter ?? (() => true);
    return ok(true);
  }

  ingest(sourceId: string): Result<readonly WorkItem[], QueueError> {
    const source = this.#sources.get(sourceId);
    if (source === undefined) return err("unknown_source", `no source ${sourceId}`);
    if (source.connection === undefined) return err("detached", `source ${sourceId} is not attached`);
    const page = source.connection.read(source.cursor);
    if (!page.open) return ok([]);
    source.cursor = page.cursor;
    const accepted: WorkItem[] = [];
    for (const event of page.events) {
      if (source.delivered.has(event.id) || !source.filter(event)) continue;
      source.delivered.add(event.id);
      // The id already belongs to a manual item or to another source. Keep that item.
      if (this.#items.has(event.id)) continue;
      const item = { id: event.id, outcome: event.body };
      this.#items.set(item.id, item);
      this.#inbox.push(item);
      accepted.push(item);
    }
    return ok(accepted);
  }

  inbox(): readonly WorkItem[] {
    return this.#inbox;
  }

  toJSON(): WorkQueueData {
    return {
      items: [...this.#items.values()].map((item) => ({ id: item.id, outcome: item.outcome })),
      inbox: this.#inbox.map((item) => item.id),
      sources: [...this.#sources.entries()].map(([id, source]) => ({
        id,
        cursor: source.cursor ?? null,
        delivered: [...source.delivered],
      })),
    };
  }

  static fromJSON(data: unknown): WorkQueue {
    if (!isRecord(data) || !Array.isArray(data["items"]) || !Array.isArray(data["inbox"]) || !Array.isArray(data["sources"])) {
      throw new Error("invalid work queue data");
    }
    const queue = new WorkQueue();
    for (const raw of data["items"]) {
      if (!isRecord(raw) || typeof raw["id"] !== "string" || typeof raw["outcome"] !== "string" || queue.#items.has(raw["id"])) {
        throw new Error("invalid work queue data");
      }
      const stored = { id: raw["id"], outcome: raw["outcome"] };
      queue.#items.set(stored.id, stored);
    }
    const seen = new Set<string>();
    for (const id of data["inbox"]) {
      // A non-string id is never a map key, so the missing-item check still throws.
      if (typeof id !== "string" || seen.has(id)) throw new Error("invalid work queue data");
      const item = queue.#items.get(id);
      if (item === undefined) throw new Error("invalid work queue data");
      seen.add(id);
      queue.#inbox.push(item);
    }
    for (const raw of data["sources"]) {
      if (!isRecord(raw) || typeof raw["id"] !== "string" || queue.#sources.has(raw["id"]) || !Array.isArray(raw["delivered"])) {
        throw new Error("invalid work queue data");
      }
      const cursor = raw["cursor"];
      if (cursor !== null && typeof cursor !== "string") throw new Error("invalid work queue data");
      const delivered = new Set<string>();
      for (const eventId of raw["delivered"]) {
        if (typeof eventId !== "string") throw new Error("invalid work queue data");
        delivered.add(eventId);
      }
      queue.#sources.set(raw["id"], {
        connection: undefined,
        // Stryker disable next-line all: equivalent; ingest refuses a detached source before calling this, and attach replaces it
        filter: () => false,
        cursor: cursor === null ? undefined : cursor,
        delivered,
      });
    }
    return queue;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // A primitive still fails the array checks in fromJSON and throws the same message.
  return typeof value === "object" && value !== null;
}
