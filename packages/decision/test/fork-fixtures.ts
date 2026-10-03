/**
 * Test doubles for the runner's tests: hand-written members, a small fork with every
 * optional part, and a decider wired to a memory log with a manual clock.
 */
import { probability } from "@harness/cognitive";
import type { Entropy } from "@harness/core";
import { ManualClock } from "@harness/testkit";
import { answerOf, fromJudgeAnswer } from "../src/member.ts";
import { Decider, ForkRegistry } from "../src/fork.ts";
import type { DeciderOptions, Explorer, ForkGenerator } from "../src/fork.ts";
import { parsePolicy } from "../src/policy.ts";
import { MemoryDecisionLog } from "../src/records.ts";
import { forkId } from "../src/types.ts";
import type { Answers, Asked, Calibrate, DecisionLog, Fork, Member } from "../src/types.ts";

export interface In {
  readonly text: string;
}
export type Act = "allow" | "deny";

const BOOL = { type: "boolean", instructions: "ok?" } as const;
export const boolAnswer = (p: number) => fromJudgeAnswer(BOOL, { type: "boolean", probability: probability(p) });

/** A member's double: answers by a function of the call, and remembers what it was asked. */
export interface Double extends Member {
  readonly calls: Asked[];
}
export function member(id: string, answer: (asked: Asked, call: number) => Answers | Promise<Answers>, version = "v1"): Double {
  const calls: Asked[] = [];
  return {
    id,
    version,
    calls,
    async ask(asked) {
      calls.push(asked);
      return answer(asked, calls.length - 1);
    },
  };
}

/** A member that says P(true) = p to the gate's question `q` (and the verify question `correct`). */
export const sure = (id: string, p: number, version = "v1"): Double => member(id, (asked) => Object.fromEntries(Object.keys(asked.questions).map((q) => [q, boolAnswer(p)])), version);
export const failing = (id: string, message = "unreachable"): Double =>
  member(id, () => {
    throw new Error(message);
  });

const ALLOW_DENY = { allow: 0, deny: 1 } as const;

/** A fork over {text} with a boolean question `q`: true is allow. Optional parts come in through `extra`. */
export function gate(extra: Partial<Fork<In, Act>> = {}, id = "test.gate"): Fork<In, Act> {
  return {
    id: forkId(id),
    version: "f1",
    ask: (input) => ({ state: input.text, questions: { q: BOOL } }),
    interpret: (answers) => {
      const a = answers["q"];
      if (a === undefined) throw new Error("no answer to q");
      const p = a.distribution["true"]!;
      return { action: p >= 0.5 ? "allow" : "deny", confidence: probability(Math.max(p, 1 - p)) };
    },
    describe: (input) => ({ text: input.text }),
    fallback: () => "deny",
    ...extra,
  };
}

export const withVerify: Partial<Fork<In, Act>> = {
  verify: (input, action) => ({ state: { text: input.text, action }, questions: { correct: { type: "boolean", instructions: "is the action right?" } }}),
};
export const withActions: Partial<Fork<In, Act>> = { actions: () => ["allow", "deny"] };
export const withFloor = (floor: (input: In) => Act | undefined): Partial<Fork<In, Act>> => ({ floor, restrictiveness: (a) => ALLOW_DENY[a] });

export function policyJson(patch: { default?: Record<string, unknown>; forks?: Record<string, Record<string, unknown>> } = {}): unknown {
  return {
    version: "policy-t",
    default: { act: 0.9, verify: 0.5, accept: 0.8, rotate: 1, explore: 0, mode: "active", ...patch.default },
    forks: patch.forks ?? {},
  };
}

export interface Rig {
  readonly decider: Decider;
  readonly log: DecisionLog;
  readonly clock: ManualClock;
  readonly published: { type: "decision.made"; payload: unknown; sessionId?: string }[];
}

export interface RigOptions extends Partial<Omit<DeciderOptions, "policy" | "clock" | "log">> {
  readonly policy?: unknown;
  readonly log?: DecisionLog;
  readonly publishing?: boolean;
}

export function rig(options: RigOptions = {}): Rig {
  const clock = new ManualClock(1_000);
  const log = options.log ?? new MemoryDecisionLog();
  const published: Rig["published"] = [];
  const { policy, log: _log, publishing = true, members, ...rest } = options;
  const decider = new Decider({
    ...rest,
    log,
    clock,
    policy: parsePolicy(policy ?? policyJson()),
    members: members ?? [],
    ...(publishing && rest.publish === undefined ? { publish: (event) => void published.push(event) } : {}),
  });
  return { decider, log, clock, published };
}

/** A decision the real numerics would make, kept small: epsilon-greedy with the propensity computed from the options. */
export const testExplorer: Explorer = ({ options, greedy, epsilon, rng }) => {
  const explored = rng() < epsilon;
  const at = explored ? Math.min(options.length - 1, Math.floor(rng() * options.length)) : options.indexOf(greedy);
  const share = epsilon / options.length;
  return { choice: options[at]!, propensity: at === options.indexOf(greedy) ? 1 - epsilon + share : share, explored };
};

export const fixedRng = (...draws: number[]): (() => number) => {
  let i = 0;
  return () => draws[Math.min(i++, draws.length - 1)]!;
};

export const neverAsked: ForkGenerator = async () => {
  throw new Error("the generator must not be asked");
};

export const entropyOf = (bytes: readonly number[]): Entropy => ({ bytes: (length) => Uint8Array.from({ length }, (_, i) => bytes[i % bytes.length]!) });

export { answerOf, Decider, ForkRegistry };
export type { Calibrate };
