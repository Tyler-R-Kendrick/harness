import { z } from "zod";
import { ProbabilitySchema, SimilaritySchema, ToolSpecSchema } from "@harness/cognitive";
import { MemoryIdSchema } from "@harness/memory";

/**
 * What learning reads and writes, as schemas: parsed at every boundary (operations,
 * model output, saved state, settings), so everything past a parse is well formed.
 */

const text = z.string().min(1);

/** Lesson ids: "l" and a number that is never reused. A memory id ("m1") is not one. */
export const LessonIdSchema = z.templateLiteral(["l", z.int().positive()]);
export type LessonId = z.output<typeof LessonIdSchema>;

// ---- sessions ----------------------------------------------------------------------

/** One step of a session: what was said, done or observed. */
export const StepSchema = z.strictObject({
  role: z.enum(["user", "assistant", "tool", "observation"]),
  content: z.string(),
  /** The tool the assistant called, for tool steps. */
  call: z.strictObject({ name: text, arguments: z.record(z.string(), z.unknown()) }).exactOptional(),
});

/**
 * A session to learn from: the task, what happened, and how it ended. Sessions come from
 * the daemon, or from a teacher plugin translating a recording of a person doing the task
 * (a demonstration, which counts as a success).
 */
export const TrajectorySchema = z.strictObject({
  id: text,
  task: text,
  steps: z.array(StepSchema).readonly(),
  outcome: z.strictObject({ status: z.enum(["success", "failure", "unknown"]), feedback: z.string().exactOptional() }),
  source: z.enum(["session", "demonstration"]).default("session"),
  sessionId: text.exactOptional(),
});
export type Trajectory = z.output<typeof TrajectorySchema>;
export type TrajectoryInput = z.input<typeof TrajectorySchema>;

// ---- lessons -----------------------------------------------------------------------

/**
 * Kinds of knowledge distilled from sessions: an insight about the domain, a strategy
 * that worked, a procedure (reusable steps, the seed of a skill or workflow), a pitfall
 * to avoid, or a tool that was built.
 */
export const LESSON_KINDS = ["insight", "strategy", "procedure", "pitfall", "tool"] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

const LessonContent = {
  title: text,
  text,
  /** When the lesson applies. */
  when: text.exactOptional(),
  /** Ordered steps, for procedures. */
  steps: z.array(text).readonly().exactOptional(),
};

export const LessonSchema = z.strictObject({
  id: LessonIdSchema,
  kind: z.enum(LESSON_KINDS),
  ...LessonContent,
  /** The tool a "tool" lesson made available. */
  tool: ToolSpecSchema.exactOptional(),
  /** Times the lesson was confirmed useful, and times it misled. */
  helpful: z.int().min(0),
  harmful: z.int().min(0),
  /** Trajectories it was learned or confirmed from. */
  sources: z.array(text).readonly(),
  /** What plugins made of it (skills, workflows, tools). */
  artifacts: z.array(z.strictObject({ target: text, name: text })).readonly(),
  /** Its entry in memory, where it is found by meaning. */
  memoryId: MemoryIdSchema,
});
export type Lesson = z.output<typeof LessonSchema>;

/**
 * How a reflection changes the lessons: incremental edits, never a rewrite, so what was
 * learned is not lost to a summary (ACE's delta updates). Ids must be lessons the
 * reflection was shown.
 */
export const DeltaSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), kind: z.enum(LESSON_KINDS).exclude(["tool"]), ...LessonContent }),
  z.strictObject({ op: z.literal("refine"), id: LessonIdSchema, ...LessonContent }),
  z.strictObject({ op: z.literal("helpful"), id: LessonIdSchema }),
  z.strictObject({ op: z.literal("harmful"), id: LessonIdSchema }),
]);
export type Delta = z.output<typeof DeltaSchema>;
export const ReflectionSchema = z.strictObject({ operations: z.array(DeltaSchema) });

// ---- teaching ----------------------------------------------------------------------

/** Whatever a client could record of a person doing a task: screen, audio, input events, a transcript... */
export const RecordingSchema = z.strictObject({
  task: text,
  parts: z.array(z.strictObject({ modality: text, mediaType: text, data: z.string() })).min(1),
  note: z.string().exactOptional(),
});
export type Recording = z.output<typeof RecordingSchema>;

// ---- settings (data/settings.json) -------------------------------------------------

export const SettingsSchema = z.strictObject({
  $schema: z.string().exactOptional(),
  reflection: z.strictObject({
    /** Instructions for the model that distills lessons; it answers with a ReflectionSchema object. */
    system: text,
    maxTokens: z.int().positive(),
    /** Related lessons shown to the reflection, so it can confirm or refine them. */
    related: z.int().min(0),
  }),
  curation: z.strictObject({
    /** Similarity at which a new lesson is the same as an old one, and merges into it. */
    duplicate: SimilaritySchema,
    /** A lesson that misled this many more times than it helped is retired. */
    retireMargin: z.int().positive(),
  }),
  recall: z.strictObject({ limit: z.int().positive(), minScore: SimilaritySchema }),
  ladder: z.strictObject({
    /** Asked of the judge: can the model do the task from its own knowledge? */
    native: z.strictObject({ question: text, threshold: ProbabilitySchema }),
    /** The router's confidence needed to use a tool it picked. */
    tool: z.strictObject({ confidence: ProbabilitySchema }),
    /** Asked of the judge: does the model know how to build a tool for the task? */
    build: z.strictObject({ question: text, threshold: ProbabilitySchema }),
  }),
});
export type Settings = z.output<typeof SettingsSchema>;

export function parse<T>(schema: z.ZodType<T>, what: string, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`invalid ${what}\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Parse learning's settings file (see data/settings.json). */
export const parseSettings = (input: unknown): Settings => parse(SettingsSchema, "learning settings", input);

/** JSON Schema for the settings file, for editors (data/settings.schema.json). */
export const settingsJsonSchema = (): object => z.toJSONSchema(SettingsSchema, { io: "input" });
