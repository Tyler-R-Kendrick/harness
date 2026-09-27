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
  readonly #name: string;
  readonly #caches: CacheStorageLike | undefined;
  #cache: ReturnType<CacheStorageLike["open"]> | undefined;

  constructor(options: { readonly name?: string; readonly caches?: CacheStorageLike } = {}) {
    this.#name = options.name ?? "harness-models";
    this.#caches = options.caches ?? (globalThis as { caches?: CacheStorageLike }).caches;
  }

  /** The cache, opened on first use; a page without the Cache API (an insecure one) says so then. */
  #open(): ReturnType<CacheStorageLike["open"]> {
    const caches = this.#caches;
    if (!caches) return Promise.reject(new Error("the Cache API is not available here (it needs a secure context); pass a cache"));
    return (this.#cache ??= caches.open(this.#name));
  }

  static #url(key: string): string {
    return `https://harness.invalid/${encodeURIComponent(key)}`;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const hit = await (await this.#open()).match(CacheStorageByteCache.#url(key));
    return hit ? new Uint8Array(await hit.arrayBuffer()) : undefined;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await (await this.#open()).put(CacheStorageByteCache.#url(key), new Response(bytes as Uint8Array<ArrayBuffer>));
  }
}
