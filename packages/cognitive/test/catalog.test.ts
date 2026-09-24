import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogJsonSchemas, parseCatalog, rankForTask, TASK_CATEGORIES, TASK_PORTS } from "@harness/cognitive";
import type { Platform, TaskCategory } from "@harness/cognitive";

const data = (file: string) => JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8")) as Record<string, unknown> & { models: Record<string, unknown>[]; rows: unknown[][] };
const catalogFile = data("catalog.json");
const benchmarksFile = data("benchmarks.json");
const { models: MODEL_CATALOG, preferences: TASK_PREFERENCES } = parseCatalog(catalogFile, benchmarksFile);
const top = (task: TaskCategory, platform: Platform) => rankForTask(task, MODEL_CATALOG, { platform, prefer: TASK_PREFERENCES[task] ?? [] })[0]?.id;

/** The shipped catalog with one change; parsing it must fail and say why. */
const refused = (edit: (catalog: typeof catalogFile, benchmarks: typeof benchmarksFile) => void) => {
  const catalog = structuredClone(catalogFile);
  const benchmarks = structuredClone(benchmarksFile);
  edit(catalog, benchmarks);
  return expect(() => parseCatalog(catalog, benchmarks));
};
const model = (catalog: typeof catalogFile, id: string) => catalog.models.find((m) => m["id"] === id)!;

describe("model catalog (data/catalog.json, data/benchmarks.json)", () => {
  it("CT1.1 the shipped data parses: every model's tasks are served by its ports, and benchmarks attach to their models", () => {
    expect(MODEL_CATALOG).toHaveLength(catalogFile.models.length);
    for (const m of MODEL_CATALOG) for (const t of m.tasks) expect(TASK_PORTS[t].some((p) => m.ports.includes(p)), `${m.id} ${t}`).toBe(true);
    expect(MODEL_CATALOG.flatMap((m) => m.benchmarks)).toHaveLength(benchmarksFile.rows.length);
    expect(MODEL_CATALOG.find((m) => m.id === "Qwen/Qwen3.5-0.8B")!.benchmarks).toContainEqual({ benchmark: "MMLU-Pro", task: "chat", metric: "accuracy", score: 29.7, higherIsBetter: true, setting: "non-thinking" });
    expect(MODEL_CATALOG.find((m) => m.id === "typesafe-ai/jev")!.benchmarks).toContainEqual({ benchmark: "JevBench v1.0 (242 decisions)", task: "judgment", metric: "ECE", score: 0.027, higherIsBetter: false });
  });

  it("CT1.2 a model entry that cannot be right is refused, naming where", () => {
    refused((c) => (model(c, "typesafe-ai/jev")["tasks"] = ["judgment", "chat"])).toThrow(/no port of typesafe-ai\/jev serves chat/);
    refused((c) => c.models.push(structuredClone(c.models[0]!))).toThrow(/model typesafe-ai\/jev is listed twice/);
    refused((c) => (model(c, "typesafe-ai/jev")["downloadBytes"] = 5)).toThrow(/a hosted model downloads nothing/);
    refused((c) => delete model(c, "Cactus-Compute/needle3")["artifact"]).toThrow(/a local model pins its weights/);
    refused((c) => (model(c, "Cactus-Compute/needle3")["downloadBytes"] = 1)).toThrow(/downloadBytes is the sum/);
    refused((c) => ((model(c, "Cactus-Compute/needle3")["artifact"] as { revision: string }).revision = "main")).toThrow(/a pinned commit, never a branch/);
    refused((c) => ((model(c, "Cactus-Compute/needle3")["artifact"] as { files: { sha256: string }[] }).files[0]!.sha256 = "abc")).toThrow(/sha256/);
    refused((c) => (model(c, "Cactus-Compute/needle3")["runtime"] = "tensorflow")).toThrow(/runtime/);
    refused((c) => (model(c, "Cactus-Compute/needle3")["colour"] = "blue")).toThrow(/colour/);
  });

  it("CT1.3 preferences and benchmark rows must name catalog models that serve the task", () => {
    refused((c) => ((c["preferences"] as Record<string, string[]>)["coding"] = ["typesafe-ai/jev"])).toThrow(/typesafe-ai\/jev does not serve coding/);
    refused((_, b) => b.rows.push(["nobody/model", "chat", "X", "acc", 1, "higher"])).toThrow(/nobody\/model is not a catalog model serving chat/);
    refused((_, b) => b.rows.push(["typesafe-ai/jev", "chat", "X", "acc", 1, "higher"])).toThrow(/typesafe-ai\/jev is not a catalog model serving chat/);
    refused((_, b) => b.rows.push(["typesafe-ai/jev", "judgment", "X", "acc", 1, "sideways"])).toThrow(/rows\[\d+\]\[5\]/);
    refused((_, b) => b.rows.push(["typesafe-ai/jev", "judgment", "X", "acc", 1, "higher", "s", "extra"])).toThrow(/at most 7 fields/);
    refused((_, b) => b.rows.push(["typesafe-ai/jev", "judgment", "X", "acc", "high", "higher"])).toThrow(/rows\[\d+\]\[4\]/);
  });

  it("CT1.10 each data file names its JSON Schema, and the schemas are generated from the parser", async () => {
    expect(catalogFile["$schema"]).toBe("./catalog.schema.json");
    expect(benchmarksFile["$schema"]).toBe("./benchmarks.schema.json");
    const schemas = catalogJsonSchemas();
    await expect(`${JSON.stringify(schemas.catalog, null, 2)}\n`).toMatchFileSnapshot("../data/catalog.schema.json");
    await expect(`${JSON.stringify(schemas.benchmarks, null, 2)}\n`).toMatchFileSnapshot("../data/benchmarks.schema.json");
  });

  it("CT1.4 natively every task but text embedding has a model (memory brings that); the browser also lacks coding and steered chat", () => {
    const uncovered = (platform: Platform) => TASK_CATEGORIES.filter((t) => rankForTask(t, MODEL_CATALOG, { platform }).length === 0);
    expect(uncovered("native")).toEqual(["text-embedding"]);
    expect(uncovered("browser")).toEqual(["text-embedding", "coding", "steered-chat"]);
  });

  it("CT1.5 the judges are Jev, the only hosted model, and CLM, its local fallback", () => {
    expect(MODEL_CATALOG.filter((m) => m.tasks.includes("judgment")).map((m) => [m.id, m.locality])).toEqual([
      ["typesafe-ai/jev", "hosted"],
      ["Contrastive-LM/CLM-v0.1-8B", "local"],
    ]);
    expect(top("judgment", "native")).toBe("typesafe-ai/jev");
    expect(rankForTask("judgment", MODEL_CATALOG, { platform: "native", allowHosted: false, prefer: TASK_PREFERENCES["judgment"] ?? [] })[0]?.id).toBe("Contrastive-LM/CLM-v0.1-8B");
    expect(MODEL_CATALOG.filter((m) => m.locality === "hosted").map((m) => [m.id, m.runtime])).toEqual([["typesafe-ai/jev", "ai-gateway"]]);
  });

  it("CT1.6 the browser only gets models that run there, and Ornith and OvisOCR2 stay native", () => {
    const browser = MODEL_CATALOG.filter((m) => m.platforms.includes("browser")).map((m) => m.id);
    expect(browser).not.toContain("ornith-ai/Ornith-1.5-9B");
    expect(browser).not.toContain("ATH-MaaS/OvisOCR2");
    for (const m of MODEL_CATALOG.filter((x) => x.platforms.includes("browser") && x.locality === "local")) expect(["transformers.js", "needle-wasm"]).toContain(m.runtime);
  });

  it("CT1.7 selection follows the published evidence", () => {
    // Needle 3's own chart: Needle wins tool calling 2 of 3 against Qwen3.5-0.8B...
    expect(top("tool-calling", "browser")).toBe("Cactus-Compute/needle3");
    // ...and loses structured extraction 0 of 3.
    expect(top("structured-extraction", "browser")).toBe("Qwen/Qwen3.5-0.8B");
    expect(top("prompt-compression", "browser")).toBe("microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank");
    expect(top("document-parsing", "browser")).toBe("lightonai/LightOnOCR-2-1B");
    expect(top("document-parsing", "native")).toBe("ATH-MaaS/OvisOCR2");
    expect(top("chat", "browser")).toBe("Qwen/Qwen3.5-0.8B");
    expect(top("chat", "native")).toBe("ornith-ai/Ornith-1.5-9B");
    expect(top("coding", "native")).toBe("ornith-ai/Ornith-1.5-9B");
    expect(top("vision-qa", "browser")).toBe("Qwen/Qwen3.5-0.8B");
    expect(top("judgment", "native")).toBe("typesafe-ai/jev");
  });

  it("CT1.9 steered chat is the local steerable kernel alone: Qwen3-1.7B, whose layers have public SAEs", () => {
    expect(MODEL_CATALOG.filter((m) => m.tasks.includes("steered-chat")).map((m) => [m.id, m.locality, m.runtime])).toEqual([["Qwen/Qwen3-1.7B", "local", "onnxruntime"]]);
    expect(top("steered-chat", "native")).toBe("Qwen/Qwen3-1.7B");
    expect(TASK_PORTS["steered-chat"]).toEqual(["generator"]);
  });

});
