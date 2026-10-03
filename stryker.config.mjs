// Mutation testing over the portable packages. `break` fails the release gate when the
// mutation score drops below the floor; raise it as suites mature, never lower it.
// Sharding and the changed-file filter live in tools/ci/scope.mjs, which the promote workflow shares.
import { mutationTargets } from "./tools/ci/scope.mjs";

const SOURCES = "packages/{core,runtime,protocol,cognitive,behavior,memory,learning,workflows,learning-plugins,constrained,dialogue,dialogue-standards,decision,evolution,procedural}/src/**/*.ts";
const MUTATE = [SOURCES, "!packages/*/src/index.ts"];

/** No shard and no file filter keeps the glob. A shard or a file list returns those paths. */
function mutate() {
  const targets = mutationTargets({ shard: process.env.MUTATION_SHARD, only: process.env.MUTATION_FILES });
  return targets === null ? MUTATE : targets;
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  mutate: mutate(),
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: { high: 95, low: 90, break: 90 },
  concurrency: 4,
  timeoutMS: 10000,
};
