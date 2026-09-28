import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { bytes, parseCatalog } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { lexicalDecider } from "../src/decide.ts";
import { DecisionModel, pickDecisionModel } from "../src/decision-model.ts";
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

describe("the page's decision model", () => {
  it("PD1.1 the page's decision model is the catalog's best local classification judge that runs in a browser, picked by rank, not by name", () => {
    const m = pickDecisionModel(catalog)!;
    expect(m.ports).toContain("judge");
    expect(m.tasks).toContain("classification");
    expect(m.platforms).toContain("browser");
    expect(m.locality).toBe("local");
    const none = { models: catalog.models.filter((x: ModelDescriptor) => x.id !== m.id), preferences: {} };
    expect(pickDecisionModel(none)?.id).not.toBe(m.id);
    expect(pickDecisionModel({ models: [], preferences: {} })).toBeUndefined();
  });

  it("PD1.2 it loads when asked, not before; until it is ready the lexical judge decides alone, then the model decides first and the lexical judge stands behind it", async () => {
    const e = ensemble();
    const changes: string[] = [];
    const m = new DecisionModel({ model: { id: "org/decider", name: "Decider", downloadBytes: bytes(614_135_099) }, ensemble: e, onChange: () => changes.push(m.status()) });
    expect([m.status(), m.phase(), m.name]).toEqual(["Decider: not downloaded (614 MB, once; kept in this browser): /decide model loads it", "idle", "Decider (org/decider)"]);
    expect(m.deciders("model", lexical)).toEqual([lexical]);
    m.load();
    m.load();
    expect(e.asked).toBe(1);
    expect(m.status()).toBe("Decider: loading (614 MB, once; kept in this browser)");
    e.settle().resolve(judge);
    await tick();
    expect([m.status(), m.phase()]).toEqual(["Decider: ready", "ready"]);
    const [first, second] = m.deciders("model", lexical);
    expect([first!.judge, first!.lexical, second]).toEqual([judge, false, lexical]);
    expect(m.deciders("lexical", lexical)).toEqual([lexical]);
    expect(changes).toEqual(["Decider: loading (614 MB, once; kept in this browser)", "Decider: ready"]);
  });

  it("PD1.3 a model that cannot load says why, and the lexical judge keeps deciding", async () => {
    const e = ensemble();
    const m = new DecisionModel({ model: { id: "org/decider", name: "Decider", downloadBytes: bytes(1) }, ensemble: e, onChange: () => {} });
    m.load();
    e.settle().reject(new Error("GET https://huggingface.co/... failed: TypeError: Failed to fetch"));
    await tick();
    expect([m.status(), m.phase()]).toEqual(["Decider: could not load (GET https://huggingface.co/... failed: TypeError: Failed to fetch); the lexical judge decides", "failed"]);
    expect(m.deciders("model", lexical)).toEqual([lexical]);
    // Asked again (/decide model), it tries again.
    m.load();
    expect(e.asked).toBe(2);
    e.settle().resolve(judge);
    await tick();
    expect(m.phase()).toBe("ready");
  });

  it("PD1.5 files the browser would not keep are said, and so is the last decision it left to the lexical judge", async () => {
    const e = ensemble();
    const m = new DecisionModel({ model: { id: "org/decider", name: "Decider", downloadBytes: bytes(614_135_099) }, ensemble: e, onChange: () => {}, notKept: "QuotaExceededError" });
    expect(m.status()).toBe("Decider: not kept in this browser last time (QuotaExceededError): /decide model downloads it again (614 MB)");
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

  it("PD1.4 a page whose catalog has no such model says so, and never loads", () => {
    const m = new DecisionModel({ model: undefined, ensemble: ensemble(), onChange: () => {} });
    m.load();
    expect([m.status(), m.phase(), m.name]).toEqual(["none for a browser in the catalog; the lexical judge decides", "none", undefined]);
    expect(m.deciders("model", lexical)).toEqual([lexical]);
  });
});
