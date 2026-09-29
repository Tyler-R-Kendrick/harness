// One level-synchronous frontier over explicit states. Width and budget are arguments.
// A round that admits nothing, or that adds no cost and finds no goal, returns.
// Votes are an order key, not a probability.

export interface FrontierDomain<S> {
  readonly start: S;
  /** Equal keys merge. Order is UTF-16 (`a < b`). */
  key(state: S): string;
  /**
   * Total order for the survivor inside one key.
   * Negative means `a` survives over `b`. 0 or NaN throws.
   */
  compare(a: S, b: S): number;
  /** Constant on a key. Checked on the survivor. */
  isGoal(state: S): boolean;
  /** Constant on a key. A dead goal is dead, not solved. */
  isDead(state: S): boolean;
  /** Executed children, best rank first (index 0 votes 1). */
  propose(state: S): { readonly children: readonly S[]; readonly cost: number } | Promise<{ readonly children: readonly S[]; readonly cost: number }>;
  /** Finite judge cost >= 0 for this merged set, same unit. Not used when the set is empty. */
  judgeCost(states: readonly S[]): number;
}

export interface FrontierLimits {
  /** Integer >= 1. How many open states advance. Not a function of `budget`. */
  readonly width: number;
  /** Finite and >= 0. A round starts only while `cost < budget`. */
  readonly budget: number;
}

/** `null` means order by votes. Numbers are not probabilities. */
export type FrontierJudge<S> = (states: readonly S[]) => readonly number[] | null | Promise<readonly number[] | null>;

export type FrontierResult<S> =
  | { readonly solved: true; readonly state: S; readonly cost: number; readonly rounds: number; readonly orderedBy: "score" | "votes" | "start" }
  | { readonly solved: false; readonly cost: number; readonly rounds: number; readonly reason: "budget" | "no-progress" };

interface Entry<S> {
  key: string;
  state: S;
  vote: number;
}

function requireKey(key: unknown): string {
  if (typeof key !== "string") throw new TypeError("frontier key must be a string");
  return key;
}

function requireCost(cost: unknown): number {
  // Stryker disable next-line CallExpression,ConditionalExpression,StringLiteral: equivalent; Number.isFinite is false for every non-number, so the next line still throws
  if (typeof cost !== "number") throw new TypeError("frontier cost must be a finite number >= 0");
  if (!Number.isFinite(cost) || cost < 0) throw new TypeError("frontier cost must be a finite number >= 0");
  return cost;
}

function survivor<S>(domain: FrontierDomain<S>, current: S, proposed: S): S {
  const order = domain.compare(current, proposed);
  if (!Number.isFinite(order) || order === 0) throw new TypeError("frontier compare must be a non-zero finite number");
  // Stryker disable next-line EqualityOperator: equivalent; 0 already threw, so < and <= keep the same state
  return order < 0 ? current : proposed;
}

function ascending(left: string, right: string): number {
  // A key is admitted once, so < and <= name the same order.
  return left < right ? -1 : 1;
}

/** Search one frontier. Does not restart, draw a random number, or call a model. */
export async function frontierSearch<S>(domain: FrontierDomain<S>, judge: FrontierJudge<S>, limits: FrontierLimits): Promise<FrontierResult<S>> {
  if (!Number.isInteger(limits.width) || limits.width < 1) throw new TypeError("frontier width must be an integer >= 1");
  // Stryker disable next-line CallExpression,ConditionalExpression,StringLiteral: equivalent; Number.isFinite is false for every non-number, so the next line still throws
  if (typeof limits.budget !== "number") throw new TypeError("frontier budget must be a finite number >= 0");
  if (!Number.isFinite(limits.budget) || limits.budget < 0) throw new TypeError("frontier budget must be a finite number >= 0");
  const start = domain.start;
  if (domain.isDead(start)) return { solved: false, cost: 0, rounds: 0, reason: "no-progress" };
  if (domain.isGoal(start)) return { solved: true, state: start, cost: 0, rounds: 0, orderedBy: "start" };

  let live: S[] = [start];
  const expanded = new Set<string>();
  let cost = 0;
  let rounds = 0;

  for (;;) {
    if (cost >= limits.budget) return { solved: false, cost, rounds, reason: "budget" };

    for (const state of live) expanded.add(requireKey(domain.key(state)));
    const pool = new Map<string, Entry<S>>();
    let proposeCost = 0;
    for (const state of live) {
      const proposed = await domain.propose(state);
      if (!Array.isArray(proposed.children)) throw new TypeError("frontier children must be an array");
      proposeCost += requireCost(proposed.cost);
      for (let rank = 0; rank < proposed.children.length; rank++) {
        const child = proposed.children[rank]!;
        if (domain.isDead(child)) continue;
        const key = requireKey(domain.key(child));
        if (expanded.has(key)) continue;
        const vote = 1 / (rank + 1);
        const existing = pool.get(key);
        if (existing === undefined) pool.set(key, { key, state: child, vote });
        else pool.set(key, { key, state: survivor(domain, existing.state, child), vote: existing.vote + vote });
      }
    }

    rounds += 1;
    if (pool.size === 0) return { solved: false, cost: cost + proposeCost, rounds, reason: "no-progress" };

    const admitted = [...pool.values()].sort((a, b) => ascending(a.key, b.key));
    const states = admitted.map((entry) => entry.state);
    const roundCost = proposeCost + requireCost(domain.judgeCost(states));
    const goals = admitted.some((entry) => domain.isGoal(entry.state));
    if (!goals && roundCost === 0) return { solved: false, cost, rounds, reason: "no-progress" };

    const scores = await judge(states);
    if (scores !== null) {
      if (!Array.isArray(scores) || scores.length !== states.length) throw new TypeError("frontier scores must match the merged states");
      for (const score of scores) {
        // Stryker disable next-line CallExpression,ConditionalExpression,StringLiteral: equivalent; Number.isFinite is false for every non-number
        if (typeof score !== "number") throw new TypeError("frontier score must be a finite number");
        if (!Number.isFinite(score)) throw new TypeError("frontier score must be a finite number");
      }
    }

    const ordered = admitted
      .map((entry, index) => ({ entry, score: scores === null ? 0 : scores[index]! }))
      .sort((a, b) => {
        const byScore = b.score - a.score;
        // Admitted keys are already ascending, and this sort is stable, so a zero leaves that order in place.
        if (byScore !== 0) return byScore;
        return b.entry.vote - a.entry.vote;
      });
    cost += roundCost;
    const goal = ordered.find((row) => domain.isGoal(row.entry.state));
    if (goal !== undefined) return { solved: true, state: goal.entry.state, cost, rounds, orderedBy: scores === null ? "votes" : "score" };
    live = ordered.slice(0, limits.width).map((row) => row.entry.state);
  }
}
