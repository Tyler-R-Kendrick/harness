import { experimental_evaluate, generateText } from "ai";
import type { Experimental_EvaluationModelV4Input as EvaluationModelV4Input, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { Ensemble } from "./ensemble.ts";
import type { FrontierDomain, FrontierJudge } from "./frontier.ts";
import type { TaskCategory } from "./models.ts";
import type { JudgeQuestion } from "./ports.ts";
import { ProbabilitySchema } from "./units.ts";

export interface FrontierSetup<S> {
  readonly domain: FrontierDomain<S>;
  readonly judge: FrontierJudge<S>;
}

type RankQuestion = Exclude<JudgeQuestion, { type: "choice" }>;

interface FrontierArgs<S> {
  readonly ensemble: Ensemble;
  readonly question: JudgeQuestion;
  readonly evaluationState: (state: S) => EvaluationModelV4Input;
  readonly start: S;
  readonly key: FrontierDomain<S>["key"];
  readonly compare: FrontierDomain<S>["compare"];
  readonly isGoal: FrontierDomain<S>["isGoal"];
  readonly isDead: FrontierDomain<S>["isDead"];
}

function rankQuestion(question: JudgeQuestion): RankQuestion {
  if (question.type === "choice") throw new TypeError("frontier question must be boolean or score");
  return question;
}

function outputTokens(total: number | undefined): number {
  if (total === undefined) return 0;
  if (!Number.isFinite(total) || total < 0) throw new TypeError("frontier output tokens must be a finite number >= 0");
  return total;
}

async function rank(ensemble: Ensemble, question: RankQuestion, state: EvaluationModelV4Input): Promise<number> {
  const result = await experimental_evaluate({
    model: ensemble.evaluationModel(),
    maxRetries: 0,
    state,
    questions: { rank: question },
  });
  const answer = result.answers.rank;
  if (question.type === "boolean") {
    // Stryker disable next-line LogicalOperator: equivalent; experimental_evaluate has already rejected a missing or non-boolean answer, so both sides are false here
    if (answer === undefined || answer.type !== "boolean") throw new TypeError("frontier judge answer must match the question");
    return ProbabilitySchema.parse(answer.probability);
  }
  // Stryker disable next-line LogicalOperator: equivalent; experimental_evaluate has already rejected a missing, non-score, or non-finite answer
  if (answer === undefined || answer.type !== "score" || !Number.isFinite(answer.score)) throw new TypeError("frontier score must be a finite number");
  return answer.score;
}

function judged<S>(args: FrontierArgs<S>, question: RankQuestion, propose: FrontierDomain<S>["propose"]): FrontierSetup<S> {
  return {
    domain: {
      start: args.start,
      key: args.key,
      compare: args.compare,
      isGoal: args.isGoal,
      isDead: args.isDead,
      propose,
      judgeCost: (states) => (args.ensemble.serves("judgment", "judge") ? states.length : 0),
    },
    judge: async (states) => {
      if (!args.ensemble.serves("judgment", "judge")) return null;
      const scores: number[] = [];
      for (const state of states) scores.push(await rank(args.ensemble, question, args.evaluationState(state)));
      return scores;
    },
  };
}

/** Listed moves cost nothing and never call a generator. */
export function listedFrontier<S>(args: FrontierArgs<S> & { readonly children: (state: S) => readonly S[] }): FrontierSetup<S> {
  const question = rankQuestion(args.question);
  return judged(args, question, (state) => ({ children: args.children(state), cost: 0 }));
}

/** One generator call per live state. The prompt is that state alone, and the propose cost is its output-token count. */
export function openFrontier<S>(args: FrontierArgs<S> & {
  readonly render: (state: S) => string;
  readonly parse: (text: string) => readonly S[];
  readonly task: TaskCategory;
  readonly providerOptions?: SharedV4ProviderOptions;
}): FrontierSetup<S> {
  const question = rankQuestion(args.question);
  return judged(args, question, async (state) => {
    const result = await generateText({
      model: args.ensemble.languageModel(args.task),
      prompt: args.render(state),
      maxRetries: 0,
      ...(args.providerOptions === undefined ? {} : { providerOptions: args.providerOptions }),
    });
    return { children: args.parse(result.text), cost: outputTokens(result.usage.outputTokens) };
  });
}
