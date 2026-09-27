import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

// Model tests load real weights (pinned revisions, sha256-verified, cached under
// HARNESS_MODEL_CACHE). They are slow and download hundreds of megabytes, so they run
// as their own gate: `npm run test:models` locally and the "models" job in CI.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["packages/*/test/**/*.model.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
