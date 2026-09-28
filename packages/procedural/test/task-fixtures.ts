/** Scripted models and a task suite for the task-suite evaluator's tests and its contract run. */
import type { LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { usage } from "@harness/cognitive";
import { applyEdits, parseTaskSuite, ProceduralGraphSchema } from "@harness/procedural";
import type { ProceduralGraph, TaskSuite } from "@harness/procedural";
import { core, renameGuidance } from "./dream-fixtures.ts";

/** Every call's prompt as JSON, recorded by the scripted models. */
export type Calls = string[];

/** A model answering each call from its prompt (as JSON) with text, or with content parts. */
export function scripted(reply: (prompt: string, options: LanguageModelV4CallOptions) => string | LanguageModelV4Content[], calls: Calls = []): MockLanguageModelV4 & { calls: Calls } {
  const model = new MockLanguageModelV4({
    modelId: "scripted",
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      calls.push(prompt);
      const answer = reply(prompt, options);
      const content = typeof answer === "string" ? [{ type: "text" as const, text: answer }] : answer;
      const called = content.some((part) => part.type === "tool-call");
      return { content, finishReason: { unified: called ? "tool-calls" : "stop", raw: undefined }, usage: usage(1, 1), warnings: [] };
    },
  });
  return Object.assign(model, { calls });
}

/** Guidance that tells a graph with a Verify step from one without. */
export const guidanceModel = (calls: Calls = []) => scripted((prompt) => (prompt.includes("Verify") ? "Verify the answer before you give it." : "Answer at once."), calls);

export const ANSWERS: Readonly<Record<string, string>> = {
  "Capital of France?": "Paris",
  "Capital of Italy?": "Rome",
  "Capital of Spain?": "Madrid",
  "Capital of Japan?": "Tokyo",
  "Capital of Peru?": "Lima",
};

/** A solver that answers right only when the guidance says to verify, and a guess otherwise. */
export const solverModel = (calls: Calls = []) =>
  scripted((prompt) => {
    const asked = Object.keys(ANSWERS).find((q) => prompt.includes(q)) ?? "";
    return prompt.includes("Verify the answer") ? ANSWERS[asked] ?? "" : "Lyon";
  }, calls);

export const suiteOf = (over: Record<string, unknown> = {}): TaskSuite =>
  parseTaskSuite({
    description: "Name capitals.",
    scorer: "exact",
    tasks: [
      { id: "t0", prompt: "Capital of Spain?", expected: "Madrid", split: "train" },
      { id: "t1", prompt: "Capital of Japan?", expected: "Tokyo", split: "train" },
      { id: "t2", prompt: "Capital of Peru?", expected: "Lima", split: "train" },
      { id: "v0", prompt: "Capital of France?", expected: "Paris", split: "validation" },
      { id: "v1", prompt: "Capital of Italy?", expected: "Rome", split: "validation" },
    ],
    ...over,
  });

/** The hotpot core, and the core whose first edge says to verify: guidance at Start (so answers) differ between them. */
export const graphs = (): ProceduralGraph[] => [core(), ProceduralGraphSchema.parse(applyEdits(core(), renameGuidance("Verify each answer.")))];
