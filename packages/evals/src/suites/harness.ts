import { gateway } from "@ai-sdk/gateway";
import type { LanguageModel } from "ai";
import { ModelWorker } from "@harness/workers";
import { BlockedError } from "../runner.ts";
import type { EvalCase } from "../runner.ts";
import { runSession } from "../session.ts";
import type { TurnResult } from "../session.ts";

/** Free model on the Vercel AI Gateway used as the default subject under test. */
export const DEFAULT_SUBJECT_MODEL = "inclusionai/ling-3.0-flash-fin";

export type ModelFactory = (modelId: string) => LanguageModel;

async function converse(model: LanguageModel, prompts: readonly string[]): Promise<TurnResult[]> {
  const turns = await runSession(new ModelWorker({ model, system: "You are a concise assistant." }), prompts);
  const failure = turns.flatMap((t) => t.notices).find((n) => n.severity === "error");
  if (failure) {
    const detail = `${failure.title}: ${failure.description ?? ""}`;
    if (/\b(401|403)\b|unauthori[sz]ed|forbidden|authentication|api key|credential/i.test(detail)) throw new BlockedError(detail);
    throw new Error(detail);
  }
  return turns;
}

/**
 * End-to-end harness behavior: prompts go through the real daemon core and the
 * in-process model worker, and Jev judges the outcome.
 */
export function harnessSuite(modelId = DEFAULT_SUBJECT_MODEL, makeModel: ModelFactory = (id) => gateway(id)): readonly EvalCase[] {
  const converseWith = (prompts: readonly string[]) => converse(makeModel(modelId), prompts);
  return [
    {
      id: "harness.answers-question",
      description: "A prompt through the daemon gets a correct answer",
      subject: async () => {
        const [turn] = await converseWith(["What is the capital of France? Answer in one word."]);
        return { prompt: turn!.prompt, reply: turn!.reply };
      },
      questions: { paris: { type: "boolean", instructions: "Does `reply` state that the capital of France is Paris?" } },
      expect: { paris: { type: "boolean", expect: true } },
    },
    {
      id: "harness.multi-turn-context",
      description: "The session keeps context across turns",
      subject: async () => {
        const turns = await converseWith(["My name is Ada. Reply with just OK.", "What is my name?"]);
        return { turns: turns.map((t) => ({ user: t.prompt, assistant: t.reply })) };
      },
      questions: { remembers: { type: "boolean", instructions: "In the last entry of `turns`, does the assistant correctly say the user's name is Ada?" } },
      expect: { remembers: { type: "boolean", expect: true } },
    },
    {
      id: "harness.turn-completes",
      description: "Turns end normally rather than being cut off",
      subject: async () => {
        const [turn] = await converseWith(["Name three primary colors, comma-separated."]);
        return { reply: turn!.reply, stopReason: turn!.stopReason ?? "none" };
      },
      questions: { complete: { type: "boolean", instructions: "Is `reply` a complete answer naming three colors, and is `stopReason` equal to end_turn?" } },
      expect: { complete: { type: "boolean", expect: true } },
    },
  ];
}

