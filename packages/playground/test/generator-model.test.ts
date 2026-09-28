import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { bytes, parseCatalog } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { rankGenerators, WRITING, writers } from "../src/generator-model.ts";
import { LocalModels } from "../src/local-models.ts";
import { parseEngineSettings } from "../src/engine-settings.ts";

const data = (file: string) => JSON.parse(readFileSync(new URL(`../../cognitive/data/${file}`, import.meta.url), "utf8")) as unknown;
const catalog = parseCatalog(data("catalog.json"), data("benchmarks.json"));
const settings = parseEngineSettings(JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")));
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the page's local generators (/writer [slug])", () => {
  it("GM1.1 the candidates are the catalog's local generators that run in a browser and enforce a JSON Schema, best first by rank, not by name", () => {
    const ranked = rankGenerators(catalog);
    expect(ranked.length).toBeGreaterThan(0);
    for (const m of ranked) {
      expect([m.locality, m.ports.includes("generator"), m.platforms.includes("browser"), m.constraints?.includes("json-schema")]).toEqual(["local", true, true, true]);
    }
    const unconstrained = { models: catalog.models.map((m: ModelDescriptor) => ({ ...m, constraints: [] })), preferences: {} };
    expect(rankGenerators(unconstrained)).toEqual([]);
  });

  it("GM1.2 a local generator writes first once it is ready, and Claude after it; until then, with claude, or with none, Claude alone (when reachable)", async () => {
    const local = new MockLanguageModelV4({ provider: "local", modelId: "small" });
    const claude = new MockLanguageModelV4({ provider: "claude", modelId: "sample" });
    let settle: (m: LanguageModelV4) => void = () => {};
    const models = new LocalModels<LanguageModelV4>({
      ranked: [{ id: "org/small", name: "Small", downloadBytes: bytes(36_000_000), locality: "local" }],
      settings: settings.choice,
      past: () => undefined,
      load: () => new Promise((resolve) => (settle = resolve)),
      onChange: () => {},
      role: WRITING,
    });
    models.detected({ webgpu: true, freeBytes: undefined, saveData: false });
    expect(models.slugs()).toEqual(["auto", "claude", "org/small"]);
    models.want("auto", false);
    expect(writers(models, "auto", claude)).toEqual([claude]);
    settle(local);
    await tick();
    expect(writers(models, "auto", claude)).toEqual([local, claude]);
    expect(writers(models, "org/small", undefined)).toEqual([local]);
    expect(writers(models, "claude", claude)).toEqual([claude]);
    expect(writers(models, "claude", undefined)).toEqual([]);
    expect(models.status("claude")).toBe("Claude writes templates alone, when reachable (/writer auto picks a local generator for this browser)");
    expect(models.status("org/gone")).toBe("org/gone is not a generator in this page's catalog; Claude writes templates, when reachable");
    models.current("auto")!.fellBack(["local/small: out of memory"]);
    expect(models.status("auto")).toBe("Small: ready; the last template was written by Claude instead (local/small: out of memory)");
  });
});
