/**
 * Reply templates: what `/ask` answers from before it spends any inference. Each is a
 * file in the virtual filesystem (`~/agent/templates/<id>.md`), so the person sees,
 * edits and keeps them like any other file: YAML frontmatter (what the template answers,
 * examples, where each hole's value comes from, feedback counts) and a body whose
 * `{{holes}}` make it a template constraint of fixed text and holes. A reply template's
 * body is the answer; a script template's body is a bash script, run through the
 * agent's `bash` tool (and its approval).
 */
import type { IFileSystem } from "just-bash";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { ConstraintSchema } from "@harness/cognitive";
import type { TemplateConstraint } from "@harness/cognitive";
import { HOME } from "./vfs.ts";

/** Where the templates live in the virtual filesystem. */
export const TEMPLATES = `${HOME}/agent/templates`;

/**
 * Where a hole's value comes from, cheapest first: a fact the harness knows (the files,
 * the working directory, the date), a pattern in the request, a choice the decision
 * model makes among options, or text a generator writes.
 */
export const HOLE_SOURCES = ["fact", "pattern", "choice", "text"] as const;
export type HoleSource = (typeof HOLE_SOURCES)[number];

const HoleSchema = z
  .strictObject({
    description: z.string().min(1),
    source: z.enum(HOLE_SOURCES).default("text"),
    /** For a fact, which one (the hole's name when absent); for a choice, the fact whose lines are the options. */
    fact: z.string().min(1).optional(),
    /** For a pattern: a regular expression whose first group, found in the request, is the value. */
    pattern: z.string().min(1).optional(),
    /** For a choice: the options. */
    options: z.array(z.string().min(1)).min(2).optional(),
  })
  .superRefine((hole, ctx) => {
    if (hole.source === "pattern" && hole.pattern === undefined) ctx.addIssue({ code: "custom", message: "a pattern hole needs a pattern" });
    if (hole.source === "choice" && hole.options === undefined && hole.fact === undefined) ctx.addIssue({ code: "custom", message: "a choice hole needs options, or a fact whose lines are the options" });
  });
export type Hole = z.output<typeof HoleSchema>;

export const TEMPLATE_KINDS = ["reply", "script"] as const;

const HOLE_NAME = /^[a-z][a-z0-9_]*$/;
const TEMPLATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FrontmatterSchema = z.strictObject({
  description: z.string().min(1),
  examples: z.array(z.string().min(1)).default([]),
  kind: z.enum(TEMPLATE_KINDS).default("reply"),
  /** A regular expression: a request it matches is this template's, without asking the decision model. */
  match: z
    .string()
    .min(1)
    .refine((pattern) => {
      try {
        new RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    }, "match is a regular expression")
    .optional(),
  holes: z.record(z.string().regex(HOLE_NAME, "a hole is named in snake_case"), HoleSchema).default({}),
  helpful: z.number().int().min(0).default(0),
  harmful: z.number().int().min(0).default(0),
  version: z.number().int().min(1).default(1),
  /** Who wrote it: `seed`, `written` (by a person) or `generated:<model>`. */
  origin: z.string().min(1).default("written"),
  /** Feedback waiting to be applied: the next time the template is chosen, it is refined first. */
  refine: z.string().min(1).optional(),
});

export interface Template extends z.output<typeof FrontmatterSchema> {
  readonly id: string;
  readonly body: string;
  /** The body as fixed text and holes. */
  readonly constraint: TemplateConstraint;
}

/** A template before its body is read into a constraint. */
export type TemplateDraft = Omit<Template, "constraint">;

/** The body's `{{holes}}` as a template constraint (refused when holes touch). */
function constraintOf(body: string): TemplateConstraint {
  const parts = body.split(/\{\{([a-z][a-z0-9_]*)\}\}/).flatMap((text, i): TemplateConstraint["parts"] => (i % 2 === 1 ? [{ hole: text }] : text === "" ? [] : [text]));
  const parsed = ConstraintSchema.safeParse({ type: "template", parts: parts.length ? parts : [" "] });
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data as TemplateConstraint;
}

export function parseTemplate(id: string, text: string): Template {
  if (!TEMPLATE_ID.test(id) || id === "none") throw new Error(`a template id is kebab-case, and not none: ${id}`);
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("a template starts with --- frontmatter ---");
  const parsed = FrontmatterSchema.safeParse(parse(match[1]!) ?? {});
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const body = match[2]!;
  return { id, ...parsed.data, body, constraint: constraintOf(body) };
}

export function templateFile(template: TemplateDraft): string {
  const { id: _id, body, constraint: _constraint, ...frontmatter } = template as Template;
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n${body}`;
}

export interface Feedback {
  readonly helpful: number;
  readonly harmful: number;
  readonly refine?: string | undefined;
  readonly retired: boolean;
}

/** The templates in their directory of the virtual filesystem. */
export class TemplateStore {
  readonly #fs: IFileSystem;
  readonly #retireMargin: number;
  readonly dir: string;

  constructor(fs: IFileSystem, options: { readonly retireMargin?: number; readonly dir?: string } = {}) {
    this.#fs = fs;
    this.#retireMargin = options.retireMargin ?? 3;
    this.dir = options.dir ?? TEMPLATES;
  }

  /** Every template (retired ones aside), and the files there that are not templates, with why. */
  async list(): Promise<{ templates: Template[]; problems: { path: string; error: string }[] }> {
    const templates: Template[] = [];
    const problems: { path: string; error: string }[] = [];
    const names = await this.#fs.readdir(this.dir).catch(() => [] as string[]);
    for (const name of [...names].sort()) {
      if (!name.endsWith(".md")) continue;
      const path = `${this.dir}/${name}`;
      try {
        templates.push(parseTemplate(name.slice(0, -3), await this.#fs.readFile(path)));
      } catch (e) {
        problems.push({ path, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { templates, problems };
  }

  async get(id: string): Promise<Template | undefined> {
    const path = `${this.dir}/${id}.md`;
    return (await this.#fs.exists(path)) ? parseTemplate(id, await this.#fs.readFile(path)) : undefined;
  }

  /** Write a template; one that exists is kept under `.history` and the new one's version counts up. */
  async put(draft: TemplateDraft): Promise<Template> {
    const was = await this.get(draft.id);
    let version = draft.version;
    if (was) {
      await this.#fs.mkdir(`${this.dir}/.history`, { recursive: true });
      await this.#fs.writeFile(`${this.dir}/.history/${was.id}.v${was.version}.md`, templateFile(was));
      version = was.version + 1;
    }
    const template = parseTemplate(draft.id, templateFile({ ...draft, version }));
    await this.#write(template);
    return template;
  }

  /** Count a reply as helpful or harmful (a harmful one with a note is refined when next chosen); retire one harmful by the margin. */
  async feedback(id: string, kind: "helpful" | "harmful", note?: string): Promise<Feedback> {
    const template = await this.get(id);
    if (!template) throw new Error(`no template ${id}`);
    const next = { ...template, [kind]: template[kind] + 1, ...(note ? { refine: note } : {}) };
    const retired = next.harmful - next.helpful >= this.#retireMargin;
    if (retired) {
      await this.#fs.mkdir(`${this.dir}/retired`, { recursive: true });
      await this.#fs.writeFile(`${this.dir}/retired/${id}.md`, templateFile(next));
      await this.#fs.rm(`${this.dir}/${id}.md`);
    } else await this.#write(next);
    return { helpful: next.helpful, harmful: next.harmful, refine: next.refine, retired };
  }

  async #write(template: TemplateDraft): Promise<void> {
    await this.#fs.mkdir(this.dir, { recursive: true });
    await this.#fs.writeFile(`${this.dir}/${template.id}.md`, templateFile(template));
  }
}
