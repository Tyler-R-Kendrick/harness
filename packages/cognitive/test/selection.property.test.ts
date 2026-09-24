import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { rankForTask } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";

const descriptor = (id: string, scores: readonly (number | null)[], bytes: number): ModelDescriptor => ({
  id,
  name: id,
  publisher: "p",
  tasks: ["chat"],
  ports: ["generator"],
  locality: "local",
  runtime: "transformers.js",
  platforms: ["native"],
  license: "MIT",
  downloadBytes: bytes,
  benchmarks: scores.flatMap((s, i) =>
    s === null ? [] : [{ benchmark: `B${i}`, task: "chat" as const, metric: "acc", score: s, higherIsBetter: true, source: "https://example.test" }],
  ),
});

const models = fc
  .array(fc.tuple(fc.array(fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }), { minLength: 3, maxLength: 3 }), fc.nat(10)), { maxLength: 6 })
  .map((rows) => rows.map(([scores, bytes], i) => descriptor(`m${i}`, scores, bytes)));

describe("selection properties", () => {
  test.prop([models, fc.nat()])("SE2.1 ranking is a permutation of the eligible models and does not depend on input order except for ties", (ms, seed) => {
    const ranked = rankForTask("chat", ms, { platform: "native" });
    expect(ranked.map((r) => r.id).sort()).toEqual(ms.map((m) => m.id).sort());
    const shuffled = [...ms].sort((a, b) => ((a.id.charCodeAt(1) * 31 + seed) % 7) - ((b.id.charCodeAt(1) * 31 + seed) % 7));
    const again = rankForTask("chat", shuffled, { platform: "native" });
    // Win/loss records are order independent.
    const record = (r: typeof ranked) => Object.fromEntries(r.map((x) => [x.id, [x.wins, x.losses]]));
    expect(record(again)).toEqual(record(ranked));
  });

  test.prop([models])("SE2.2 a model that beats every other model on all benchmarks they share is ranked first", (ms) => {
    const shared = (a: ModelDescriptor, b: ModelDescriptor) => a.benchmarks.filter((x) => b.benchmarks.some((y) => y.benchmark === x.benchmark));
    const scoreOf = (m: ModelDescriptor, name: string) => m.benchmarks.find((y) => y.benchmark === name)!.score;
    const dominant = ms.find((a) =>
      ms.every((b) => b === a || (shared(a, b).length > 0 && shared(a, b).every((x) => x.score > scoreOf(b, x.benchmark)))),
    );
    if (dominant && ms.length > 1) expect(rankForTask("chat", ms, { platform: "native" })[0]!.id).toBe(dominant.id);
  });
});
