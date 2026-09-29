import { z } from "zod";
import { ProbabilitySchema } from "@harness/cognitive";
import { HoldoutSettingsSchema, HoldoutStateSchema, holdoutLevel } from "./holdout.ts";
import { RecordSchema } from "./ledger.ts";
import { MeasurementSchema } from "./measure.ts";
import { roundLevel } from "./schedule.ts";
import { RuleSchema } from "./select.ts";
import { ChangeSchema } from "./surface.ts";

const text = z.string().min(1);

// ---- settings (data/settings.json) -------------------------------------------------

export const SettingsSchema = z
  .strictObject({
    $schema: z.string().exactOptional(),
    /** T: rounds in a run. */
    rounds: z.int().positive(),
    /** k: trials per task in every evaluation. */
    trials: z.int().positive(),
    /** m: candidates drafted per round. */
    candidates: z.int().min(1).max(25),
    /** Bounds of the annealed edit budget b_t (Eq. 4). */
    budget: z.strictObject({ min: z.int().positive(), max: z.int().positive() }),
    explore: z.strictObject({
      /** w: rounds without progress that make a stall. */
      window: z.int().positive(),
      /** m_draft: candidate slots reserved, when stalled, for components the run never exercised. */
      reserved: z.int().min(0),
    }),
    select: RuleSchema,
    /** Ablations of accepted mechanisms (calibrated rule): first `after` rounds after acceptance, then again every `every` rounds. */
    prune: z.strictObject({ after: z.int().min(1), every: z.int().positive() }),
    /** The budgeted holdout, when the split has one: a winner is confirmed on it, at level alpha / (2^budget - 1) (see holdout.ts). */
    holdout: HoldoutSettingsSchema,
    leakage: z.strictObject({ ngram: z.int().min(2) }),
    /** Times a refused proposal goes back to the proposer with the reasons. */
    repair: z.int().min(0),
    /** The share of missing trials past which an evaluation is invalid (infrastructure), not a measurement. */
    invalid: ProbabilitySchema,
    /** What the proposer is shown: the worst and best tasks of the incumbent, and the last records of the ledger. */
    analysis: z.strictObject({ failures: z.int().min(0), successes: z.int().min(0), history: z.int().positive() }),
    proposer: z.strictObject({
      system: text,
      maxTokens: z.int().positive(),
      /**
       * Ax GEPA (`optimize`) for the proposer's signature. `maxMetricCalls` is the
       * spend cap for one proposer; zero leaves the compiled signature prompt untuned.
       * `seed` fixes the optimizer's sampling.
       */
      optimize: z.strictObject({ maxMetricCalls: z.int().min(0), seed: z.int().min(0) }),
    }),
    critic: z.strictObject({ question: text, threshold: ProbabilitySchema, examples: z.int().min(0) }),
  })
  .refine((s) => s.budget.min <= s.budget.max, { message: "budget.min must not exceed budget.max", path: ["budget"] })
  .refine((s) => s.explore.reserved <= s.candidates, { message: "explore.reserved must not exceed candidates", path: ["explore", "reserved"] })
  .superRefine((s, ctx) => {
    if (s.select.rule !== "calibrated") return;
    const alpha = s.select.alpha;
    // Every test level must lie in (0, 0.5): a bound at level 0.5 or more is not a bound (compare() refuses it), and alpha 0 has no level at all.
    if (!(alpha > 0)) {
      ctx.addIssue({ code: "custom", message: "select.alpha: alpha must be above 0", path: ["select", "alpha"] });
      return;
    }
    const tests = s.candidates + 1;
    for (let t = 0; t < s.rounds; t++) {
      const level = roundLevel(alpha, t, s.rounds, tests, s.select.spending);
      if (!(level < 0.5)) {
        ctx.addIssue({ code: "custom", message: `select.alpha: with ${s.rounds} round(s) and ${tests} tests a round, alpha ${alpha} gives round ${t}'s test a level of ${Number(level.toPrecision(2))}, which must lie in (0, 0.5): lower alpha or use more rounds or candidates`, path: ["select", "alpha"] });
        return;
      }
    }
    // A bound at level a is a quantile of the resamples and needs at least ceil(1 / a) of
    // them (compare.ts): refuse settings that would fail in the middle of a run, in the
    // round whose level is the smallest, or on the futility prefix.
    let needed = 0;
    let why = "";
    const need = (level: number, what: string) => {
      const n = Math.ceil(1 / level);
      if (n > needed) [needed, why] = [n, what];
    };
    for (let t = 0; t < s.rounds; t++) need(roundLevel(alpha, t, s.rounds, tests, s.select.spending), `round ${t}'s test level`);
    if (s.select.futility) need(s.select.futility.alpha, "the futility level");
    // The holdout's confirmation is the same kind of test, at the level of one node of its query tree.
    const beta = holdoutLevel(s.holdout);
    if (!(beta > 0 && beta < 0.5)) {
      ctx.addIssue({ code: "custom", message: `holdout.alpha: alpha ${s.holdout.alpha} with a budget of ${s.holdout.budget} queries gives each query a level of ${Number(beta.toPrecision(2))}, which must lie in (0, 0.5): lower holdout.alpha or the budget`, path: ["holdout", "alpha"] });
      return;
    }
    need(beta, "the holdout's confirmation level");
    if (s.select.resamples < needed) ctx.addIssue({ code: "custom", message: `select.resamples must be at least ${needed}: ${why} needs that many resamples to be certified, not ${s.select.resamples}`, path: ["select", "resamples"] });
  });
export type Settings = z.output<typeof SettingsSchema>;

export function parse<T>(schema: z.ZodType<T>, what: string, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`invalid ${what}\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Parse evolution's settings file (see data/settings.json). */
export const parseSettings = (input: unknown): Settings => parse(SettingsSchema, "evolution settings", input);

/** JSON Schema for the settings file, for editors (data/settings.schema.json). */
export const settingsJsonSchema = (): object => z.toJSONSchema(SettingsSchema, { io: "input" });

// ---- state ---------------------------------------------------------------------------

/** An accepted edit that is part of the incumbent: what it wrote, how to take it out, and its evidence. */
export const MechanismSchema = z.strictObject({
  id: text,
  round: z.int().min(0),
  hypothesis: text,
  components: z.array(text).readonly(),
  changes: z.array(ChangeSchema).readonly(),
  /** The lower bound of the gain it was accepted with. */
  lower: z.number(),
  /** The last round it was ablated in (and kept). */
  ablated: z.int().min(0).exactOptional(),
  /** A later edit rewrote what it wrote: it can no longer be removed on its own. */
  entangled: z.boolean().exactOptional(),
});
export type Mechanism = z.output<typeof MechanismSchema>;

export const DocumentsSchema = z.record(z.string(), z.json());

/**
 * What a run's error control depends on, as a flat record: the settings that fix the
 * levels of its tests and what its claims are (rounds, candidates, select's alpha,
 * spending, margin, saving, beta0 and beta1, the holdout's alpha and budget). It is kept in
 * the state so that a restored run refuses different ones: the run's alpha is spent
 * against them, and (for one) extending `rounds` mid-run would silently exceed it.
 * Settings that only trade power or cost (resamples, futility, trials, the proposer's
 * prompts) are not in it. The paper's rule has no error control to protect: only its rule
 * name, rounds and candidates.
 */
export type ErrorControl = Record<string, number | string>;
export function errorControlKey(s: Settings): ErrorControl {
  const key: ErrorControl = { rounds: s.rounds, candidates: s.candidates, "select.rule": s.select.rule };
  if (s.select.rule === "calibrated") {
    const r = s.select;
    Object.assign(key, {
      "select.alpha": r.alpha,
      "select.spending": r.spending.kind === "uniform" ? "uniform" : `geometric ${r.spending.ratio}`,
      "select.margin": r.margin,
      "select.saving": r.saving,
      "select.beta0": r.beta0,
      "select.beta1": r.beta1,
      "holdout.alpha": s.holdout.alpha,
      "holdout.budget": s.holdout.budget,
    });
  }
  return key;
}

/** The differences between a saved run's error-control key and the current one, each named. */
export function errorControlDifferences(saved: ErrorControl, now: ErrorControl): string[] {
  return [...new Set([...Object.keys(saved), ...Object.keys(now)])].sort().flatMap((k) => (saved[k] === now[k] ? [] : [`${k} was ${saved[k] ?? "absent"} and is now ${now[k] ?? "absent"}`]));
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * States saved with Thresholdout kept a `holdout` of {state: {queries, ...}, incumbent} and
 * a Thresholdout answer in each record that was checked on it. The queries it had made are
 * kept (they are the budget spent); the noisy threshold, the cached incumbent and the
 * answers, which have no meaning to the budgeted holdout, are dropped.
 */
function migrate(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  const holdout = raw["holdout"];
  if (isRecord(holdout) && isRecord(holdout["state"])) out["holdout"] = { queries: holdout["state"]["queries"] };
  if (Array.isArray(raw["records"]))
    out["records"] = raw["records"].map((r: unknown) => {
      if (!isRecord(r) || !isRecord(r["measured"]) || !isRecord(r["measured"]["holdout"]) || !("state" in r["measured"]["holdout"])) return r;
      const { holdout: _, ...measured } = r["measured"];
      return { ...r, measured };
    });
  return out;
}

const StateShape = z.strictObject({
  format: z.literal("harness.evolution/v1"),
  round: z.int().min(0),
  /** The incumbent H_t. */
  documents: DocumentsSchema,
  /** H_0 on the evolve set: the anchor of the cost cap. */
  base: MeasurementSchema,
  /**
   * The incumbent's measurements on the evolve set that count as its evidence: under the
   * calibrated rule only those taken after it was chosen (the one it was chosen on is the
   * luckiest of its round), pooled; under the paper's rule, the one it was chosen on.
   */
  incumbent: z.array(MeasurementSchema).readonly(),
  /** The incumbent's latest measurement, whatever it was taken for: what the proposer is shown of its failures and successes. */
  observed: MeasurementSchema,
  /** The holdout's queries used, when the split has a holdout. */
  holdout: HoldoutStateSchema.exactOptional(),
  /** The error-control settings the run was made with (see errorControlKey); absent in states saved before it existed, which adopt the current ones. */
  errorControl: z.record(z.string(), z.union([z.number(), z.string()])).exactOptional(),
  /** The paper's delta, and S*. */
  delta: z.number().min(0).exactOptional(),
  best: z.number(),
  /**
   * The base harness's score, then one entry per round: the score the new incumbent was
   * chosen with (paper's rule, which its stall flag reads), or the incumbent's pooled
   * fresh estimate in that round (calibrated rule, for reporting).
   */
  trajectory: z.array(z.number()).readonly(),
  /**
   * The loss counter of the calibrated rule: a CUSUM of the lower bounds of every accepted
   * step, max(0, drift - lower) (select.ts). Older states kept the score lost to accepted
   * savings since the last supported gain here; it is read as the counter's value.
   */
  drift: z.number().min(0),
  /** The sum of the lower bounds of the steps accepted so far: a lower bound on the total change against H_0. States saved before it existed read 0. */
  certified: z.number().default(0),
  mechanisms: z.array(MechanismSchema).readonly(),
  records: z.array(RecordSchema).readonly(),
});
export const StateSchema = z.preprocess(migrate, StateShape);
export type State = z.output<typeof StateShape>;
