import { DecisionError, DecisionRecordSchema, OutcomeSchema } from "@harness/decision";
import type { DecisionFilter, DecisionId, DecisionLog, DecisionRecord, Outcome } from "@harness/decision";

const RECORDS = "records";
const META = "meta";
/** The meta store's keys: the next id to issue, and the next position in the order records are appended in (which the cap drops them by). */
const NEXT_ID = "next";
const NEXT_SEQ = "seq";
/** The records' indexes: by position, and (for records without an outcome only) by position. */
const BY_SEQ = "seq";
const BY_UNLABELLED = "unlabelled";

/** A record as stored under its id number: where it came in the order of appends, and the record. `unlabelled` is that position while it has no outcome and is left out once it has one (an index leaves out what lacks its key). */
interface Stored {
  readonly seq: number;
  readonly unlabelled?: number;
  readonly record: DecisionRecord;
}

const stored = (seq: number, record: DecisionRecord): Stored => ({ seq, ...(record.outcome === undefined ? { unlabelled: seq } : {}), record });
const numberOf = (id: DecisionId): number => Number(id.slice("dec-".length));

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function issuesOf(error: { readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[] }): string {
  return error.issues.map((issue) => `${issue.path.length === 0 ? "(value)" : issue.path.map(String).join(".")}: ${issue.message}`).join("; ");
}

export interface IndexedDbDecisionLogOptions {
  /** The database's name (default `harness-decisions`). */
  readonly name?: string;
  /** The IndexedDB to use (default the context's). */
  readonly factory?: IDBFactory;
  /**
   * Keep at most this many records, by the rule of `MemoryDecisionLog`: past it the oldest
   * records without an outcome go first (labelled ones are what calibration needs), then the
   * oldest; the newest never does. "Oldest" is the order of appending, not of id.
   */
  readonly maxRecords?: number;
}

/**
 * Decisions in IndexedDB: an object store of records keyed by their id number (so a query
 * reads them in id order), and a meta store holding the id counter, which is why an id is
 * never issued twice, across restarts and across tabs that share the database. Each call is
 * one transaction, so calls land in the order made and a failed one changes nothing. An
 * id can be appended only by the log that issued it (and only once).
 */
export class IndexedDbDecisionLog implements DecisionLog {
  readonly #db: Promise<IDBDatabase>;
  readonly #max: number;
  /** Ids this log issued and has not appended: the only ids `append` accepts. */
  readonly #issued = new Set<number>();

  constructor(options: IndexedDbDecisionLogOptions = {}) {
    const { maxRecords } = options;
    if (maxRecords !== undefined && !(Number.isInteger(maxRecords) && maxRecords >= 1)) throw new DecisionError("invalid", `maxRecords is a whole number from 1, got ${maxRecords}`);
    this.#max = maxRecords ?? Number.POSITIVE_INFINITY;
    const open = (options.factory ?? indexedDB).open(options.name ?? "harness-decisions", 1);
    open.onupgradeneeded = () => {
      const records = open.result.createObjectStore(RECORDS);
      records.createIndex(BY_SEQ, "seq", { unique: true });
      records.createIndex(BY_UNLABELLED, "unlabelled", { unique: true });
      open.result.createObjectStore(META);
    };
    this.#db = done(open);
    // A database that cannot be opened fails the calls made on it; it is not an unhandled rejection of its own.
    this.#db.catch(() => {});
  }

  /** One transaction over both stores: nothing is written unless `body` completes. */
  async #transaction<T>(mode: IDBTransactionMode, body: (records: IDBObjectStore, meta: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await this.#db;
    const tx = db.transaction([RECORDS, META], mode);
    const finished = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("the transaction was aborted"));
    });
    // Whichever way the body ends, the transaction's own outcome is awaited, so nothing is left unhandled.
    finished.catch(() => {});
    let result: T;
    try {
      result = await body(tx.objectStore(RECORDS), tx.objectStore(META));
    } catch (error) {
      // A request that failed has aborted the transaction already.
      if (tx.error === null) tx.abort();
      await finished.catch(() => {});
      throw error;
    }
    await finished;
    return result;
  }

  async next(): Promise<DecisionId> {
    const n = await this.#transaction("readwrite", async (_records, meta) => {
      const issued = ((await done(meta.get(NEXT_ID))) as number | undefined) ?? 0;
      await done(meta.put(issued + 1, NEXT_ID));
      return issued;
    });
    this.#issued.add(n);
    return `dec-${n}`;
  }

  async append(record: DecisionRecord): Promise<void> {
    const parsed = DecisionRecordSchema.safeParse(record);
    if (!parsed.success) throw new DecisionError("invalid", `not a decision record:\n${issuesOf(parsed.error)}`);
    const n = numberOf(parsed.data.id);
    if (!this.#issued.has(n)) {
      const known = await this.#transaction("readonly", (records) => done(records.count(n)));
      throw new DecisionError("refused", known > 0 ? `${parsed.data.id} is already in the log` : `${parsed.data.id} was not issued by next(), or has been used`);
    }
    await this.#transaction("readwrite", async (records, meta) => {
      if ((await done(records.count(n))) > 0) throw new DecisionError("refused", `${parsed.data.id} is already in the log`);
      const seq = ((await done(meta.get(NEXT_SEQ))) as number | undefined) ?? 0;
      await done(meta.put(seq + 1, NEXT_SEQ));
      await done(records.put(stored(seq, parsed.data), n));
      await this.#trim(records, n);
    });
    this.#issued.delete(n);
  }

  /** Enforce the cap: oldest unlabelled first, then oldest, never `newest`. */
  async #trim(records: IDBObjectStore, newest: number): Promise<void> {
    for (let excess = (await done(records.count())) - this.#max; excess > 0; excess--) {
      const victim = (await firstExcept(records.index(BY_UNLABELLED), newest)) ?? (await firstExcept(records.index(BY_SEQ), newest));
      await done(records.delete(victim!));
    }
  }

  async outcome(id: DecisionId, outcome: Outcome): Promise<boolean> {
    const parsed = OutcomeSchema.safeParse(outcome);
    if (!parsed.success) throw new DecisionError("invalid", `not an outcome:\n${issuesOf(parsed.error)}`);
    const n = numberOf(id);
    return this.#transaction("readwrite", async (records) => {
      const found = (await done(records.get(n))) as Stored | undefined;
      if (found === undefined) return false;
      await done(records.put(stored(found.seq, { ...found.record, outcome: parsed.data }), n));
      return true;
    });
  }

  async get(id: DecisionId): Promise<DecisionRecord | undefined> {
    const found = await this.#transaction("readonly", (records) => done(records.get(numberOf(id))) as Promise<Stored | undefined>);
    return found === undefined ? undefined : DecisionRecordSchema.parse(found.record);
  }

  async query(filter: DecisionFilter = {}): Promise<DecisionRecord[]> {
    const { fork, session, mode, hasOutcome, since, until, after, limit } = filter;
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw new DecisionError("invalid", `limit is a whole number from 0, got ${limit}`);
    const past = after === undefined ? -1 : numberOf(after);
    return this.#transaction("readonly", async (records) => {
      const found: DecisionRecord[] = [];
      const request = records.openCursor();
      let first = await done(request);
      // Ids are whole numbers, so the first one after `past` is `past + 1` or later.
      if (first !== null && (first.key as number) <= past) {
        first.continue(past + 1);
        first = await done(request);
      }
      for (let cursor = first; cursor !== null && found.length !== limit; cursor = await done(request)) {
        const r = (cursor.value as Stored).record;
        if (
          (fork === undefined || r.fork === fork) &&
          (session === undefined || r.session === session) &&
          (mode === undefined || r.mode === mode) &&
          (hasOutcome === undefined || (r.outcome !== undefined) === hasOutcome) &&
          (since === undefined || r.at >= since) &&
          (until === undefined || r.at < until)
        ) {
          found.push(DecisionRecordSchema.parse(r));
        }
        cursor.continue();
      }
      return found;
    });
  }

  async size(): Promise<number> {
    return this.#transaction("readonly", (records) => done(records.count()));
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    (await this.#db).close();
  }
}

/** The primary key of the first entry of the index other than `except`, if there is one. */
async function firstExcept(index: IDBIndex, except: number): Promise<number | undefined> {
  const request = index.openKeyCursor();
  for (let cursor = await done(request); cursor !== null; cursor = await done(request)) {
    if (cursor.primaryKey !== except) return cursor.primaryKey as number;
    cursor.continue();
  }
  return undefined;
}
