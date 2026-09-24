import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ByteCache, NeedleModule } from "@harness/models";

/**
 * Model files on disk, one file per key. Keys are hashed into file names, so no key
 * can address a path outside the directory; writes go through a temp file and a
 * rename, so a crash never leaves a partial file under a real name.
 */
export class FileByteCache implements ByteCache {
  readonly #dir: string;
  #seq = 0;

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
    const target = this.#path(key);
    const tmp = `${target}.tmp-${process.pid}-${++this.#seq}`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
  }
}

/**
 * Instantiate Needle's Emscripten module from its (already hash-verified) loader
 * source. The loader is CommonJS; it gets module/exports/require/__dirname, and the
 * WASM bytes are passed in so it never reads the file system for them.
 */
export async function loadNeedleModule(source: Uint8Array, wasm: Uint8Array): Promise<NeedleModule> {
  const module: { exports: unknown } = { exports: {} };
  const require = createRequire(import.meta.url);
  new Function("module", "exports", "require", "__filename", "__dirname", new TextDecoder().decode(source))(module, module.exports, require, "needle.js", ".");
  const factory = module.exports;
  if (typeof factory !== "function") throw new Error("needle.js did not export a module factory");
  return (await (factory as (arg: { wasmBinary: Uint8Array }) => Promise<NeedleModule>)({ wasmBinary: wasm })) as NeedleModule;
}
