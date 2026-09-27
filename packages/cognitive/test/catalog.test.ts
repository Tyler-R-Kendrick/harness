import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogJsonSchemas, parseCatalog, rankForTask, TASK_CATEGORIES, TASK_PORTS } from "@harness/cognitive";
import type { Platform, TaskCategory } from "@harness/cognitive";

const data = (file: string) => JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), "utf8")) as Record<string, unknown> & { models: Record<string, unknown>[]; rows: unknown[][] };
const catalogFile = data("catalog.json");
const benchmarksFile = data("benchmarks.json");
const { models: MODEL_CATALOG, preferences: TASK_PREFERENCES } = parseCatalog(catalogFile, benchmarksFile);

/** The shipped catalog with one change; parsing it must fail and say why. */
const refused = (edit: (catalog: typeof catalogFile, benchmarks: typeof benchmarksFile) => void) => {
  const catalog = structuredClone(catalogFile);
  const benchmarks = structuredClone(benchmarksFile);
  edit(catalog, benchmarks);
  return expect(() => parseCatalog(catalog, benchmarks));
};
/** Tests pick models by runtime and category, never by name, so they hold whatever the catalog lists. */
const byRuntime = (catalog: typeof catalogFile, runtime: string) => catalog.models.find((m) => m["runtime"] === runtime)!;
const hosted = byRuntime(catalogFile, "ai-gateway")["id"] as string;
const c0 = () => catalogFile.models[0]!["id"] as string;
const esc = (id: string) => id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

describe("model catalog (data/catalog.json, data/benchmarks.json)", () => {
  it("CT1.1 the shipped data parses: every model's tasks are served by its ports, and benchmarks attach to their models", () => {
    expect(MODEL_CATALOG).toHaveLength(catalogFile.models.length);
    for (const m of MODEL_CATALOG) for (const t of m.tasks) expect(TASK_PORTS[t].some((p) => m.ports.includes(p)), `${m.id} ${t}`).toBe(true);
    expect(MODEL_CATALOG.flatMap((m) => m.benchmarks)).toHaveLength(benchmarksFile.rows.length);
    for (const [id, task, benchmark, metric, score, better, setting] of benchmarksFile.rows as [string, TaskCategory, string, string, number, string, string?][]) {
      expect(MODEL_CATALOG.find((m) => m.id === id)!.benchmarks).toContainEqual({ benchmark, task, metric, score, higherIsBetter: better === "higher", ...(setting ? { setting } : {}) });
    }
  });

  it("CT1.2 a model entry that cannot be right is refused, naming where", () => {
    refused((c) => (byRuntime(c, "ai-gateway")["tasks"] = ["judgment", "chat"])).toThrow(new RegExp(`no port of ${esc(hosted)} serves chat`));
    refused((c) => c.models.push(structuredClone(c.models[0]!))).toThrow(new RegExp(`model ${esc(c0())} is listed twice`));
    refused((c) => (byRuntime(c, "ai-gateway")["downloadBytes"] = 5)).toThrow(/a hosted model downloads nothing/);
    refused((c) => delete byRuntime(c, "cactus-wasm")["artifact"]).toThrow(/a local model pins its weights/);
    refused((c) => (byRuntime(c, "cactus-wasm")["downloadBytes"] = 1)).toThrow(/downloadBytes is the sum/);
    refused((c) => ((byRuntime(c, "cactus-wasm")["artifact"] as { revision: string }).revision = "main")).toThrow(/a pinned commit, never a branch/);
    refused((c) => ((byRuntime(c, "cactus-wasm")["artifact"] as { files: { sha256: string }[] }).files[0]!.sha256 = "abc")).toThrow(/sha256/);
    refused((c) => (byRuntime(c, "cactus-wasm")["runtime"] = "tensorflow")).toThrow(/runtime/);
    refused((c) => (byRuntime(c, "cactus-wasm")["colour"] = "blue")).toThrow(/colour/);
  });

  it("CT1.11 constraint enforcement is declared where it can happen: token-level runtimes name their vocabulary encoding, llama-server does JSON Schema, others none", () => {
    const tokenLevel = (c: typeof catalogFile) => c.models.find((m) => m["runtime"] === "onnxruntime")!;
    refused((c) => delete (tokenLevel(c)["run"] as Record<string, unknown>)["vocab"]).toThrow(/names its vocabulary encoding/);
    refused((c) => (byRuntime(c, "llama.cpp-server")["constraints"] = ["json-schema", "regex"])).toThrow(/enforces only JSON Schema/);
    refused((c) => (byRuntime(c, "ai-gateway")["constraints"] = ["json-schema"])).toThrow(/only a generator enforces constraints[\s\S]*ai-gateway models cannot enforce constraints/);
    refused((c) => (tokenLevel(c)["constraints"] = ["telepathy"])).toThrow(/constraints/);
    expect(MODEL_CATALOG.filter((m) => m.constraints).every((m) => m.ports.includes("generator"))).toBe(true);
  });

  it("CT1.8 run settings belong to the runtime, name files of the artifact, and category settings come exactly with their port", () => {
    refused((c) => ((byRuntime(c, "cactus-wasm")["run"] as Record<string, unknown>)["weights"] = "missing.bin")).toThrow(/missing.bin is not a file of the artifact/);
    refused((c) => ((byRuntime(c, "cactus-wasm")["run"] as Record<string, unknown>)["prefix"] = "Bad-Prefix")).toThrow(/prefix/);
    refused((c) => ((byRuntime(c, "cactus-wasm")["run"] as Record<string, unknown>)["dtype"] = "q4")).toThrow(/dtype/);
    const compressor = (c: typeof catalogFile) => c.models.find((m) => (m["ports"] as string[]).includes("compressor"))!;
    refused((c) => delete compressor(c)["compression"]).toThrow(/a compressor, and only a compressor/);
    refused((c) => (byRuntime(c, "cactus-wasm")["compression"] = { window: 8, subwords: "wordpiece", keepLabel: 1 })).toThrow(/a compressor, and only a compressor/);
    refused((c) => (byRuntime(c, "cactus-wasm")["embedding"] = { query: "{text}", document: "{text}", dimensions: [8] })).toThrow(/an embedder, and only an embedder/);
    const vision = (c: typeof catalogFile) => c.models.find((m) => m["runtime"] === "transformers.js" && (m["ports"] as string[]).includes("generator"))!;
    refused((c) => delete (vision(c)["run"] as Record<string, unknown>)["modelClass"]).toThrow(/names its model class/);
    refused((c) => ((compressor(c)["run"] as Record<string, unknown>)["modelClass"] = "X")).toThrow(/names its model class/);
  });

  it("CT1.3 preferences and benchmark rows must name catalog models that serve the task", () => {
    refused((c) => ((c["preferences"] as Record<string, string[]>)["coding"] = [hosted])).toThrow(new RegExp(`${esc(hosted)} does not serve coding`));
    refused((_, b) => b.rows.push(["nobody/model", "chat", "X", "acc", 1, "higher"])).toThrow(/nobody\/model is not a catalog model serving chat/);
    refused((_, b) => b.rows.push([hosted, "chat", "X", "acc", 1, "higher"])).toThrow(new RegExp(`${esc(hosted)} is not a catalog model serving chat`));
    refused((_, b) => b.rows.push([hosted, "judgment", "X", "acc", 1, "sideways"])).toThrow(/rows\[\d+\]\[5\]/);
    refused((_, b) => b.rows.push([hosted, "judgment", "X", "acc", 1, "higher", "s", "extra"])).toThrow(/at most 7 fields/);
    refused((_, b) => b.rows.push([hosted, "judgment", "X", "acc", "high", "higher"])).toThrow(/rows\[\d+\]\[4\]/);
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

  it("CT1.5 judging works without keys: every hosted judge has a local fallback, which takes over when hosted models are off", () => {
    const judges = MODEL_CATALOG.filter((m) => m.tasks.includes("judgment"));
    expect(judges.some((m) => m.locality === "hosted")).toBe(true);
    const fallback = rankForTask("judgment", MODEL_CATALOG, { platform: "native", allowHosted: false, prefer: TASK_PREFERENCES["judgment"] ?? [] })[0];
    expect(fallback?.descriptor.locality).toBe("local");
  });

  it("CT1.6 browser models run on browser runtimes; server and patched-ONNX runtimes stay native", () => {
    for (const m of MODEL_CATALOG.filter((x) => x.platforms.includes("browser") && x.locality === "local")) expect(["transformers.js", "cactus-wasm"], m.id).toContain(m.runtime);
    for (const m of MODEL_CATALOG.filter((x) => x.runtime === "llama.cpp-server" || x.runtime === "onnxruntime")) expect(m.platforms, m.id).toEqual(["native"]);
  });

  it("CT1.7 every task preference names models in the order selection breaks ties by", () => {
    for (const [task, ids] of Object.entries(TASK_PREFERENCES) as [TaskCategory, readonly string[]][]) {
      const ranked = rankForTask(task, MODEL_CATALOG, { platform: "native", prefer: ids }).map((r) => r.id);
      const tied = ids.filter((id) => ranked.includes(id) && MODEL_CATALOG.find((m) => m.id === id)!.benchmarks.every((b) => b.task !== task));
      expect(ranked.filter((id) => tied.includes(id)), task).toEqual(tied);
    }
  });

  it("CT1.9 steered chat is served only by local models on the steerable ONNX runtime", () => {
    const steered = MODEL_CATALOG.filter((m) => m.tasks.includes("steered-chat"));
    expect(steered.length).toBeGreaterThan(0);
    for (const m of steered) expect([m.locality, m.runtime]).toEqual(["local", "onnxruntime"]);
    expect(TASK_PORTS["steered-chat"]).toEqual(["generator"]);
  });
});
