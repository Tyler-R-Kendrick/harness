import { gateway } from "@ai-sdk/gateway";
import type { Experimental_EvaluationModelV4 } from "@ai-sdk/provider";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { experimental_evaluate as evaluate } from "ai";
import type { Judge, JudgeAnswer, JudgeRequest } from "@harness/cognitive";

/** Jev (TypeSafe AI), served through the Vercel AI Gateway. */
export const JEV_MODEL_ID = "typesafe-ai/jev";

export const jev = (): Experimental_EvaluationModelV4 => gateway.evaluationModel(JEV_MODEL_ID);

export interface ClmOptions {
  /** clm-serve's address (default CLM_BASE_URL, else http://127.0.0.1:8700). */
  readonly baseUrl?: string;
  /** Needed only when clm-serve was started with CLM_API_KEY. */
  readonly apiKey?: string;
  readonly model?: string;
  readonly fetch?: typeof fetch;
}

const clmBase = (options: ClmOptions) => (options.baseUrl ?? process.env["CLM_BASE_URL"] ?? "http://127.0.0.1:8700").replace(/\/$/, "");

/**
 * CLM (Contrastive-LM), the local alternative to Jev: clm-serve answers the same typed
 * questions on TypeSafe's API, so TypeSafe's own AI SDK provider talks to it.
 */
export function clm(options: ClmOptions = {}): Experimental_EvaluationModelV4 {
  return createTypeSafeAi({
    baseURL: `${clmBase(options)}/v1`,
    // The provider requires a key; clm-serve ignores it unless it was started with one.
    apiKey: options.apiKey ?? process.env["CLM_API_KEY"] ?? "none",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }).evaluationModel(options.model ?? "clm-latest");
}

/** Whether clm-serve answers its health check. */
export async function clmAvailable(options: ClmOptions = {}): Promise<boolean> {
  try {
    return (await (options.fetch ?? fetch)(`${clmBase(options)}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/**
 * A judge over any AI SDK evaluation model (Jev by default, or CLM): typed judgments as
 * boolean probabilities, choices with a distribution, and rubric scores. Its confidence
 * is evidence about one question, not proof and not authorization.
 */
export class EvaluationJudge implements Judge {
  readonly #model: Experimental_EvaluationModelV4;

  constructor(model: Experimental_EvaluationModelV4 = jev()) {
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
    return result.answers as Record<string, JudgeAnswer>;
  }
}
