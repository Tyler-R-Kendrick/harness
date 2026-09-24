import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

// Mutation testing targets the pure packages; their own suites (plus testkit's
// contracts) are what should kill mutants. Integration tests spawn processes or
// sleep, which slows every mutant run without adding signal on this code.
// (mergeConfig would concatenate `include`, so override explicitly.)
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["packages/{core,protocol,cognitive,behavior,memory,learning,workflows,learning-plugins,testkit}/test/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
  },
});
