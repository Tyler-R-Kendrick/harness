/**
 * Members and the conversions around them: the AI SDK's evaluation answers to the layer's
 * `Answer` (a distribution over the question's own option keys) and back, the rotations
 * of a choice question that cancel position bias, and `evaluationMember`, which turns any
 * AI SDK evaluation model into a `Member` with a pinned id and version.
 *
 * Option keys: a boolean's are `"true"` and `"false"`, a choice's are its criteria names,
 * a score's are its level indexes `"0"` to `"n-1"`.
 */
import { experimental_evaluate } from "ai";
import type { Experimental_EvaluationModelV4 as EvaluationModel } from "@ai-sdk/provider";
import { JudgeAnswerSchema, probability } from "@harness/cognitive";
import type { JudgeAnswer, JudgeQuestion } from "@harness/cognitive";
import { answerOfDistribution, booleanDistribution, distributionFromWeights, expectedLevel } from "./distribution.ts";
import { DecisionError } from "./types.ts";
import type { Answer, Answers, Asked, Member } from "./types.ts";

type ChoiceQuestion = Extract<JudgeQuestion, { type: "choice" }>;

/** An answer of a question type from non-negative weights: normalized, the first heaviest option on top, a score's expected level. */
export const answerOf = (type: Answer["type"], weights: Readonly<Record<string, number>>): Answer => answerOfDistribution(type, distributionFromWeights(weights));

const mismatch = (question: { readonly type: string }, answer: { readonly type: string }) => new RangeError(`a ${answer.type} answer does not fit a ${question.type} question`);

function sameKeys(actual: readonly string[], expected: readonly string[], what: string): void {
  if (actual.length !== expected.length || !expected.every((key) => actual.includes(key))) {
    throw new RangeError(`the answer is over ${what} [${actual.join(", ")}] but the question has [${expected.join(", ")}]`);
  }
}

/** Probabilities in the question's own option order, refused when they are over other options. */
function inOrder(probabilities: Readonly<Record<string, number>>, keys: readonly string[], what: string): Record<string, number> {
  sameKeys(Object.keys(probabilities), keys, what);
  return Object.fromEntries(keys.map((key) => [key, probabilities[key]!]));
}

const levelKeys = (levels: number): string[] => Array.from({ length: levels }, (_, level) => String(level));

/** A score with no probabilities as the two neighboring levels whose mean is the score. */
function neighbors(score: number, keys: readonly string[]): Record<string, number> {
  const low = Math.floor(score);
  const high = score - low;
  return Object.fromEntries(keys.map((key, level) => [key, level === low ? 1 - high : level === low + 1 ? high : 0]));
}

/**
 * The AI SDK's answer to a question as an `Answer` over that question's own option keys.
 * A choice without probabilities is one-hot; a score without probabilities is spread over
 * the two levels beside it so that its mean is the score. Answers the question cannot
 * have given are refused with a RangeError.
 */
export function fromJudgeAnswer(question: JudgeQuestion, answer: JudgeAnswer): Answer {
  if (answer.type === "boolean") {
    if (question.type !== "boolean") throw mismatch(question, answer);
    return answerOfDistribution("boolean", booleanDistribution(answer.probability));
  }
  if (answer.type === "choice") {
    if (question.type !== "choice") throw mismatch(question, answer);
    const keys = Object.keys(question.criteria);
    if (!keys.includes(answer.choice)) throw new RangeError(`"${answer.choice}" is not one of the question's options`);
    return answerOf("choice", answer.probabilities ? inOrder(answer.probabilities, keys, "options") : Object.fromEntries(keys.map((key) => [key, key === answer.choice ? 1 : 0])));
  }
  if (question.type !== "score") throw mismatch(question, answer);
  const keys = levelKeys(question.criteria.length);
  if (!(answer.score >= 0 && answer.score <= keys.length - 1)) throw new RangeError(`a score is between 0 and ${keys.length - 1}, got ${answer.score}`);
  return answerOf("score", answer.probabilities ? inOrder(answer.probabilities, keys, "levels") : neighbors(answer.score, keys));
}

/** The inverse of `fromJudgeAnswer`: an `Answer` to the question as the AI SDK's answer to it. */
export function toJudgeAnswer(question: JudgeQuestion, answer: Answer): JudgeAnswer {
  if (question.type !== answer.type) throw mismatch(question, answer);
  const options = Object.keys(answer.distribution);
  if (question.type === "boolean") {
    sameKeys(options, ["true", "false"], "options");
    return { type: "boolean", probability: answer.distribution["true"]! };
  }
  if (question.type === "choice") {
    sameKeys(options, Object.keys(question.criteria), "options");
    return { type: "choice", choice: answer.top, probabilities: answer.distribution };
  }
  sameKeys(options, levelKeys(question.criteria.length), "levels");
  return { type: "score", score: answer.score ?? expectedLevel(answer.distribution), probabilities: answer.distribution };
}

// ---- rotations ---------------------------------------------------------------------------------

function rotateChoice(question: ChoiceQuestion, k: number): ChoiceQuestion {
  const keys = Object.keys(question.criteria);
  const shift = (k % keys.length) + keys.length;
  return { ...question, criteria: Object.fromEntries(keys.map((_, i) => keys[(i + shift) % keys.length]!).map((key) => [key, question.criteria[key]!])) };
}

/**
 * The k-th rotation of a choice question's option order (the first k options moved to the
 * end), which cancels a model's bias towards a position when the answers are averaged.
 * Score and boolean questions have an order that means something, so they are returned as
 * they are. Options named by whole numbers keep JavaScript's property order and cannot be
 * reordered.
 */
export function rotateQuestion(question: JudgeQuestion, k: number): JudgeQuestion {
  if (!Number.isInteger(k)) throw new RangeError(`a rotation is a whole number, got ${k}`);
  return question.type === "choice" ? rotateChoice(question, k) : question;
}

/** Up to `count` distinct rotations of a question, the original first; a question that cannot be rotated has only itself. */
export function rotations(question: JudgeQuestion, count: number): JudgeQuestion[] {
  if (!Number.isInteger(count) || count < 1) throw new RangeError(`the number of rotations is a whole number from 1, got ${count}`);
  if (question.type !== "choice") return [question];
  const orders = new Set<string>();
  const distinct: JudgeQuestion[] = [];
  for (let k = 0; k < Math.min(count, Object.keys(question.criteria).length); k++) {
    const rotated = rotateChoice(question, k);
    const order = JSON.stringify(Object.keys(rotated.criteria));
    if (!orders.has(order)) distinct.push(rotated);
    orders.add(order);
  }
  return distinct;
}

/** The mean of answers to the same question (asked in different rotations), in the first answer's option order. */
export function averageAnswers(answers: readonly Answer[]): Answer {
  const [first] = answers;
  if (first === undefined) throw new RangeError("there are no answers to average");
  const options = Object.keys(first.distribution);
  for (const answer of answers) {
    if (answer.type !== first.type) throw new RangeError(`answers of different types cannot be averaged: ${first.type} and ${answer.type}`);
    sameKeys(Object.keys(answer.distribution), options, "the same options");
  }
  const mean = options.map((option) => [option, probability(answers.reduce((sum, answer) => sum + answer.distribution[option]!, 0) / answers.length)] as const);
  return answerOfDistribution(first.type, Object.fromEntries(mean));
}

// ---- the AI SDK's evaluation model as a member ---------------------------------------------------

/**
 * Any AI SDK evaluation model as a member. All questions go in one `experimental_evaluate`
 * call (no retries: the ladder passes a failing member up instead), and each answer is
 * converted to a distribution over its question's options. An answer the question cannot
 * have is a rejection, which the ladder records and passes over.
 */
export function evaluationMember(model: EvaluationModel, identity: { readonly id: string; readonly version: string }): Member {
  return {
    id: identity.id,
    version: identity.version,
    async ask(asked: Asked): Promise<Answers> {
      const result = await experimental_evaluate({ model, state: asked.state, questions: asked.questions, maxRetries: 0 });
      return Object.fromEntries(
        Object.entries(asked.questions).map(([id, question]) => {
          try {
            return [id, fromJudgeAnswer(question, JudgeAnswerSchema.parse(result.answers[id]))];
          } catch (e) {
            throw new DecisionError("invalid", `${identity.id} gave an unusable answer to "${id}": ${(e as Error).message}`);
          }
        }),
      );
    },
  };
}
