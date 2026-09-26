import { homedir } from "node:os";
import { join } from "node:path";

/** Shared setup for *.model.test.ts: where verified weights are cached. */
export const modelCacheDir = process.env["HARNESS_MODEL_CACHE"] ?? join(homedir(), ".cache", "harness", "models");
