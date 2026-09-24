import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { SnapshotStorage } from "@harness/core";

/**
 * Snapshot storage in a single JSON file. Each save writes a temp file, fsyncs it and
 * renames it over the target, so a crash leaves either the old or the new snapshot.
 * Saves are serialized so the last one issued is the one that lands.
 */
export class FileStorage implements SnapshotStorage {
  readonly #path: string;
  #queue: Promise<void> = Promise.resolve();
  #seq = 0;

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

  save(snapshot: unknown): Promise<void> {
    const text = JSON.stringify(snapshot);
    const tmp = `${this.#path}.tmp-${process.pid}-${++this.#seq}`;
    const next = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const handle = await open(tmp, "w", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, this.#path);
    });
    this.#queue = next.catch(() => {});
    return next;
  }
}
