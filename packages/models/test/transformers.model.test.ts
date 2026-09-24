import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cosine, MODEL_CATALOG } from "@harness/cognitive";
import type { GenerationEvent, ImageInput, ModelDescriptor } from "@harness/cognitive";
import {
  EmbeddingGemmaEmbedder,
  LinguaCompressor,
  loadEmbeddingGemmaBackend,
  loadLinguaBackend,
  loadVisionChatBackend,
  VisionChatDocumentParser,
  VisionChatGenerator,
} from "@harness/models";
import { compressorContract, documentParserContract, embedderContract, generatorContract } from "@harness/testkit";

const cacheDir = join(process.env["HARNESS_MODEL_CACHE"] ?? join(homedir(), ".cache", "harness", "models"), "transformers");
const pinned = (id: string) => {
  const m = MODEL_CATALOG.find((x) => x.id === id) as ModelDescriptor;
  return { repo: m.artifact!.repo, revision: m.artifact!.revision, cacheDir };
};
const once = <T>(make: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= make());
};
async function collect(stream: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}
const textOf = (events: readonly GenerationEvent[]) => events.map((e) => (e.type === "text" ? e.text : "")).join("");
async function png(svg: string): Promise<ImageInput> {
  return { mediaType: "image/png", data: new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer()) };
}

// ---- EmbeddingGemma ----------------------------------------------------------------------
const gemma = once(async () => new EmbeddingGemmaEmbedder(await loadEmbeddingGemmaBackend({ ...pinned("google/embeddinggemma-300m"), dtype: "q4" })));

describe("EmbeddingGemma 300M, real weights", () => {
  it("EM1.1 ranks the relevant document first for a query", async () => {
    const [q, mars, bananas, rust] = await (await gemma()).embed([
      { kind: "query", text: "Which planet is known as the red planet?" },
      { kind: "document", text: "Mars appears red because of iron oxide on its surface." },
      { kind: "document", text: "Bananas are rich in potassium." },
      { kind: "document", text: "Rust is a systems programming language." },
    ]);
    const sims = [mars!, bananas!, rust!].map((d) => cosine(q!, d));
    expect(sims.indexOf(Math.max(...sims))).toBe(0);
  });
});
embedderContract("EmbeddingGemma 300M, real weights", gemma, { sizes: [512, 256, 128] });

// ---- LLMLingua-2 -----------------------------------------------------------------------------
const lingua = once(async () => new LinguaCompressor(await loadLinguaBackend({ ...pinned("microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"), dtype: "uint8" })));

describe("LLMLingua-2 (mBERT), real weights", () => {
  it("LM1.1 halves a meeting note while keeping its key facts", async () => {
    const r = await (await lingua()).compress({
      text: "Um, so, basically, the thing is that the quarterly budget review has been moved, you know, from Tuesday to Thursday at 3pm, and, uh, Sarah will be presenting the updated hiring plan for the payments team.",
      rate: 0.5,
    });
    expect(r.compressedTokens).toBeLessThanOrEqual(Math.ceil(r.originalTokens * 0.6));
    for (const fact of ["budget", "Thursday", "Sarah", "hiring"]) expect(r.text).toContain(fact);
  });
});
compressorContract("LLMLingua-2 (mBERT), real weights", lingua);

// ---- Qwen3.5 0.8B (the browser LLM, here on onnxruntime-node) ---------------------------------
const qwenBackend = once(() =>
  loadVisionChatBackend({
    ...pinned("Qwen/Qwen3.5-0.8B"),
    modelClass: "Qwen3_5ForConditionalGeneration",
    dtype: { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" },
    templateOptions: { enable_thinking: false },
  }),
);
const qwen = once(async () => new VisionChatGenerator(await qwenBackend(), { maxTokens: 96 }));

describe("Qwen3.5 0.8B, real weights", () => {
  it("QM1.1 answers a factual question", async () => {
    expect(textOf(await collect((await qwen()).generate({ messages: [{ role: "user", content: "What is the capital of France? Answer in one word." }] })))).toMatch(/Paris/);
  });

  it("QM1.2 calls the offered tool with the argument from the request", async () => {
    const events = await collect(
      (await qwen()).generate({
        messages: [{ role: "user", content: "What's the weather in Lagos?" }],
        tools: [{ name: "get_weather", description: "Get the weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
      }),
    );
    expect(events.filter((e) => e.type === "tool-call")).toEqual([{ type: "tool-call", call: { name: "get_weather", arguments: { city: "Lagos" } } }]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });

  it("QM1.3 sees an image", async () => {
    const red = await png(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="100%" height="100%" fill="#e00000"/></svg>`);
    const events = await collect((await qwen()).generate({ messages: [{ role: "user", content: [{ type: "image", image: red }, { type: "text", text: "What color fills this image? Answer in one word." }] }] }));
    expect(textOf(events).toLowerCase()).toMatch(/red/);
  });
});
generatorContract("Qwen3.5 0.8B, real weights", qwen);

// ---- LightOnOCR-2 1B -----------------------------------------------------------------------------
const invoice = () =>
  png(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="100%" height="100%" fill="white"/>
  <text x="60" y="90" font-family="DejaVu Sans" font-size="44" font-weight="bold">Invoice 4521</text>
  <text x="60" y="150" font-family="DejaVu Sans" font-size="26">Acme Corporation, 12 Harbour Street</text>
  <g font-family="DejaVu Sans" font-size="26">
    <line x1="60" y1="220" x2="940" y2="220" stroke="black"/><text x="70" y="260">Item</text><text x="600" y="260">Qty</text><text x="780" y="260">Price</text>
    <line x1="60" y1="280" x2="940" y2="280" stroke="black"/><text x="70" y="320">Widget</text><text x="600" y="320">3</text><text x="780" y="320">30.00</text>
    <text x="70" y="370">Gadget</text><text x="600" y="370">1</text><text x="780" y="370">45.50</text>
    <line x1="60" y1="390" x2="940" y2="390" stroke="black"/><text x="70" y="440">Total</text><text x="780" y="440">75.50</text>
  </g></svg>`);
const lighton = once(
  async () =>
    new VisionChatDocumentParser(
      await loadVisionChatBackend({
        ...pinned("lightonai/LightOnOCR-2-1B"),
        modelClass: "LightOnOcrForConditionalGeneration",
        dtype: { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" },
        imagesFirst: true,
      }),
      { maxTokens: 512 },
    ),
);

describe("LightOnOCR-2 1B, real weights", () => {
  it("DM1.1 reads a rendered invoice into Markdown with its text and numbers", async () => {
    const { pages } = await (await lighton()).parse({ pages: [await invoice()] });
    const md = pages[0]!.markdown;
    for (const s of ["Invoice 4521", "Acme", "Widget", "Gadget", "45.50", "75.50"]) expect(md).toContain(s);
  });
});
documentParserContract("LightOnOCR-2 1B, real weights", lighton, invoice);
