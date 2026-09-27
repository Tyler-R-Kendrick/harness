import type { Experimental_EvaluationModelV4, Experimental_EvaluationModelV4CallOptions } from "@ai-sdk/provider";

type Answer = { type: "boolean"; probability: number } | { type: "choice"; choice: string; probabilities?: Record<string, number> } | { type: "score"; score: number };

/** A scripted EvaluationModelV4 standing in for a judge model in deterministic tests. */
export class FakeEvaluationModel implements Experimental_EvaluationModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = "fake";
  readonly modelId = "fake-judge";
  readonly supportedQuestionTypes = ["boolean", "choice", "score"] as const;
  readonly calls: Experimental_EvaluationModelV4CallOptions[] = [];
  readonly #answer: (options: Experimental_EvaluationModelV4CallOptions) => Record<string, Answer>;

  constructor(answer: (options: Experimental_EvaluationModelV4CallOptions) => Record<string, Answer>) {
    this.#answer = answer;
  }

  async doEvaluate(options: Experimental_EvaluationModelV4CallOptions) {
    this.calls.push(options);
    return { answers: this.#answer(options), warnings: [], usage: { inputTokens: 10, outputTokens: 0 } };
  }
}
