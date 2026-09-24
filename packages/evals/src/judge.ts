import type { Judge as CognitiveJudge, JudgeAnswer, JudgeQuestion, JudgeState } from "@harness/cognitive";

export { clm, EvaluationJudge, JEV_MODEL_ID, jev } from "@harness/models";

export type Answer = JudgeAnswer;
export type Question = JudgeQuestion;
export type State = JudgeState;

/** A judge the eval runner can report on: a cognitive judge that names its model. */
export interface Judge extends CognitiveJudge {
  readonly identity: { readonly provider: string; readonly modelId: string };
}
