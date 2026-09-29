import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { bytes, parseCatalog } from "@harness/cognitive";
import { answerers, enforcesJson, rankGenerators, WRITING, writers } from "../src/generator-model.ts";
import { LocalModels } from "../src/local-models.ts";
import { parseEngineSettings } from "../src/engine-settings.ts";

const data = (file: string) => JSON.parse(readFileSync(new URL(`../../cognitive/data/${file}`, import.meta.url), "utf8")) as unknown;
const catalog = parseCatalog(data("catalog.json"), data("benchmarks.json"));
const settings = parseEngineSettings(JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")));
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the page's local generators (/writer [slug])", () => {
  it("GM1.1 the candidates are the catalog's local generators that run in a browser, best first by rank, not by name; the smallest runs on WebAssembly alone", () => {
    const ranked = rankGenerators(catalog);
    expect(ranked.length).toBeGreaterThan(1);
    for (const m of ranked) expect([m.locality, m.ports.includes("generator"), m.platforms.includes("browser"), m.tasks.includes("chat")]).toEqual(["local", true, true, true]);
    const smallest = [...ranked].sort((a, b) => a.downloadBytes - b.downloadBytes)[0]!;
    expect(smallest.downloadBytes).toBeLessThanOrEqual(settings.choice.gpuBytes);
    expect(rankGenerators({ models: [], preferences: {} })).toEqual([]);
  });

  it("GM1.2 a local model writes templates only when it enforces a JSON Schema, and answers either way; Claude writes and answers only when named (claude)", () => {
    const local = { id: "org/small", port: new MockLanguageModelV4({ provider: "local", modelId: "small" }) };
    const claude = new MockLanguageModelV4({ provider: "claude", modelId: "sample" });
    const json = (id: string) => id === "org/small";
    expect(writers("auto", local, claude, json)).toEqual([local.port]);
    expect(writers("auto", local, claude, () => false)).toEqual([]);
    expect(writers("auto", undefined, claude, json)).toEqual([]);
    expect(answerers("auto", local, claude)).toEqual([local.port]);
    expect(answerers("org/small", undefined, claude)).toEqual([]);
    expect([writers("claude", local, claude, json), answerers("claude", local, claude)]).toEqual([[claude], [claude]]);
    expect([writers("claude", local, undefined, json), answerers("claude", local, undefined)]).toEqual([[], []]);
    expect(enforcesJson(catalog)(rankGenerators(catalog).find((m) => m.constraints?.includes("json-schema"))!.id)).toBe(true);
    expect(enforcesJson(catalog)(rankGenerators(catalog).find((m) => !m.constraints)!.id)).toBe(false);
  });

  it("GM1.4 the Writes status says a failed template was answered instead, and names Claude alone for claude", async () => {
    const models = new LocalModels<LanguageModelV4>({
      ranked: [{ id: "org/small", name: "Small", downloadBytes: bytes(36_000_000), locality: "local" }],
      settings: settings.choice,
      past: () => undefined,
      load: async () => new MockLanguageModelV4({ provider: "local", modelId: "small" }),
      onChange: () => {},
      role: WRITING,
    });
    models.detected({ webgpu: true, freeBytes: undefined, saveData: false });
    await models.ready("auto");
    expect(models.slugs()).toEqual(["auto", "claude", "org/small"]);
    expect(models.status("claude")).toBe("Claude writes templates and answers alone, when reachable (/writer auto picks a local model for this browser)");
    expect(models.status("org/gone")).toBe("org/gone is not a generator in this page's catalog; nothing answers without a local model (/writer claude uses Claude)");
    models.current("auto")!.fellBack(["local/small: it leaves joke without a value"]);
    expect(models.status("auto")).toBe("Small: ready; its last template was refused, so it answered the request itself (local/small: it leaves joke without a value)");
  });

  it("GM1.3 the local generator is mandatory: with none that fits, auto loads the smallest this browser runs and says why; a question waits for it to be ready, and moves past one that fails to load", async () => {
    const local = new MockLanguageModelV4({ provider: "local", modelId: "tiny" });
    const settle = new Map<string, { resolve: (m: LanguageModelV4) => void; reject: (e: Error) => void }>();
    const models = new LocalModels<LanguageModelV4>({
      ranked: [
        { id: "org/small", name: "Small", downloadBytes: bytes(150_000_000), locality: "local" },
        { id: "org/tiny", name: "Tiny", downloadBytes: bytes(36_000_000), locality: "local" },
      ],
      settings: settings.choice,
      past: () => undefined,
      load: (m) => new Promise((resolve, reject) => settle.set(m.id, { resolve, reject })),
      onChange: () => {},
      role: WRITING,
    });
    models.detected({ webgpu: false, freeBytes: undefined, saveData: true });
    expect(models.pick()?.id).toBe("org/tiny");
    const waiting = models.ready("auto");
    await tick();
    expect(models.status("auto")).toBe("Tiny: loading (36 MB, once; kept in this browser); picked for this browser over Small (this browser asks to save data); loaded though this browser asks to save data: local inference is mandatory");
    settle.get("org/tiny")!.reject(new Error("quota"));
    await tick();
    // Auto moves on to the next that can run, and the question waits for it.
    expect(models.current("auto")?.id).toBe("org/small");
    settle.get("org/small")!.resolve(local);
    expect(await waiting).toBe(local);
    expect(await models.ready("auto")).toBe(local);
    expect(await models.ready("claude")).toBeUndefined();
  });
});
