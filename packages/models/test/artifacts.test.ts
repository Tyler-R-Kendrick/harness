import { describe, expect, it } from "vitest";
import { bytes as size, commitSha, sha256 } from "@harness/cognitive";
import { ArtifactIntegrityError, ArtifactStore, MemoryByteCache, sha256Hex } from "@harness/models";
import type { Artifact } from "@harness/cognitive";

const bytes = new TextEncoder().encode("weights!");
const digest = await sha256Hex(bytes);
const artifact: Artifact = { repo: "org/model", revision: commitSha("a".repeat(40)), files: [{ path: "w.bin", bytes: size(bytes.length), sha256: sha256(digest) }] };

function fakeFetch(body: Uint8Array | (() => Uint8Array), status = 200) {
  const urls: string[] = [];
  const f = async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response((typeof body === "function" ? body() : body) as Uint8Array<ArrayBuffer>, { status });
  };
  return { f: f as typeof fetch, urls };
}

describe("ArtifactStore", () => {
  it("AR1.1 downloads a file at the pinned revision and verifies its size and sha256", async () => {
    const { f, urls } = fakeFetch(bytes);
    const store = new ArtifactStore({ fetch: f, cache: new MemoryByteCache() });
    expect(await store.file(artifact, "w.bin")).toEqual(bytes);
    expect(urls).toEqual([`https://huggingface.co/org/model/resolve/${"a".repeat(40)}/w.bin`]);
  });

  it("AR1.2 a verified file is served from the cache afterwards", async () => {
    const { f, urls } = fakeFetch(bytes);
    const store = new ArtifactStore({ fetch: f, cache: new MemoryByteCache() });
    await store.file(artifact, "w.bin");
    await store.file(artifact, "w.bin");
    expect(urls).toHaveLength(1);
  });

  it("AR1.3 a download that does not match its hash or size is rejected and not cached", async () => {
    const cache = new MemoryByteCache();
    const tampered = new TextEncoder().encode("weights?");
    const store = new ArtifactStore({ fetch: fakeFetch(tampered).f, cache });
    const error = await store.file(artifact, "w.bin").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArtifactIntegrityError);
    expect(String(error)).toMatch(/sha256/);
    expect(await cache.get(`org/model@${"a".repeat(40)}/w.bin`)).toBeUndefined();
    const short = new ArtifactStore({ fetch: fakeFetch(new Uint8Array(3)).f, cache });
    await expect(short.file(artifact, "w.bin")).rejects.toThrow(/bytes/);
  });

  it("AR1.4 a corrupted cache entry is replaced by a fresh verified download", async () => {
    const cache = new MemoryByteCache();
    await cache.put(`org/model@${"a".repeat(40)}/w.bin`, new Uint8Array([9, 9]));
    const { f, urls } = fakeFetch(bytes);
    expect(await new ArtifactStore({ fetch: f, cache }).file(artifact, "w.bin")).toEqual(bytes);
    expect(urls).toHaveLength(1);
  });

  it("AR1.5 HTTP failures and unknown files are errors", async () => {
    const store = new ArtifactStore({ fetch: fakeFetch(bytes, 404).f, cache: new MemoryByteCache() });
    await expect(store.file(artifact, "w.bin")).rejects.toThrow(/404/);
    await expect(store.file(artifact, "other.bin")).rejects.toThrow(/not part of/);
  });
});
