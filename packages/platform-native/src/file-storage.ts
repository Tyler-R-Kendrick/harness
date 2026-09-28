import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { SnapshotStorage } from "@harness/core";
import { storedConversations } from "@harness/workers";
import type { ConversationStore } from "@harness/workers";

/** Bytes in the JSON: `{ "$bytes": <base64> }`. */
const BYTES = "$bytes";
/** An object that would read as a tag, escaped: `{ "$object": <its entries> }`. */
const OBJECT = "$object";

const isTag = (key: string | undefined) => key === BYTES || key === OBJECT;

function onlyKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0] : undefined;
}

// `this` is the holder: its own value is read before `toJSON` (a Buffer's) has run.
function replacer(this: unknown, key: string, value: unknown): unknown {
  const own = (this as Record<string, unknown>)[key];
  if (own instanceof Uint8Array) return { [BYTES]: Buffer.from(own.buffer, own.byteOffset, own.byteLength).toString("base64") };
  if (own instanceof ArrayBuffer) return { [BYTES]: Buffer.from(own).toString("base64") };
  return isTag(onlyKey(value)) ? { [OBJECT]: Object.entries(value as object) } : value;
}

function reviver(_key: string, value: unknown): unknown {
  const key = onlyKey(value);
  const inner = key === undefined ? undefined : (value as Record<string, unknown>)[key];
  if (key === BYTES && typeof inner === "string") return new Uint8Array(Buffer.from(inner, "base64"));
  if (key === OBJECT && Array.isArray(inner)) return Object.fromEntries(inner as [string, unknown][]);
  return value;
}

/**
 * Snapshot storage in a single JSON file (bytes kept as tagged base64, objects that look tagged escaped). Saves are atomic (a crash leaves the old or
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
      return JSON.parse(text, reviver) as unknown;
    } catch (e) {
      throw new Error(`corrupt snapshot at ${this.#path}: ${(e as Error).message}`);
    }
  }

  async save(snapshot: unknown): Promise<void> {
    const text = JSON.stringify(snapshot, replacer);
    // One shared promise keeps saves in issue order; write-file-atomic queues them from there.
    await (this.#dir ??= mkdir(dirname(this.#path), { recursive: true }));
    await writeFileAtomic(this.#path, text, { mode: 0o600 });
  }
}

/** Where agent workers keep conversations: the directory named, else beside the daemon's state, else nowhere. */
export function conversationsDir(options: { readonly state?: string | undefined; readonly conversations?: string | undefined }): string | undefined {
  return options.conversations ?? (options.state === undefined ? undefined : `${options.state.replace(/\.json$/, "")}.conversations`);
}

/** Each session's conversation in a file of its own in `dir` (its id made a safe file name). */
export function fileConversations(dir: string): ConversationStore {
  return storedConversations((sessionId) => new FileStorage(join(dir, `${encodeURIComponent(sessionId)}.json`)));
}
