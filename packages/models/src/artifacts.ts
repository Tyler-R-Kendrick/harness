import type { Artifact } from "@harness/cognitive";

/** Byte storage the host provides: a directory natively, the Cache API or OPFS in a browser. */
export interface ByteCache {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

export class MemoryByteCache implements ByteCache {
  readonly #entries = new Map<string, Uint8Array>();
  async get(key: string): Promise<Uint8Array | undefined> {
    return this.#entries.get(key);
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.#entries.set(key, bytes);
  }
}

export class ArtifactIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactIntegrityError";
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetches model files at the catalog's pinned revision and refuses any file whose
 * size or sha256 differs from the catalog. Verified files are cached; a cached copy
 * that no longer verifies is downloaded again.
 */
export class ArtifactStore {
  readonly #fetch: typeof fetch;
  readonly #cache: ByteCache;
  readonly #baseUrl: string;

  constructor(options: { fetch: typeof fetch; cache: ByteCache; baseUrl?: string }) {
    this.#fetch = options.fetch;
    this.#cache = options.cache;
    this.#baseUrl = options.baseUrl ?? "https://huggingface.co";
  }

  async file(artifact: Artifact, path: string): Promise<Uint8Array> {
    const spec = artifact.files.find((f) => f.path === path);
    if (!spec) throw new Error(`${path} is not part of ${artifact.repo}@${artifact.revision}`);
    const key = `${artifact.repo}@${artifact.revision}/${path}`;
    const cached = await this.#cache.get(key);
    if (cached && (await this.#problem(cached, spec)) === undefined) return cached;
    const url = `${this.#baseUrl}/${artifact.repo}/resolve/${artifact.revision}/${path}`;
    const response = await this.#fetch(url);
    if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const problem = await this.#problem(bytes, spec);
    if (problem) throw new ArtifactIntegrityError(`${key}: ${problem}`);
    await this.#cache.put(key, bytes);
    return bytes;
  }

  async #problem(bytes: Uint8Array, spec: Artifact["files"][number]): Promise<string | undefined> {
    if (bytes.length !== spec.bytes) return `expected ${spec.bytes} bytes, got ${bytes.length}`;
    if (spec.sha256 !== undefined) {
      const actual = await sha256Hex(bytes);
      if (actual !== spec.sha256) return `sha256 ${actual} does not match ${spec.sha256}`;
    }
    return undefined;
  }
}
