// Mutation testing over the portable packages. `break` fails CI when the mutation
// score drops below the floor; raise it as suites mature, never lower it.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.config.ts" },
  mutate: [
    "packages/{core,protocol,cognitive}/src/**/*.ts",
    "!packages/*/src/index.ts",
  ],
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 95, low: 85, break: 85 },
  concurrency: 4,
  timeoutMS: 10000,
};
