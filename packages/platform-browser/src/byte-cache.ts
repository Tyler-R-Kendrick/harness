import type { ByteCache } from "@harness/models";

/** The part of the Cache API (`caches`) a byte cache needs. */
export interface CacheStorageLike {
  open(name: string): Promise<{ match(request: string): Promise<Response | undefined>; put(request: string, response: Response): Promise<void> }>;
}

/**
 * Model files in the browser's Cache API, one entry per key in the cache `name`. Keys
 * become URLs of their own under a reserved host, so no key can address another entry.
 * The files are verified (sha256) by the artifact store before they are kept.
 */
export class CacheStorageByteCache implements ByteCache {
  readonly #cache: ReturnType<CacheStorageLike["open"]>;

  constructor(options: { readonly name?: string; readonly caches?: CacheStorageLike } = {}) {
    this.#cache = (options.caches ?? (globalThis as unknown as { caches: CacheStorageLike }).caches).open(options.name ?? "harness-models");
  }

  static #url(key: string): string {
    return `https://harness.invalid/${encodeURIComponent(key)}`;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const hit = await (await this.#cache).match(CacheStorageByteCache.#url(key));
    return hit ? new Uint8Array(await hit.arrayBuffer()) : undefined;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await (await this.#cache).put(CacheStorageByteCache.#url(key), new Response(bytes as Uint8Array<ArrayBuffer>));
  }
}
