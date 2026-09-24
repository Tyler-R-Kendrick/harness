import { describe, expect, it } from "vitest";
import { rankForTask } from "@harness/cognitive";
import type { BenchmarkResult, ModelDescriptor } from "@harness/cognitive";

const bench = (benchmark: string, score: number, extra: Partial<BenchmarkResult> = {}): BenchmarkResult => ({
  benchmark,
  task: "chat",
  metric: "accuracy",
  score,
  higherIsBetter: true,
  ...extra,
});

function model(id: string, benchmarks: readonly BenchmarkResult[], extra: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id,
    name: id,
    publisher: "test",
    tasks: ["chat"],
    ports: ["generator"],
    locality: "local",
    runtime: "transformers.js",
    platforms: ["native", "browser"],
    license: "Apache-2.0",
    downloadBytes: 1000,
    benchmarks,
    ...extra,
  };
}

const ids = (r: ReturnType<typeof rankForTask>) => r.map((x) => x.id);

describe("benchmark-driven model selection", () => {
  it("SE1.1 only models for the task, the platform, the locality policy and the size budget are ranked", () => {
    const models = [
      model("ok", []),
      model("wrong-task", [], { tasks: ["coding"] }),
      model("native-only", [], { platforms: ["native"] }),
      model("hosted", [], { locality: "hosted", downloadBytes: 0 }),
      model("too-big", [], { downloadBytes: 10_000 }),
    ];
    expect(ids(rankForTask("chat", models, { platform: "browser", maxDownloadBytes: 5000, allowHosted: false }))).toEqual(["ok"]);
    expect(ids(rankForTask("chat", models, { platform: "browser", maxDownloadBytes: 5000 }))).toEqual(["ok", "hosted"]);
  });

  it("SE1.2 models are compared only on benchmarks they share, with the same metric and setting", () => {
    const a = model("a", [bench("MMLU-Pro", 40, { setting: "non-thinking" }), bench("IFEval", 90)]);
    const b = model("b", [bench("MMLU-Pro", 55, { setting: "non-thinking" }), bench("GPQA", 20)]);
    const c = model("c", [bench("MMLU-Pro", 70, { setting: "thinking" })]);
    // b beats a on the shared non-thinking MMLU-Pro. c shares nothing comparable with either.
    const ranked = rankForTask("chat", [a, b, c], { platform: "native" });
    expect(ids(ranked).indexOf("b")).toBeLessThan(ids(ranked).indexOf("a"));
    expect(ranked.find((r) => r.id === "c")!.evidence).toEqual([]);
  });

  it("SE1.3 lower-is-better metrics invert the comparison", () => {
    const a = model("a", [bench("OmniDocBench", 0.3, { metric: "edit distance", higherIsBetter: false, task: "document-parsing" })], { tasks: ["document-parsing"] });
    const b = model("b", [bench("OmniDocBench", 0.1, { metric: "edit distance", higherIsBetter: false, task: "document-parsing" })], { tasks: ["document-parsing"] });
    expect(ids(rankForTask("document-parsing", [a, b], { platform: "native" }))).toEqual(["b", "a"]);
  });

  it("SE1.4 pairwise wins decide the order across several models", () => {
    const a = model("a", [bench("X", 3), bench("Y", 1)]);
    const b = model("b", [bench("X", 2), bench("Y", 2)]);
    const c = model("c", [bench("X", 1), bench("Y", 3)]);
    // a vs b: 1-1 tie; a vs c: tie; b vs c: tie -> evidence counts tie -> input order
    expect(ids(rankForTask("chat", [c, b, a], { platform: "native" }))).toEqual(["c", "b", "a"]);
    const d = model("d", [bench("X", 5), bench("Y", 5)]);
    expect(ids(rankForTask("chat", [a, b, c, d], { platform: "native" }))[0]).toBe("d");
  });

  it("SE1.5 without head-to-head evidence, the preference order wins, then more task evidence, then the smaller download", () => {
    const rich = model("rich", [bench("P", 1), bench("Q", 1)], { downloadBytes: 900 });
    const poor = model("poor", [bench("R", 1)], { downloadBytes: 100 });
    expect(ids(rankForTask("chat", [poor, rich], { platform: "native" }))).toEqual(["rich", "poor"]);
    const big = model("big", [], { downloadBytes: 900 });
    const small = model("small", [], { downloadBytes: 100 });
    expect(ids(rankForTask("chat", [big, small], { platform: "native" }))).toEqual(["small", "big"]);
    expect(ids(rankForTask("chat", [small, big], { platform: "native", prefer: ["big"] }))).toEqual(["big", "small"]);
    // A curated preference outranks a longer list of unrelated benchmarks.
    expect(ids(rankForTask("chat", [rich, poor], { platform: "native", prefer: ["poor"] }))).toEqual(["poor", "rich"]);
  });

  it("SE1.6 benchmarks for other tasks do not count", () => {
    const a = model("a", [bench("HumanEval", 90, { task: "coding" }), bench("X", 1)]);
    const b = model("b", [bench("HumanEval", 10, { task: "coding" }), bench("X", 2)]);
    expect(ids(rankForTask("chat", [a, b], { platform: "native" }))).toEqual(["b", "a"]);
  });

  it("SE1.7 every ranked model explains its record against the others", () => {
    const a = model("a", [bench("X", 3)]);
    const b = model("b", [bench("X", 2)]);
    const [first, second] = rankForTask("chat", [b, a], { platform: "native" });
    expect(first).toMatchObject({ id: "a", wins: 1, losses: 0 });
    expect(first!.evidence).toEqual([{ against: "b", benchmark: "X", metric: "accuracy", setting: undefined, ours: 3, theirs: 2 }]);
    expect(second).toMatchObject({ id: "b", wins: 0, losses: 1 });
  });

  it("SE1.8 a pinned model goes first when it is eligible", () => {
    const a = model("a", [bench("X", 3)]);
    const b = model("b", [bench("X", 2)]);
    expect(ids(rankForTask("chat", [a, b], { platform: "native", pin: "b" }))).toEqual(["b", "a"]);
    expect(ids(rankForTask("chat", [a, b], { platform: "native", pin: "missing" }))).toEqual(["a", "b"]);
  });
});
