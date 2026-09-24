import { wilsonInterval } from "@harness/cognitive";
import { clm, clmAvailable, EvaluationJudge, jev } from "@harness/models";
import type { ClmOptions } from "@harness/models";
import type { Answer, Judge, Question, State } from "./judge.ts";
import { caseVerdict, questionVerdict } from "./verdict.ts";
import type { Expectation, Verdict } from "./verdict.ts";

export interface EvalCase {
  readonly id: string;
  readonly description: string;
  /** Produce the state to judge, typically by running the harness. */
  readonly subject: () => Promise<State>;
  readonly questions: Readonly<Record<string, Question>>;
  readonly expect: Readonly<Record<string, Expectation>>;
}

export interface EvalResult {
  readonly id: string;
  readonly description: string;
  readonly verdict: Verdict;
  readonly reason?: string;
  readonly state?: State;
  readonly answers?: Record<string, Answer>;
  readonly questionVerdicts?: Record<string, Exclude<Verdict, "blocked">>;
  readonly durationMs: number;
}

export interface EvalReport {
  readonly schemaVersion: "harness.eval/v1";
  readonly sourceRevision: string | undefined;
  readonly judge: { readonly provider: string; readonly modelId: string };
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly results: readonly EvalResult[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly inconclusive: number;
    readonly blocked: number;
    /** Pass rate over decided (passed + failed) cases, with a 95% Wilson interval. */
    readonly passRate: { readonly successes: number; readonly trials: number; readonly interval: [number, number] };
  };
}

/** Thrown by a subject that cannot run without access it does not have. */
export class BlockedError extends Error {}

/** How the judge is reached: an AI Gateway credential for Jev, or a local clm-serve for CLM. */
export type Credential = "api-key" | "oidc" | "local";

export function resolveGatewayCredential(env: Readonly<Record<string, string | undefined>>): Credential | undefined {
  if (env["AI_GATEWAY_API_KEY"]) return "api-key";
  if (env["VERCEL_OIDC_TOKEN"]) return "oidc";
  return undefined;
}

const PLACEHOLDERS = new Set(["", "resolved-by-runner", "unknown", "HEAD"]);
const NO_CREDENTIAL = "No judge: set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN for Jev, or run clm-serve (CLM_BASE_URL) for CLM";

/** Jev when there is an AI Gateway credential; otherwise CLM when clm-serve answers; otherwise none, and cases are blocked. */
export async function chooseJudge(env: Readonly<Record<string, string | undefined>>, options: { readonly clm?: ClmOptions } = {}): Promise<{ judge: Judge; credential: Credential | undefined }> {
  const credential = resolveGatewayCredential(env);
  if (credential) return { judge: new EvaluationJudge(jev()), credential };
  if (await clmAvailable(options.clm)) return { judge: new EvaluationJudge(clm(options.clm)), credential: "local" };
  return { judge: new EvaluationJudge(jev()), credential: undefined };
}

/** Run eval cases. A missing credential or denied access is `blocked`, never a pass. */
export async function runEvals(
  cases: readonly EvalCase[],
  judge: Judge,
  options: { credential: Credential | undefined; sourceRevision?: string },
): Promise<EvalReport> {
  if (options.sourceRevision !== undefined && PLACEHOLDERS.has(options.sourceRevision)) {
    throw new Error(`source revision "${options.sourceRevision}" is a placeholder; pass the real commit`);
  }
  const startedAt = new Date().toISOString();
  const results: EvalResult[] = [];
  for (const c of cases) results.push(await runCase(c, judge, options.credential));
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  const passed = count("passed");
  const failed = count("failed");
  return {
    schemaVersion: "harness.eval/v1",
    sourceRevision: options.sourceRevision,
    judge: judge.identity,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      passed,
      failed,
      inconclusive: count("inconclusive"),
      blocked: count("blocked"),
      passRate: { successes: passed, trials: passed + failed, interval: wilsonInterval(passed, passed + failed) },
    },
  };
}

async function runCase(c: EvalCase, judge: Judge, credential: Credential | undefined): Promise<EvalResult> {
  const started = performance.now();
  const base = { id: c.id, description: c.description };
  const done = (rest: Omit<EvalResult, "id" | "description" | "durationMs">): EvalResult => ({ ...base, ...rest, durationMs: Math.round(performance.now() - started) });
  if (credential === undefined) return done({ verdict: "blocked", reason: NO_CREDENTIAL });
  let state: State;
  try {
    state = await c.subject();
  } catch (e) {
    if (e instanceof BlockedError) return done({ verdict: "blocked", reason: e.message });
    return done({ verdict: "failed", reason: `subject failed: ${message(e)}` });
  }
  let answers: Record<string, Answer>;
  try {
    answers = await judge.evaluate({ state, questions: c.questions });
  } catch (e) {
    return done({ verdict: isAccessError(e) ? "blocked" : "inconclusive", reason: `judge failed: ${message(e)}`, state });
  }
  const questionVerdicts = Object.fromEntries(Object.entries(c.expect).map(([id, exp]) => [id, questionVerdict(exp, answers[id])]));
  return done({ verdict: caseVerdict(Object.values(questionVerdicts)), state, answers, questionVerdicts });
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Authentication/authorization failures, possibly wrapped (e.g. in a retry error). */
export function isAccessError(e: unknown, depth = 0): boolean {
  if (typeof e !== "object" || e === null || depth > 4) return false;
  const err = e as { statusCode?: unknown; name?: unknown; cause?: unknown; errors?: unknown; lastError?: unknown };
  if (err.statusCode === 401 || err.statusCode === 403) return true;
  if (err.name === "GatewayAuthenticationError" || err.name === "GatewayForbiddenError") return true;
  const nested = [err.cause, err.lastError, ...(Array.isArray(err.errors) ? err.errors : [])];
  return nested.some((n) => isAccessError(n, depth + 1));
}
