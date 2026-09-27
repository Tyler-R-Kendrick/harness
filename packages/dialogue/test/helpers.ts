import { readFileSync } from "node:fs";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { HARNESS, usage } from "@harness/cognitive";
import { parseSettings } from "@harness/dialogue";
import type { Observation, Settings } from "@harness/dialogue";
import { promptText } from "@harness/testkit";

const file = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;

/** The shipped settings, with sections overridden field by field. */
export function settings(overrides: { readonly [section: string]: Readonly<Record<string, unknown>> | number } = {}): Settings {
  const merged: Record<string, unknown> = { ...file };
  for (const [section, value] of Object.entries(overrides)) merged[section] = typeof value === "number" ? value : { ...file[section], ...value };
  return parseSettings(merged);
}

export const supportBook = (): unknown => JSON.parse(readFileSync(new URL("./fixtures/support.book.json", import.meta.url), "utf8"));

/** What a scripted router picks: a tool, its arguments and its confidence. */
export interface Pick {
  readonly tool: string;
  readonly args?: Record<string, unknown>;
  readonly confidence: number;
}

/** A tool router that picks with `pick(input, tool names)` (one call, several, or none), recording the tools it was offered. */
export function routerModel(
  pick: (input: string, tools: readonly string[]) => Pick | readonly Pick[] | undefined,
): MockLanguageModelV4 & { readonly offered: string[][]; readonly tools: LanguageModelV4CallOptions["tools"][] } {
  const offered: string[][] = [];
  const tools: LanguageModelV4CallOptions["tools"][] = [];
  const model = new MockLanguageModelV4({
    modelId: "scripted-router",
    doGenerate: async (options) => {
      const names = (options.tools ?? []).map((t) => t.name);
      offered.push(names);
      tools.push(options.tools);
      const chosen = pick(promptText(options.prompt), names);
      const calls = chosen === undefined ? [] : "tool" in chosen ? [chosen] : chosen;
      return {
        content: calls.map((c, i) => ({ type: "tool-call" as const, toolCallId: `call_${i}`, toolName: c.tool, input: JSON.stringify(c.args ?? {}) })),
        finishReason: { unified: calls.length > 0 ? "tool-calls" : "stop", raw: undefined },
        usage: usage(),
        providerMetadata: { [HARNESS]: { confidence: calls[0]?.confidence ?? 0.9 } },
        warnings: [],
      };
    },
  });
  return Object.assign(model, { offered, tools });
}

/** An embedding model giving each text its vector (unknown texts [0, 0, 1]), recording what it embedded and as what kind. */
export function vectorEmbedder(vectors: Readonly<Record<string, readonly number[]>>): MockEmbeddingModelV4 & { readonly calls: { values: string[]; kind: unknown }[] } {
  const calls: { values: string[]; kind: unknown }[] = [];
  const model = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: null,
    doEmbed: async ({ values, providerOptions }) => {
      calls.push({ values, kind: providerOptions?.[HARNESS]?.["kind"] });
      return { embeddings: values.map((v) => [...(vectors[v] ?? [0, 0, 1])]), warnings: [] };
    },
  });
  return Object.assign(model, { calls });
}

/** A model answering every call with `answer(call)` as text, recording the calls. */
export function textModel(answer: (call: LanguageModelV4CallOptions) => string): MockLanguageModelV4 & { readonly calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    modelId: "scripted-text",
    doGenerate: async (options) => {
      calls.push(options);
      return { content: [{ type: "text" as const, text: answer(options) }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] };
    },
  });
  return Object.assign(model, { calls });
}

/** A model whose every call fails. */
export const failingModel = (): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("model unavailable");
    },
  });

export const said = (utterance: string, reply: string): Observation => ({ utterance, reply });
