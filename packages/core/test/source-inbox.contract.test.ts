import { describe, expect, it } from "vitest";
import { WorkQueue } from "@harness/core";
import type { SourceConnection, SourceEvent, SourcePage } from "@harness/core";

/** What the inbox contract is allowed to do to a source: append, drop, and replay. */
interface InboxDriver {
  readonly connection: SourceConnection;
  readonly reads: (string | undefined)[];
  emit(event: SourceEvent): void;
  close(): void;
  open(): void;
  replay(events: readonly SourceEvent[]): void;
}

/** Opaque page tokens. A read that does not present the token the previous page issued is closed. */
class TokenLog implements InboxDriver {
  readonly reads: (string | undefined)[] = [];
  readonly #log: SourceEvent[] = [];
  readonly #index = new Map<string, number>();
  #issued = 0;
  #closed = false;
  #replay: readonly SourceEvent[] | undefined;
  readonly connection: SourceConnection = { read: (cursor) => this.#read(cursor) };

  emit(event: SourceEvent): void {
    this.#log.push(event);
  }

  close(): void {
    this.#closed = true;
  }

  open(): void {
    this.#closed = false;
  }

  replay(events: readonly SourceEvent[]): void {
    this.#replay = events;
  }

  #read(cursor: string | undefined): SourcePage {
    this.reads.push(cursor);
    if (this.#closed) return { open: false };
    const from = cursor === undefined ? 0 : this.#index.get(cursor);
    if (from === undefined) return { open: false };
    const replay = this.#replay ?? [];
    this.#replay = undefined;
    const token = `t${this.#issued}`;
    this.#issued += 1;
    this.#index.set(token, this.#log.length);
    return { open: true, cursor: token, events: [...replay, ...this.#log.slice(from)] };
  }
}

/** The cursor is the index of the next log entry. */
class IndexLog implements InboxDriver {
  readonly reads: (string | undefined)[] = [];
  readonly #log: SourceEvent[] = [];
  #closed = false;
  #replay: readonly SourceEvent[] | undefined;
  readonly connection: SourceConnection = { read: (cursor) => this.#read(cursor) };

  emit(event: SourceEvent): void {
    this.#log.push(event);
  }

  close(): void {
    this.#closed = true;
  }

  open(): void {
    this.#closed = false;
  }

  replay(events: readonly SourceEvent[]): void {
    this.#replay = events;
  }

  #read(cursor: string | undefined): SourcePage {
    this.reads.push(cursor);
    if (this.#closed) return { open: false };
    const from = cursor === undefined ? 0 : Number(cursor);
    const replay = this.#replay ?? [];
    this.#replay = undefined;
    return { open: true, cursor: String(this.#log.length), events: [...replay, ...this.#log.slice(from)] };
  }
}

const keep = (event: SourceEvent): boolean => event.body.startsWith("keep");

function sourceInboxContract(prefix: string, make: () => InboxDriver): void {
  describe(`${prefix} source inbox`, () => {
    it(`${prefix}.1 a filter keeps a matching event and drops one it rejects`, () => {
      const driver = make();
      const queue = new WorkQueue();
      expect(queue.connect("src", driver.connection, keep).ok).toBe(true);
      driver.emit({ id: "a", body: "keep a" });
      driver.emit({ id: "b", body: "drop b" });
      driver.emit({ id: "c", body: "keep c" });
      const ingested = queue.ingest("src");
      expect(ingested.ok && ingested.value.map((item) => item.id)).toEqual(["a", "c"]);
      expect(queue.inbox().map((item) => item.outcome)).toEqual(["keep a", "keep c"]);
      expect(queue.toJSON().sources[0]?.delivered).toEqual(["a", "c"]);
    });

    it(`${prefix}.2 a closed page delivers nothing and does not move the cursor`, () => {
      const driver = make();
      const queue = new WorkQueue();
      expect(queue.connect("src", driver.connection, keep).ok).toBe(true);
      driver.emit({ id: "a", body: "keep a" });
      expect(queue.ingest("src").ok).toBe(true);
      const cursor = queue.toJSON().sources[0]?.cursor;
      driver.close();
      driver.emit({ id: "d", body: "keep d" });
      const closed = queue.ingest("src");
      expect(closed.ok && closed.value).toEqual([]);
      expect(queue.toJSON().sources[0]?.cursor).toBe(cursor);
      expect(driver.reads.at(-1)).toBe(cursor);
    });

    it(`${prefix}.3 after the connection resumes, a new matching event arrives once and a replay does not`, () => {
      const driver = make();
      const queue = new WorkQueue();
      expect(queue.connect("src", driver.connection, keep).ok).toBe(true);
      driver.emit({ id: "a", body: "keep a" });
      driver.emit({ id: "b", body: "drop b" });
      expect(queue.ingest("src").ok).toBe(true);
      const cursor = queue.toJSON().sources[0]?.cursor;
      driver.close();
      expect(queue.ingest("src").ok).toBe(true);
      driver.open();
      driver.emit({ id: "e", body: "keep e" });
      driver.replay([{ id: "a", body: "keep a" }]);
      const restored = WorkQueue.fromJSON(queue.toJSON());
      expect(restored.attach("src", driver.connection, keep).ok).toBe(true);
      const ingested = restored.ingest("src");
      expect(ingested.ok && ingested.value.map((item) => item.id)).toEqual(["e"]);
      expect(driver.reads.at(-1)).toBe(cursor);
      driver.replay([{ id: "a", body: "keep a" }, { id: "e", body: "keep e" }]);
      const again = restored.ingest("src");
      expect(again.ok && again.value).toEqual([]);
      expect(restored.inbox().map((item) => item.id)).toEqual(["a", "e"]);
    });
  });
}

describe("source inbox contract", () => {
  sourceInboxContract("IC1", () => new TokenLog());
  sourceInboxContract("IC2", () => new IndexLog());
});
