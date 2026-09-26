import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { instantiateEmscripten } from "@harness/models";
import type { ByteCache } from "@harness/models";
import writeFileAtomic from "write-file-atomic";

/**
 * Model files on disk, one file per key. Keys are hashed into file names, so no key
 * can address a path outside the directory; writes are atomic, so a crash never leaves
 * a partial file under a real name.
 */
export class FileByteCache implements ByteCache {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #path(key: string): string {
    return join(this.#dir, createHash("sha256").update(key).digest("hex"));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFileAtomic(this.#path(key), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { mode: 0o600 });
  }
}

/**
 * Instantiate an Emscripten module from its (already hash-verified) loader source, with
 * Node's `require` for what it asks of the host; the WASM bytes are passed in, so it
 * never reads the file system for them.
 */
export async function loadEmscriptenModule<M>(source: Uint8Array, wasm: Uint8Array, name = "loader.js"): Promise<M> {
  return instantiateEmscripten<M>(source, wasm, { name, require: createRequire(import.meta.url) });
}
