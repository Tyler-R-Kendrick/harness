import { describe, expect, it } from "vitest";
import { applyImageProcessorDefaults } from "@harness/models";

describe("transformers.js image processor defaults", () => {
  it("TB1.1 a config with mean/std but no do_normalize gets Python's default of normalizing", () => {
    // Qwen3.5's preprocessor_config.json omits do_normalize; Python defaults it to true,
    // transformers.js 4.3.0 reads it as undefined and feeds unnormalized pixels (red looks pink).
    const ip: Record<string, unknown> = { image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5], do_normalize: undefined };
    applyImageProcessorDefaults(ip);
    expect(ip["do_normalize"]).toBe(true);
  });

  it("TB1.2 an explicit setting, or a processor without mean/std, is left alone", () => {
    const off: Record<string, unknown> = { image_mean: [0.5], image_std: [0.5], do_normalize: false };
    applyImageProcessorDefaults(off);
    expect(off["do_normalize"]).toBe(false);
    const none: Record<string, unknown> = {};
    applyImageProcessorDefaults(none);
    expect(none["do_normalize"]).toBeUndefined();
    applyImageProcessorDefaults(undefined);
  });
});

// ---- the backends against a fake transformers.js module --------------------------------------

import { loadEmbeddingGemmaBackend, loadLinguaBackend, loadVisionChatBackend } from "@harness/models";
import { fakeTransformers } from "./fake-transformers.ts";

describe("transformers.js backends", () => {
  it("TB2.1 the embedding backend loads the pinned revision and returns one Float32Array per text", async () => {
    const { module, log } = fakeTransformers();
    const b = await loadEmbeddingGemmaBackend({ repo: "r/emb", revision: "abc", module, cacheDir: "/cache" });
    const out = await b.embed(["a", "b"]);
    expect(out.map((v) => Array.from(v))).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(module.env["cacheDir"]).toBe("/cache");
    expect(log.find((l) => l.name === "model.load")!.args).toEqual(["r/emb", { revision: "abc", dtype: "q4" }]);
    expect(log.find((l) => l.name === "tokenizer")!.args[1]).toEqual({ padding: true, truncation: true });
  });

  it("TB2.2 the LLMLingua backend wraps each window in CLS/SEP and returns softmax P(keep) per token", async () => {
    const { module, log } = fakeTransformers();
    const b = await loadLinguaBackend({ repo: "r/lingua", revision: "abc", module, device: "cpu" });
    expect(b.tokenize("one two three")).toEqual(["one", "two", "three"]);
    const probs = await b.keepProbabilities(["one", "three"]);
    expect(log.find((l) => l.name === "classify")!.args[0]).toEqual([101, 3, 5, 102]);
    // positions 1..2 have logits [0, 0] and [0, 1]
    expect(probs[0]).toBeCloseTo(0.5, 9);
    expect(probs[1]).toBeCloseTo(1 / (1 + Math.exp(-1)), 9);
    expect(probs).toHaveLength(2);
  });

  it("TB2.3 the vision chat backend fixes the image defaults, templates tools and streams the reply", async () => {
    const { module, log, processor } = fakeTransformers();
    const b = await loadVisionChatBackend({ repo: "r/qwen", revision: "abc", module, modelClass: "Qwen3_5ForConditionalGeneration", dtype: { decoder: "q4" }, templateOptions: { enable_thinking: false } });
    expect(processor.image_processor["do_normalize"]).toBe(true);
    let text = "";
    const r = await b.generate(
      { messages: [{ role: "user", content: [{ type: "image" }] }], images: [{ mediaType: "image/png", data: new Uint8Array([1]) }], tools: [{ name: "t", description: "d", parameters: {} }], maxTokens: 10 },
      (d) => (text += d),
      () => false,
    );
    expect(text).toBe("Hello");
    expect(r).toEqual({ hitLimit: false });
    expect(log.find((l) => l.name === "template")!.args[1]).toEqual({ add_generation_prompt: true, tools: [{ type: "function", function: { name: "t", description: "d", parameters: {} } }], enable_thinking: false });
    expect(log.find((l) => l.name === "processor")!.args).toEqual(["PROMPT", { image: "image/png" }]);
  });

  it("TB2.4 Pixtral-style processors get images first; text-only prompts get text alone", async () => {
    const { module, log } = fakeTransformers();
    const ocr = await loadVisionChatBackend({ repo: "r/ocr", revision: "abc", module, modelClass: "LightOnOcrForConditionalGeneration", dtype: {}, imagesFirst: true });
    const img = { mediaType: "image/png", data: new Uint8Array([1]) };
    await ocr.generate({ messages: [], images: [img, img], tools: [], maxTokens: 5 }, () => {}, () => false);
    expect(log.filter((l) => l.name === "processor")[0]!.args).toEqual([[{ image: "image/png" }, { image: "image/png" }], "PROMPT"]);
    await ocr.generate({ messages: [], images: [], tools: [], maxTokens: 5 }, () => {}, () => false);
    expect(log.filter((l) => l.name === "processor")[1]!.args).toEqual(["PROMPT"]);
  });

  it("TB2.5 stopping interrupts generation; reaching the token budget reports hitLimit; calls never overlap", async () => {
    const { module } = fakeTransformers({ generated: ["a", "b", "c", "d"] });
    const b = await loadVisionChatBackend({ repo: "r/qwen", revision: "abc", module, modelClass: "Qwen3_5ForConditionalGeneration", dtype: {} });
    let seen = "";
    await b.generate({ messages: [], images: [], tools: [], maxTokens: 10 }, (d) => (seen += d), () => seen.length >= 2);
    expect(seen).toBe("ab");
    const req = { messages: [], images: [], tools: [], maxTokens: 4 };
    const [x, y] = await Promise.all([b.generate(req, () => {}, () => false), b.generate(req, () => {}, () => false)]);
    expect(x).toEqual({ hitLimit: true });
    expect(y).toEqual({ hitLimit: true });
  });
});
