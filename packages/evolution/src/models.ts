import { experimental_evaluate, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import type { Experimental_EvaluationModel as EvaluationModel, LanguageModel } from "ai";
import { ProbabilitySchema } from "@harness/cognitive";
import type { CriticRequest, CriticVerdict, ProposalRequest } from "./evolution.ts";
import type { Settings } from "./schemas.ts";
import { ProposalSchema } from "./surface.ts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A proposer on any AI SDK language model: the round's request as the prompt, answered
 * as a Proposal constrained to its JSON Schema (models that enforce constraints spend
 * tokens only on the edits). An answer that is not a proposal comes back as the reason,
 * which the round sends to the next attempt.
 */
export function modelProposer(model: LanguageModel, settings: Settings["proposer"]): (request: ProposalRequest) => Promise<unknown> {
  return async (request) => {
    try {
      const { output } = await generateText({ model, instructions: settings.system, prompt: JSON.stringify(request), maxOutputTokens: settings.maxTokens, maxRetries: 0, output: Output.object({ schema: ProposalSchema }) });
      return output;
    } catch (e) {
      if (NoObjectGeneratedError.isInstance(e) || NoOutputGeneratedError.isInstance(e)) return message(e);
      throw e;
    }
  };
}

/**
 * The model half of the leakage screen, on any AI SDK evaluation model: asked whether the
 * edits encode knowledge only these tasks need, it refuses them when the probability
 * reaches the threshold. A critic that cannot answer refuses too: the screen runs before
 * any evaluation is spent, and an unscreened candidate is what it exists to stop. Use a
 * judge from another family than the proposer's model where one is reachable: a critic
 * that shares the proposer's blind spots screens little (the paper uses one model for
 * both).
 */
export function judgeCritic(model: EvaluationModel, settings: Settings["critic"]): (request: CriticRequest) => Promise<CriticVerdict> {
  return async ({ edits, examples }) => {
    try {
      const { answers } = await experimental_evaluate({
        model,
        maxRetries: 0,
        state: { edits: edits.map((e) => ({ hypothesis: e.hypothesis, targets: e.targets, changes: e.changes.map((c) => ({ document: c.document, wrote: c.wrote })) })), examples: examples.map((t) => t.text) },
        questions: { specific: { type: "boolean", instructions: settings.question } },
      });
      const p = ProbabilitySchema.parse(answers.specific.probability);
      return p >= settings.threshold ? { accept: false, reasons: [`it reads as specific to the evolve tasks (p = ${p.toFixed(2)})`] } : { accept: true, reasons: [] };
    } catch (e) {
      return { accept: false, reasons: [`the critic could not judge it: ${message(e)}`] };
    }
  };
}
