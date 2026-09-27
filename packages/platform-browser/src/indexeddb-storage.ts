import type { SnapshotStorage } from "@harness/core";

const STORE = "snapshots";

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Snapshots in IndexedDB: one record under `key` in the `snapshots` store of database
 * `name`. Each save is its own transaction, so saves land in the order issued; the
 * value is stored as a structured clone, so later changes to it are not stored.
 */
export class IndexedDbStorage implements SnapshotStorage {
  readonly #db: Promise<IDBDatabase>;
  readonly #key: string;

  constructor(options: { readonly name?: string; readonly key?: string; readonly factory?: IDBFactory } = {}) {
    this.#key = options.key ?? "daemon";
    const open = (options.factory ?? indexedDB).open(options.name ?? "harness", 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    this.#db = done(open);
  }

  async load(): Promise<unknown> {
    const db = await this.#db;
    return done(db.transaction(STORE, "readonly").objectStore(STORE).get(this.#key));
  }

  async save(snapshot: unknown): Promise<void> {
    const db = await this.#db;
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(snapshot, this.#key);
    // A failed request aborts its transaction (unless handled), so abort covers every failure.
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("the snapshot save was aborted"));
    });
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    (await this.#db).close();
  }
}
