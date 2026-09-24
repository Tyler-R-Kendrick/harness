import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelDescriptor } from "@harness/cognitive";
import { MODEL_CATALOG } from "@harness/cognitive";
import { ArtifactStore } from "@harness/models";
import { FileByteCache } from "@harness/platform-native";

/** Shared setup for *.model.test.ts: the catalog entry and a verified, cached artifact store. */
export const modelCacheDir = process.env["HARNESS_MODEL_CACHE"] ?? join(homedir(), ".cache", "harness", "models");
export const artifacts = new ArtifactStore({ fetch, cache: new FileByteCache(join(modelCacheDir, "artifacts")) });
export function catalogEntry(id: string): ModelDescriptor & { artifact: NonNullable<ModelDescriptor["artifact"]> } {
  const m = MODEL_CATALOG.find((x) => x.id === id);
  if (!m?.artifact) throw new Error(`${id} has no artifact in the catalog`);
  return m as ModelDescriptor & { artifact: NonNullable<ModelDescriptor["artifact"]> };
}
