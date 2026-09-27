import { z } from "zod";
import { ToolSpecSchema } from "@harness/cognitive";
import type { ToolSpec } from "@harness/cognitive";
import type { Learning } from "./learning.ts";
import { parse, RecordingSchema, TrajectorySchema } from "./schemas.ts";
import type { Lesson, Recording, Trajectory, TrajectoryInput } from "./schemas.ts";

/**
 * Plugins turn what learning knows into something a client can use, or teach it
 * something new. Learning defines only the contract; clients bring implementations
 * (a skills generator writing agent skills, a workflow generator, a code-mode tool
 * builder, a teacher that watches a recorded session), so each client offers what
 * its interface can observe and produce.
 */

/** Well-known materializer targets. Any other string names a target a client defines. */
export const TARGETS = {
  /** A learned behavior as an agent skill (instructions a coding agent loads on demand). */
  agentSkill: "agent-skill",
  /** A learned behavior as a workflow (steps with inputs, runnable again). */
  workflow: "workflow",
  /** Custom tooling built with code-mode tools; it becomes a tool learning can offer. */
  tool: "tool",
} as const;

export interface MaterializeInput {
  /** What the result is for: the task, or the behavior being captured. */
  readonly purpose: string;
  /** The lessons to capture (empty when building a tool for a new task). */
  readonly lessons: readonly Lesson[];
  /** Tools already available, so a builder can compose them. */
  readonly tools: readonly ToolSpec[];
}

export const MaterializedSchema = z.strictObject({
  target: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  files: z.array(z.strictObject({ path: z.string().min(1), content: z.string() })).readonly(),
  /** For tools: how to call it. Learning then offers it on later tasks. */
  tool: ToolSpecSchema.exactOptional(),
});
export type Materialized = z.output<typeof MaterializedSchema>;

/** Makes a skill, a workflow, a tool, or another target out of lessons. */
export interface Materializer {
  readonly kind: "materializer";
  readonly id: string;
  readonly target: string;
  materialize(input: MaterializeInput): Promise<unknown>;
}

/** Translates a recording of a person doing a task into a session learning can learn from. */
export interface Teacher {
  readonly kind: "teacher";
  readonly id: string;
  /** What it can observe, e.g. "screen", "audio", "events", "transcript". */
  readonly modalities: readonly string[];
  demonstrate(recording: Recording): Promise<TrajectoryInput>;
}

export type LearningPlugin = Materializer | Teacher;

export type PluginInfo = { readonly kind: "materializer"; readonly id: string; readonly target: string } | { readonly kind: "teacher"; readonly id: string; readonly modalities: readonly string[] };

/** The plugins a client has installed into learning, and what learning does with them. */
export class Plugins {
  readonly #plugins = new Map<string, LearningPlugin>();

  /** Install a plugin; returns a function that removes it. */
  use(plugin: LearningPlugin): () => void {
    if (this.#plugins.has(plugin.id)) throw new Error(`a plugin ${plugin.id} is already installed`);
    this.#plugins.set(plugin.id, plugin);
    return () => this.#plugins.delete(plugin.id);
  }

  list(): PluginInfo[] {
    return [...this.#plugins.values()].map((p) => (p.kind === "materializer" ? { kind: p.kind, id: p.id, target: p.target } : { kind: p.kind, id: p.id, modalities: p.modalities }));
  }

  /** The first plugin that makes `target`. */
  materializer(target: string): Materializer | undefined {
    return [...this.#plugins.values()].find((p): p is Materializer => p.kind === "materializer" && p.target === target);
  }

  teachers(): Teacher[] {
    return [...this.#plugins.values()].filter((p): p is Teacher => p.kind === "teacher");
  }

  /** Turn lessons into a skill, workflow, tool, or any target a plugin makes; the lessons remember what was made. */
  async materialize(learning: Learning, request: { readonly target: string; readonly lessons: readonly string[]; readonly purpose?: string; readonly tools?: readonly ToolSpec[] }): Promise<Materialized> {
    const lessons = request.lessons.map((id) => learning.lesson(id));
    const made = await this.#make(request.target, { purpose: request.purpose ?? lessons.map((l) => l.title).join("; "), lessons, tools: request.tools ?? [] });
    for (const l of lessons) learning.noteArtifact(l.id, { target: made.target, name: made.name });
    return made;
  }

  /** Build a tool for a task with the tool-building plugin; a built tool is learned, so later tasks find it. */
  async buildTool(learning: Learning, request: { readonly task: string; readonly tools?: readonly ToolSpec[] }): Promise<Materialized> {
    const made = await this.#make(TARGETS.tool, { purpose: request.task, lessons: [], tools: request.tools ?? [] });
    if (made.tool) {
      const lesson = await learning.addLesson({ kind: "tool", title: made.tool.name, text: made.tool.description || made.description, when: request.task, tool: made.tool, source: `built:${made.name}` });
      learning.noteArtifact(lesson.id, { target: made.target, name: made.name });
    }
    return made;
  }

  /** Learn from a person doing the task: a teacher that observes every part of the recording translates it into a demonstration. */
  async teach(learning: Learning, input: unknown): Promise<{ trajectory: Trajectory } & Awaited<ReturnType<Learning["observe"]>>> {
    const recording = parse(RecordingSchema, "recording", input);
    const modalities = [...new Set(recording.parts.map((p) => p.modality))];
    const teacher = this.teachers().find((t) => modalities.every((m) => t.modalities.includes(m)));
    if (!teacher) throw new Error(`no teacher observes ${modalities.join(" and ")}`);
    const trajectory = parse(TrajectorySchema, `${teacher.id} demonstration`, { ...(await teacher.demonstrate(recording)), source: "demonstration" });
    return { trajectory, ...(await learning.observe(trajectory)) };
  }

  async #make(target: string, input: MaterializeInput): Promise<Materialized> {
    const plugin = this.materializer(target);
    if (!plugin) throw new Error(`no plugin makes ${target}`);
    return parse(MaterializedSchema, `${plugin.id} output`, await plugin.materialize(input));
  }
}
