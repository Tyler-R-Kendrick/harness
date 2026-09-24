import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, parseBenchmarks } from "@harness/cognitive";

describe("benchmark table", () => {
  it("BK1.1 one result per line: model | task | benchmark | metric | score | setting; < marks lower-is-better", () => {
    const rows = parseBenchmarks(`
      # comments and blank lines are ignored

      org/a | judgment | JevBench | accuracy | 96.3
      org/a | judgment | JevBench | ECE      | <0.027
      org/b | chat     | MMLU-Pro | accuracy | 29.7  | non-thinking
    `);
    expect(rows).toEqual([
      { model: "org/a", task: "judgment", benchmark: "JevBench", metric: "accuracy", score: 96.3, higherIsBetter: true },
      { model: "org/a", task: "judgment", benchmark: "JevBench", metric: "ECE", score: 0.027, higherIsBetter: false },
      { model: "org/b", task: "chat", benchmark: "MMLU-Pro", metric: "accuracy", score: 29.7, higherIsBetter: true, setting: "non-thinking" },
    ]);
  });

  it("BK1.2 a malformed line is refused, naming its line and field", () => {
    expect(() => parseBenchmarks("org/a | judgment | X | acc")).toThrow(/line 1[\s\S]*score/);
    expect(() => parseBenchmarks("\norg/a | dancing | X | acc | 1")).toThrow(/line 2[\s\S]*task/);
    expect(() => parseBenchmarks("org/a | chat | X | acc | high")).toThrow(/score/);
    expect(() => parseBenchmarks("org/a | chat | X | acc | 1 | s | extra")).toThrow(/too many fields/);
    expect(() => parseBenchmarks(" | chat | X | acc | 1")).toThrow(/model/);
  });

  it("BK1.3 the catalog's benchmarks come from the table, attached to the model each row names", () => {
    const qwen = MODEL_CATALOG.find((m) => m.id === "Qwen/Qwen3.5-0.8B")!;
    expect(qwen.benchmarks).toContainEqual({ benchmark: "MMLU-Pro", task: "chat", metric: "accuracy", score: 29.7, higherIsBetter: true, setting: "non-thinking" });
    expect(MODEL_CATALOG.flatMap((m) => m.benchmarks).every((b) => !("model" in b))).toBe(true);
  });
});
