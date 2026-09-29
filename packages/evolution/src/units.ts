import { z } from "zod";

/**
 * The units of evolution, as refined types (ADR 0003). A score is a verifier's reward for
 * one trial, or a mean of rewards, in [0, 1]; a cost is policy tokens (of a trial, or a
 * mean over trials). Differences of scores and relative cost changes are plain numbers:
 * they are neither a score nor a cost.
 */
export const ScoreSchema = z.number().min(0).max(1).brand<"Score">();
export type Score = z.output<typeof ScoreSchema>;

export const TokensSchema = z.number().min(0).brand<"Tokens">();
export type Tokens = z.output<typeof TokensSchema>;

function refine<S extends z.ZodType>(schema: S, what: string): (value: unknown) => z.output<S> {
  return (value) => {
    const result = schema.safeParse(value);
    if (!result.success) throw new RangeError(`not ${what}: ${JSON.stringify(value)}\n${z.prettifyError(result.error)}`);
    return result.data;
  };
}

export const score = refine(ScoreSchema, "a score");
export const tokens = refine(TokensSchema, "a number of tokens");
