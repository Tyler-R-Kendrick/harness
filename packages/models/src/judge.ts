import { gateway } from "@ai-sdk/gateway";
import type { Experimental_EvaluationModelV4, Experimental_EvaluationModelV4Answer, Experimental_EvaluationModelV4Input, Experimental_EvaluationModelV4Question, LanguageModelV4 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { constrain, HARNESS, logprobsIn, withLogprobs } from "@harness/cognitive";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";

/** An evaluation model served through the Vercel AI Gateway, by its gateway id. */
export const gatewayEvaluationModel = (model: string): Experimental_EvaluationModelV4 => gateway.evaluationModel(model);

export interface TypeSafeApiOptions {
  /** The server's address; the API lives under /v1. */
  readonly baseUrl: string;
  readonly model: string;
  /** Local servers usually ignore the key; the provider requires one, so a placeholder is sent without it. */
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

/**
 * An evaluation model on any server that speaks TypeSafe's evaluation API, such as a
 * local judge: TypeSafe's own AI SDK provider talks to it.
 */
export function typesafeApiEvaluationModel(options: TypeSafeApiOptions): Experimental_EvaluationModelV4 {
  return createTypeSafeAi({
    baseURL: `${options.baseUrl.replace(/\/$/, "")}/v1`,
    apiKey: options.apiKey ?? "none",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }).evaluationModel(options.model);
}

/** Whether a service answers `url` with a success status within two seconds. */
export async function serviceAvailable(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    return (await fetchFn(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

type Input = Experimental_EvaluationModelV4Input;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const text = (input: Input | null | undefined): string => (input === null || input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input));

/** A question's options, in order: what each is called in the answer, and how it is shown. */
function optionsOf(q: Experimental_EvaluationModelV4Question): { readonly key: string; readonly shown: string }[] {
  const shown = (name: string, description: Input | null | undefined) => (text(description) ? `${name}: ${text(description)}` : name);
  if (q.type === "boolean") return [{ key: "true", shown: shown("true", q.criteria?.true) }, { key: "false", shown: shown("false", q.criteria?.false) }];
  if (q.type === "choice") return Object.entries(q.criteria).map(([key, description]) => ({ key, shown: shown(key, description) }));
  return q.criteria.map((description, level) => ({ key: String(level), shown: shown(`level ${level}`, description) }));
}

const SYSTEM = "You judge a state. Answer the question about it with the letter of the one option that is true of the state.";

/**
 * Any AI SDK language model as a judge (LLM-as-judge), for when no dedicated judgment
 * model is reachable. Each question goes to the model with the state and its options
 * as letters. The model first reasons briefly (a generator's first token is often a
 * reflex, such as "no" to "is this right?", which its reasoning then corrects), then is
 * asked for the letter alone, constrained to one letter (a JSON Schema enum, which
 * generators that enforce constraints follow). Probabilities come from the letters'
 * token probabilities when the model reports them (llama-server does); otherwise the
 * answer counts as certain, with a warning.
 */
export function generatorJudge(model: LanguageModelV4, options: { readonly topLogprobs?: number; readonly reasoningTokens?: number } = {}): Experimental_EvaluationModelV4 {
  const ask = async (state: Input, q: Experimental_EvaluationModelV4Question, abortSignal: AbortSignal | undefined): Promise<{ distribution: number[]; certain: boolean }> => {
    const opts = optionsOf(q);
    if (opts.length > LETTERS.length) throw new Error(`a question can have at most ${LETTERS.length} options for ${model.modelId}`);
    const letters = opts.map((_, i) => LETTERS[i]!);
    const lines = opts.map((o, i) => `${letters[i]}. ${o.shown}`).join("\n");
    const question = `State:\n${text(state)}\n\nQuestion: ${text(q.instructions)}\n\nOptions:\n${lines}`;
    const call = { model, system: SYSTEM, temperature: 0, maxRetries: 0, ...(abortSignal ? { abortSignal } : {}) };
    const reasoning = await generateText({ ...call, prompt: `${question}\n\nFirst reason briefly (at most three sentences) about which option is true. Do not give the letter yet.`, maxOutputTokens: options.reasoningTokens ?? 192 });
    const result = await generateText({
      ...call,
      messages: [
        { role: "user", content: question },
        { role: "assistant", content: reasoning.text },
        { role: "user", content: "Now answer with the letter only." },
      ],
      maxOutputTokens: 8,
      providerOptions: { [HARNESS]: { ...constrain({ type: "json-schema", schema: { type: "string", enum: letters } }).providerOptions[HARNESS], ...withLogprobs(options.topLogprobs ?? 20).providerOptions[HARNESS] } },
    });
    const answered = result.text.trim().replace(/^"|"$/g, "");
    const index = letters.indexOf(answered);
    if (index < 0) throw new Error(`${model.modelId} answered ${JSON.stringify(result.text)}, not one of ${letters.join(", ")}`);
    // The first generated token that is an answer letter: the others at its position are the alternatives.
    const position = logprobsIn(result.providerMetadata)?.find((t) => letters.includes(t.token.trim().replace(/"/g, "")));
    const weights = letters.map((l) => (position?.top ?? []).filter((t) => t.token.trim().replace(/"/g, "") === l).reduce((sum, t) => sum + Math.exp(t.logprob), 0));
    const total = weights.reduce((a, b) => a + b, 0);
    if (total > 0) return { distribution: weights.map((w) => w / total), certain: false };
    return { distribution: letters.map((_, i) => (i === index ? 1 : 0)), certain: true };
  };
  return {
    specificationVersion: "v4",
    provider: "harness.generator-judge",
    modelId: model.modelId,
    supportedQuestionTypes: ["boolean", "choice", "score"],
    async doEvaluate({ state, questions, abortSignal }) {
      const answers: Record<string, Experimental_EvaluationModelV4Answer> = {};
      let certain = false;
      for (const [id, q] of Object.entries(questions)) {
        const { distribution, certain: took } = await ask(state, q, abortSignal);
        certain ||= took;
        if (q.type === "boolean") answers[id] = { type: "boolean", probability: distribution[0]! };
        else if (q.type === "choice") {
          const keys = Object.keys(q.criteria);
          const best = distribution.indexOf(Math.max(...distribution));
          answers[id] = { type: "choice", choice: keys[best]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, distribution[i]!])) };
        } else answers[id] = { type: "score", score: distribution.reduce((s, p, level) => s + p * level, 0), probabilities: Object.fromEntries(distribution.map((p, level) => [String(level), p])) };
      }
      return { answers, warnings: certain ? [{ type: "other", message: `${model.modelId} reported no token probabilities; its answers count as certain` }] : [] };
    },
  };
}
