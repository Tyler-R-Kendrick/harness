/**
 * Answers built by hand for the improvement loops' tests, so that they depend only on
 * the shared vocabulary (types.ts): distributions from weights, and the three answer kinds.
 */
import { probability } from "@harness/cognitive";
import { DecisionIdSchema, forkId } from "../src/types.ts";
import type { Answer, Answers, Asked, DecisionRecord, Json, Member, Outcome } from "../src/types.ts";

/** An answer of a question type from non-negative weights: normalized, first heaviest option on top, a score's expected level. */
export function answer(type: Answer["type"], weights: Readonly<Record<string, number>>): Answer {
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  const distribution = Object.fromEntries(Object.entries(weights).map(([option, w]) => [option, probability(w / total)]));
  let top = "";
  let best = -1;
  for (const [option, p] of Object.entries(distribution)) {
    if (p > best) {
      best = p;
      top = option;
    }
  }
  if (type !== "score") return { type, distribution, top };
  return { type, distribution, top, score: Object.entries(distribution).reduce((sum, [level, p]) => sum + Number(level) * p, 0) };
}

/** A boolean answer with P(true) = p. */
export const yes = (p: number): Answer => answer("boolean", { true: p, false: 1 - p });

/** A score answer over levels 0..n-1 from weights in level order. */
export const levels = (weights: readonly number[]): Answer => answer("score", Object.fromEntries(weights.map((w, i) => [String(i), w])));

/** A choice answer over the options' weights. */
export const chose = (weights: Readonly<Record<string, number>>): Answer => answer("choice", weights);

/** A member that answers by a function of what it is asked, remembering the calls. */
export function memberOf(id: string, reply: (asked: Asked, call: number) => Answers | Promise<Answers>, version = "v1"): Member & { readonly calls: Asked[] } {
  const calls: Asked[] = [];
  return {
    id,
    version,
    calls,
    async ask(asked) {
      calls.push(asked);
      return reply(asked, calls.length - 1);
    },
  };
}

/**
 * A value made each time it is used. A module-level value that fails to build fails the
 * whole test file at load, which a mutation run cannot count as a test failing; behind
 * this, the failure happens inside the tests that use it. It is made afresh on every use
 * (never kept) so that what its construction runs counts as covered by each test that
 * uses it, not only the first.
 */
export function lazy<T extends object>(make: () => T): T {
  return new Proxy({} as T, { get: (_, key) => Reflect.get(make(), key) });
}

// ---- records ----------------------------------------------------------------------------------------------

let counter = 0;

/** A decision record with every field present, and the given ones changed. Ids count up from `dec-0` unless given. */
export function record(patch: Partial<Omit<DecisionRecord, "id">> & { readonly id?: number } = {}): DecisionRecord {
  const { id, ...rest } = patch;
  const n = id ?? counter++;
  return {
    id: DecisionIdSchema.parse(`dec-${n}`),
    fork: forkId("test.gate"),
    forkVersion: "f1",
    at: 1000 + n,
    input: { text: `input ${n}` },
    rung: "model",
    policy: "p1",
    answers: { q: yes(0.9) },
    action: "allow",
    confidence: probability(0.9),
    propensity: probability(1),
    explored: false,
    mode: "active",
    trace: [],
    ...rest,
  };
}

/** An outcome from a person. */
export const outcome = (kind: Outcome["kind"], extra: { readonly correct?: boolean; readonly label?: Json } = {}): Outcome => ({ at: 2000, source: "human", kind, ...extra });
