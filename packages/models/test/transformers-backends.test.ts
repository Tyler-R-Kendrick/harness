import { describe, expect, it } from "vitest";
import { applyImageProcessorDefaults, loadChatTokenizer } from "@harness/models";

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

describe("transformers.js chat tokenizer (for steered generation)", () => {
  function fakeTokenizerModule() {
    const log: { name: string; args: unknown[] }[] = [];
    const vocab: Record<string, number> = { "<|im_end|>": 7, "<|endoftext|>": 8, "<eos>": 9 };
    const tokenizer = {
      apply_chat_template: (messages: unknown, o: unknown) => (log.push({ name: "template", args: [messages, o] }), "PROMPT"),
      encode: (text: string, o: unknown) => (log.push({ name: "encode", args: [text, o] }), [1, 2, 3]),
      decode: (ids: number[], o: unknown) => (log.push({ name: "decode", args: [ids, o] }), ids.join(",")),
      convert_tokens_to_ids: (tokens: string[]) => tokens.map((t) => vocab[t] ?? 0),
    };
    const module = {
      env: {} as Record<string, unknown>,
      AutoTokenizer: { from_pretrained: async (repo: string, o: unknown) => (log.push({ name: "load", args: [repo, o] }), tokenizer) },
    };
    return { module, log };
  }

  it("TB3.1 loads the pinned tokenizer, templates messages and tools, and encodes without adding special tokens", async () => {
    const { module, log } = fakeTokenizerModule();
    const tok = await loadChatTokenizer({ repo: "org/m", revision: "abc", subfolder: "cpu", module, templateOptions: { enable_thinking: false } });
    const tools = [{ name: "search", description: "find", parameters: { type: "object" } }];
    const ids = tok.encodeChat(
      [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
        { role: "assistant", content: "", toolCalls: [{ name: "search", arguments: { q: "x" } }] },
        { role: "tool", name: "search", content: "found" },
      ],
      tools,
    );
    expect(ids).toEqual([1, 2, 3]);
    expect(log[0]).toEqual({ name: "load", args: ["org/m", { revision: "abc", subfolder: "cpu" }] });
    expect(log[1]).toEqual({
      name: "template",
      args: [
        [
          { role: "system", content: "be brief" },
          { role: "user", content: "ab" },
          { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name: "search", arguments: { q: "x" } } }] },
          { role: "tool", name: "search", content: "found" },
        ],
        { tokenize: false, add_generation_prompt: true, tools: [{ type: "function", function: tools[0] }], enable_thinking: false },
      ],
    });
    expect(log[2]).toEqual({ name: "encode", args: ["PROMPT", { add_special_tokens: false }] });
    expect(tok.decode([4, 5])).toBe("4,5");
    expect(log[3]).toEqual({ name: "decode", args: [[4, 5], { skip_special_tokens: false }] });
    expect(tok.endTokens).toEqual([7, 8]);
  });

  it("TB3.2 end tokens can be named; without tools none are templated; images are refused", async () => {
    const { module, log } = fakeTokenizerModule();
    const tok = await loadChatTokenizer({ repo: "org/m", revision: "abc", module, endTokens: ["<eos>"] });
    expect(tok.endTokens).toEqual([9]);
    tok.encodeChat([{ role: "user", content: "hi" }]);
    expect(log[0]).toEqual({ name: "load", args: ["org/m", { revision: "abc" }] });
    expect(log[1]!.args[1]).toEqual({ tokenize: false, add_generation_prompt: true });
    expect(() => tok.encodeChat([{ role: "user", content: [{ type: "image", image: { mediaType: "image/png", data: new Uint8Array() } }] }])).toThrow(/text only/);
    await expect(loadChatTokenizer({ repo: "org/m", revision: "abc", module, endTokens: ["<nope>"] })).rejects.toThrow(/<nope>/);
  });
});
