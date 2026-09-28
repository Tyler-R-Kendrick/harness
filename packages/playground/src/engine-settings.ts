/**
 * What the template engine is tuned by, as data (`data/templates.json`, whose `$schema`
 * is generated from this parser): when a decision is taken, how the lexical decision
 * model scores, when a template retires, and what generators are asked.
 */
import { BytesSchema, ProbabilitySchema } from "@harness/cognitive";
import { z } from "zod";

const Prompt = z.string().min(1);

const EngineSettingsSchema = z.strictObject({
  $schema: z.string().optional(),
  decision: z.strictObject({
    /** The probability a decision model's choice needs before its template answers. */
    accept: ProbabilitySchema,
    /** Options per question the decision model takes (none included); more templates are narrowed lexically first. */
    maxOptions: z.number().int().min(2),
    question: Prompt,
    /** The option that says no template answers. */
    none: Prompt,
    /** Ask a model with the options in every rotation at once and average its answers, so an option's position does not decide it. */
    rotate: z.boolean(),
  }),
  lexical: z.strictObject({
    /** The probability the lexical decision model's choice needs before its template answers. */
    accept: ProbabilitySchema,
    /** The similarity the `none` option scores, so a request unlike every template is none. */
    none: z.number().min(0).max(1),
    /** Softmax temperature over similarities. */
    temperature: z.number().gt(0),
    stopwords: z.array(z.string().min(1)),
  }),
  /** Which local model the page picks when the person has not: large ones need WebGPU, and every download room to spare. */
  choice: z.strictObject({
    /** Local models larger than this run only with a WebGPU adapter. */
    gpuBytes: BytesSchema,
    /** The storage a download needs, as a multiple of its size. */
    headroom: z.number().min(1),
  }),
  curation: z.strictObject({
    /** Harmful minus helpful votes that retire a template. */
    retireMargin: z.number().int().min(1),
  }),
  generation: z.strictObject({
    /** Writing a new template: its format, and the facts a hole can take its value from. */
    write: Prompt,
    /** Filling a template's text holes for one request. */
    fill: Prompt,
    /** Rewriting a template from feedback. */
    refine: Prompt,
    /** The most tokens a generator's answer may take (a small model can loop until it is cut off). */
    maxTokens: z.number().int().min(64),
    /** How long a written script may run on a copy of the files before it is kept (milliseconds). */
    trialMs: z.number().int().min(100),
    /** Seed templates shown to a generator as worked examples of a written template, by id. */
    examples: z.array(z.string().min(1)),
    /** Bounds on a written template, held by the schema a generator writes to. */
    limits: z.strictObject({
      /** Characters in its id. */
      id: z.number().int().min(8),
      /** Characters in its description, and in each example request. */
      text: z.number().int().min(16),
      /** Characters in its body. */
      body: z.number().int().min(16),
      /** Example requests it answers. */
      examples: z.number().int().min(1),
    }),
  }),
});

export type EngineSettings = z.output<typeof EngineSettingsSchema>;

export function parseEngineSettings(value: unknown): EngineSettings {
  return EngineSettingsSchema.parse(value);
}

export const engineSettingsJsonSchema = (): object => z.toJSONSchema(EngineSettingsSchema, { io: "input" });
