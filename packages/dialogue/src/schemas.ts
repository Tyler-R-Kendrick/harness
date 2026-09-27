import { z } from "zod";
import { ConstraintSchema, ProbabilitySchema, SimilaritySchema } from "@harness/cognitive";

/**
 * What a dialogue reads and writes, as schemas: script books (authored, or saved with
 * what the dialogue built), and its settings. Everything past a parse is well formed.
 */

const text = z.string().min(1);

export function parse<S extends z.ZodType>(schema: S, what: string, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`invalid ${what}\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Script ids: lower-case names (`order-status`); scripts the dialogue builds are `s1`, `s2`, ... */
export const ScriptIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/, "a script id is a lower-case name").brand<"ScriptId">();
export type ScriptId = z.output<typeof ScriptIdSchema>;
export const scriptId = (id: string): ScriptId => parse(ScriptIdSchema, "script id", id);

/** Slots and generated holes are named in snake_case (a template's holes are). */
const Name = z.string().regex(/^[a-z][a-z0-9_]*$/, "a slot or hole is named in snake_case");

/** A refinement's issue: `message` at `path`. */
const issue = (ctx: z.core.$RefinementCtx, message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });

/** Patterns match whole utterances, ignoring case. */
export const PATTERN_FLAGS = "iu";
const Regex = z
  .string()
  .min(1)
  .superRefine((source, ctx) => {
    try {
      new RegExp(source, PATTERN_FLAGS);
    } catch (e) {
      issue(ctx, `not a regular expression: ${(e as Error).message}`, []);
    }
  });
/** The named groups a pattern captures. */
export const groupsOf = (source: string): string[] => [...source.matchAll(/\(\?<([^>=!]+)>/g)].map((m) => m[1]!);

/** A path into a tool's input or output: object keys and array indexes. */
export const PathSchema = z.array(z.union([z.string(), z.int().min(0)])).readonly();
export type Path = z.output<typeof PathSchema>;

const HoleConstraint = ConstraintSchema.refine((c) => c.type !== "template", "a template in a template is not supported");

/**
 * A part of a reply: fixed text, or a hole filled from a slot, from the result step's
 * tool input or output (at a path), or generated (optionally constrained).
 */
export const PartSchema = z.union([
  text,
  z.strictObject({ slot: Name }),
  z.strictObject({ input: PathSchema }),
  z.strictObject({ output: PathSchema }),
  z.strictObject({ generate: Name, constraint: HoleConstraint.exactOptional() }),
]);
export type Part = z.output<typeof PartSchema>;

/**
 * A slot: something the user says that the reply needs. A value pattern finds it in an
 * answer; prompts ask for it when a matched script lacks it, in order, one per retry
 * (VoiceXML's prompt counts); a slot with no prompts is never asked for.
 */
export const SlotSchema = z.strictObject({
  description: text.exactOptional(),
  pattern: Regex.exactOptional(),
  prompts: z.array(text).readonly().default([]),
});
export type Slot = z.output<typeof SlotSchema>;

export const SCRIPT_STATUSES = ["active", "candidate", "retired"] as const;
export type ScriptStatus = (typeof SCRIPT_STATUSES)[number];

export const EvidenceSchema = z.strictObject({
  /** Times the model's own reply fit the script (or a judge found it as good), and feedback that it helped. */
  fits: z.int().min(0),
  /** Times the model said something else, and feedback that it misled. */
  misses: z.int().min(0),
  /** Times it answered. */
  served: z.int().min(0),
});
export type Evidence = z.output<typeof EvidenceSchema>;

/**
 * A script answers one kind of step without the model. An utterance script is matched
 * by patterns (anchored, case-insensitive, named groups filling slots), by exemplars (by
 * meaning) or by the tool router (its intent is the description); a result script
 * answers the step that follows a call of its tool. A context limits a script to the
 * step after the one its context script matched. Only active scripts answer: a
 * candidate is checked against the model's replies first.
 */
export const ScriptSchema = z
  .strictObject({
    id: ScriptIdSchema,
    intent: text,
    status: z.enum(SCRIPT_STATUSES).default("active"),
    origin: z.enum(["authored", "induced", "drafted"]).default("authored"),
    context: ScriptIdSchema.exactOptional(),
    patterns: z.array(Regex).readonly().default([]),
    exemplars: z.array(text).readonly().default([]),
    result: z.strictObject({ tool: text }).exactOptional(),
    slots: z.record(Name, SlotSchema).default({}),
    reply: z.array(PartSchema).min(1).readonly(),
    evidence: EvidenceSchema.default({ fits: 0, misses: 0, served: 0 }),
  })
  .superRefine((s, ctx) => {
    if (s.context === s.id) issue(ctx, "a script cannot be its own context", ["context"]);
    s.patterns.forEach((p, i) => {
      for (const group of groupsOf(p)) if (!(group in s.slots)) issue(ctx, `pattern names slot ${group}, which is not declared`, ["patterns", i]);
    });
    if (s.result && (s.patterns.length > 0 || s.exemplars.length > 0 || Object.keys(s.slots).length > 0)) issue(ctx, "a result script is not matched by patterns, exemplars or slots", ["result"]);
    const generated = new Set<string>();
    s.reply.forEach((part, i) => {
      if (typeof part === "string") return;
      if (typeof s.reply[i - 1] === "object") issue(ctx, "holes next to each other have no text between them to tell where one ends", ["reply", i]);
      if ("slot" in part && !(part.slot in s.slots)) issue(ctx, `reply names slot ${part.slot}, which is not declared`, ["reply", i]);
      if (("input" in part || "output" in part) && !s.result) issue(ctx, "only a result script reads a tool's input or output", ["reply", i]);
      if ("generate" in part) {
        if (generated.has(part.generate)) issue(ctx, `hole ${part.generate} is named twice`, ["reply", i]);
        generated.add(part.generate);
      }
    });
  });
export type Script = z.output<typeof ScriptSchema>;
export type ScriptInput = z.input<typeof ScriptSchema>;
export const parseScript = (input: unknown): Script => parse(ScriptSchema, "script", input);

/** A tool call and its result, as a result step has them. */
export const ResultSchema = z.strictObject({ tool: text, input: z.json(), output: z.json() });
export type ToolResult = z.output<typeof ResultSchema>;

/** A step the model answered: what the user said last, the tool result it followed (if any), and the reply. */
export const ObservationSchema = z.strictObject({ utterance: z.string(), result: ResultSchema.exactOptional(), reply: z.string() });
export type Observation = z.output<typeof ObservationSchema>;

/**
 * Steps alike (a result step's by its tool; an utterance step's by what was said, in
 * the same context), kept until a script is built from them and becomes active.
 */
export const ClusterSchema = z.strictObject({
  context: ScriptIdSchema.exactOptional(),
  tool: text.exactOptional(),
  /** The script built from it. */
  script: ScriptIdSchema.exactOptional(),
  /** Whether the drafter was asked for a script (once per cluster). */
  drafted: z.boolean().default(false),
  observations: z.array(ObservationSchema),
});
export type Cluster = z.output<typeof ClusterSchema>;

/** A script book: authored scripts, and what a dialogue saved (the scripts it built, and clusters it is building from). */
export const BookSchema = z
  .strictObject({
    $schema: z.string().exactOptional(),
    /** The number of the next built script's id (`s<next>`); ids are never reused. */
    next: z.int().positive().default(1),
    scripts: z.array(ScriptSchema).default([]),
    clusters: z.array(ClusterSchema).default([]),
  })
  .superRefine((book, ctx) => {
    const ids = new Set<string>();
    book.scripts.forEach((s, i) => {
      if (ids.has(s.id)) issue(ctx, `script ${s.id} is in the book twice`, ["scripts", i]);
      ids.add(s.id);
    });
    book.scripts.forEach((s, i) => {
      if (s.context !== undefined && !ids.has(s.context)) issue(ctx, `context ${s.context} is not a script in the book`, ["scripts", i, "context"]);
    });
    book.clusters.forEach((c, i) => {
      if (c.script !== undefined && !ids.has(c.script)) issue(ctx, `cluster's script ${c.script} is not in the book`, ["clusters", i, "script"]);
    });
  });
export type Book = z.output<typeof BookSchema>;
export const parseBook = (input: unknown): Book => parse(BookSchema, "script book", input);

/** JSON Schema for script books, for editors (data/book.schema.json). */
export const bookJsonSchema = (): object => z.toJSONSchema(BookSchema, { io: "input" });

// ---- settings (data/settings.json) -------------------------------------------------

export const SettingsSchema = z.strictObject({
  $schema: z.string().exactOptional(),
  match: z.strictObject({
    /** Exemplar similarity at or above which an utterance matches a script. */
    similar: SimilaritySchema,
    /** Router confidence at or above which its pick of a script is taken. */
    route: ProbabilitySchema,
  }),
  induce: z
    .strictObject({
      /** Observations a cluster needs before a script is induced from it. */
      support: z.int().min(2),
      /** Similarity at or above which an utterance joins a cluster (by meaning, or by shape without an embedder). */
      cluster: SimilaritySchema,
      /**
       * The share of an induced reply that must be determined without the model (fixed text,
       * and values from slots or the tool's result), and of an utterance pattern that must be
       * fixed text.
       */
      determined: ProbabilitySchema,
      /** The most holes an induced reply may have. */
      holes: z.int().min(0),
      /** Observations kept per cluster (the latest). */
      keep: z.int().min(2),
    })
    .refine((i) => i.keep >= i.support, "keep at least support observations"),
  promote: z.strictObject({
    /** Fits at which a candidate becomes active. */
    fits: z.int().min(1),
    /** A script whose misses exceed its fits by this much is retired. */
    retireMargin: z.int().min(1),
    /** Judge probability at or above which a candidate's rendering counts as a fit. */
    judge: ProbabilitySchema,
    /** Asked of the judge about `request`, the model's `reply` and the script's `candidate`. */
    question: text,
  }),
  draft: z.strictObject({
    /** Instructions for the drafter model; it answers with a draft (see DraftSchema). */
    system: text,
    maxTokens: z.int().positive(),
    /** Follow-up scripts asked for with each draft: what the user will likely say next. */
    followUps: z.int().min(0),
  }),
  /** Sessions whose dialogue state (the last script, a form being filled) is kept; the least recent is forgotten. */
  sessions: z.int().min(1),
});
export type Settings = z.output<typeof SettingsSchema>;
export const parseSettings = (input: unknown): Settings => parse(SettingsSchema, "dialogue settings", input);

/** JSON Schema for the settings file, for editors (data/settings.schema.json). */
export const settingsJsonSchema = (): object => z.toJSONSchema(SettingsSchema);
