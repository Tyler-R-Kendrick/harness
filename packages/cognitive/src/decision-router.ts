import { experimental_evaluate } from "ai";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { EvaluationModelV4 } from "./ports.ts";
import { HARNESS } from "./options.ts";
import { usage } from "./stream-parts.ts";

/** The probability a decision model's choice of a script needs before that script answers. */
export const DECISION_ACCEPT = 0.6;

const NONE = "none";
const NONE_TEXT = "Something else, not a report, a calculation, instructions, a manual page, or what you can do";
const QUESTION = "Does the user's message ask for this?";
/** One option is none. A decision model takes at most 20 options. */
const MAX_SCRIPTS = 19;

/**
 * The classification judge as the dialogue's tool router. Each offered script is
 * its own question, so one message can be several intents. Each script at or above
 * the decision bar is one tool call, in the order the scripts were offered. No
 * accepted script is no call, so the chat model answers the turn. A question's two
 * answers are rotated and averaged, because a decision model can favour a position.
 */
export function decisionRouter(judge: EvaluationModelV4): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "harness.decision",
    modelId: "classification",
    supportedUrls: {},
    doGenerate: (options) => choose(judge, options),
    doStream: () => Promise.reject(new Error("the decision router answers a single choice")),
  };
}

function said(options: LanguageModelV4CallOptions): string {
  const last = [...options.prompt].reverse().find((message) => message.role === "user");
  if (last?.role !== "user") return "";
  return last.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

const TOOL_NONE = "Something else, not this tool";

/** Each option against "none", rotated and averaged, because a decision model can favour a position. */
async function decisionScores(
  judge: EvaluationModelV4,
  input: string,
  options: readonly { readonly name: string; readonly description: string }[],
  noneText: string,
): Promise<ReadonlyMap<string, number>> {
  if (options.length === 0) return new Map();
  const asked: { name: string; order: readonly (readonly [string, string])[] }[] = [];
  for (const option of options) {
    const positive = [option.name, option.description] as const;
    const negative = [NONE, noneText] as const;
    asked.push({ name: option.name, order: [positive, negative] }, { name: option.name, order: [negative, positive] });
  }
  const questions = Object.fromEntries(
    asked.map((row, index) => [
      `q${index}`,
      { type: "choice" as const, instructions: QUESTION, criteria: Object.fromEntries(row.order.map(([, text], key) => [`o${key}`, text])) },
    ]),
  );
  const { answers } = await experimental_evaluate({ model: judge, maxRetries: 0, state: input, questions });
  const totals = new Map(options.map((option) => [option.name, 0]));
  asked.forEach((row, index) => {
    const answer = answers[`q${index}`];
    if (answer?.type !== "choice") return;
    const probabilities = answer.probabilities ?? { [answer.choice]: 1 };
    row.order.forEach(([name], key) => {
      if (name === NONE) return;
      totals.set(name, (totals.get(name) ?? 0) + (probabilities[`o${key}`] ?? 0));
    });
  });
  return new Map([...totals].map(([name, total]) => [name, total / 2]));
}

/**
 * Rank tools for a request with the decision layer. A tool at or above the decision
 * bar stays, highest score first; a tie keeps the order the tools were offered.
 * A tool below the bar is left out. No tools does not ask the model.
 */
export async function rankTools(
  judge: EvaluationModelV4,
  request: { readonly input: string; readonly tools: readonly { readonly name: string; readonly description: string }[] },
): Promise<readonly { readonly name: string; readonly score: number }[]> {
  const scores = await decisionScores(judge, request.input, request.tools, TOOL_NONE);
  return request.tools
    .map((tool, index) => ({ name: tool.name, score: scores.get(tool.name) ?? 0, index }))
    .filter((row) => row.score >= DECISION_ACCEPT)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ name, score }) => ({ name, score }));
}

async function choose(judge: EvaluationModelV4, options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
  const scripts = (options.tools ?? []).filter((tool) => tool.name !== NONE).slice(0, MAX_SCRIPTS);
  if (scripts.length === 0) return declined(0);
  const scores = await decisionScores(
    judge,
    said(options),
    scripts.map((tool) => ({ name: tool.name, description: "description" in tool && tool.description ? tool.description : tool.name })),
    NONE_TEXT,
  );
  const accepted = scripts.filter((tool) => (scores.get(tool.name) ?? 0) >= DECISION_ACCEPT);
  if (accepted.length === 0) return declined(0);
  const confidence = Math.min(...accepted.map((tool) => scores.get(tool.name) ?? 0));
  return {
    content: accepted.map((tool, index) => ({ type: "tool-call", toolCallId: `call_${index}`, toolName: tool.name, input: "{}" })),
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: usage(),
    providerMetadata: { [HARNESS]: { confidence } },
    warnings: [],
  };
}

function declined(confidence: number): LanguageModelV4GenerateResult {
  return {
    content: [],
    finishReason: { unified: "stop", raw: undefined },
    usage: usage(),
    providerMetadata: { [HARNESS]: { confidence } },
    warnings: [],
  };
}
