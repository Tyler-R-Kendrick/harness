import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Artifact } from "@harness/cognitive";
import { ModelFiles } from "@harness/platform-native";

const body = new TextEncoder().encode("gguf-weights-".repeat(1000));
const sha = createHash("sha256").update(body).digest("hex");
const artifact: Artifact = { repo: "org/m-GGUF", revision: "b".repeat(40), files: [{ path: "m.gguf", bytes: body.length, sha256: sha }] };

function streamingFetch(bytes: Uint8Array, status = 200) {
  const urls: string[] = [];
  const f = async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 1000) c.enqueue(bytes.slice(i, i + 1000));
          c.close();
        },
      }),
      { status },
    );
  };
  return { f: f as typeof fetch, urls };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), "harness-files-"));
  dirs.push(d);
  return d;
}

describe("native model files (streamed to disk)", () => {
  it("MF1.1 streams a file to disk at the pinned revision, verifies it, and returns its path", async () => {
    const dir = await tempDir();
    const { f, urls } = streamingFetch(body);
    const path = await new ModelFiles({ dir, fetch: f }).path(artifact, "m.gguf");
    expect(new Uint8Array(await readFile(path))).toEqual(body);
    expect(urls).toEqual([`https://huggingface.co/org/m-GGUF/resolve/${"b".repeat(40)}/m.gguf`]);
  });

  it("MF1.2 a verified file is reused without downloading or re-hashing it", async () => {
    const dir = await tempDir();
    const first = streamingFetch(body);
    const path = await new ModelFiles({ dir, fetch: first.f }).path(artifact, "m.gguf");
    const second = streamingFetch(body);
    expect(await new ModelFiles({ dir, fetch: second.f }).path(artifact, "m.gguf")).toBe(path);
    expect(second.urls).toEqual([]);
  });

  it("MF1.3 a corrupt download is rejected and leaves nothing behind", async () => {
    const dir = await tempDir();
    const bad = new Uint8Array(body);
    bad[5] = 0;
    await expect(new ModelFiles({ dir, fetch: streamingFetch(bad).f }).path(artifact, "m.gguf")).rejects.toThrow(/sha256/);
    expect(await readdir(dir, { recursive: true })).toEqual([]);
  });

  it("MF1.6 a failed download never touches other cached models", async () => {
    const dir = await tempDir();
    const files = new ModelFiles({ dir, fetch: streamingFetch(body).f });
    const kept = await files.path(artifact, "m.gguf");
    const other: Artifact = { repo: "org/other-GGUF", revision: "c".repeat(40), files: [{ path: "o.gguf", bytes: body.length, sha256: sha }] };
    const bad = new Uint8Array(body);
    bad[0] = 1;
    await expect(new ModelFiles({ dir, fetch: streamingFetch(bad).f }).path(other, "o.gguf")).rejects.toThrow(/sha256/);
    expect(new Uint8Array(await readFile(kept))).toEqual(body);
  });

  it("MF1.4 a file whose size changed since it was verified is downloaded again", async () => {
    const dir = await tempDir();
    const path = await new ModelFiles({ dir, fetch: streamingFetch(body).f }).path(artifact, "m.gguf");
    await writeFile(path, "truncated");
    const again = streamingFetch(body);
    await new ModelFiles({ dir, fetch: again.f }).path(artifact, "m.gguf");
    expect(again.urls).toHaveLength(1);
    expect(new Uint8Array(await readFile(path))).toEqual(body);
  });

  it("MF1.5 HTTP failures and files outside the artifact are errors", async () => {
    const dir = await tempDir();
    await expect(new ModelFiles({ dir, fetch: streamingFetch(body, 403).f }).path(artifact, "m.gguf")).rejects.toThrow(/403/);
    await expect(new ModelFiles({ dir, fetch: streamingFetch(body).f }).path(artifact, "other.gguf")).rejects.toThrow(/not part of/);
  });
});
