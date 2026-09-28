import { z } from "zod";
import { defineSurface, Evolution, parseSettings, score, tokens } from "@harness/evolution";
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
  /** Also a text document `code`: a rule is on wherever a line `enable <rule>` is in it. */
  readonly code?: boolean;
}

/** The text document a world with `code` starts from. */
export const CODE = "# harness code\n# rules\nmode = base\n";

export const DocsSchema = z.strictObject({
  rules: z.record(z.string(), z.boolean()),
  prompt: z.strictObject({ system: z.string().min(1) }),
});

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
    documents: {
      ...(spec.code
        ? {
            code: {
              kind: "text" as const,
              component: "skill",
              check: (text: string) => (text.includes("<<<<<<<") ? "it holds a merge conflict marker" : undefined),
            },
          }
        : {}),
      policy: {
        schema: DocsSchema,
        classify: (path) => (path === "/prompt/system" ? "prompt" : (components[path.split("/")[2] ?? ""] ?? "config")),
      },
    },
    components: ["prompt", "config", "skill", "memory"],
    structural: ["skill", "memory"],
  });
  const active = (documents: Documents) => {
    const rules = DocsSchema.parse(documents["policy"]).rules;
    const code = documents["code"];
    return [...new Set([...Object.keys(rules).filter((r) => rules[r]), ...(typeof code === "string" ? [...code.matchAll(/^enable (\w+)$/gm)].map((m) => m[1]!) : [])])];
  };
  const p = (documents: Documents, i: number, isHoldout: boolean) => {
    const on = active(documents);
    return Math.min(1, Math.max(0, spec.base(i, isHoldout) + on.reduce((s, r) => s + (spec.effects?.[r]?.(i, isHoldout) ?? 0), 0)));
  };
  const calls: { documents: Documents; tasks: readonly Task[] }[] = [];
  const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => {
    calls.push({ documents, tasks });
    const spent = 1000 + active(documents).reduce((s, r) => s + (spec.cost?.[r] ?? 0), 0);
    return tasks.map((t): TaskRun => {
      const isHoldout = t.id.startsWith("h");
      const pi = p(documents, Number(t.id.slice(1)), isHoldout);
      return {
        task: t.id,
        ...(t.group ? { group: t.group } : {}),
        trials: Array.from({ length: k }, () => ({
          reward: score(pi === 0 || pi === 1 ? pi : u.next() < pi ? 1 : 0),
          tokens: tokens(spent),
          feedback: `p=${pi}`,
        })),
      };
    });
  };
  /** The true score of a harness on the evolve set. */
  const truth = (documents: Documents) => evolve.reduce((s, _, i) => s + p(documents, i, false), 0) / spec.n;
  const documents = {
    policy: { rules: {}, prompt: { system: "Work carefully." } },
    ...(spec.code ? { code: CODE } : {}),
  };
  return {
    surface,
    split: { evolve, ...(holdout.length ? { holdout } : {}) },
    evaluate,
    calls,
    truth,
    documents,
  };
}

/** A proposal switching one rule on (or off). */
export const toggle = (rule: string, on = true, extra: Record<string, unknown> = {}) => ({
  summary: `${on ? "enable" : "disable"} ${rule}`,
  edits: [
    {
      id: "e1",
      hypothesis: `${rule} helps`,
      targets: "failures",
      ops: [{ op: "add", document: "policy", path: `/rules/${rule}`, value: on }],
      ...extra,
    },
  ],
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
    select: {
      rule: "calibrated",
      alpha: 0.1,
      resamples: 400,
      margin: 0.02,
      saving: 0.05,
      beta0: 0.1,
      beta1: 35,
    },
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

/** Success probabilities of the Monte Carlo worlds: a fifth of the tasks always fail, two fifths always pass, a fifth is a coin flip (true score 1/2). */
export const coinBase = (i: number) => [0, 0, 1, 1, 0.5][i % 5]!;

export interface Campaign {
  readonly n: number;
  readonly seed: number;
  readonly rounds: number;
  readonly select: object;
  readonly effects?: WorldSpec["effects"];
  readonly propose: (request: ProposalRequest) => unknown;
  /** Stop after this round (0-based) instead of running all of them. */
  readonly through?: number;
}

/**
 * One seeded run over a world, and what the studies count: how often a change was accepted,
 * the first accepted candidate of the last round played, whether candidate A of that round
 * was abandoned for futility, how many candidates were in all, and the evolve-set tasks evaluated since the base harness's
 * measurement.
 */
export async function campaign(c: Campaign) {
  const w = world({ n: c.n, base: coinBase, seed: c.seed, ...(c.effects ? { effects: c.effects } : {}) });
  const e = await Evolution.start({ surface: w.surface, settings: settings({ rounds: c.rounds, select: c.select, prune: { after: 1, every: 3 } }), split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(c.seed) } });
  const spent = () => w.calls.reduce((s, x) => s + x.tasks.length, 0);
  const before = spent();
  const { propose } = scripted((r) => c.propose(r));
  let accepted = 0;
  let last: Awaited<ReturnType<Evolution["round"]>> | undefined;
  while (!e.done && (c.through === undefined || e.completed <= c.through)) {
    last = await e.round({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(c.seed * 7 + e.completed) });
    if (last.accepted) accepted++;
  }
  return { accepted, abandoned: e.records.filter((r) => /abandoned for futility/.test(r.reason)).length, last: last?.accepted, abandonedA: /abandoned for futility/.test(last?.records.find((r) => r.candidate === "A")?.reason ?? ""), tasks: spent() - before };
}
