import { describe, expect, it } from "vitest";
import { experimental_evaluate } from "ai";
import * as ort from "onnxruntime-node";
import { collateDecisions, decisionModel, encodeDecision, loadDecisionModel, OnnxDecisionSession, writeJson } from "@harness/models";
import type { OrtLike } from "@harness/models";
import type { ModelDescriptor } from "@harness/cognitive";
import { decisionFiles } from "./decision-fixture.ts";
import type { DecisionBatch, DecisionFormat, DecisionSession, DecisionTokenizer } from "@harness/models";

/** A word-level tokenizer: each word is one token, numbered from 10 in the order first seen. */
function wordTokenizer(): DecisionTokenizer & { word(id: number): string } {
  const ids = new Map<string, number>();
  const words: string[] = [];
  const id = (w: string) => {
    if (!ids.has(w)) {
      ids.set(w, 10 + words.length);
      words.push(w);
    }
    return ids.get(w)!;
  };
  return {
    marker: "<mask>",
    ids: { marker: 4, start: 2, separator: 1, pad: 0 },
    encode: (text) => text.split(/\s+/).filter((w) => w !== "").map(id),
    word: (n) => (n === 4 ? "<mask>" : n === 2 ? "<bos>" : n === 1 ? "<eos>" : n === 0 ? "<pad>" : words[n - 10]!),
  };
}

const FORMAT: DecisionFormat = {
  model: "model.onnx",
  tokenizer: "tokenizer.json",
  tokenizerConfig: "tokenizer_config.json",
  head: "{type} question: {question}",
  option: " {option}",
  types: { choice: { id: 0, name: "choice" }, score: { id: 1, name: "score" }, boolean: { id: 2, name: "noul" } },
  json: { item: ", ", key: ": " },
  limits: { tokens: 64, head: 24, option: 4, options: { min: 2, max: 4 }, cut: { head: 3, budget: 6, option: 2 } },
  strict: true,
  padTo: 8,
  batchTokens: 64,
};
const loose: DecisionFormat = { ...FORMAT, strict: false };

const words = (t: ReturnType<typeof wordTokenizer>, ids: readonly number[]) => ids.map((n) => t.word(n)).join(" ");

describe("decision model encoding (encodeDecision)", () => {
  it("DM1.1 a request is the start token, the question head, a separator, each option behind a marker, a separator, the state and a separator; markers point at the markers", () => {
    const t = wordTokenizer();
    const e = encodeDecision(t, FORMAT, { type: "choice", question: "which team?", options: ["billing desk", "shipping"], state: "charged twice" });
    expect(words(t, e.ids)).toBe("<bos> choice question: which team? <eos> <mask> billing desk <mask> shipping <eos> charged twice <eos>");
    expect(e.markers.map((m) => t.word(e.ids[m]!))).toEqual(["<mask>", "<mask>"]);
    expect(e.markers).toEqual([6, 9]);
    expect(e.qtype).toBe(0);
    expect(e.truncated).toBe(false);
  });

  it("DM1.2 a JSON state is written with the format's separators", () => {
    expect(writeJson({ a: 1, b: [true, null, "x\"y"], c: {} }, FORMAT.json)).toBe('{"a": 1, "b": [true, null, "x\\"y"], "c": {}}');
    expect(writeJson([], { item: ",", key: ":" })).toBe("[]");
    expect(writeJson("é", FORMAT.json)).toBe('"é"');
    const t = wordTokenizer();
    const e = encodeDecision(t, FORMAT, { type: "score", question: "how?", options: ["low", "high"], state: { n: 1, m: [2, 3] } });
    expect(words(t, e.ids)).toBe('<bos> score question: how? <eos> <mask> low <mask> high <eos> {"n": 1, "m": [2, 3]} <eos>');
    expect(e.qtype).toBe(1);
  });

  it("DM1.3 strict encoding refuses an option longer than the option limit, naming it", () => {
    expect(() => encodeDecision(wordTokenizer(), FORMAT, { type: "choice", question: "q", options: ["a b c d e", "f"], state: "" })).toThrow(/option 1 is 5 tokens; at most 4/);
  });

  it("DM1.4 strict encoding refuses a question head that does not fit beside the options", () => {
    const question = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    expect(() => encodeDecision(wordTokenizer(), FORMAT, { type: "choice", question, options: ["a", "b"], state: "" })).toThrow(/question and options are more than 24 tokens/);
  });

  it("DM1.5 a state longer than the room left is refused when strict, and cut to fit otherwise", () => {
    const state = Array.from({ length: 60 }, (_, i) => `s${i}`).join(" ");
    const request = { type: "choice" as const, question: "q", options: ["a", "b"], state };
    expect(() => encodeDecision(wordTokenizer(), FORMAT, request)).toThrow(/state is 60 tokens; 53 fit/);
    const e = encodeDecision(wordTokenizer(), loose, request);
    expect(e.ids).toHaveLength(64);
    expect(e.ids.at(-1)).toBe(1);
    expect(e.truncated).toBe(true);
  });

  it("DM1.6 the marker token in a request is refused when strict, and read as a space otherwise", () => {
    const request = { type: "choice" as const, question: "pick<mask>one", options: ["a", "b"], state: "" };
    expect(() => encodeDecision(wordTokenizer(), FORMAT, request)).toThrow(/reserved marker <mask>/);
    const t = wordTokenizer();
    expect(words(t, encodeDecision(t, loose, request).ids)).toBe("<bos> choice question: pick one <eos> <mask> a <mask> b <eos> <eos>");
  });

  it("DM1.7 without strict, the model's own cuts apply: options to the option limit, then evenly when they leave the head too little, and at least cut.head of the question", () => {
    const t = wordTokenizer();
    const long = "o1 o2 o3 o4 o5 o6";
    // Options cut to 4 words each: 4 options x 5 tokens = 20 leave 4 < budget 6, so each is cut to max(2, (24 - 6) / 4) = 4 tokens with its marker,
    // leaving the question 24 - 16 = 8 tokens of its 10.
    const e = encodeDecision(t, loose, { type: "choice", question: "a b c d e f g h", options: [long, long, long, long], state: "" });
    expect(words(t, e.ids)).toBe("<bos> choice question: a b c d e f <eos> <mask> o1 o2 o3 <mask> o1 o2 o3 <mask> o1 o2 o3 <mask> o1 o2 o3 <eos> <eos>");
    // Options that leave the question less than cut.head still leave it cut.head tokens.
    const floor: DecisionFormat = { ...loose, limits: { ...loose.limits, cut: { head: 5, budget: 6, option: 6 } } };
    const tight = encodeDecision(t, floor, { type: "choice", question: "a b c d e f g h", options: [long, long, long, long], state: "" });
    expect(words(t, tight.ids)).toBe("<bos> choice question: a b c <eos> <mask> o1 o2 o3 o4 <mask> o1 o2 o3 o4 <mask> o1 o2 o3 o4 <mask> o1 o2 o3 o4 <eos> <eos>");
  });

  it("DM1.8 too few or too many options are refused, and a boolean question takes exactly two", () => {
    const t = wordTokenizer();
    expect(() => encodeDecision(t, FORMAT, { type: "choice", question: "q", options: ["a"], state: "" })).toThrow(/2 to 4 options, not 1/);
    expect(() => encodeDecision(t, FORMAT, { type: "choice", question: "q", options: ["a", "b", "c", "d", "e"], state: "" })).toThrow(/2 to 4 options, not 5/);
    expect(() => encodeDecision(t, FORMAT, { type: "boolean", question: "q", options: ["a", "b", "c"], state: "" })).toThrow(/a boolean question has two options/);
    expect(() => encodeDecision(t, FORMAT, { type: "choice", question: "q", options: ["a", ""], state: "" })).toThrow(/option 2 is empty/);
  });
});

describe("decision batches (collateDecisions)", () => {
  it("DM3.1 questions are padded to the longest, rounded up to padTo but never past the limit, with masks over tokens and options", () => {
    const b = collateDecisions(
      [
        { ids: [2, 5, 4, 6, 4, 7, 1], markers: [2, 4], qtype: 0, truncated: false },
        { ids: [2, 4, 8, 4, 9, 4, 3, 1, 1], markers: [1, 3, 5], qtype: 2, truncated: false },
      ],
      { pad: 0, padTo: 8, tokens: 64 },
    );
    expect([b.size, b.length, b.options]).toEqual([2, 16, 3]);
    expect(Array.from(b.inputIds.subarray(0, 16), Number)).toEqual([2, 5, 4, 6, 4, 7, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(b.attentionMask.subarray(16), Number)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(b.markerPos, Number)).toEqual([2, 4, 0, 1, 3, 5]);
    expect(Array.from(b.markerMask)).toEqual([1, 1, 0, 1, 1, 1]);
    expect(Array.from(b.qtype, Number)).toEqual([0, 2]);
    expect(collateDecisions([{ ids: Array(61).fill(3), markers: [1, 2], qtype: 0, truncated: false }], { pad: 0, padTo: 8, tokens: 62 }).length).toBe(62);
  });
});

/** A session whose logits are scripted per question: `logits(batch, row)` gives that row's scores. */
function scriptedSession(logits: (batch: DecisionBatch, row: number) => number[]): DecisionSession & { batches: DecisionBatch[] } {
  const batches: DecisionBatch[] = [];
  return {
    batches,
    async run(batch) {
      batches.push(batch);
      const out = new Float32Array(batch.size * batch.options).fill(-1e4);
      for (let r = 0; r < batch.size; r++) out.set(logits(batch, r), r * batch.options);
      return out;
    },
  };
}

const softmax = (xs: number[]) => {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
};

describe("decision model (decisionModel, an AI SDK evaluation model)", () => {
  const model = (session: DecisionSession, tokenizer = wordTokenizer()) => decisionModel({ modelId: "decider", session, tokenizer, format: FORMAT });

  it("DM2.1 each question type becomes options: choice descriptions (the name where there is none), score levels (the index where none), boolean false then true (literal where none)", async () => {
    const t = wordTokenizer();
    const session = scriptedSession((b) => Array(b.options).fill(0));
    await experimental_evaluate({
      model: model(session, t),
      maxRetries: 0,
      state: "s",
      questions: {
        team: { type: "choice", instructions: "which?", criteria: { billing: "money desk", shipping: null } },
        level: { type: "score", instructions: "how?", criteria: ["poor", null, "good"] },
        ok: { type: "boolean", instructions: "ok?", criteria: { true: "it works" } },
        plain: { type: "boolean", instructions: "yes?" },
      },
    });
    const [b] = session.batches;
    const rows = Array.from({ length: b!.size }, (_, r) => {
      const ids = Array.from(b!.inputIds.subarray(r * b!.length, (r + 1) * b!.length), Number).filter((n) => n !== 0);
      return words(t, ids);
    });
    expect(rows).toEqual([
      "<bos> choice question: which? <eos> <mask> money desk <mask> shipping <eos> s <eos>",
      "<bos> score question: how? <eos> <mask> poor <mask> 1 <mask> good <eos> s <eos>",
      "<bos> noul question: ok? <eos> <mask> false <mask> it works <eos> s <eos>",
      "<bos> noul question: yes? <eos> <mask> false <mask> true <eos> s <eos>",
    ]);
    expect(Array.from(b!.qtype, Number)).toEqual([0, 1, 2, 2]);
  });

  it("DM2.2 answers: the most probable choice with the full distribution, the expected score level, and P(true)", async () => {
    const scores: Record<number, number[]> = { 0: [0.5, 2, -1], 1: [0, 1, 2], 2: [1, 3] };
    const session = scriptedSession((_, r) => scores[r]!);
    const result = await experimental_evaluate({
      model: model(session),
      maxRetries: 0,
      state: "s",
      questions: {
        pick: { type: "choice", instructions: "q", criteria: { a: null, b: null, c: null } },
        level: { type: "score", instructions: "q", criteria: ["x", "y", "z"] },
        yes: { type: "boolean", instructions: "q" },
      },
    });
    const p = softmax(scores[0]!);
    expect(result.answers.pick.choice).toBe("b");
    expect(result.answers.pick.probabilities!["a"]).toBeCloseTo(p[0]!, 6);
    expect(result.answers.pick.probabilities!["c"]).toBeCloseTo(p[2]!, 6);
    const q = softmax(scores[1]!);
    expect(result.answers.level.score).toBeCloseTo(q[1]! + 2 * q[2]!, 6);
    expect(result.answers.level.probabilities!["2"]).toBeCloseTo(q[2]!, 6);
    expect(result.answers.yes.probability).toBeCloseTo(softmax(scores[2]!)[1]!, 6);
  });

  it("DM2.3 all of a call's questions go to the model in one batch, and usage counts the tokens read", async () => {
    const session = scriptedSession((b) => Array(b.options).fill(0));
    const m = model(session);
    const result = await m.doEvaluate({ state: "one two", questions: { a: { type: "boolean", instructions: "q" }, b: { type: "boolean", instructions: "q r" } } });
    expect(session.batches).toHaveLength(1);
    expect(session.batches[0]!.size).toBe(2);
    // <bos> noul question: q <eos> <mask> false <mask> true <eos> one two <eos> = 13, and 14 with "r".
    expect(result.usage).toEqual({ inputTokens: 27, outputTokens: 0 });
    expect(result.warnings).toEqual([]);
    expect(result.response?.modelId).toBe("decider");
  });

  it("DM2.8 a call larger than the model's batch budget runs in batches of at most batchTokens (a longer row alone), one after another, its answers in order", async () => {
    const session = scriptedSession((b, r) => [Number(b.qtype[r]), 0]);
    const questions = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`q${i}`, { type: "boolean" as const, instructions: "q" }]));
    // Each row is 11 tokens (<bos> noul question: q <eos> <mask> false <mask> true <eos> <eos>), padded to 16: four fit in 64.
    const result = await model(session).doEvaluate({ state: "", questions });
    expect(session.batches.map((b) => [b.size, b.length])).toEqual([
      [4, 16],
      [1, 16],
    ]);
    expect(Object.keys(result.answers)).toEqual(["q0", "q1", "q2", "q3", "q4"]);
    const big = scriptedSession(() => [0, 0]);
    await decisionModel({ modelId: "decider", session: big, tokenizer: wordTokenizer(), format: { ...FORMAT, batchTokens: 8 } }).doEvaluate({ state: "", questions: { a: { type: "boolean", instructions: "q" }, b: { type: "boolean", instructions: "q" } } });
    expect(big.batches.map((b) => b.size)).toEqual([1, 1]);
  });

  it("DM2.9 a JSON question or option is written with the format's separators too", async () => {
    const t = wordTokenizer();
    const session = scriptedSession((b) => Array(b.options).fill(0));
    await decisionModel({ modelId: "decider", session, tokenizer: t, format: FORMAT }).doEvaluate({ state: "s", questions: { pick: { type: "choice", instructions: { ask: 1 }, criteria: { a: { n: [1, 2] }, b: null } } } });
    const b = session.batches[0]!;
    expect(words(t, Array.from(b.inputIds, Number).filter((n) => n !== 0))).toBe('<bos> choice question: {"ask": 1} <eos> <mask> {"n": [1, 2]} <mask> b <eos> s <eos>');
  });

  it("DM2.4 an aborted call does not run the model", async () => {
    const session = scriptedSession(() => [0, 0]);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(model(session).doEvaluate({ state: "", questions: { a: { type: "boolean", instructions: "q" } }, abortSignal: controller.signal })).rejects.toThrow(/stop/);
    expect(session.batches).toHaveLength(0);
  });

  it("DM2.5 non-finite scores are an error, not an answer", async () => {
    const session = scriptedSession(() => [Number.NaN, 0]);
    await expect(model(session).doEvaluate({ state: "", questions: { a: { type: "boolean", instructions: "q" } } })).rejects.toThrow(/non-finite scores/);
  });

  it("DM2.6 it answers boolean, choice and score questions, as harness.decision/<model id>", () => {
    const m = model(scriptedSession(() => [0, 0]));
    expect([m.specificationVersion, m.provider, m.modelId]).toEqual(["v4", "harness.decision", "decider"]);
    expect([...m.supportedQuestionTypes].sort()).toEqual(["boolean", "choice", "score"]);
  });

  it("DM2.7 calls run one at a time on the session", async () => {
    let running = 0;
    let most = 0;
    const session: DecisionSession = {
      async run(batch) {
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return new Float32Array(batch.size * batch.options);
      },
    };
    const m = model(session);
    await Promise.all([1, 2, 3].map(() => m.doEvaluate({ state: "", questions: { a: { type: "boolean", instructions: "q" } } })));
    expect(most).toBe(1);
  });
});

describe("onnxruntime decision session", () => {
  interface T {
    type: string;
    data: ArrayLike<number | bigint>;
    dims: readonly number[];
  }
  const fakeRuntime = () => {
    const runs: Record<string, T>[] = [];
    const created: { model: unknown; options: unknown }[] = [];
    const Tensor = class {
      readonly type: string;
      readonly data: ArrayLike<number | bigint>;
      readonly dims: readonly number[];
      constructor(type: string, data: ArrayLike<number | bigint>, dims: readonly number[]) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    };
    const session = {
      inputNames: ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"],
      run: async (feeds: Record<string, T>) => {
        runs.push(feeds);
        const [size, options] = feeds["marker_pos"]!.dims;
        return { logits: new Tensor("float32", Float32Array.from({ length: size! * options! }, (_, i) => i), [size!, options!]) };
      },
    };
    return { runtime: { Tensor, InferenceSession: { create: async (model: unknown, options?: object) => (created.push({ model, options }), session) } }, runs, created };
  };

  it("DM4.1 feeds the batch as int64 ids, masks and positions, a bool option mask and int64 types, and reads one logit per option", async () => {
    const { runtime, runs, created } = fakeRuntime();
    const s = await OnnxDecisionSession.create({ runtime, model: "/models/m.onnx", sessionOptions: { executionProviders: ["cpu"] } });
    expect(created).toEqual([{ model: "/models/m.onnx", options: { executionProviders: ["cpu"] } }]);
    const batch = collateDecisions([{ ids: [2, 4, 5, 4, 6, 1, 1], markers: [1, 3], qtype: 2, truncated: false }], { pad: 0, padTo: 8, tokens: 64 });
    expect(Array.from(await s.run(batch))).toEqual([0, 1]);
    const feeds = runs[0]!;
    expect(Object.fromEntries(Object.entries(feeds).map(([k, v]) => [k, [v.type, [...v.dims]]]))).toEqual({
      input_ids: ["int64", [1, 8]],
      attention_mask: ["int64", [1, 8]],
      marker_pos: ["int64", [1, 2]],
      marker_mask: ["bool", [1, 2]],
      qtype: ["int64", [1]],
    });
    expect(Array.from(feeds["qtype"]!.data, Number)).toEqual([2]);
  });

  it("DM4.3 logits that are not float32 scores, one per row and option, are refused", async () => {
    const { runtime } = fakeRuntime();
    const reply = (type: string, dims: number[]) => ({ ...runtime, InferenceSession: { create: async () => ({ inputNames: ["input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype"], run: async () => ({ logits: new runtime.Tensor(type, new Float32Array(4), dims) }) }) } });
    const batch = collateDecisions([{ ids: [2, 4, 5, 4, 6, 1, 1], markers: [1, 3], qtype: 2, truncated: false }], { pad: 0, padTo: 8, tokens: 64 });
    await expect((await OnnxDecisionSession.create({ runtime: reply("float16", [1, 2]), model: "m" })).run(batch)).rejects.toThrow(/logits are float16 \[1,2\]; expected float32 \[1,2\]/);
    await expect((await OnnxDecisionSession.create({ runtime: reply("float32", [1, 4]), model: "m" })).run(batch)).rejects.toThrow(/logits are float32 \[1,4\]; expected float32 \[1,2\]/);
  });

  it("DM4.2 a model without the decision inputs is refused when it loads", async () => {
    const { runtime } = fakeRuntime();
    const bad = { ...runtime, InferenceSession: { create: async () => ({ inputNames: ["input_ids", "attention_mask"], run: async () => ({}) }) } };
    await expect(OnnxDecisionSession.create({ runtime: bad, model: new Uint8Array(1) })).rejects.toThrow(/not a decision model: it has no marker_pos, marker_mask, qtype input/);
  });
});

describe("a decision model from its files (loadDecisionModel)", () => {
  it("DM5.1 the model file, tokenizer.json and tokenizer config load onto onnxruntime and answer through the AI SDK", async () => {
    const m = { id: "tiny/decider", runtime: "onnxruntime-decision", run: FORMAT } as Extract<ModelDescriptor, { runtime: "onnxruntime-decision" }>;
    const files = decisionFiles(FORMAT);
    const judge = await loadDecisionModel(m, { model: files[FORMAT.model]!, tokenizer: files[FORMAT.tokenizer]!, tokenizerConfig: files[FORMAT.tokenizerConfig]! }, { runtime: ort as unknown as OrtLike });
    expect([judge.provider, judge.modelId]).toEqual(["harness.decision", "tiny/decider"]);
    const { answers } = await experimental_evaluate({ model: judge, maxRetries: 0, state: "a  b", questions: { pick: { type: "choice", instructions: "a", criteria: { first: "a", second: "b", third: "a b" } } } });
    // Scores are marker positions, so the last option wins; the probabilities are a softmax over them.
    expect(answers.pick.choice).toBe("third");
    expect(Object.values(answers.pick.probabilities!).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 6);
  });
});
