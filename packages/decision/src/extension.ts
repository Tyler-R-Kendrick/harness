/**
 * The decision layer as a cognitive-core extension: its operations are served as
 * `decision.<op>` through `_harness/cognitive/invoke`, to clients and plugins. It brings no
 * models (the layer's members are its own) and requires no other extension.
 *
 * Every input is parsed (strict objects: an unknown field is an error) before anything runs,
 * and a failure is an error whose message says which operation failed and, for a
 * `DecisionError`, with which code: `decision.decide failed (unknown-fork): no fork is
 * registered as nope`. Results are plain JSON. A number that cannot be JSON (the break-even
 * of a switch that never pays is infinite) is `null`.
 *
 * - `status`, `forks`, `policy`: what the layer is and is made of.
 * - `decide`, `record`, `outcome`, `spans`: decide a fork by name, read decisions back (at
 *   most 100 at a time unless `limit` is given), attach what became of one, and see
 *   decisions as OpenTelemetry spans.
 * - `report`, `calibrate`, `thresholds`, `estimate`: measure the layer on its own records.
 * - `distill`, `induce`, `rules`, `evolve`: the improvement loops. `evolve` asks the
 *   proposer the extension was given, else a language model of the ensemble, else fails.
 * - `inbox`: add items, resolve items, and see what a person should look at first.
 * - `dispatch`: whether switching a session to a cheaper tier for a stretch pays, with the
 *   data's prices.
 */
import type { CognitiveExtension, Ensemble } from "@harness/cognitive";
import { z } from "zod";
import { AttentionItemSchema } from "./attention.ts";
import type { DecisionLayer } from "./compose.ts";
import { switchPlan } from "./dispatch.ts";
import { examplesToJsonl } from "./distill.ts";
import { CriteriaBookSchema, llmProposer } from "./evolve.ts";
import type { Proposer } from "./evolve.ts";
import { toSpan } from "./otel.ts";
import { DecisionError, DecisionIdSchema, ForkIdSchema, OutcomeSchema, ProbabilitySchema } from "./types.ts";
import type { DecisionFilter } from "./types.ts";

export interface DecisionExtensionOptions {
  /** Its language model proposes wording for `decision.evolve` when no proposer is given. */
  readonly ensemble?: Pick<Ensemble, "languageModel">;
  readonly proposer?: Proposer;
}

/** How many decisions `record` and `spans` return unless `limit` says otherwise. */
export const DEFAULT_LIMIT = 100;

const count = z.int().min(0);
const time = count;

const FilterFields = {
  session: z.string().exactOptional(),
  mode: z.enum(["active", "shadow"]).exactOptional(),
  hasOutcome: z.boolean().exactOptional(),
  since: time.exactOptional(),
  until: time.exactOptional(),
  after: DecisionIdSchema.exactOptional(),
  limit: count.exactOptional(),
};
const Filter = z.strictObject({ fork: ForkIdSchema.exactOptional(), ...FilterFields });
const FilterOfFork = z.strictObject(FilterFields);

const Empty = z.strictObject({});
const Policy = z.strictObject({
  act: ProbabilitySchema.exactOptional(),
  verify: ProbabilitySchema.exactOptional(),
  accept: ProbabilitySchema.exactOptional(),
  rotate: z.int().min(1).max(16).exactOptional(),
  explore: ProbabilitySchema.exactOptional(),
  mode: z.enum(["active", "shadow"]).exactOptional(),
});

const INPUTS = {
  status: Empty,
  forks: Empty,
  policy: Empty,
  decide: z.strictObject({ fork: z.string().min(1), input: z.unknown(), session: z.string().exactOptional(), correlation: z.string().exactOptional() }),
  record: z.union([z.strictObject({ id: DecisionIdSchema }), Filter]),
  outcome: z.strictObject({ id: DecisionIdSchema, outcome: OutcomeSchema.extend({ at: time.exactOptional() }) }),
  report: z.strictObject({ fork: ForkIdSchema.exactOptional(), filter: FilterOfFork.exactOptional() }),
  calibrate: z.strictObject({ at: time.exactOptional(), minSamples: z.int().min(1).exactOptional() }),
  thresholds: z.strictObject({ fork: ForkIdSchema, targetRisk: z.number().finite(), delta: z.number().finite(), bound: z.enum(["hoeffding", "clopper-pearson"]) }),
  estimate: z.strictObject({ fork: ForkIdSchema, target: Policy }),
  distill: z.strictObject({ fork: ForkIdSchema.exactOptional(), holdout: z.number().finite(), salt: z.string().exactOptional() }),
  induce: z.strictObject({
    fork: ForkIdSchema,
    fields: z.array(z.string().min(1)).exactOptional(),
    minSupport: z.int().min(1),
    minPurity: z.number().finite(),
    maxRules: count,
    maxConditions: z.union([z.literal(1), z.literal(2)]),
  }),
  rules: z.strictObject({ fork: ForkIdSchema.exactOptional() }),
  evolve: z.strictObject({ fork: ForkIdSchema, member: z.string().min(1).exactOptional(), initial: CriteriaBookSchema.exactOptional() }),
  inbox: z.strictObject({ items: z.array(AttentionItemSchema).exactOptional(), resolve: z.array(z.string().min(1)).exactOptional() }),
  dispatch: z.strictObject({
    context: z.number().finite().min(0),
    expectedStretch: z.number().finite().min(0),
    newOutput: z.number().finite().positive().exactOptional(),
    from: z.string().min(1).exactOptional(),
    to: z.string().min(1).exactOptional(),
  }),
  spans: z.strictObject({ filter: Filter.exactOptional() }),
} as const;

/** A fresh object with every property that is defined (a parsed input may not have exact-optional keys the layer's types refuse as `undefined`). */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function decisionExtension(layer: DecisionLayer, options: DecisionExtensionOptions = {}): CognitiveExtension {
  /** An operation: its input parsed against its schema, its failures made clear. */
  function operation<K extends keyof typeof INPUTS>(name: K, run: (input: z.output<(typeof INPUTS)[K]>) => Promise<unknown> | unknown): (value: unknown) => Promise<unknown> {
    return async (value) => {
      const parsed = (INPUTS[name] as z.ZodType).safeParse(value ?? {});
      if (!parsed.success) throw new Error(`invalid decision.${name} input\n${z.prettifyError(parsed.error)}`);
      try {
        return await run(parsed.data as z.output<(typeof INPUTS)[K]>);
      } catch (e) {
        if (e instanceof DecisionError) throw new Error(`decision.${name} failed (${e.code}): ${e.message}`);
        throw new Error(`decision.${name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
  }

  /** At most `limit` records (100 unless given), and whether there are more. */
  async function page(filter: DecisionFilter) {
    const limit = filter.limit ?? DEFAULT_LIMIT;
    const found = await layer.records({ ...filter, limit: limit + 1 });
    return { records: found.slice(0, limit), more: found.length > limit };
  }

  const proposerFor = (): Proposer => {
    if (options.proposer !== undefined) return options.proposer;
    if (options.ensemble === undefined) throw new DecisionError("unavailable", "there is no proposer: give the extension one, or an ensemble whose language model can propose wording");
    const { system, maxTokens } = layer.settings.evolve.proposer;
    return llmProposer(options.ensemble.languageModel(), { system, maxTokens });
  };

  return {
    id: "decision",
    models: [],
    operations: {
      status: operation("status", () => layer.status()),
      forks: operation("forks", () => ({ forks: layer.forks() })),
      policy: operation("policy", () => ({ policy: layer.policy, forks: layer.forks().map((fork) => ({ id: fork.id, policy: fork.policy })) })),

      decide: operation("decide", async ({ fork, input, session, correlation }) => layer.decideNamed(fork, input, { session, correlation })),
      record: operation("record", async (input) => {
        if ("id" in input) {
          const record = await layer.record(input.id);
          if (record === undefined) throw new DecisionError("invalid", `no decision ${input.id}`);
          return { record };
        }
        return page(defined(input));
      }),
      outcome: operation("outcome", async ({ id, outcome }) => {
        if (!(await layer.outcome(id, { ...outcome, at: outcome.at ?? layer.clock.now() }))) throw new DecisionError("invalid", `no decision ${id}`);
        return { id, attached: true };
      }),
      spans: operation("spans", async ({ filter }) => {
        const { records, more } = await page(defined(filter ?? {}));
        return { spans: records.map(toSpan), more };
      }),

      report: operation("report", async ({ fork, filter }) => ({ reports: await layer.report(fork, defined(filter ?? {})) })),
      calibrate: operation("calibrate", async (input) => {
        const fitted = await layer.calibrate(defined(input));
        return { fitted, entries: layer.calibration().entries.length };
      }),
      thresholds: operation("thresholds", (input) => layer.thresholds(input)),
      estimate: operation("estimate", (input) => layer.estimate({ fork: input.fork, target: defined(input.target) })),

      distill: operation("distill", async (input) => {
        const examples = await layer.distill(defined(input));
        return { examples: examples.length, holdout: examples.filter((e) => e.split === "holdout").length, jsonl: examplesToJsonl(examples) };
      }),
      induce: operation("induce", (input) => layer.induce(defined(input))),
      rules: operation("rules", ({ fork }) => layer.rules(fork)),
      evolve: operation("evolve", (input) => layer.evolve({ ...defined(input), proposer: proposerFor() })),

      inbox: operation("inbox", ({ items, resolve }) => {
        for (const item of items ?? []) layer.inbox.add(item);
        // Stryker disable next-line ArrayDeclaration: equivalent; no item has the id the mutation makes up
        const resolved = (resolve ?? []).filter((id) => layer.inbox.resolve(id)).length;
        return { added: items?.length ?? 0, resolved, ranked: layer.inbox.rank(layer.clock.now()) };
      }),
      dispatch: operation("dispatch", ({ context, expectedStretch, newOutput, from, to }) => {
        const { prices, hysteresis, stepTokens } = layer.settings.dispatch;
        const plan = switchPlan({ context, expectedStretch, newOutput: newOutput ?? stepTokens, from: from ?? "large", to: to ?? "small", prices, hysteresis });
        return { ...plan, breakEvenStretch: Number.isFinite(plan.breakEvenStretch) ? plan.breakEvenStretch : null };
      }),
    },
  };
}
