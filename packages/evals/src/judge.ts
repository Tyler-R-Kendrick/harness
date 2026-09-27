import type { Experimental_EvaluationModel as EvaluationModel } from "ai";
import type { JudgeAnswer, JudgeQuestion } from "@harness/cognitive";

export type Answer = JudgeAnswer;
export type Question = JudgeQuestion;
/** What a judge is shown; it goes to the judge as JSON. */
export type State = string | Readonly<Record<string, unknown>> | readonly unknown[];

/** A judge the eval runner can report on: an AI SDK evaluation model, and the model it is. */
export interface Judge {
  readonly identity: { readonly provider: string; readonly modelId: string };
  readonly model: EvaluationModel;
}
