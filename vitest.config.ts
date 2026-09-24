import { defineConfig } from "vitest/config";

// Resolve workspace packages to sources next to this config rather than through the
// node_modules symlinks. Stryker runs tests in a sandbox copy; symlinks would point
// back at the unmutated originals and every mutant would falsely "survive".
const pkg = (name: string) => new URL(`./packages/${name}/src/index.ts`, import.meta.url).pathname;
const PACKAGES = ["protocol", "core", "cognitive", "testkit", "platform-native", "evals", "workers", "models", "behavior", "memory", "learning", "workflows", "learning-plugins"];

// Test taxonomy (by filename suffix):
//   *.test.ts              atomic unit tests: one behavior per test, named by assertion ID
//   *.property.test.ts     property/fuzz tests (fast-check); seeds are reported on failure
//   *.contract.test.ts     contract suites run against every implementation of a port/protocol
//   *.integration.test.ts  real processes/transports (e.g. ACP SDK client over stdio)
//   *.model.test.ts        real model weights (downloads); run by `npm run test:models`
//                          (vitest.models.config.ts) and the CI "models" job, not here
// Evals (LLM-as-judge) are not vitest tests; see packages/evals and `npm run eval`.
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(PACKAGES.map((name) => [`@harness/${name}`, pkg(name)])),
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    exclude: ["**/*.model.test.ts", "**/node_modules/**"],
    environment: "node",
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/index.ts", "packages/evals/src/cli.ts", "packages/platform-native/src/main.ts", "packages/platform-native/src/workflow-cli.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      thresholds: { lines: 95, branches: 90, functions: 95, statements: 95 },
    },
  },
});
