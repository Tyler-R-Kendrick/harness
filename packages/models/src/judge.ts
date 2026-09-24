import { gateway } from "@ai-sdk/gateway";
import type { Experimental_EvaluationModelV4 } from "@ai-sdk/provider";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { experimental_evaluate as evaluate } from "ai";
import { z } from "zod";
import { JudgeAnswerSchema } from "@harness/cognitive";
import type { Judge, JudgeAnswer, JudgeRequest } from "@harness/cognitive";

const Answers = z.record(z.string(), JudgeAnswerSchema);

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

/**
 * A judge over any AI SDK evaluation model: typed judgments as boolean probabilities,
 * choices with a distribution, and rubric scores. Its confidence is evidence about one
 * question, not proof and not authorization.
 */
export class EvaluationJudge implements Judge {
  readonly #model: Experimental_EvaluationModelV4;

  constructor(model: Experimental_EvaluationModelV4) {
    this.#model = model;
  }

  get identity(): { provider: string; modelId: string } {
    return { provider: this.#model.provider, modelId: this.#model.modelId };
  }

  async evaluate(input: JudgeRequest): Promise<Record<string, JudgeAnswer>> {
    const result = await evaluate({
      model: this.#model,
      state: input.state as Parameters<typeof evaluate>[0]["state"],
      questions: input.questions,
      maxRetries: 1,
    });
    const answers = Answers.safeParse(result.answers);
    if (!answers.success) throw new Error(`the model's judge answers are not valid\n${z.prettifyError(answers.error)}`);
    return answers.data;
  }
}
