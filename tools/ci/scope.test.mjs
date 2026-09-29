import { expect, it } from "vitest";
import { assignShards, classify, mutationSelection, mutationTargets, promotionPlan, SHARD_FILE_BUDGET, shardCountFor } from "./scope.mjs";

const SOURCES = [
  "packages/core/src/task-graph.ts",
  "packages/core/src/daemon.ts",
  "packages/dialogue/src/book.ts",
  "packages/evolution/src/run.ts",
];

it("CI1.1 a docs-only diff does not run code, host, or browser tests", () => {
  expect(classify(["docs/features.md", "README.md"])).toEqual({ code: false, browser: false, host: false });
});

it("CI1.2 a core change runs unit tests and the host integration that wraps the core", () => {
  expect(classify(["packages/core/src/task-graph.ts"])).toEqual({ code: true, browser: false, host: true });
});

it("CI1.3 a browser or playground change runs browser integration and not the host suite", () => {
  expect(classify(["packages/playground/src/app.ts"])).toEqual({ code: true, browser: true, host: false });
  expect(classify(["packages/platform-browser/src/host.ts"])).toEqual({ code: true, browser: true, host: false });
});

it("CI1.4 a dialogue change runs unit tests and leaves both hosts alone", () => {
  expect(classify(["packages/dialogue/src/book.ts"])).toEqual({ code: true, browser: false, host: false });
});

it("CI1.5 a changed source mutates that file, and a changed test mutates its package", () => {
  expect(mutationSelection(["packages/core/src/task-graph.ts"], SOURCES)).toEqual(["packages/core/src/task-graph.ts"]);
  expect(mutationSelection(["packages/core/test/task-graph.test.ts"], SOURCES)).toEqual([
    "packages/core/src/daemon.ts",
    "packages/core/src/task-graph.ts",
  ]);
  expect(mutationSelection(["packages/dialogue/data/book.json"], SOURCES)).toEqual(["packages/dialogue/src/book.ts"]);
});

it("CI1.6 a mutation-config change mutates every source, and a readme mutates none", () => {
  expect(mutationSelection(["stryker.config.mjs"], SOURCES)).toEqual(SOURCES);
  expect(mutationSelection(["vitest.config.ts"], SOURCES)).toEqual(SOURCES);
  expect(mutationSelection(["README.md"], SOURCES)).toEqual([]);
});

it("CI1.7 shards place the largest file on the lightest shard, one shard per file when asked for more", () => {
  const assigned = assignShards(
    [
      { file: "packages/core/src/small.ts", lines: 10 },
      { file: "packages/evolution/src/run.ts", lines: 100 },
    ],
    2,
  );
  expect(assigned[0]).toEqual(["packages/evolution/src/run.ts"]);
  expect(assigned[1]).toEqual(["packages/core/src/small.ts"]);
});

it("CI1.8 a small selection is one shard and a large one is four", () => {
  expect(shardCountFor([])).toBe(0);
  expect(shardCountFor(["a.ts"], () => 10)).toBe(1);
  expect(shardCountFor(["a.ts"], () => 5000)).toBe(1);
  expect(shardCountFor(["a.ts", "b.ts"], () => 1500)).toBe(2);
  expect(shardCountFor(Array.from({ length: SHARD_FILE_BUDGET + 1 }, (_, index) => `${index}.ts`), () => 1)).toBe(4);
  expect(mutationTargets({ shard: "0/1", only: "packages/core/src/task-graph.ts\n" })).toEqual(["packages/core/src/task-graph.ts"]);
  expect(mutationTargets({ shard: "1/4", only: "packages/core/src/task-graph.ts" })).toEqual([]);
});

it("CI1.9 a promotion with no baseline runs every gate, and a docs diff runs none", () => {
  expect(promotionPlan([], true)).toMatchObject({ mutate: true, shards: ["0/4", "1/4", "2/4", "3/4"], files: "", models: true, evals: true });
  expect(promotionPlan(["docs/features.md"], false)).toMatchObject({ mutate: false, shards: [], files: "", models: false, evals: false });
});

it("CI1.10 a catalog change gates models and evals, and a core source gates mutation only", () => {
  const catalog = promotionPlan(["packages/cognitive/data/catalog.json"], false);
  expect(catalog.models).toBe(true);
  expect(catalog.evals).toBe(true);
  expect(catalog.mutate).toBe(false);
  const core = promotionPlan(["packages/core/src/task-graph.ts"], false);
  expect(core.mutate).toBe(true);
  expect(core.shards).toEqual(["0/1"]);
  expect(core.files).toBe("packages/core/src/task-graph.ts");
  expect(core.models).toBe(false);
  expect(core.evals).toBe(false);
});
