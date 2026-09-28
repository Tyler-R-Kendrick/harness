import { defineConfig } from "vitest/config";
import base from "./vitest.config.ts";

// Mutation testing targets the pure packages; their own suites (plus testkit's
// contracts) are what should kill mutants. Integration tests spawn processes or
// sleep, and simulation tests run whole searches thousands of times over; both slow
// every mutant run without adding signal on this code.
// (mergeConfig would concatenate `include`, so override explicitly.)
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["packages/{core,runtime,protocol,cognitive,behavior,memory,learning,workflows,learning-plugins,constrained,dialogue,dialogue-standards,evolution,testkit}/test/**/*.test.ts"],
    exclude: ["**/*.integration.test.ts", "**/*.simulation.test.ts", "**/node_modules/**"],
  },
});
