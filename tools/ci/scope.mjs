// What a diff is allowed to spend CI time on.
//
// A pull request runs typecheck, lint, and unit coverage when it changes code,
// and host or browser integration only when the diff can reach those hosts.
// Mutation, real-weight model tests, and evals are release gates: they run in
// the promote workflow, and only for the packages the promotion actually changes.

import { globSync, readFileSync } from "node:fs";

/** Packages whose sources the mutation suite instruments. Mirrors stryker.config.mjs. */
export const MUTATION_PACKAGES = [
  "core",
  "runtime",
  "protocol",
  "cognitive",
  "behavior",
  "memory",
  "learning",
  "workflows",
  "learning-plugins",
  "constrained",
  "dialogue",
  "dialogue-standards",
  "evolution",
  "procedural",
];

const MUTATION_PACKAGE = new Set(MUTATION_PACKAGES);

const SOURCE_GLOB = `packages/{${MUTATION_PACKAGES.join(",")}}/src/**/*.ts`;

/** A change here can move the mutation score of every package, so the gate mutates all of them. */
const MUTATION_WIDE = new Set(["stryker.config.mjs", "vitest.config.ts", "vitest.mutation.config.ts"]);

const CODE_ROOT = /^(?:package(?:-lock)?\.json|tsconfig(?:\.[^/]+)?\.json|vitest\.[^/]+\.ts|eslint\.config\.[^/]+|stryker\.config\.mjs)$/;

const HOST_PREFIXES = [
  "packages/core/",
  "packages/runtime/",
  "packages/protocol/",
  "packages/workers/",
  "packages/client/",
  "packages/platform-native/",
  "packages/evals/",
];

const BROWSER_PREFIXES = ["packages/platform-browser/", "packages/playground/"];

const MODEL_PREFIXES = ["packages/models/", "packages/playground/"];

const EVAL_PREFIXES = ["packages/evals/", "packages/cognitive/", "packages/models/"];

/**
 * One shard once the changed sources are small; four once they are large enough
 * that one job would crowd the runner's six-hour limit. The full tree is four.
 */
export const SHARD_LINE_BUDGET = 2000;
export const SHARD_FILE_BUDGET = 12;
export const FULL_SHARDS = 4;

/** @param {readonly string[]} files */
export function classify(files) {
  return {
    code: files.some(isCode),
    browser: files.some((file) => BROWSER_PREFIXES.some((prefix) => file.startsWith(prefix))),
    host: files.some((file) => HOST_PREFIXES.some((prefix) => file.startsWith(prefix))),
  };
}

/** @param {string} file */
function isCode(file) {
  if (CODE_ROOT.test(file)) return true;
  if (file.startsWith("packages/") && /\.(?:ts|tsx|js|mjs|cjs|json)$/.test(file)) return true;
  if (file.startsWith("tools/") && /\.(?:ts|js|mjs|cjs)$/.test(file)) return true;
  return false;
}

/**
 * Mutable sources the promotion should instrument.
 * A changed source file mutates that file. A changed test, index, or data file
 * mutates the whole package, because the score depends on those tests.
 * A wide config change mutates every package.
 *
 * @param {readonly string[]} changed
 * @param {readonly string[]} allSources mutable source paths, indexes already removed
 */
export function mutationSelection(changed, allSources) {
  if (changed.some((file) => MUTATION_WIDE.has(file))) return [...allSources];
  /** @type {Set<string>} */
  const wholePackage = new Set();
  /** @type {Set<string>} */
  const direct = new Set();
  for (const file of changed) {
    const match = /^packages\/([^/]+)\/(.*)$/.exec(file);
    if (match === null || !MUTATION_PACKAGE.has(match[1])) continue;
    const rest = match[2];
    if (rest === "data/catalog.json") continue;
    if (rest.startsWith("src/") && rest.endsWith(".ts") && !isIndex(rest)) {
      if (allSources.includes(file)) direct.add(file);
      continue;
    }
    wholePackage.add(match[1]);
  }
  const fromPackages = allSources.filter((file) => {
    const match = /^packages\/([^/]+)\//.exec(file);
    return match !== null && wholePackage.has(match[1]);
  });
  return [...new Set([...direct, ...fromPackages])].sort();
}

/**
 * @param {readonly { file: string, lines: number }[]} files largest-first into the lightest shard
 * @param {number} count
 * @returns {string[][]}
 */
export function assignShards(files, count) {
  const shards = Array.from({ length: count }, () => ({ lines: 0, files: /** @type {string[]} */ ([]) }));
  const ordered = [...files].sort((a, b) => b.lines - a.lines || (a.file < b.file ? -1 : 1));
  for (const file of ordered) {
    const lightest = shards.reduce((min, shard) => (shard.lines < min.lines ? shard : min));
    lightest.lines += file.lines;
    lightest.files.push(file.file);
  }
  return shards.map((shard) => shard.files.sort());
}

/** @param {string} rest path inside the package */
function isIndex(rest) {
  return rest === "src/index.ts" || rest.endsWith("/index.ts");
}

/**
 * @param {readonly string[]} files
 * @param {(file: string) => number} [linesOf]
 */
export function shardCountFor(files, linesOf = (file) => readFileSync(file, "utf8").split("\n").length) {
  if (files.length === 0) return 0;
  const lines = files.reduce((sum, file) => sum + linesOf(file), 0);
  if (lines <= SHARD_LINE_BUDGET && files.length <= SHARD_FILE_BUDGET) return 1;
  return Math.min(FULL_SHARDS, files.length);
}

/** Mutable sources on disk, indexes excluded, the same set the unscoped suite mutates. */
export function mutableSources() {
  return globSync(SOURCE_GLOB)
    .filter((file) => !file.endsWith("/src/index.ts"))
    .sort();
}

/**
 * The file list one mutation job instruments.
 * No shard and no filter returns null, and stryker keeps its glob.
 * A shard of a filtered set can be empty; the job then exits before stryker.
 *
 * @param {{ shard?: string, only?: string }} options
 * @returns {string[] | null}
 */
export function mutationTargets(options) {
  const only = (options.only ?? "").split("\n").map((file) => file.trim()).filter((file) => file !== "");
  const shard = options.shard ?? "";
  if (shard === "" && only.length === 0) return null;
  let files = mutableSources();
  if (only.length > 0) {
    const allow = new Set(only);
    files = files.filter((file) => allow.has(file));
  }
  if (shard === "") return files;
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  const index = match === null ? NaN : Number(match[1]);
  const count = match === null ? NaN : Number(match[2]);
  if (!(count > 0 && index >= 0 && index < count)) throw new Error(`MUTATION_SHARD is i/n with 0 <= i < n, not ${JSON.stringify(shard)}`);
  const weighed = files.map((file) => ({ file, lines: readFileSync(file, "utf8").split("\n").length }));
  return assignShards(weighed, count)[index] ?? [];
}

/** @param {{ browser: boolean, host: boolean }} flags */
export function integrationPaths(flags) {
  /** @type {string[]} */
  const paths = [];
  if (flags.browser) paths.push(...globSync("packages/{platform-browser,playground}/test/**/*.integration.test.ts"));
  if (flags.host) paths.push(...globSync("packages/{platform-native,evals}/test/**/*.integration.test.ts"));
  return paths.sort();
}

/**
 * @param {readonly string[]} changed empty means there is no baseline: run every gate
 * @param {boolean} full
 */
export function promotionPlan(changed, full) {
  if (full) {
    return {
      mutate: true,
      shards: Array.from({ length: FULL_SHARDS }, (_, index) => `${index}/${FULL_SHARDS}`),
      files: "",
      models: true,
      evals: true,
    };
  }
  const selected = mutationSelection(changed, mutableSources());
  const count = shardCountFor(selected);
  return {
    mutate: count > 0,
    shards: Array.from({ length: count }, (_, index) => `${index}/${count}`),
    files: selected.join("\n"),
    models: changed.some(isModelChange),
    evals: changed.some(isEvalChange),
  };
}

/** @param {string} file */
function isModelChange(file) {
  if (file === "vitest.models.config.ts") return true;
  if (/^packages\/[^/]+\/data\/catalog\.json$/.test(file)) return true;
  return MODEL_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/** @param {string} file */
function isEvalChange(file) {
  if (isModelChange(file)) return true;
  return EVAL_PREFIXES.some((prefix) => file.startsWith(prefix));
}
