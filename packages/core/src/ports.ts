/** Milliseconds since the Unix epoch. Hosts supply real time; tests supply a manual clock. */
export interface Clock {
  now(): number;
}

/** Source of randomness. Hosts use a CSPRNG; tests use a seeded stream. */
export interface Entropy {
  bytes(length: number): Uint8Array;
}

/**
 * Durable storage for daemon snapshots. `save` must be atomic: after a crash, `load`
 * returns either the previous snapshot or the new one, never a torn mix. Hosts pick
 * the backend (a file on native, OPFS/IndexedDB in browsers, a database remotely).
 */
export interface SnapshotStorage {
  /** The last saved snapshot, or undefined if nothing was ever saved. */
  load(): Promise<unknown>;
  save(snapshot: unknown): Promise<void>;
}
