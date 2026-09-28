import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scriptedModel } from "@harness/testkit";

/**
 * A simulated suite with a known truth, as packages/evolution/test/world.ts: the harness is
 * a policy document (rules switched on or off, and a prompt); a task's success probability
 * is its base plus the effects of the rules that are on, and each trial succeeds by a hash of
 * (policy, task, trial), so an evaluation is the same whichever process runs it, in whatever order.
 */
export const BASE = 0.3;
/** What each rule adds to every task's success probability; a rule not named adds nothing. */
export const EFFECTS: Readonly<Record<string, number>> = { verify: 0.5 };

export interface EvaluatorInput {
  readonly documents: Record<string, unknown>;
  readonly tasks: readonly { readonly id: string; readonly text: string; readonly group?: string }[];
  readonly k: number;
}

const rulesOn = (documents: Record<string, unknown>) => {
  const rules = (documents["policy"] as { rules: Record<string, boolean> }).rules;
  return Object.keys(rules).filter((r) => rules[r]);
};

/** The probability a trial succeeds with these documents. */
export const truth = (documents: Record<string, unknown>): number => Math.min(1, BASE + rulesOn(documents).reduce((s, r) => s + (EFFECTS[r] ?? 0), 0));

const uniform = (seed: string) => createHash("sha256").update(seed).digest().readUInt32BE(0) / 2 ** 32;

export function simulate({ documents, tasks, k }: EvaluatorInput) {
  const p = truth(documents);
  const policy = JSON.stringify(documents["policy"]);
  const spent = 1000 + 10 * rulesOn(documents).length;
  return tasks.map((t) => ({
    task: t.id,
    ...(t.group === undefined ? {} : { group: t.group }),
    trials: Array.from({ length: k }, (_, j) => ({ reward: uniform(`${policy}|${t.id}|${j}`) < p ? 1 : 0, tokens: spent, feedback: `p=${p}` })),
  }));
}

export const POLICY_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    rules: { type: "object", additionalProperties: { type: "boolean" } },
    prompt: { type: "object", properties: { system: { type: "string", minLength: 1 } }, required: ["system"], additionalProperties: false },
  },
  required: ["rules", "prompt"],
  additionalProperties: false,
};

/** Settings for a short run: a real gain is certified in a round, and the holdout confirms it. */
export const SETTINGS = {
  rounds: 3,
  trials: 2,
  candidates: 1,
  budget: { min: 1, max: 1 },
  explore: { window: 2, reserved: 0 },
  select: { rule: "calibrated", alpha: 0.1, resamples: 400, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 },
  prune: { after: 5, every: 10 },
  holdout: { threshold: 0.05, sigma: 0, budget: 2, confirm: 0 },
  leakage: { ngram: 6 },
  repair: 1,
  invalid: 0.15,
  analysis: { failures: 3, successes: 2, history: 20 },
  proposer: { system: "Propose.", maxTokens: 512 },
  critic: { question: "Specific?", threshold: 0.5, examples: 2 },
};

export const task = (i: number, holdout = false) => ({
  id: `${holdout ? "h" : "e"}${String(i).padStart(3, "0")}`,
  text: `Case ${holdout ? "h" : "e"}${i}: reconcile ledger ${i * 7 + 3} against invoice batch ${i * 13 + 1} and report discrepancies`,
  group: `g${i % 12}`,
});

export interface Scenario {
  readonly dir: string;
  readonly config: string;
  readonly state: string;
  readonly policy: string;
  readonly settings: string;
}

/** The files of a run in `dir`: config, settings, the policy document with its JSON Schema, and (optionally) an evaluator command. */
export function scenario(dir: string, options: { readonly evolve?: number; readonly holdout?: number; readonly evaluator?: readonly string[]; readonly config?: Record<string, unknown> } = {}): Scenario {
  mkdirSync(dir, { recursive: true });
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("policy.json", { rules: {}, prompt: { system: "Work carefully." } });
  write("policy.schema.json", POLICY_SCHEMA);
  write("settings.json", SETTINGS);
  const holdout = Array.from({ length: options.holdout ?? 0 }, (_, i) => task(i, true));
  write("evolution.json", {
    documents: { policy: { path: "policy.json", schema: "policy.schema.json" } },
    components: ["prompt", "config", "skill"],
    structural: ["skill"],
    classify: { rules: [{ prefix: "/prompt", component: "prompt" }, { prefix: "/rules", component: "config" }] },
    tasks: { evolve: Array.from({ length: options.evolve ?? 24 }, (_, i) => task(i)), ...(holdout.length ? { holdout } : {}) },
    evaluator: { command: options.evaluator ?? ["node", "--version"], concurrency: 4 },
    settings: "settings.json",
    ...options.config,
  });
  return { dir, config: join(dir, "evolution.json"), state: join(dir, "evolution.state.json"), policy: join(dir, "policy.json"), settings: join(dir, "settings.json") };
}

/** A proposal enabling a rule. */
export const enable = (rule: string) => ({
  summary: `enable ${rule}`,
  edits: [{ id: "e1", hypothesis: `${rule} helps`, targets: "failures", ops: [{ op: "add", document: "policy", path: `/rules/${rule}`, value: true }] }],
});

/** A proposer model: the first proposal enables `verify` (a real gain), each later one a rule that does nothing. Counts its calls. */
export function proposer() {
  let calls = 0;
  const model = scriptedModel(() => JSON.stringify(enable(calls++ === 0 ? "verify" : `noop${calls}`)));
  return { model, calls: () => calls };
}
