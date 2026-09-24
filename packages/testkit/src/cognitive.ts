import { describe, expect, it } from "vitest";
import { ChatStreamParser, compressWords } from "@harness/cognitive";
import type {
  Compression,
  CompressRequest,
  Compressor,
  DocumentParser,
  Embedder,
  EmbedInput,
  GenerateRequest,
  GenerationEvent,
  Generator,
  Judge,
  JudgeAnswer,
  JudgeQuestion,
  JudgeRequest,
  ParseRequest,
  RouteRequest,
  Routing,
  ToolRouter,
  ToolSpec,
} from "@harness/cognitive";

// ---- deterministic fakes ------------------------------------------------------------

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Feature-hashing embedder: texts sharing words get similar vectors. */
export class HashEmbedder implements Embedder {
  readonly dimensions: number;
  constructor(dimensions = 64) {
    this.dimensions = dimensions;
  }
  async embed(inputs: readonly EmbedInput[], options: { readonly dimensions?: number } = {}): Promise<Float32Array[]> {
    const size = options.dimensions ?? this.dimensions;
    return inputs.map((input) => {
      const v = new Float32Array(size);
      for (const w of words(input.text)) {
        const h = hash(w);
        v[h % size]! += h & 1 ? 1 : -1;
      }
      let norm = Math.hypot(...v);
      if (norm === 0) {
        v[0] = 1;
        norm = 1;
      }
      return v.map((x) => x / norm);
    });
  }
}

/** Picks the tool whose name and description share the most words with the input. */
export class KeywordRouter implements ToolRouter {
  readonly requests: RouteRequest[] = [];
  async route(request: RouteRequest): Promise<Routing> {
    this.requests.push(request);
    const said = new Set(words(request.input));
    const scored = request.tools.map((t) => ({ t, score: words(`${t.name.replace(/_/g, " ")} ${t.description}`).filter((w) => said.has(w)).length }));
    const best = scored.sort((a, b) => b.score - a.score)[0];
    if (!best || best.score === 0) return { calls: [], confidence: 0.9, reasoning: "no tool shares a word with the request" };
    return { calls: [{ name: best.t.name, arguments: {} }], confidence: Math.min(0.99, 0.5 + 0.2 * best.score), reasoning: `matched ${best.score} word(s)` };
  }
}

/** Streams a scripted raw ChatML reply through the real parser, a few characters at a time. */
export class ScriptedGenerator implements Generator {
  readonly requests: GenerateRequest[] = [];
  readonly #reply: (request: GenerateRequest) => string;
  readonly #chunk: number;
  constructor(reply: (request: GenerateRequest) => string, chunk = 3) {
    this.#reply = reply;
    this.#chunk = chunk;
  }
  async *generate(request: GenerateRequest): AsyncIterable<GenerationEvent> {
    this.requests.push(request);
    const raw = this.#reply(request);
    const parser = new ChatStreamParser();
    let calls = 0;
    for (let i = 0; i < raw.length; i += this.#chunk) {
      for (const e of parser.push(raw.slice(i, i + this.#chunk))) {
        if (e.type === "tool-call") calls++;
        yield e;
      }
    }
    for (const e of parser.end()) yield e;
    yield { type: "finish", reason: calls > 0 ? "tool-calls" : "stop" };
  }
}

function defaultAnswer(q: JudgeQuestion): JudgeAnswer {
  if (q.type === "boolean") return { type: "boolean", probability: 0.5 };
  if (q.type === "choice") {
    const options = Object.keys(q.criteria);
    return { type: "choice", choice: options[0]!, probabilities: Object.fromEntries(options.map((o) => [o, 1 / options.length])) };
  }
  return { type: "score", score: (q.criteria.length - 1) / 2 };
}

/** Answers every question with `answer`, or a neutral default. */
export class ScriptedJudge implements Judge {
  readonly requests: JudgeRequest[] = [];
  readonly #answer: (id: string, q: JudgeQuestion, request: JudgeRequest) => JudgeAnswer | undefined;
  constructor(answer: (id: string, q: JudgeQuestion, request: JudgeRequest) => JudgeAnswer | undefined = () => undefined) {
    this.#answer = answer;
  }
  async evaluate(request: JudgeRequest): Promise<Record<string, JudgeAnswer>> {
    this.requests.push(request);
    return Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, this.#answer(id, q, request) ?? defaultAnswer(q)]));
  }
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

/** Describes each page instead of reading it. */
export class StubDocumentParser implements DocumentParser {
  async parse(request: ParseRequest): Promise<{ pages: { markdown: string; raw: string }[] }> {
    return { pages: request.pages.map((p, i) => ({ markdown: `# Page ${i + 1}\n\n${p.mediaType}, ${p.data.length} bytes`, raw: `page ${i + 1}` })) };
  }
}

// ---- contract suites ------------------------------------------------------------------

const TOOLS: ToolSpec[] = [
  { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "set_timer", description: "Start a countdown timer for some minutes.", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } },
];

async function collect(stream: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

export function judgeContract(label: string, make: () => Judge | Promise<Judge>): void {
  describe(`Judge contract: ${label}`, () => {
    it("JC1 answers exactly the questions asked, each with its question's type and a value in range", async () => {
      const judge = await make();
      const answers = await judge.evaluate({
        state: { request: "What is 17 + 25?", reply: "42" },
        questions: {
          correct: { type: "boolean", instructions: "Is `reply` the correct answer to `request`?" },
          topic: { type: "choice", instructions: "What is `request` about?", criteria: { math: "Arithmetic", history: null, cooking: null } },
          quality: { type: "score", instructions: "How complete is `reply`?", criteria: ["poor", "fair", "good"] },
        },
      });
      expect(Object.keys(answers).sort()).toEqual(["correct", "quality", "topic"]);
      const correct = answers["correct"]!;
      const topic = answers["topic"]!;
      const quality = answers["quality"]!;
      expect(correct.type === "boolean" && correct.probability >= 0 && correct.probability <= 1).toBe(true);
      expect(topic.type === "choice" && ["math", "history", "cooking"].includes(topic.choice)).toBe(true);
      if (topic.type === "choice" && topic.probabilities) {
        expect(Object.keys(topic.probabilities).sort()).toEqual(["cooking", "history", "math"]);
        expect(Object.values(topic.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
      }
      expect(quality.type === "score" && quality.score >= 0 && quality.score <= 2).toBe(true);
    });
  });
}

export function routerContract(label: string, make: () => ToolRouter | Promise<ToolRouter>): void {
  describe(`ToolRouter contract: ${label}`, () => {
    it("RC1 calls only offered tools, with object arguments and a confidence in [0, 1]", async () => {
      const router = await make();
      const r = await router.route({ input: "What's the weather like in Lagos right now?", tools: TOOLS });
      for (const c of r.calls) {
        expect(TOOLS.map((t) => t.name)).toContain(c.name);
        expect(typeof c.arguments === "object" && c.arguments !== null && !Array.isArray(c.arguments)).toBe(true);
      }
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
      expect(typeof r.reasoning).toBe("string");
    });

    it("RC2 with no tools offered there is nothing to call", async () => {
      const router = await make();
      expect((await router.route({ input: "What's the weather in Lagos?", tools: [] })).calls).toEqual([]);
    });

    it("RC3 independent requests do not leak into each other", async () => {
      const fresh = await make();
      const alone = await fresh.route({ input: "Start a timer for 5 minutes.", tools: TOOLS });
      const router = await make();
      await router.route({ input: "What's the weather in Paris?", tools: TOOLS });
      const after = await router.route({ input: "Start a timer for 5 minutes.", tools: TOOLS });
      expect(after.calls).toEqual(alone.calls);
    });
  });
}

export function embedderContract(label: string, make: () => Embedder | Promise<Embedder>, options: { sizes?: readonly number[] } = {}): void {
  describe(`Embedder contract: ${label}`, () => {
    it("EC1 returns one unit vector of the model's size per input, deterministically", async () => {
      const embedder = await make();
      const inputs: EmbedInput[] = [
        { kind: "query", text: "which planet is red?" },
        { kind: "document", text: "Mars is the red planet." },
      ];
      const [a, b] = await embedder.embed(inputs);
      for (const v of [a!, b!]) {
        expect(v.length).toBe(embedder.dimensions);
        expect(Math.hypot(...v)).toBeCloseTo(1, 3);
      }
      const [again] = await embedder.embed(inputs.slice(0, 1));
      for (let i = 0; i < a!.length; i++) expect(again![i]).toBeCloseTo(a![i]!, 4);
    });

    it("EC2 a query is closer to a relevant document than to an unrelated one", async () => {
      const embedder = await make();
      const [q, rel, other] = await embedder.embed([
        { kind: "query", text: "Which planet is known as the red planet?" },
        { kind: "document", text: "Mars is often called the red planet." },
        { kind: "document", text: "Bananas are a yellow fruit rich in potassium." },
      ]);
      const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * y[i]!, 0);
      expect(dot(q!, rel!)).toBeGreaterThan(dot(q!, other!));
    });

    for (const size of options.sizes ?? []) {
      it(`EC3 truncates to ${size} dimensions as unit vectors`, async () => {
        const embedder = await make();
        const [v] = await embedder.embed([{ kind: "document", text: "hello world" }], { dimensions: size });
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

export function generatorContract(label: string, make: () => Generator | Promise<Generator>): void {
  describe(`Generator contract: ${label}`, () => {
    it("GC1 a simple prompt yields text and ends with exactly one finish event", async () => {
      const g = await make();
      const events = await collect(g.generate({ messages: [{ role: "user", content: "What is the capital of France? Answer in one word." }], maxTokens: 32 }));
      expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
      expect(events.at(-1)!.type).toBe("finish");
      expect(events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : "")).join("").trim()).not.toBe("");
    });

    it("GC2 tool calls only name offered tools", async () => {
      const g = await make();
      const events = await collect(g.generate({ messages: [{ role: "user", content: "What's the weather in Lagos?" }], tools: TOOLS, maxTokens: 96 }));
      for (const e of events) if (e.type === "tool-call") expect(TOOLS.map((t) => t.name)).toContain(e.call.name);
      expect(events.at(-1)!.type).toBe("finish");
    });

    it("GC3 stopping early is clean and the generator keeps working", async () => {
      const g = await make();
      for await (const _ of g.generate({ messages: [{ role: "user", content: "Count from one to fifty." }], maxTokens: 64 })) break;
      const events = await collect(g.generate({ messages: [{ role: "user", content: "Say OK." }], maxTokens: 8 }));
      expect(events.at(-1)!.type).toBe("finish");
    });
  });
}

export function documentParserContract(label: string, make: () => DocumentParser | Promise<DocumentParser>, page: () => Promise<ParseRequest["pages"][number]>): void {
  describe(`DocumentParser contract: ${label}`, () => {
    it("DC1 returns one page of Markdown per input page", async () => {
      const parser = await make();
      const p = await page();
      const result = await parser.parse({ pages: [p, p] });
      expect(result.pages).toHaveLength(2);
      for (const r of result.pages) {
        expect(typeof r.markdown).toBe("string");
        expect(r.markdown.trim()).not.toBe("");
      }
    });
  });
}
