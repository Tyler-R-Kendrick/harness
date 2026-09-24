import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, parseBenchmarks, rankForTask, TASK_CATEGORIES, TASK_PORTS, TASK_PREFERENCES } from "@harness/cognitive";
import { BENCHMARKS } from "../src/benchmark-table.ts";
import type { Platform, TaskCategory } from "@harness/cognitive";

const top = (task: TaskCategory, platform: Platform) => rankForTask(task, MODEL_CATALOG, { platform, prefer: TASK_PREFERENCES[task] ?? [] })[0]?.id;

describe("model catalog", () => {
  it("CT1.1 ids are unique and every task a model claims is served by a port it implements", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MODEL_CATALOG) {
      expect(m.tasks.length, m.id).toBeGreaterThan(0);
      for (const task of m.tasks) expect(TASK_PORTS[task].some((p) => m.ports.includes(p)), `${m.id} ${task}`).toBe(true);
    }
  });

  it("CT1.2 local models pin a commit and hashed files; hosted models download nothing", () => {
    for (const m of MODEL_CATALOG) {
      if (m.locality === "hosted") {
        expect(m.artifact, m.id).toBeUndefined();
        expect(m.downloadBytes, m.id).toBe(0);
        continue;
      }
      expect(m.artifact!.revision, m.id).toMatch(/^[0-9a-f]{40}$/);
      expect(m.artifact!.files.length, m.id).toBeGreaterThan(0);
      for (const f of m.artifact!.files) {
        expect(f.bytes, `${m.id} ${f.path}`).toBeGreaterThan(0);
        expect(f.sha256, `${m.id} ${f.path}`).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(m.downloadBytes, m.id).toBe(m.artifact!.files.reduce((s, f) => s + f.bytes, 0));
    }
  });

  it("CT1.3 every row of the benchmark table names a catalog model and a task that model claims", () => {
    const rows = parseBenchmarks(BENCHMARKS);
    for (const r of rows) expect(MODEL_CATALOG.find((m) => m.id === r.model)?.tasks, `${r.model} ${r.benchmark}`).toContain(r.task);
    expect(MODEL_CATALOG.flatMap((m) => m.benchmarks)).toHaveLength(rows.length);
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

  it("CT1.8 preferences only name catalog models that serve the task", () => {
    for (const [task, ids] of Object.entries(TASK_PREFERENCES))
      for (const id of ids ?? []) expect(MODEL_CATALOG.find((m) => m.id === id)?.tasks, `${task} ${id}`).toContain(task);
  });

  it("CT1.10 the catalog is reviewed data: pinned weights, hashes, benchmarks and preferences change only with the reviewed snapshot", async () => {
    await expect(JSON.stringify({ models: MODEL_CATALOG, preferences: TASK_PREFERENCES }, null, 1)).toMatchFileSnapshot("./catalog.snapshot.json");
  });
});
