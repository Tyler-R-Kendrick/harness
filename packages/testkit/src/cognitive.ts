import { describe, expect, it } from "vitest";
import type { EmbeddingModelV4, Experimental_EvaluationModelV4CallOptions as EvaluationModelV4CallOptions, LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { embedMany, experimental_evaluate, generateText, streamText } from "ai";
import { convertArrayToReadableStream, Experimental_EvaluationMockModelV4, MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { ChatStreamParser, collectParts, compressWords, embedding, embedInputs, HARNESS, StreamParts, toolSet, usage } from "@harness/cognitive";
import type { Compression, CompressRequest, Compressor, EvaluationModelV4, ImageInput, JudgeAnswer, JudgeQuestion, ToolSpec } from "@harness/cognitive";

// ---- deterministic fakes, as AI SDK models --------------------------------------------

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The text of a prompt's last user message. */
export function promptText(prompt: LanguageModelV4Prompt): string {
  const last = [...prompt].reverse().find((m) => m.role === "user");
  return last?.role === "user" ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("") : "";
}

/** A feature-hashing embedding model: texts sharing words get similar unit vectors. Reads the size wanted from our embedding options. */
export function hashEmbeddingModel(size = 64): EmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    modelId: `hash-${size}`,
    maxEmbeddingsPerCall: null,
    doEmbed: async ({ values, providerOptions }) => {
      const wanted = embedInputs(values, providerOptions).dimensions ?? size;
      const embeddings = values.map((text) => {
        const v = new Array<number>(wanted).fill(0);
        for (const w of words(text)) {
          const h = hash(w);
          v[h % wanted]! += h & 1 ? 1 : -1;
        }
        let norm = Math.hypot(...v);
        if (norm === 0) {
          v[0] = 1;
          norm = 1;
        }
        return v.map((x) => x / norm);
      });
      return { embeddings, warnings: [] };
    },
  });
}

/** A tool router model: calls the offered tool sharing the most words with the request, with a confidence in provider metadata. */
export function keywordRouterModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "keyword-router",
    doGenerate: async (options) => {
      const said = new Set(words(promptText(options.prompt)));
      const tools = (options.tools ?? []).flatMap((t) => (t.type === "function" ? [t] : []));
      const best = tools.map((t) => ({ t, score: words(`${t.name.replace(/_/g, " ")} ${t.description ?? ""}`).filter((w) => said.has(w)).length })).sort((a, b) => b.score - a.score)[0];
      const confidence = !best || best.score === 0 ? 0.9 : Math.min(0.99, 0.5 + 0.2 * best.score);
      const reasoning = !best || best.score === 0 ? "no tool shares a word with the request" : `matched ${best.score} word(s)`;
      return {
        content: [{ type: "reasoning", text: reasoning }, ...(best && best.score > 0 ? [{ type: "tool-call" as const, toolCallId: "call_0", toolName: best.t.name, input: "{}" }] : [])],
        finishReason: { unified: best && best.score > 0 ? "tool-calls" : "stop", raw: undefined },
        usage: usage(),
        providerMetadata: { [HARNESS]: { confidence } },
        warnings: [],
      };
    },
  });
}

/** Parts for a raw ChatML reply, parsed by the real parser a few characters at a time. */
function replyParts(raw: string, chunk: number): LanguageModelV4StreamPart[] {
  const parser = new ChatStreamParser();
  const parts = new StreamParts();
  const out: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  for (let i = 0; i < raw.length; i += chunk) for (const e of parser.push(raw.slice(i, i + chunk))) out.push(...parts.push(e));
  for (const e of parser.end()) out.push(...parts.push(e));
  return [...out, ...parts.end()];
}

/** A generator model that streams a scripted raw ChatML reply (think, tool_call and all) through the real parser. */
export function scriptedModel(reply: (options: LanguageModelV4CallOptions) => string, chunk = 3): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "scripted",
    doStream: async (options) => ({ stream: convertArrayToReadableStream(replyParts(reply(options), chunk)) }),
    doGenerate: async (options) => collectParts(replyParts(reply(options), chunk)),
  });
}

function defaultAnswer(q: JudgeQuestion): JudgeAnswer {
  if (q.type === "boolean") return { type: "boolean", probability: 0.5 } as JudgeAnswer;
  if (q.type === "choice") {
    const options = Object.keys(q.criteria);
    return { type: "choice", choice: options[0]!, probabilities: Object.fromEntries(options.map((o) => [o, 1 / options.length])) } as JudgeAnswer;
  }
  return { type: "score", score: (q.criteria.length - 1) / 2 };
}

/** A judge answering every question with `answer`, or a neutral default. Records the calls it gets. */
export function scriptedJudge(answer: (id: string, q: JudgeQuestion, state: unknown) => { type: string } | undefined = () => undefined): Experimental_EvaluationMockModelV4 & { readonly requests: EvaluationModelV4CallOptions[] } {
  const requests: EvaluationModelV4CallOptions[] = [];
  const model = new Experimental_EvaluationMockModelV4({
    modelId: "scripted-judge",
    doEvaluate: async (options) => {
      requests.push(options);
      return {
        answers: Object.fromEntries(Object.entries(options.questions).map(([id, q]) => [id, (answer(id, q as JudgeQuestion, options.state) ?? defaultAnswer(q as JudgeQuestion)) as never])),
        warnings: [],
      };
    },
  });
  return Object.assign(model, { requests });
}

const STOPWORDS = new Set(["a", "an", "the", "of", "to", "and", "or", "is", "are", "was", "in", "on", "at", "for", "that", "this", "it", "be", "with", "as", "by"]);

/** A token-classifier-shaped compressor that scores stopwords low: exercises the real word selection. */
export class HeuristicCompressor implements Compressor {
  async compress(request: CompressRequest): Promise<Compression> {
    const tokens = request.text.split(/\s+/).filter((w) => w !== "");
    const scored = tokens.map((w) => ({ text: w, keep: STOPWORDS.has(w.toLowerCase()) ? 0.1 : 0.6 + (hash(w) % 30) / 100, tokens: 1 }));
    const kept = compressWords(scored, { rate: request.rate, keepDigits: true, ...(request.forceTokens ? { forceTokens: request.forceTokens } : {}) });
    return { text: kept.map((w) => w.text).join(" "), originalTokens: tokens.length, compressedTokens: kept.length };
  }
}

/** A document parser model that describes each page image instead of reading it. */
export function stubDocumentParser(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: "stub-parser",
    doGenerate: async ({ prompt }) => {
      const files = prompt.flatMap((m) => (m.role === "user" ? m.content.filter((p) => p.type === "file") : []));
      const text = files.map((f) => `# Page\n\n${f.mediaType}`).join("\n\n") || "(no page)";
      return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] };
    },
  });
}

// ---- contract suites, driving models through the AI SDK -------------------------------

const TOOLS: ToolSpec[] = [
  { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "set_timer", description: "Start a countdown timer for some minutes.", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } },
];

export function judgeContract(label: string, make: () => EvaluationModelV4 | Promise<EvaluationModelV4>): void {
  describe(`Judge contract: ${label}`, () => {
    it("JC1 answers exactly the questions asked, each with its question's type and a value in range", async () => {
      const { answers } = await experimental_evaluate({
        model: await make(),
        maxRetries: 0,
        state: { request: "What is 17 + 25?", reply: "42" },
        questions: {
          correct: { type: "boolean", instructions: "Is `reply` the correct answer to `request`?" },
          topic: { type: "choice", instructions: "What is `request` about?", criteria: { math: "Arithmetic", history: null, cooking: null } },
          quality: { type: "score", instructions: "How complete is `reply`?", criteria: ["poor", "fair", "good"] },
        },
      });
      expect(Object.keys(answers).sort()).toEqual(["correct", "quality", "topic"]);
      expect(answers.correct.probability).toBeGreaterThanOrEqual(0);
      expect(answers.correct.probability).toBeLessThanOrEqual(1);
      expect(["math", "history", "cooking"]).toContain(answers.topic.choice);
      if (answers.topic.probabilities) {
        expect(Object.keys(answers.topic.probabilities).sort()).toEqual(["cooking", "history", "math"]);
        expect(Object.values(answers.topic.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
      }
      expect(answers.quality.score >= 0 && answers.quality.score <= 2).toBe(true);
    });
  });
}

/** A router is a language model that answers with tool calls and a calibrated confidence (provider metadata `harness.confidence`). */
export function routerContract(label: string, make: () => LanguageModelV4 | Promise<LanguageModelV4>): void {
  const route = async (model: LanguageModelV4, prompt: string, tools: readonly ToolSpec[]) => generateText({ model, prompt, tools: toolSet(tools), maxRetries: 0 });
  describe(`Router contract: ${label}`, () => {
    it("RC1 calls only offered tools, with object arguments and a confidence in [0, 1]", async () => {
      const r = await route(await make(), "What's the weather like in Lagos right now?", TOOLS);
      for (const c of r.toolCalls) {
        expect(TOOLS.map((t) => t.name)).toContain(c.toolName);
        expect(typeof c.input === "object" && c.input !== null && !Array.isArray(c.input)).toBe(true);
      }
      const confidence = r.providerMetadata?.[HARNESS]?.["confidence"];
      expect(typeof confidence === "number" && confidence >= 0 && confidence <= 1).toBe(true);
    });

    it("RC2 with no tools offered there is nothing to call", async () => {
      expect((await route(await make(), "What's the weather in Lagos?", [])).toolCalls).toEqual([]);
    });

    it("RC3 independent requests do not leak into each other", async () => {
      const calls = (r: Awaited<ReturnType<typeof route>>) => r.toolCalls.map((c) => [c.toolName, c.input]);
      const alone = await route(await make(), "Start a timer for 5 minutes.", TOOLS);
      const model = await make();
      await route(model, "What's the weather in Paris?", TOOLS);
      expect(calls(await route(model, "Start a timer for 5 minutes.", TOOLS))).toEqual(calls(alone));
    });
  });
}

export function embedderContract(label: string, make: () => EmbeddingModelV4 | Promise<EmbeddingModelV4>, options: { readonly size: number; readonly sizes?: readonly number[] }): void {
  const embed = async (model: EmbeddingModelV4, kind: "query" | "document", values: string[], dimensions?: number) =>
    (await embedMany({ model, values, maxRetries: 0, ...embedding({ kind, ...(dimensions === undefined ? {} : { dimensions: dimensions as never }) }) })).embeddings;
  describe(`Embedder contract: ${label}`, () => {
    it("EC1 returns one unit vector of the model's size per input, deterministically", async () => {
      const model = await make();
      const [a] = await embed(model, "query", ["which planet is red?"]);
      const [b] = await embed(model, "document", ["Mars is the red planet."]);
      for (const v of [a!, b!]) {
        expect(v.length).toBe(options.size);
        expect(Math.hypot(...v)).toBeCloseTo(1, 3);
      }
      const [again] = await embed(model, "query", ["which planet is red?"]);
      for (let i = 0; i < a!.length; i++) expect(again![i]).toBeCloseTo(a![i]!, 4);
    });

    it("EC2 a query is closer to a relevant document than to an unrelated one", async () => {
      const model = await make();
      const [q] = await embed(model, "query", ["Which planet is known as the red planet?"]);
      const [rel, other] = await embed(model, "document", ["Mars is often called the red planet.", "Bananas are a yellow fruit rich in potassium."]);
      const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
      expect(dot(q!, rel!)).toBeGreaterThan(dot(q!, other!));
    });

    for (const size of options.sizes ?? []) {
      it(`EC3 truncates to ${size} dimensions as unit vectors`, async () => {
        const [v] = await embed(await make(), "document", ["hello world"], size);
        expect(v!.length).toBe(size);
        expect(Math.hypot(...v!)).toBeCloseTo(1, 3);
      });
    }
  });
}

export function compressorContract(label: string, make: () => Compressor | Promise<Compressor>): void {
  const text =
    "The quarterly review meeting is scheduled for Thursday at 3pm in room 402. Please bring the budget report and the updated hiring plan, and be ready to discuss the delay on the payments project.";
  const norm = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const subsequence = (small: readonly string[], big: readonly string[]) => {
    let i = 0;
    for (const w of big) if (w === small[i]) i++;
    return i === small.length;
  };

  describe(`Compressor contract: ${label}`, () => {
    it("CC1 keeps fewer tokens, drawn from the original in the original order", async () => {
      const c = await make();
      const r = await c.compress({ text, rate: 0.5 });
      expect(r.compressedTokens).toBeLessThan(r.originalTokens);
      expect(r.text.length).toBeLessThan(text.length);
      expect(subsequence(norm(r.text), norm(text))).toBe(true);
    });

    it("CC2 rate 1 keeps every word", async () => {
      const c = await make();
      const r = await c.compress({ text, rate: 1 });
      expect(norm(r.text)).toEqual(norm(text));
    });

    it("CC3 forced tokens survive heavy compression", async () => {
      const c = await make();
      const r = await c.compress({ text, rate: 0.2, forceTokens: ["Thursday"] });
      expect(norm(r.text)).toContain("thursday");
    });
  });
}

export function generatorContract(label: string, make: () => LanguageModelV4 | Promise<LanguageModelV4>): void {
  describe(`Generator contract: ${label}`, () => {
    it("GC1 a simple prompt streams text and finishes", async () => {
      const result = streamText({ model: await make(), prompt: "What is the capital of France? Answer in one word.", maxOutputTokens: 32, maxRetries: 0 });
      expect((await result.text).trim()).not.toBe("");
      expect(["stop", "length"]).toContain(await result.finishReason);
    });

    it("GC2 tool calls only name offered tools", async () => {
      const result = streamText({ model: await make(), prompt: "What's the weather in Lagos?", tools: toolSet(TOOLS), maxOutputTokens: 96, maxRetries: 0 });
      for (const c of await result.toolCalls) expect(TOOLS.map((t) => t.name)).toContain(c.toolName);
      expect(await result.finishReason).toBeDefined();
    });

    it("GC3 stopping early is clean and the model keeps working", async () => {
      const model = await make();
      const first = streamText({ model, prompt: "Count from one to fifty.", maxOutputTokens: 64, maxRetries: 0 });
      for await (const _ of first.textStream) break;
      const second = streamText({ model, prompt: "Say OK.", maxOutputTokens: 8, maxRetries: 0 });
      expect(await second.finishReason).toBeDefined();
    });
  });
}

export function documentParserContract(label: string, make: () => LanguageModelV4 | Promise<LanguageModelV4>, page: () => Promise<ImageInput>): void {
  describe(`Document parser contract: ${label}`, () => {
    it("DC1 reads a page image into non-empty text", async () => {
      const p = await page();
      const { text } = await generateText({ model: await make(), maxRetries: 0, messages: [{ role: "user", content: [{ type: "file", data: p.data, mediaType: p.mediaType }] }] });
      expect(text.trim()).not.toBe("");
    });
  });
}
