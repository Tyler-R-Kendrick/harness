import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact } from "@harness/cognitive";

/**
 * Model files that must live on disk (GGUF weights for llama-server, several GB).
 * Downloads stream to a temp file while hashing, are verified against the catalog's
 * size and sha256, then renamed into place with a sidecar recording the verified
 * hash, so later starts check the size and sidecar instead of re-hashing gigabytes.
 */
export class ModelFiles {
  readonly #dir: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: { dir: string; fetch?: typeof fetch; baseUrl?: string }) {
    this.#dir = options.dir;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = options.baseUrl ?? "https://huggingface.co";
  }

  async path(artifact: Artifact, file: string): Promise<string> {
    const spec = artifact.files.find((f) => f.path === file);
    if (!spec) throw new Error(`${file} is not part of ${artifact.repo}@${artifact.revision}`);
    const dir = join(this.#dir, artifact.repo.replace("/", "--"), artifact.revision);
    const target = join(dir, file.replaceAll("/", "--"));
    const sidecar = `${target}.sha256`;
    if (await verified(target, sidecar, spec.bytes, spec.sha256)) return target;

    const url = `${this.#baseUrl}/${artifact.repo}/resolve/${artifact.revision}/${file}`;
    const response = await this.#fetch(url);
    if (!response.ok || !response.body) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
    await mkdir(dir, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await open(tmp, "w", 0o600);
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        bytes += value.length;
        await handle.write(value);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const digest = hash.digest("hex");
    const problem = bytes !== spec.bytes ? `expected ${spec.bytes} bytes, got ${bytes}` : spec.sha256 !== undefined && digest !== spec.sha256 ? `sha256 ${digest} does not match ${spec.sha256}` : undefined;
    if (problem) {
      await rm(tmp, { force: true });
      // Remove only the directories this download created, and only if they are empty.
      for (const d of [dir, join(dir, "..")]) await rmdir(d).catch(() => undefined);
      throw new Error(`${artifact.repo}@${artifact.revision}/${file}: ${problem}`);
    }
    await rename(tmp, target);
    await writeFile(sidecar, digest);
    return target;
  }
}

async function verified(target: string, sidecar: string, bytes: number, sha256: string | undefined): Promise<boolean> {
  try {
    const [info, recorded] = await Promise.all([stat(target), readFile(sidecar, "utf8")]);
    return info.size === bytes && (sha256 === undefined || recorded.trim() === sha256);
  } catch {
    return false;
  }
}
