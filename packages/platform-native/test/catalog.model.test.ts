import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { cosineSimilarity, embedMany, generateText, streamText } from "ai";
import { constrain, embedding, readTemplate, route, toolSet } from "@harness/cognitive";
import type { ImageInput, ModelDescriptor, PortKind, PortMap, TaskCategory, ToolSpec } from "@harness/cognitive";
import { buildNativeEnsemble, loadCatalog } from "@harness/platform-native";
import { compressorContract, documentParserContract, embedderContract, generatorContract, routerContract } from "@harness/testkit";
import { modelCacheDir } from "./models-env.ts";

// Every catalog model that runs natively, on real weights, loaded by the host exactly
// as in production (pinned, sha256-verified, cached under HARNESS_MODEL_CACHE). What is
// checked follows from the model's category, its ports and tasks, never its name, so a
// model swapped into the catalog is held to the same bar. llama.cpp-server models need
// LLAMA_SERVER (CI downloads the release); without it their tests fail, not pass.
// Judges are checked by the evals, and the steerable kernel by steered.model.test.ts.

const models = [...loadCatalog().models, ...loadCatalog({ package: "@harness/memory" }).models].filter(
  (m) => m.platforms.includes("native") && m.locality === "local" && !m.ports.includes("judge") && !m.tasks.includes("steered-chat"),
);
const hosts: ReturnType<typeof buildNativeEnsemble>[] = [];
afterAll(async () => {
  await Promise.all(hosts.map((h) => h.close()));
});

/** The model's port for a task, loaded once per model through the native host. */
function port<K extends PortKind>(m: ModelDescriptor, task: TaskCategory, kind: K): () => Promise<PortMap[K]> {
  let host: ReturnType<typeof buildNativeEnsemble> | undefined;
  return async () => {
    if (m.runtime === "llama.cpp-server" && !process.env["LLAMA_SERVER"]) throw new Error("LLAMA_SERVER is not set: point it at a llama.cpp llama-server binary");
    if (!host) {
      host = buildNativeEnsemble({ cacheDir: modelCacheDir, allowHosted: false, catalog: { models: [m], preferences: {} }, ...(process.env["LLAMA_SERVER"] ? { llamaServer: process.env["LLAMA_SERVER"] } : {}) });
      hosts.push(host);
    }
    return (await host.ensemble.resolve(task, kind)).port;
  };
}

async function png(svg: string): Promise<ImageInput> {
  return { mediaType: "image/png", data: new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer()) };
}
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
const tools: ToolSpec[] = [
  { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "set_timer", description: "Start a countdown timer.", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } },
];

for (const m of models) {
  const label = `${m.id} (${m.runtime}), real weights`;

  if (m.ports.includes("router")) {
    const router = port(m, "tool-calling", "router");
    describe(`tool router ${label}`, () => {
      it("RW1.1 routes a request to the right tool with its argument", async () => {
        const r = await route(await router(), { input: "what's it like in Lagos right now?", tools });
        expect(r.valid).toEqual([{ name: "get_weather", arguments: { city: "Lagos" } }]);
        expect(r.problems).toEqual([]);
        expect(r.confidence).toBeGreaterThan(0.8);
      });

      it("RW1.2 two requests in one sentence give two calls in order", async () => {
        const r = await route(await router(), { input: "set a timer for 5 minutes and tell me the weather in Paris", tools });
        expect(r.valid).toEqual([
          { name: "set_timer", arguments: { minutes: 5 } },
          { name: "get_weather", arguments: { city: "Paris" } },
        ]);
      });

      it("RW1.3 a request no tool covers gets no calls", async () => {
        expect((await route(await router(), { input: "write me a poem about cats", tools })).valid).toEqual([]);
      });
    });
    routerContract(label, router);
  }

  if (m.embedding) {
    const embedder = port(m, "text-embedding", "embedder");
    describe(`embedder ${label}`, () => {
      it("RW2.1 ranks the relevant document first for a query", async () => {
        const model = await embedder();
        const {
          embeddings: [q],
        } = await embedMany({ model, values: ["Which planet is known as the red planet?"], maxRetries: 0, ...embedding({ kind: "query" }) });
        const { embeddings: documents } = await embedMany({
          model,
          values: ["Mars appears red because of iron oxide on its surface.", "Bananas are rich in potassium.", "Rust is a systems programming language."],
          maxRetries: 0,
          ...embedding({ kind: "document" }),
        });
        const sims = documents.map((d) => cosineSimilarity(q!, d));
        expect(sims.indexOf(Math.max(...sims))).toBe(0);
      });
    });
    embedderContract(label, embedder, { size: m.embedding.dimensions[0]!, sizes: m.embedding.dimensions.slice(1) });
  }

  if (m.compression) {
    const compressor = port(m, "prompt-compression", "compressor");
    describe(`compressor ${label}`, () => {
      it("RW3.1 halves a meeting note while keeping its key facts", async () => {
        const r = await (await compressor()).compress({
          text: "Um, so, basically, the thing is that the quarterly budget review has been moved, you know, from Tuesday to Thursday at 3pm, and, uh, Sarah will be presenting the updated hiring plan for the payments team.",
          rate: 0.5,
        });
        expect(r.compressedTokens).toBeLessThanOrEqual(Math.ceil(r.originalTokens * 0.6));
        for (const fact of ["budget", "Thursday", "Sarah", "hiring"]) expect(r.text).toContain(fact);
      });
    });
    compressorContract(label, compressor);
  }

  if (m.ports.includes("generator") && m.tasks.includes("chat")) {
    const generator = port(m, "chat", "generator");
    describe(`chat model ${label}`, () => {
      it("RW4.1 answers a factual question", async () => {
        const { text } = await generateText({ model: await generator(), prompt: "What is the capital of France? Answer in one word.", maxRetries: 0 });
        expect(text).toMatch(/Paris/);
      });

      it.runIf(m.tasks.includes("tool-calling"))("RW4.2 calls the offered tool with the argument from the request", async () => {
        const result = streamText({ model: await generator(), prompt: "What's the weather in Lagos? Use the tool.", tools: toolSet([tools[0]!]), maxOutputTokens: 1024, maxRetries: 0 });
        expect((await result.toolCalls).map((c) => ({ name: c.toolName, arguments: c.input, invalid: c.invalid === true }))).toEqual([{ name: "get_weather", arguments: { city: "Lagos" }, invalid: false }]);
        expect(await result.finishReason).toBe("tool-calls");
      });

      it.runIf(m.constraints?.includes("json-schema") === true)("RW4.4 under a JSON Schema constraint the answer is JSON that matches it", async () => {
        const schema = { type: "object", properties: { city: { type: "string" }, population_millions: { type: "number" } }, required: ["city", "population_millions"], additionalProperties: false };
        const { text } = await generateText({ model: await generator(), prompt: "Name the largest city in Japan and its population in millions, as JSON.", maxOutputTokens: 64, maxRetries: 0, ...constrain({ type: "json-schema", schema }) });
        const value = JSON.parse(text) as { city: string; population_millions: number };
        expect(Object.keys(value).sort()).toEqual(["city", "population_millions"]);
        expect(value.city).toMatch(/Tokyo/i);
        expect(typeof value.population_millions).toBe("number");
      });

      it.runIf(m.constraints?.includes("template") === true)("RW4.5 under a template the answer is the template with the holes filled", async () => {
        const template = { type: "template" as const, parts: ["Capital: ", { hole: "capital", constraint: { type: "regex" as const, pattern: "[A-Z][a-z]+" } }, "\nCountry: France\n"] };
        const { text } = await generateText({ model: await generator(), prompt: "What is the capital of France?", maxOutputTokens: 32, maxRetries: 0, ...constrain(template) });
        expect(readTemplate(template, text)).toEqual({ capital: "Paris" });
      });

      it.runIf(m.tasks.includes("vision-qa"))("RW4.3 sees an image", async () => {
        const red = await png(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="100%" height="100%" fill="#e00000"/></svg>`);
        const { text } = await generateText({
          model: await generator(),
          maxRetries: 0,
          messages: [{ role: "user", content: [{ type: "file", data: red.data, mediaType: red.mediaType }, { type: "text", text: "What color fills this image? Answer in one word." }] }],
        });
        expect(text.toLowerCase()).toMatch(/red/);
      });
    });
    generatorContract(label, generator);
  }

  if (m.ports.includes("document-parser")) {
    const parser = port(m, "document-parsing", "document-parser");
    describe(`document parser ${label}`, () => {
      it("RW5.1 reads a rendered invoice into Markdown with its text and numbers", async () => {
        const page = await invoice();
        const { text } = await generateText({ model: await parser(), maxOutputTokens: 4096, maxRetries: 0, messages: [{ role: "user", content: [{ type: "file", data: page.data, mediaType: page.mediaType }] }] });
        for (const s of ["Invoice 4521", "Acme", "Widget", "Gadget", "45.50", "75.50"]) expect(text).toContain(s);
      });
    });
    documentParserContract(label, parser, invoice);
  }
}
