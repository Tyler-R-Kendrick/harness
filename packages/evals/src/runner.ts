import { CognitiveError, wilsonInterval } from "@harness/cognitive";
import type { Ensemble } from "@harness/cognitive";
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

/** The judge for a run, or why there is none (every case is then blocked). */
export type JudgeChoice = { readonly judge: Judge } | { readonly judge?: undefined; readonly unavailable: string };

const PLACEHOLDERS = new Set(["", "resolved-by-runner", "unknown", "HEAD"]);
const NO_JUDGE = { provider: "none", modelId: "none" };

/**
 * The best judge the host can reach now: the ensemble's judgment models in order of
 * preference, each tried until one loads (a hosted model needs its credential, a local
 * one its server). Without one, the reasons each failed.
 */
export async function chooseJudge(ensemble: Ensemble): Promise<JudgeChoice> {
  try {
    const { id, port } = await ensemble.resolve("judgment", "judge");
    const { runtime } = ensemble.members().find((m) => m.id === id)!.descriptor;
    return { judge: { identity: { provider: runtime, modelId: id }, evaluate: (request) => port.evaluate(request) } };
  } catch (e) {
    if (!(e instanceof CognitiveError)) throw e;
    const reasons = ensemble.members().flatMap((m) => (m.descriptor.tasks.includes("judgment") && m.reason ? [`${m.id}: ${m.reason}`] : []));
    return { unavailable: `No judge could be reached${reasons.length ? `: ${reasons.join("; ")}` : ""}` };
  }
}

/** Run eval cases. No judge, or denied access, is `blocked`, never a pass. */
export async function runEvals(cases: readonly EvalCase[], choice: JudgeChoice, options: { sourceRevision?: string } = {}): Promise<EvalReport> {
  if (options.sourceRevision !== undefined && PLACEHOLDERS.has(options.sourceRevision)) {
    throw new Error(`source revision "${options.sourceRevision}" is a placeholder; pass the real commit`);
  }
  const startedAt = new Date().toISOString();
  const results: EvalResult[] = [];
  for (const c of cases) results.push(await runCase(c, choice));
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  const passed = count("passed");
  const failed = count("failed");
  return {
    schemaVersion: "harness.eval/v1",
    sourceRevision: options.sourceRevision,
    judge: choice.judge?.identity ?? NO_JUDGE,
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

async function runCase(c: EvalCase, choice: JudgeChoice): Promise<EvalResult> {
  const started = performance.now();
  const base = { id: c.id, description: c.description };
  const done = (rest: Omit<EvalResult, "id" | "description" | "durationMs">): EvalResult => ({ ...base, ...rest, durationMs: Math.round(performance.now() - started) });
  if (!choice.judge) return done({ verdict: "blocked", reason: choice.unavailable });
  const { judge } = choice;
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
