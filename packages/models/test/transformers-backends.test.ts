import { describe, expect, it } from "vitest";
import { applyImageProcessorDefaults, loadChatTokenizer } from "@harness/models";

describe("transformers.js image processor defaults", () => {
  it("TB1.1 a config with mean/std but no do_normalize gets Python's default of normalizing", () => {
    // A preprocessor_config.json may omit do_normalize; Python defaults it to true,
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

import { loadFeatureExtractionBackend, loadTokenClassificationBackend, loadVisionChatBackend } from "@harness/models";
import { fakeTransformers } from "./fake-transformers.ts";

describe("transformers.js backends", () => {
  it("TB2.1 the embedding backend loads the pinned revision and returns one Float32Array per text", async () => {
    const { module, log } = fakeTransformers();
    const b = await loadFeatureExtractionBackend({ repo: "r/emb", revision: "abc", module, cacheDir: "/cache", dtype: "q4" });
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

  it("TB2.2 the token-classification backend wraps each window in CLS/SEP and returns the keep label's softmax per token", async () => {
    const { module, log } = fakeTransformers();
    const b = await loadTokenClassificationBackend({ repo: "r/classifier", revision: "abc", module, device: "cpu", dtype: "uint8", keepLabel: 1 });
    expect(b.tokenize("one two three")).toEqual(["one", "two", "three"]);
    const probs = await b.keepProbabilities(["one", "three"]);
    expect(log.find((l) => l.name === "classify")!.args[0]).toEqual([101, 3, 5, 102]);
    // positions 1..2 have logits [0, 0] and [0, 1]
    expect(probs[0]).toBeCloseTo(0.5, 9);
    expect(probs[1]).toBeCloseTo(1 / (1 + Math.exp(-1)), 9);
    expect(probs).toHaveLength(2);
    // the other label, as keep: its softmax is the complement
    const inverse = await loadTokenClassificationBackend({ repo: "r/classifier", revision: "abc", module, dtype: "uint8", keepLabel: 0 });
    expect((await inverse.keepProbabilities(["one", "three"]))[1]).toBeCloseTo(1 - 1 / (1 + Math.exp(-1)), 9);
  });

  it("TB2.3 the vision chat backend fixes the image defaults, templates tools and streams the reply", async () => {
    const { module, log, processor } = fakeTransformers();
    const b = await loadVisionChatBackend({ repo: "r/vision", revision: "abc", module, modelClass: "AcmeVisionForConditionalGeneration", dtype: { decoder: "q4" }, templateOptions: { enable_thinking: false } });
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
    const ocr = await loadVisionChatBackend({ repo: "r/ocr", revision: "abc", module, modelClass: "PixtralLikeForConditionalGeneration", dtype: {}, imagesFirst: true });
    const img = { mediaType: "image/png", data: new Uint8Array([1]) };
    await ocr.generate({ messages: [], images: [img, img], tools: [], maxTokens: 5 }, () => {}, () => false);
    expect(log.filter((l) => l.name === "processor")[0]!.args).toEqual([[{ image: "image/png" }, { image: "image/png" }], "PROMPT"]);
    await ocr.generate({ messages: [], images: [], tools: [], maxTokens: 5 }, () => {}, () => false);
    expect(log.filter((l) => l.name === "processor")[1]!.args).toEqual(["PROMPT"]);
  });

  it("TB2.7 a constrained request masks the logits of every step, accepting each generated token; the vocabulary comes from the tokenizer", async () => {
    const { module, log } = fakeTransformers({ generated: ["a", "b", "!"] });
    const vocabularies: unknown[] = [];
    const accepted: number[] = [];
    let disposed = 0;
    const constrainer = async (v: unknown) => (
      vocabularies.push(v),
      async () => ({ mask: (l: Float32Array) => l.forEach((_, i) => (l[i] = i === [1, 2, 0][accepted.length] ? 1 : -Infinity)), accept: (id: number) => (accepted.push(id), true), forced: () => "", done: false, dispose: () => void disposed++ })
    );
    const b = await loadVisionChatBackend({ repo: "r/vision", revision: "abc", module, modelClass: "AcmeVisionForConditionalGeneration", dtype: "q4", constrainer });
    expect(vocabularies).toEqual([{ tokens: ["<eos>", "a", "b", "", "<pad>"], stopTokens: [0] }]);
    await b.generate({ messages: [], images: [], tools: [], maxTokens: 5, constraint: { type: "regex", pattern: "ab" } }, () => {}, () => false);
    expect(log.filter((l) => l.name === "step").map((l) => l.args[1])).toEqual([1, 2, 0]);
    expect(accepted).toEqual([1, 2]);
    expect(disposed).toBe(1);
    // unconstrained requests pass no processor
    await b.generate({ messages: [], images: [], tools: [], maxTokens: 5 }, () => {}, () => false);
    expect(log.filter((l) => l.name === "step").slice(3).map((l) => (l.args[0] as number[]).every((x) => x === 1))).toEqual([true, true, true]);
  });

  it("TB2.6 a model class transformers.js does not have is an error", async () => {
    await expect(loadVisionChatBackend({ repo: "r/vision", revision: "abc", module: fakeTransformers().module, modelClass: "NoSuchModel", dtype: "q4" })).rejects.toThrow("transformers.js has no model class NoSuchModel");
  });

  it("TB2.5 stopping interrupts generation; reaching the token budget reports hitLimit; calls never overlap", async () => {
    const { module } = fakeTransformers({ generated: ["a", "b", "c", "d"] });
    const b = await loadVisionChatBackend({ repo: "r/vision", revision: "abc", module, modelClass: "AcmeVisionForConditionalGeneration", dtype: {} });
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
    const get_vocab = () => new Map(Object.entries(vocab));
    const tokenizer = {
      apply_chat_template: (messages: unknown, o: unknown) => (log.push({ name: "template", args: [messages, o] }), "PROMPT"),
      encode: (text: string, o: unknown) => (log.push({ name: "encode", args: [text, o] }), [1, 2, 3]),
      decode: (ids: number[], o: unknown) => (log.push({ name: "decode", args: [ids, o] }), ids.join(",")),
      convert_tokens_to_ids: (tokens: string[]) => tokens.map((t) => vocab[t] ?? 0),
      get_vocab,
    };
    const module = {
      env: {} as Record<string, unknown>,
      AutoTokenizer: { from_pretrained: async (repo: string, o: unknown) => (log.push({ name: "load", args: [repo, o] }), tokenizer) },
    };
    return { module, log };
  }

  it("TB3.1 loads the pinned tokenizer, templates messages and tools, and encodes without adding special tokens", async () => {
    const { module, log } = fakeTokenizerModule();
    const tok = await loadChatTokenizer({ repo: "org/m", revision: "abc", subfolder: "cpu", module, endTokens: ["<|im_end|>", "<|endoftext|>"], templateOptions: { enable_thinking: false } });
    const tools = [{ name: "search", description: "find", parameters: { type: "object" } }];
    const ids = tok.encodeChat(
      [
        { role: "system", content: [{ type: "text", text: "be brief" }] },
        { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
        { role: "assistant", content: [], tool_calls: [{ type: "function", function: { name: "search", arguments: { q: "x" } } }] },
        { role: "tool", name: "search", content: [{ type: "text", text: "found" }] },
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

  it("TB3.3 the chat tokenizer encodes plain text without special tokens and lists its vocabulary in id order", async () => {
    const { module, log } = fakeTokenizerModule();
    const tok = await loadChatTokenizer({ repo: "org/m", revision: "abc", module, endTokens: ["<eos>"] });
    expect(tok.encodeText!("hi")).toEqual([1, 2, 3]);
    expect(log.at(-1)).toEqual({ name: "encode", args: ["hi", { add_special_tokens: false }] });
    expect(tok.vocabulary!().slice(7)).toEqual(["<|im_end|>", "<|endoftext|>", "<eos>"]);
  });

  it("TB3.2 end tokens are the ones named; without tools none are templated; images are refused", async () => {
    const { module, log } = fakeTokenizerModule();
    const tok = await loadChatTokenizer({ repo: "org/m", revision: "abc", module, endTokens: ["<eos>"] });
    expect(tok.endTokens).toEqual([9]);
    tok.encodeChat([{ role: "user", content: [{ type: "text", text: "hi" }] }], []);
    expect(log[0]).toEqual({ name: "load", args: ["org/m", { revision: "abc" }] });
    expect(log[1]!.args[1]).toEqual({ tokenize: false, add_generation_prompt: true });
    expect(() => tok.encodeChat([{ role: "user", content: [{ type: "text", text: "see" }, { type: "image" }] }])).toThrow(/text only/);
    await expect(loadChatTokenizer({ repo: "org/m", revision: "abc", module, endTokens: ["<nope>"] })).rejects.toThrow(/<nope>/);
  });
});
