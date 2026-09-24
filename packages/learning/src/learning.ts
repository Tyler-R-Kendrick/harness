import { z } from "zod";
import type { Ensemble } from "@harness/cognitive";
import type { Memory } from "@harness/memory";
import { LessonSchema, parse, ReflectionSchema, TrajectorySchema } from "./schemas.ts";
import type { Delta, Lesson, LessonId, LessonKind, Settings, TrajectoryInput } from "./schemas.ts";

/** The models learning thinks with: a generator to reflect, a judge to assess, a router to pick tools. */
export type Reasoner = Pick<Ensemble, "generate" | "judge" | "route">;

export type Change = { readonly op: "added" | "merged" | "refined" | "helpful" | "harmful" | "retired"; readonly id: LessonId };

export interface LearningOptions {
  readonly reasoner: Reasoner;
  /** Where lessons are found by meaning; learning requires the memory extension. */
  readonly memory: Memory;
  readonly settings: Settings;
  /** A previous `save()`, to continue from (memory is saved on its own). */
  readonly saved?: unknown;
  /** Called after every change, e.g. to persist `save()`. */
  readonly onChange?: (learning: Learning) => void;
}

/** Memory items that are lessons carry this kind. */
const KIND = "lesson";
const FORMAT = "harness.learning/v1";
const Saved = z.strictObject({ format: z.literal(FORMAT), next: z.int().positive(), lessons: z.array(LessonSchema) });

/** The reflection's answer format, enforced by generators that can (see the catalog's constraints). */
const REFLECTION_SCHEMA = z.toJSONSchema(ReflectionSchema, { io: "input" }) as Record<string, unknown>;

const indexText = (l: Pick<Lesson, "title" | "text" | "when">) => `${l.title}: ${l.text}${l.when ? ` (when ${l.when})` : ""}`;

/**
 * Learning from sessions. Each session is reflected on by a model that distils lessons
 * (insights, strategies, procedures, pitfalls) from what worked and what failed, and
 * edits the lesson set incrementally: add, refine, confirm, or count as misleading. New
 * lessons that say what an old one says merge into it; lessons that mislead more than
 * they help are retired. Lessons are recalled by meaning (through memory) to inform the
 * next session on a related task. This follows ExpeL (insights from successes and
 * failures), ReasoningBank (strategies, not raw traces) and ACE (incremental delta
 * edits with helpful/harmful counts instead of rewriting a summary).
 */
export class Learning {
  readonly #reasoner: Reasoner;
  readonly #memory: Memory;
  readonly #settings: Settings;
  readonly #onChange: ((learning: Learning) => void) | undefined;
  readonly #lessons = new Map<string, Lesson>();
  #next = 1;

  constructor(options: LearningOptions) {
    this.#reasoner = options.reasoner;
    this.#memory = options.memory;
    this.#settings = options.settings;
    this.#onChange = options.onChange;
    if (options.saved !== undefined) {
      const saved = parse(Saved, "saved learning", options.saved);
      this.#next = saved.next;
      for (const l of saved.lessons) this.#lessons.set(l.id, l);
    }
  }

  get settings(): Settings {
    return this.#settings;
  }

  lessons(): Lesson[] {
    return [...this.#lessons.values()];
  }

  lesson(id: string): Lesson {
    const l = this.#lessons.get(id);
    if (!l) throw new Error(`no lesson ${id}`);
    return l;
  }

  save(): unknown {
    return { format: FORMAT, next: this.#next, lessons: this.lessons() };
  }

  /** Lessons related to a task, best first, and a playbook to put before the model. */
  async recall(task: string, options: { readonly limit?: number; readonly kinds?: readonly LessonKind[] } = {}): Promise<{ lessons: Lesson[]; playbook: string }> {
    const found = await this.#memory.recall(task, { kinds: [KIND], limit: options.limit ?? this.#settings.recall.limit, minScore: this.#settings.recall.minScore });
    const byMemory = new Map(this.lessons().map((l) => [l.memoryId, l]));
    const lessons = found.flatMap((f) => byMemory.get(f.id) ?? []).filter((l) => !options.kinds || options.kinds.includes(l.kind));
    const playbook = lessons.length ? `Lessons from earlier sessions:\n${lessons.map((l) => `- [${l.kind}] ${indexText(l)}`).join("\n")}` : "";
    return { lessons, playbook };
  }

  /** Reflect on a session and apply what it teaches. */
  async observe(input: TrajectoryInput): Promise<{ changes: Change[]; rejected: string[] }> {
    const session = parse(TrajectorySchema, "trajectory", input);
    const shown = (await this.recall(session.task, { limit: this.#settings.reflection.related })).lessons;
    const raw = await this.#generate(JSON.stringify({ session, lessons: shown.map(({ id, kind, title, text, when, helpful, harmful }) => ({ id, kind, title, text, when, helpful, harmful })) }));
    const start = raw.indexOf("{");
    if (start < 0) return { changes: [], rejected: ["the reflection held no JSON object"] };
    let json: unknown;
    try {
      json = JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1));
    } catch (e) {
      return { changes: [], rejected: [`the reflection was not valid JSON: ${(e as Error).message}`] };
    }
    const reflection = ReflectionSchema.safeParse(json);
    if (!reflection.success) return { changes: [], rejected: [`the reflection was not valid\n${z.prettifyError(reflection.error)}`] };
    const allowed = new Set(shown.map((l) => l.id));
    const changes: Change[] = [];
    const rejected: string[] = [];
    for (const delta of reflection.data.operations) {
      if (delta.op !== "add" && !(allowed.has(delta.id) && this.#lessons.has(delta.id))) {
        rejected.push(`${delta.op} ${delta.id}: no such lesson was shown`);
        continue;
      }
      changes.push(...(await this.#apply(delta, session.id)));
    }
    if (changes.length) this.#onChange?.(this);
    return { changes, rejected };
  }

  /** Feedback from outside a reflection: the lesson helped, or misled. */
  async feedback(id: string, helpful: boolean): Promise<Change[]> {
    const changes = await this.#apply({ op: helpful ? "helpful" : "harmful", id: this.lesson(id).id });
    this.#onChange?.(this);
    return changes;
  }

  /** Add a lesson as it is, without the merge check (imports, tools that were built). */
  async addLesson(input: { readonly kind: LessonKind; readonly title: string; readonly text: string; readonly when?: string; readonly steps?: readonly string[]; readonly tool?: Lesson["tool"]; readonly source: string }): Promise<Lesson> {
    const { source, ...content } = input;
    const [memoryId] = await this.#memory.remember([{ text: indexText(content), kind: KIND }]);
    const lesson = parse(LessonSchema, "lesson", { ...content, id: `l${this.#next++}`, helpful: 0, harmful: 0, sources: [source], artifacts: [], memoryId });
    this.#lessons.set(lesson.id, lesson);
    this.#onChange?.(this);
    return lesson;
  }

  /** Record what a plugin made of a lesson. */
  noteArtifact(id: string, artifact: { readonly target: string; readonly name: string }): void {
    const l = this.lesson(id);
    this.#lessons.set(id, { ...l, artifacts: [...l.artifacts, artifact] });
    this.#onChange?.(this);
  }

  /**
   * Rebuild the lesson set: lessons that say the same thing (learned apart, or imported)
   * merge into the oldest, which keeps their confirmations and sources.
   */
  async consolidate(): Promise<Change[]> {
    const changes: Change[] = [];
    for (const keep of this.lessons()) {
      if (!this.#lessons.has(keep.id)) continue;
      for (const other of await this.#duplicates(indexText(keep))) {
        if (other.id === keep.id || Number(other.id.slice(1)) < Number(keep.id.slice(1))) continue;
        const current = this.#lessons.get(keep.id)!;
        this.#lessons.set(keep.id, { ...current, helpful: current.helpful + other.helpful + 1, harmful: current.harmful + other.harmful, sources: [...new Set([...current.sources, ...other.sources])] });
        await this.#retire(other);
        changes.push({ op: "merged", id: keep.id }, { op: "retired", id: other.id });
      }
    }
    if (changes.length) this.#onChange?.(this);
    return changes;
  }

  async #generate(content: string): Promise<string> {
    const { system, maxTokens } = this.#settings.reflection;
    let text = "";
    const request = { messages: [{ role: "system" as const, content: system }, { role: "user" as const, content }], maxTokens, constraint: { type: "json-schema" as const, schema: REFLECTION_SCHEMA } };
    for await (const e of this.#reasoner.generate(request, "reasoning")) {
      if (e.type === "text") text += e.text;
    }
    return text;
  }

  async #duplicates(text: string): Promise<Lesson[]> {
    const found = await this.#memory.recall(text, { kinds: [KIND], minScore: this.#settings.curation.duplicate, limit: 10 });
    const byMemory = new Map(this.lessons().map((l) => [l.memoryId, l]));
    return found.flatMap((f) => byMemory.get(f.id) ?? []);
  }

  async #apply(delta: Delta, source?: string): Promise<Change[]> {
    const sourced = (l: Lesson): Lesson => (source && !l.sources.includes(source) ? { ...l, sources: [...l.sources, source] } : l);
    switch (delta.op) {
      case "add": {
        const { op: _, ...content } = delta;
        const [same] = await this.#duplicates(indexText(content));
        if (same) {
          this.#lessons.set(same.id, sourced({ ...same, helpful: same.helpful + 1 }));
          return [{ op: "merged", id: same.id }];
        }
        const [memoryId] = await this.#memory.remember([{ text: indexText(content), kind: KIND }]);
        const lesson = parse(LessonSchema, "lesson", { ...content, id: `l${this.#next++}`, helpful: 0, harmful: 0, sources: source ? [source] : [], artifacts: [], memoryId });
        this.#lessons.set(lesson.id, lesson);
        return [{ op: "added", id: lesson.id }];
      }
      case "refine": {
        const { op: _, id, ...content } = delta;
        const old = this.#lessons.get(id)!;
        await this.#memory.forget([old.memoryId]);
        const [memoryId] = await this.#memory.remember([{ text: indexText(content), kind: KIND }]);
        const { when: _when, steps: _steps, ...kept } = old;
        this.#lessons.set(id, sourced({ ...kept, ...content, memoryId: memoryId! }));
        return [{ op: "refined", id }];
      }
      case "helpful": {
        const l = this.#lessons.get(delta.id)!;
        this.#lessons.set(l.id, sourced({ ...l, helpful: l.helpful + 1 }));
        return [{ op: "helpful", id: l.id }];
      }
      case "harmful": {
        const l = sourced({ ...this.#lessons.get(delta.id)!, harmful: this.#lessons.get(delta.id)!.harmful + 1 });
        this.#lessons.set(l.id, l);
        if (l.harmful - l.helpful < this.#settings.curation.retireMargin) return [{ op: "harmful", id: l.id }];
        await this.#retire(l);
        return [
          { op: "harmful", id: l.id },
          { op: "retired", id: l.id },
        ];
      }
    }
  }

  async #retire(l: Lesson): Promise<void> {
    this.#lessons.delete(l.id);
    await this.#memory.forget([l.memoryId]);
  }
}
