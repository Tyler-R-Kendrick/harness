// Mutation testing over the portable packages. `break` fails CI when the mutation
// score drops below the floor; raise it as suites mature, never lower it.
import { globSync, readFileSync } from "node:fs";

const SOURCES = "packages/{core,runtime,protocol,cognitive,behavior,memory,learning,workflows,learning-plugins,constrained,dialogue,dialogue-standards,procedural}/src/**/*.ts";
const MUTATE = [SOURCES, "!packages/*/src/index.ts"];

/**
 * With MUTATION_SHARD="i/n" (0 <= i < n), only shard i of n: every mutated file goes to
 * exactly one shard, largest first into the lightest (by lines), so n CI jobs split a run
 * that would outlast one job's time limit. Each shard must meet `break` on its own.
 */
function mutate() {
  const shard = process.env.MUTATION_SHARD;
  if (shard === undefined || shard === "") return MUTATE;
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  const [index, count] = match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
  if (!(count > 0 && index < count)) throw new Error(`MUTATION_SHARD is i/n with 0 <= i < n, not ${JSON.stringify(shard)}`);
  const files = globSync(SOURCES)
    .filter((file) => !file.endsWith("/src/index.ts"))
    .map((file) => ({ file, lines: readFileSync(file, "utf8").split("\n").length }))
    .sort((a, b) => b.lines - a.lines || (a.file < b.file ? -1 : 1));
  const shards = Array.from({ length: count }, () => ({ lines: 0, files: [] }));
  for (const f of files) {
    const lightest = shards.reduce((min, s) => (s.lines < min.lines ? s : min));
    lightest.lines += f.lines;
    lightest.files.push(f.file);
  }
  return shards[index].files.sort();
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
