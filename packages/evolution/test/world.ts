import { z } from "zod";
import { defineSurface, parseSettings, score, tokens } from "@harness/evolution";
import type { Documents, EvolutionPorts, ProposalRequest, Settings, Task, TaskRun } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { Uniform } from "../src/random.ts";

/**
 * A simulated harness with a known truth. Its documents are rules (switched on or off)
 * and a prompt; a task's success probability is its base plus the effects of the rules
 * that are on, and each trial succeeds with that probability. So which changes really
 * help, on the evolve set and on the holdout, is known, and the loop can be checked
 * against it.
 */
export interface WorldSpec {
  readonly n: number;
  readonly holdout?: number;
  /** A task's base success probability (index, whether it is a holdout task). */
  readonly base: (i: number, holdout: boolean) => number;
  /** What each rule adds to a task's success probability. */
  readonly effects?: Readonly<Record<string, (i: number, holdout: boolean) => number>>;
  /** Tokens each rule adds to a trial (every trial costs 1000 without rules). */
  readonly cost?: Readonly<Record<string, number>>;
  /** The component each rule belongs to (config by default). */
  readonly components?: Readonly<Record<string, string>>;
  readonly groups?: number;
  readonly seed?: number;
}

export const DocsSchema = z.strictObject({ rules: z.record(z.string(), z.boolean()), prompt: z.strictObject({ system: z.string().min(1) }) });

export function world(spec: WorldSpec) {
  const u = new Uniform(new SeededEntropy(spec.seed ?? 11));
  const task = (i: number, holdout: boolean): Task => ({
    id: `${holdout ? "h" : "e"}${String(i).padStart(3, "0")}`,
    text: `Case ${holdout ? "h" : "e"}${i}: reconcile ledger ${i * 7 + 3} against invoice batch ${i * 13 + 1} and report discrepancies`,
    ...(spec.groups ? { group: `g${i % spec.groups}` } : {}),
  });
  const evolve = Array.from({ length: spec.n }, (_, i) => task(i, false));
  const holdout = Array.from({ length: spec.holdout ?? 0 }, (_, i) => task(i, true));
  const components = spec.components ?? {};
  const surface = defineSurface({
    documents: { policy: { schema: DocsSchema, classify: (path) => (path === "/prompt/system" ? "prompt" : (components[path.split("/")[2] ?? ""] ?? "config")) } },
    components: ["prompt", "config", "skill", "memory"],
    structural: ["skill", "memory"],
  });
  const p = (documents: Documents, i: number, isHoldout: boolean) => {
    const rules = DocsSchema.parse(documents["policy"]).rules;
    const on = Object.keys(rules).filter((r) => rules[r]);
    return Math.min(1, Math.max(0, spec.base(i, isHoldout) + on.reduce((s, r) => s + (spec.effects?.[r]?.(i, isHoldout) ?? 0), 0)));
  };
  const calls: { documents: Documents; tasks: readonly Task[] }[] = [];
  const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => {
    calls.push({ documents, tasks });
    const rules = DocsSchema.parse(documents["policy"]).rules;
    const spent = 1000 + Object.keys(rules).reduce((s, r) => s + (rules[r] ? (spec.cost?.[r] ?? 0) : 0), 0);
    return tasks.map((t): TaskRun => {
      const isHoldout = t.id.startsWith("h");
      const pi = p(documents, Number(t.id.slice(1)), isHoldout);
      return { task: t.id, ...(t.group ? { group: t.group } : {}), trials: Array.from({ length: k }, () => ({ reward: score(pi === 0 || pi === 1 ? pi : u.next() < pi ? 1 : 0), tokens: tokens(spent), feedback: `p=${pi}` })) };
    });
  };
  /** The true score of a harness on the evolve set. */
  const truth = (documents: Documents) => evolve.reduce((s, _, i) => s + p(documents, i, false), 0) / spec.n;
  const documents = { policy: { rules: {}, prompt: { system: "Work carefully." } } };
  return { surface, split: { evolve, ...(holdout.length ? { holdout } : {}) }, evaluate, calls, truth, documents };
}

/** A proposal switching one rule on (or off). */
export const toggle = (rule: string, on = true, extra: Record<string, unknown> = {}) => ({
  summary: `${on ? "enable" : "disable"} ${rule}`,
  edits: [{ id: "e1", hypothesis: `${rule} helps`, targets: "failures", ops: [{ op: "add", document: "policy", path: `/rules/${rule}`, value: on }], ...extra }],
});

/** A proposer answering from a function of the request, recording every request. */
export function scripted(answer: (request: ProposalRequest, n: number) => unknown) {
  const requests: ProposalRequest[] = [];
  const propose = async (request: ProposalRequest) => {
    requests.push(request);
    return answer(request, requests.length - 1);
  };
  return { propose, requests };
}

export function settings(overrides: Record<string, unknown> = {}): Settings {
  return parseSettings({
    rounds: 6,
    trials: 2,
    candidates: 2,
    budget: { min: 1, max: 2 },
    explore: { window: 2, reserved: 1 },
    select: { rule: "calibrated", alpha: 0.1, resamples: 400, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 },
    prune: { after: 1, every: 10 },
    holdout: { threshold: 0.05, sigma: 0, budget: 2, confirm: 0 },
    leakage: { ngram: 6 },
    repair: 1,
    invalid: 0.15,
    analysis: { failures: 3, successes: 2, history: 20 },
    proposer: { system: "Propose.", maxTokens: 512 },
    critic: { question: "Specific?", threshold: 0.5, examples: 2 },
    ...overrides,
  });
}
