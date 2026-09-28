import { z } from "zod";
import { ProbabilitySchema } from "@harness/cognitive";
import { HoldoutSettingsSchema, HoldoutStateSchema } from "./holdout.ts";
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
    /** Thresholdout over the holdout split, when there is one; a gain is confirmed when its answer is above `confirm`. */
    holdout: HoldoutSettingsSchema.extend({ confirm: z.number() }),
    leakage: z.strictObject({ ngram: z.int().min(2) }),
    /** Times a refused proposal goes back to the proposer with the reasons. */
    repair: z.int().min(0),
    /** The share of missing trials past which an evaluation is invalid (infrastructure), not a measurement. */
    invalid: ProbabilitySchema,
    /** What the proposer is shown: the worst and best tasks of the incumbent, and the last records of the ledger. */
    analysis: z.strictObject({ failures: z.int().min(0), successes: z.int().min(0), history: z.int().positive() }),
    proposer: z.strictObject({ system: text, maxTokens: z.int().positive() }),
    critic: z.strictObject({ question: text, threshold: ProbabilitySchema, examples: z.int().min(0) }),
  })
  .refine((s) => s.budget.min <= s.budget.max, { message: "budget.min must not exceed budget.max", path: ["budget"] })
  .refine((s) => s.explore.reserved <= s.candidates, { message: "explore.reserved must not exceed candidates", path: ["explore", "reserved"] })
  .superRefine((s, ctx) => {
    if (s.select.rule !== "calibrated") return;
    // A bound at level a is a quantile of the resamples and needs at least ceil(1 / a) of
    // them (compare.ts): refuse settings that would fail in the middle of a run, in the
    // round whose level is the smallest, or on the futility prefix.
    let needed = 0;
    let why = "";
    const need = (level: number, what: string) => {
      const n = Math.ceil(1 / level);
      if (n > needed) [needed, why] = [n, what];
    };
    for (let t = 0; t < s.rounds; t++) need(roundLevel(s.select.alpha, t, s.rounds, s.candidates + 1, s.select.spending), `round ${t}'s test level`);
    if (s.select.futility) need(s.select.futility.alpha, "the futility level");
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

export const StateSchema = z.strictObject({
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
  holdout: z.strictObject({ state: HoldoutStateSchema, incumbent: MeasurementSchema.exactOptional() }).exactOptional(),
  /** The paper's delta, and S*. */
  delta: z.number().min(0).exactOptional(),
  best: z.number(),
  /**
   * The base harness's score, then one entry per round: the score the new incumbent was
   * chosen with (paper's rule, which its stall flag reads), or the incumbent's pooled
   * fresh estimate in that round (calibrated rule, for reporting).
   */
  trajectory: z.array(z.number()).readonly(),
  drift: z.number().min(0),
  mechanisms: z.array(MechanismSchema).readonly(),
  records: z.array(RecordSchema).readonly(),
});
export type State = z.output<typeof StateSchema>;
