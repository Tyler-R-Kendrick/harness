import { expect, it } from "vitest";
import { InvalidResponseDataError } from "@ai-sdk/provider";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Experimental_EvaluationMockModelV4, MockLanguageModelV4 } from "ai/test";
import { bytes, Ensemble, frontierSearch, listedFrontier, openFrontier, usage } from "@harness/cognitive";
import type { FrontierSetup, JudgeQuestion, ModelDescriptor, TaskCategory } from "@harness/cognitive";

interface Box {
  readonly id: string;
}

const box = (id: string): Box => ({ id });

function descriptor(id: string, tasks: readonly TaskCategory[], ports: ModelDescriptor["ports"]): ModelDescriptor {
  return { id, name: id, publisher: "t", tasks, ports, locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["native"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] };
}

const booleanQuestion: JudgeQuestion = { type: "boolean", instructions: "Is this state worth keeping?" };
const scoreQuestion: JudgeQuestion = { type: "score", instructions: "How far is this state?", criteria: [null, null, null] };

const compare = (a: Box, b: Box) => (a.id < b.id ? -1 : 1);

function generated(text: string, outputTokens?: number) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: usage(1, outputTokens),
    warnings: [],
  };
}

function promptText(request: LanguageModelV4CallOptions): string {
  const message = request.prompt[0];
  if (message === undefined || message.role !== "user") return "";
  return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function search(setup: FrontierSetup<Box>, limits: { readonly width: number; readonly budget: number }) {
  return frontierSearch(setup.domain, setup.judge, limits);
}

it("FR2.1 each merged state is judged alone, and evaluation tokens are not added", async () => {
  const calls: { readonly state: unknown; readonly questions: unknown }[] = [];
  const e = new Ensemble({ platform: "native" });
  e.register(descriptor("judge-a", ["judgment"], ["judge"]), async () => ({
    judge: new Experimental_EvaluationMockModelV4({
      doEvaluate: async (options) => {
        calls.push({ state: options.state, questions: options.questions });
        return { answers: { rank: { type: "boolean", probability: options.state === "a" ? 0.2 : 0.9 } }, warnings: [], usage: { outputTokens: 5 } };
      },
    }),
  }));
  const setup = listedFrontier({
    ensemble: e,
    question: booleanQuestion,
    evaluationState: (state) => state.id,
    start: box("start"),
    key: (state) => state.id,
    compare,
    isGoal: () => false,
    isDead: () => false,
    children: (state) => (state.id === "start" ? [box("b"), box("a")] : []),
  });
  expect(await search(setup, { width: 1, budget: 2 })).toEqual({ solved: false, cost: 2, rounds: 1, reason: "budget" });
  expect(calls.map((call) => call.state)).toEqual(["a", "b"]);
  expect(calls.map((call) => call.questions)).toEqual([{ rank: booleanQuestion }, { rank: booleanQuestion }]);
});

it("FR2.2 a listed frontier does not generate, and an invalid judge answer rejects", async () => {
  const seen = { judge: 0, generate: 0 };
  const e = new Ensemble({ platform: "native" });
  e.register(descriptor("judge-a", ["judgment"], ["judge"]), async () => ({
    judge: new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => {
        seen.judge += 1;
        throw new InvalidResponseDataError({ data: {}, message: "not a judgment" });
      },
    }),
  }));
  e.register(descriptor("generator-a", ["chat"], ["generator"]), async () => ({
    generator: new MockLanguageModelV4({ doGenerate: async () => (seen.generate += 1, generated("no")) }),
  }));
  const setup = listedFrontier({
    ensemble: e,
    question: booleanQuestion,
    evaluationState: (state) => state.id,
    start: box("start"),
    key: (state) => state.id,
    compare,
    isGoal: (state) => state.id === "goal",
    isDead: () => false,
    children: () => [box("goal")],
  });
  await expect(search(setup, { width: 1, budget: 10 })).rejects.toThrow(InvalidResponseDataError);
  expect(seen).toEqual({ judge: 1, generate: 0 });
});

it("FR2.3 an open move is one prompt for that state, and its output tokens are the propose cost", async () => {
  const requests: LanguageModelV4CallOptions[] = [];
  const e = new Ensemble({ platform: "native" });
  e.register(descriptor("judge-a", ["judgment"], ["judge"]), async () => ({
    judge: new Experimental_EvaluationMockModelV4({
      doEvaluate: async () => ({ answers: { rank: { type: "boolean", probability: 0.5 } }, warnings: [] }),
    }),
  }));
  e.register(descriptor("generator-a", ["chat"], ["generator"]), async () => ({
    generator: new MockLanguageModelV4({
      doGenerate: async (request) => {
        requests.push(request);
        const text = promptText(request);
        return generated(text, text === "S" ? 3 : text === "b" ? 1 : 5);
      },
    }),
  }));
  const options = { harness: { keep: true } };
  const setup = openFrontier({
    ensemble: e,
    question: booleanQuestion,
    evaluationState: (state) => state.id,
    start: box("S"),
    key: (state) => state.id,
    compare,
    isGoal: (state) => state.id === "goal",
    isDead: () => false,
    render: (state) => state.id,
    parse: (text) => (text === "S" ? [box("b"), box("a")] : text === "a" ? [box("goal")] : []),
    task: "chat",
    providerOptions: options,
  });
  const result = await search(setup, { width: 2, budget: 20 });
  expect(result).toMatchObject({ solved: true, cost: 12, rounds: 2, orderedBy: "score" });
  if (result.solved) expect(result.state.id).toBe("goal");
  expect(requests.map(promptText)).toEqual(["S", "b", "a"]);
  expect(requests.every((request) => request.tools === undefined && request.temperature === undefined && request.prompt.every((message) => message.role !== "system"))).toBe(true);
  expect(requests.map((request) => request.providerOptions)).toEqual([options, options, options]);
});

it("FR2.4 a missing output-token total with no judge does not propose again", async () => {
  const prompts: string[] = [];
  const e = new Ensemble({ platform: "native" });
  e.register(descriptor("generator-a", ["chat"], ["generator"]), async () => ({
    generator: new MockLanguageModelV4({
      doGenerate: async (request) => {
        prompts.push(promptText(request));
        return generated(promptText(request));
      },
    }),
  }));
  const setup = openFrontier({
    ensemble: e,
    question: booleanQuestion,
    evaluationState: (state) => state.id,
    start: box("S"),
    key: (state) => state.id,
    compare,
    isGoal: () => false,
    isDead: () => false,
    render: (state) => state.id,
    parse: () => [box("open")],
    task: "chat",
  });
  expect(await search(setup, { width: 2, budget: 10 })).toEqual({ solved: false, cost: 0, rounds: 1, reason: "no-progress" });
  expect(prompts).toEqual(["S"]);

  const zeroPrompts: string[] = [];
  const zero = new Ensemble({ platform: "native" });
  zero.register(descriptor("generator-a", ["chat"], ["generator"]), async () => ({
    generator: new MockLanguageModelV4({
      doGenerate: async (request) => {
        zeroPrompts.push(promptText(request));
        return generated("S", 0);
      },
    }),
  }));
  const zeroSetup = openFrontier({
    ensemble: zero,
    question: booleanQuestion,
    evaluationState: (state) => state.id,
    start: box("S"),
    key: (state) => state.id,
    compare,
    isGoal: () => false,
    isDead: () => false,
    render: (state) => state.id,
    parse: () => [box("open")],
    task: "chat",
  });
  expect(await search(zeroSetup, { width: 2, budget: 10 })).toEqual({ solved: false, cost: 0, rounds: 1, reason: "no-progress" });
  expect(zeroPrompts).toEqual(["S"]);
});

it("FR2.5 a score is ranked as itself and a boolean as its probability", async () => {
  const judge = (answer: (state: unknown) => { readonly type: "score"; readonly score: number } | { readonly type: "boolean"; readonly probability: number }) => {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("judge-a", ["judgment"], ["judge"]), async () => ({
      judge: new Experimental_EvaluationMockModelV4({
        doEvaluate: async (options) => ({ answers: { rank: answer(options.state) }, warnings: [] }),
      }),
    }));
    return e;
  };
  const listed = (e: Ensemble, question: JudgeQuestion) =>
    listedFrontier({
      ensemble: e,
      question,
      evaluationState: (state) => state.id,
      start: box("start"),
      key: (state) => state.id,
      compare,
      isGoal: (state) => state.id !== "start",
      isDead: () => false,
      children: () => [box("a"), box("b")],
    });
  const byScore = await search(listed(judge((state) => ({ type: "score", score: state === "a" ? 1.5 : 0.4 })), scoreQuestion), { width: 1, budget: 5 });
  const byBoolean = await search(listed(judge((state) => ({ type: "boolean", probability: state === "a" ? 0.7 : 0.9 })), booleanQuestion), { width: 1, budget: 5 });
  expect(byScore).toMatchObject({ solved: true, orderedBy: "score" });
  expect(byBoolean).toMatchObject({ solved: true, orderedBy: "score" });
  if (byScore.solved) expect(byScore.state.id).toBe("a");
  if (byBoolean.solved) expect(byBoolean.state.id).toBe("b");
});

it("FR2.6 a choice question throws before a model is loaded", () => {
  let loaded = 0;
  const e = new Ensemble({ platform: "native" });
  const bump = async () => {
    loaded += 1;
    return {};
  };
  e.register(descriptor("judge-a", ["judgment"], ["judge"]), bump);
  e.register(descriptor("generator-a", ["chat"], ["generator"]), bump);
  const choice: JudgeQuestion = { type: "choice", instructions: "pick", criteria: { yes: null, no: null } };
  const shared = {
    ensemble: e,
    question: choice,
    evaluationState: (state: Box) => state.id,
    start: box("start"),
    key: (state: Box) => state.id,
    compare,
    isGoal: () => false,
    isDead: () => false,
  };
  expect(() => listedFrontier({ ...shared, children: () => [] })).toThrow(/frontier question must be boolean or score/);
  expect(() => openFrontier({ ...shared, render: () => "", parse: () => [], task: "chat" })).toThrow(/frontier question must be boolean or score/);
  expect(loaded).toBe(0);
});

it("FR2.7 a listed frontier does not load a judge the ensemble does not serve", async () => {
  const e = new Ensemble({ platform: "native" });
  const listed = (goal: boolean) =>
    listedFrontier({
      ensemble: e,
      question: booleanQuestion,
      evaluationState: (state) => state.id,
      start: box("start"),
      key: (state) => state.id,
      compare,
      isGoal: (state) => goal && state.id === "goal",
      isDead: () => false,
      children: () => [box(goal ? "goal" : "open")],
    });
  const open = listed(false);
  const solved = listed(true);
  expect(await search(open, { width: 1, budget: 5 })).toEqual({ solved: false, cost: 0, rounds: 1, reason: "no-progress" });
  const found = await search(solved, { width: 1, budget: 5 });
  expect(found).toMatchObject({ solved: true, orderedBy: "votes", cost: 0, rounds: 1 });
  if (found.solved) expect(found.state.id).toBe("goal");
});

it("FR2.8 a non-finite or negative output-token count throws", async () => {
  for (const total of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const e = new Ensemble({ platform: "native" });
    e.register(descriptor("generator-a", ["chat"], ["generator"]), async () => ({
      generator: new MockLanguageModelV4({ doGenerate: async () => generated("open", total) }),
    }));
    const setup = openFrontier({
      ensemble: e,
      question: booleanQuestion,
      evaluationState: (state) => state.id,
      start: box("S"),
      key: (state) => state.id,
      compare,
      isGoal: () => false,
      isDead: () => false,
      render: (state) => state.id,
      parse: () => [box("open")],
      task: "chat",
    });
    await expect(search(setup, { width: 1, budget: 5 })).rejects.toThrow(/output tokens/);
  }
});
