import { gateway } from "@ai-sdk/gateway";
import type { Experimental_EvaluationModelV4, Experimental_EvaluationModelV4Question } from "@ai-sdk/provider";
import { experimental_evaluate as evaluate } from "ai";

/** Jev (TypeSafe AI), served through the Vercel AI Gateway. */
export const JEV_MODEL_ID = "typesafe-ai/jev";

export type Question = Experimental_EvaluationModelV4Question;
export type State = string | Readonly<Record<string, unknown>> | readonly unknown[];

export type Answer =
  | { readonly type: "boolean"; readonly probability: number }
  | { readonly type: "choice"; readonly choice: string; readonly probabilities?: Readonly<Record<string, number>> }
  | { readonly type: "score"; readonly score: number; readonly probabilities?: Readonly<Record<string, number>> };

export interface Judge {
  readonly identity: { readonly provider: string; readonly modelId: string };
  evaluate(input: { state: State; questions: Readonly<Record<string, Question>> }): Promise<Record<string, Answer>>;
}

/**
 * LLM-as-judge using Jev's typed judgments: boolean probabilities, choices with a
 * distribution, and rubric scores. Its confidence is evidence about one question,
 * not proof and not authorization.
 */
export class JevJudge implements Judge {
  readonly #model: Experimental_EvaluationModelV4;

  constructor(options: { model?: Experimental_EvaluationModelV4 } = {}) {
    this.#model = options.model ?? gateway.evaluationModel(JEV_MODEL_ID);
  }

  get identity(): { provider: string; modelId: string } {
    return { provider: this.#model.provider, modelId: this.#model.modelId };
  }

  async evaluate(input: { state: State; questions: Readonly<Record<string, Question>> }): Promise<Record<string, Answer>> {
    const result = await evaluate({
      model: this.#model,
      state: input.state as Parameters<typeof evaluate>[0]["state"],
      questions: input.questions,
      maxRetries: 1,
    });
    return result.answers as Record<string, Answer>;
  }
}
