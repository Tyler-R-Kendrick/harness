import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { SnapshotStorage } from "@harness/core";

/**
 * Snapshot storage in a single JSON file. Saves are atomic (a crash leaves the old or
 * the new snapshot) and serialized, so the last one issued is the one that lands.
 */
export class FileStorage implements SnapshotStorage {
  readonly #path: string;
  #dir: Promise<unknown> | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<unknown> {
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new Error(`corrupt snapshot at ${this.#path}: ${(e as Error).message}`);
    }
  }

  async save(snapshot: unknown): Promise<void> {
    const text = JSON.stringify(snapshot);
    // One shared promise keeps saves in issue order; write-file-atomic queues them from there.
    await (this.#dir ??= mkdir(dirname(this.#path), { recursive: true }));
    await writeFileAtomic(this.#path, text, { mode: 0o600 });
  }
}
