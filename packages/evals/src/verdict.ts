import type { Answer } from "./judge.ts";

export type Verdict = "passed" | "failed" | "inconclusive" | "blocked";

export type Expectation =
  /** Pass when the judge's probability clearly agrees; fail when it clearly disagrees. */
  | { readonly type: "boolean"; readonly expect: boolean; readonly pass?: number; readonly fail?: number }
  | { readonly type: "choice"; readonly expect: string; readonly minProbability?: number }
  | { readonly type: "score"; readonly min?: number; readonly max?: number };

/**
 * Map one typed answer to a verdict. The band between the pass and fail thresholds is
 * inconclusive on purpose: an uncertain judgment is not a vote in either direction.
 */
export function questionVerdict(expectation: Expectation, answer: Answer | undefined): Exclude<Verdict, "blocked"> {
  if (!answer || answer.type !== expectation.type) return "inconclusive";
  if (expectation.type === "boolean" && answer.type === "boolean") {
    const pass = expectation.pass ?? 0.8;
    const fail = expectation.fail ?? 0.5;
    const agree = expectation.expect ? answer.probability : 1 - answer.probability;
    if (agree >= pass) return "passed";
    return agree <= fail ? "failed" : "inconclusive";
  }
  if (expectation.type === "choice" && answer.type === "choice") {
    if (answer.choice !== expectation.expect) return "failed";
    const p = answer.probabilities?.[answer.choice];
    return p === undefined || p >= (expectation.minProbability ?? 0.6) ? "passed" : "inconclusive";
  }
  const score = (answer as { score: number }).score;
  const e = expectation as { min?: number; max?: number };
  return score >= (e.min ?? Number.NEGATIVE_INFINITY) && score <= (e.max ?? Number.POSITIVE_INFINITY) ? "passed" : "failed";
}

export function caseVerdict(verdicts: readonly Exclude<Verdict, "blocked">[]): Exclude<Verdict, "blocked"> {
  if (verdicts.includes("failed")) return "failed";
  if (verdicts.length === 0 || verdicts.includes("inconclusive")) return "inconclusive";
  return "passed";
}
