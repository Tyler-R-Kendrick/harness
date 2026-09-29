import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { bytes, parseCatalog } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { lexicalDecider } from "../src/decide.ts";
import { deciders, DECIDING, rankDecisionModels } from "../src/decision-model.ts";
import { LocalModel, LocalModels } from "../src/local-models.ts";
import type { Capabilities, Past } from "../src/model-choice.ts";
import { parseEngineSettings } from "../src/engine-settings.ts";

const data = (file: string) => JSON.parse(readFileSync(new URL(`../../cognitive/data/${file}`, import.meta.url), "utf8")) as unknown;
const catalog = parseCatalog(data("catalog.json"), data("benchmarks.json"));
const settings = parseEngineSettings(JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")));
const lexical = lexicalDecider(settings.lexical);

const judge: EvaluationModelV4 = { specificationVersion: "v4", provider: "harness.decision", modelId: "m", supportedQuestionTypes: ["choice"], doEvaluate: async () => ({ answers: {}, warnings: [] }) };

/** A stand-in for the browser host's ensemble: `resolve` settles when the test says. */
function ensemble() {
  let settle: { resolve: (port: EvaluationModelV4) => void; reject: (e: Error) => void } | undefined;
  let asked = 0;
  return {
    get asked() {
      return asked;
    },
    resolve: () => {
      asked++;
      return new Promise<{ id: string; port: EvaluationModelV4 }>((resolve, reject) => {
        settle = { resolve: (port) => resolve({ id: "x", port }), reject };
      });
    },
    settle: () => settle!,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
/** A model's load through a stand-in ensemble: its port. */
const loads = (e: ReturnType<typeof ensemble>) => () => e.resolve().then((r) => r.port);

describe("the page's decision model", () => {
  it("PD1.1 the page's decision models are the catalog's local classification judges that run in a browser, best first by rank, not by name", () => {
    const ranked = rankDecisionModels(catalog);
    const m = ranked[0]!;
    expect(m.ports).toContain("judge");
    expect(m.tasks).toContain("classification");
    expect(m.platforms).toContain("browser");
    for (const x of ranked) expect([x.locality, x.ports.includes("judge")]).toEqual(["local", true]);
    const none = { models: catalog.models.filter((x: ModelDescriptor) => x.id !== m.id), preferences: {} };
    expect(rankDecisionModels(none).map((x) => x.id)).not.toContain(m.id);
    expect(rankDecisionModels({ models: [], preferences: {} })).toEqual([]);
  });

  it("PD1.2 it loads when asked, not before; until it is ready the lexical judge decides alone, then the model decides first and the lexical judge stands behind it", async () => {
    const e = ensemble();
    const changes: string[] = [];
    const m = new LocalModel({ model: { id: "org/decider", name: "Decider", downloadBytes: bytes(614_135_099) }, load: loads(e), onChange: () => changes.push(m.status()), role: DECIDING });
    expect([m.status(), m.phase(), m.name, m.id, m.label]).toEqual(["Decider: not downloaded (614 MB, once; kept in this browser)", "idle", "Decider (org/decider)", "org/decider", "Decider"]);
    expect(m.port).toBeUndefined();
    m.load();
    m.load();
    expect(e.asked).toBe(1);
    expect(m.status()).toBe("Decider: loading (614 MB, once; kept in this browser)");
    e.settle().resolve(judge);
    await tick();
    expect([m.status(), m.phase()]).toEqual(["Decider: ready", "ready"]);
    expect(m.port).toBe(judge);
    expect(changes).toEqual(["Decider: loading (614 MB, once; kept in this browser)", "Decider: ready"]);
  });

  it("PD1.3 a model that cannot load says why, and the lexical judge keeps deciding", async () => {
    const e = ensemble();
    const m = new LocalModel({ model: { id: "org/decider", name: "Decider", downloadBytes: bytes(1) }, load: loads(e), onChange: () => {}, role: DECIDING });
    m.load();
    e.settle().reject(new Error("GET https://huggingface.co/... failed: TypeError: Failed to fetch"));
    await tick();
    expect([m.status(), m.phase(), m.failure]).toEqual(["Decider: could not load (GET https://huggingface.co/... failed: TypeError: Failed to fetch); the lexical judge decides", "failed", "GET https://huggingface.co/... failed: TypeError: Failed to fetch"]);
    expect(m.port).toBeUndefined();
    // Asked again, it tries again.
    m.load();
    expect(e.asked).toBe(2);
    e.settle().resolve(judge);
    await tick();
    expect(m.phase()).toBe("ready");
  });

  it("PD1.5 files the browser would not keep are said, and so is the last decision it left to the lexical judge", async () => {
    const e = ensemble();
    const m = new LocalModel({ model: { id: "org/decider", name: "Decider", downloadBytes: bytes(614_135_099) }, load: loads(e), onChange: () => {}, role: DECIDING });
    m.load();
    m.cacheProblem("QuotaExceededError");
    e.settle().resolve(judge);
    await tick();
    expect(m.status()).toBe("Decider: ready (not kept in this browser: QuotaExceededError; it downloads again next visit)");
    m.fellBack(["harness.decision/m: the question and options are more than 512 tokens"]);
    expect(m.status()).toMatch(/ready .*; the last decision fell back to the lexical judge \(harness.decision\/m: the question and options are more than 512 tokens\)$/);
    m.fellBack([]);
    expect(m.status()).not.toMatch(/fell back/);
  });

});

const FIT = settings.choice;
const GPU: Capabilities = { webgpu: true, freeBytes: 10_000_000_000, saveData: false };
const big = { id: "org/big", name: "Big", downloadBytes: bytes(600_000_000), locality: "local" as const };
const small = { id: "org/small", name: "Small", downloadBytes: bytes(36_000_000), locality: "local" as const };

/** The page's decision models over stand-in ensembles, one per model, settled when the test says. */
function models(ranked = [big, small], past: Record<string, Past> = {}) {
  const ensembles = new Map<string, ReturnType<typeof ensemble>>();
  const changed: string[] = [];
  const ensembleOf = (id: string) => ensembles.get(id) ?? (ensembles.set(id, ensemble()), ensembles.get(id)!);
  const m = new LocalModels<EvaluationModelV4>({
    ranked,
    settings: FIT,
    past: (id) => past[id],
    load: (model) => loads(ensembleOf(model.id))(),
    onChange: (model) => changed.push(`${model.id}: ${model.phase()}`),
    role: DECIDING,
  });
  /** The models asked to load, in order of their ensembles. */
  const asked = () => [...ensembles].filter(([, e]) => e.asked > 0).map(([id]) => id);
  return { m, ensembles, changed, asked };
}

describe("which decision model decides: picked for this browser unless named (/decide [slug])", () => {
  it("PD2.1 the slugs are auto, lexical and every decision model's catalog id", () => {
    expect(models().m.slugs()).toEqual(["auto", "lexical", "org/big", "org/small"]);
  });

  it("PD2.2 auto waits for what the browser offers, then loads the best-ranked model that fits, local first, without being asked; the lexical judge decides until it is ready", async () => {
    const { m, ensembles, changed, asked } = models();
    expect([m.phase("auto"), m.status("auto"), m.pick()]).toEqual(["checking", "checking what this browser can run; the lexical judge decides meanwhile", undefined]);
    m.want("auto", false);
    expect(asked()).toEqual([]);
    m.detected({ ...GPU, webgpu: false });
    m.want("auto", false);
    expect(asked()).toEqual(["org/small"]);
    expect(m.status("auto")).toBe("Small: loading (36 MB, once; kept in this browser); picked for this browser over Big (no WebGPU adapter for a 600 MB model)");
    expect(deciders(m, "auto", lexical)).toEqual([lexical]);
    ensembles.get("org/small")!.settle().resolve(judge);
    await tick();
    expect([m.phase("auto"), m.name("auto"), m.current("auto")?.id, m.pick()?.id, m.port("auto")]).toEqual(["ready", "Small (org/small)", "org/small", "org/small", judge]);
    // The model decides first, the lexical judge behind it.
    const [first, second] = deciders(m, "auto", lexical);
    expect([first!.judge, first!.lexical, second]).toEqual([judge, false, lexical]);
    expect(changed).toEqual(["org/small: loading", "org/small: ready"]);
  });

  it("PD2.3 auto with no model that fits says why each was skipped, and the lexical judge decides; a model that fails to load is skipped for the next one", async () => {
    const none = models([big]);
    none.m.detected({ ...GPU, saveData: true });
    none.m.want("auto", false);
    expect([none.m.phase("auto"), none.m.status("auto"), deciders(none.m, "auto", lexical), none.m.name("auto")]).toEqual(["none", "none fits this browser (Big: this browser asks to save data); the lexical judge decides (/decide org/big loads one anyway)", [lexical], undefined]);
    expect(models([]).m.status("auto")).toBe("none for a browser in the catalog; the lexical judge decides");
    const { m, ensembles } = models();
    m.detected(GPU);
    m.want("auto", false);
    ensembles.get("org/big")!.settle().reject(new Error("out of memory"));
    await tick();
    m.want("auto", false);
    expect(m.current("auto")?.id).toBe("org/small");
    expect(m.status("auto")).toMatch(/^Small: loading .*; picked for this browser over Big \(could not load: out of memory\)$/);
  });

  it("PD2.4 a model named by its slug loads even when auto would skip it, and says what auto would have said; one this browser did not keep waits until it is named again", async () => {
    const { m, ensembles } = models([big, small], { "org/small": { kept: false, reason: "QuotaExceededError" } });
    m.detected({ ...GPU, webgpu: false });
    m.want("org/big", false);
    expect(m.status("org/big")).toBe("Big: loading (600 MB, once; kept in this browser); named by /decide, though auto would skip it (no WebGPU adapter for a 600 MB model)");
    ensembles.get("org/big")!.settle().resolve(judge);
    await tick();
    expect(m.phase("org/big")).toBe("ready");
    m.want("org/small", false);
    expect([m.phase("org/small"), m.status("org/small")]).toEqual(["idle", "Small: not kept in this browser last time (QuotaExceededError): /decide org/small downloads it again (36 MB)"]);
    m.want("org/small", true);
    expect(m.phase("org/small")).toBe("loading");
  });

  it("PD2.5 lexical, or a slug no longer in the catalog, leaves the lexical judge alone and loads nothing", () => {
    const { m, asked } = models();
    m.detected(GPU);
    for (const slug of ["lexical", "org/gone"]) {
      m.want(slug, true);
      expect([deciders(m, slug, lexical), m.current(slug), m.name(slug)]).toEqual([[lexical], undefined, undefined]);
    }
    expect(asked()).toEqual([]);
    expect([m.phase("lexical"), m.status("lexical")]).toEqual(["alone", "the lexical judge decides alone (/decide auto picks a decision model for this browser)"]);
    expect([m.phase("org/gone"), m.status("org/gone")]).toEqual(["none", "org/gone is not a decision model in this page's catalog; the lexical judge decides"]);
  });
});
