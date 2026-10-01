/**
 * The template engine: `/ask` answered from templates before any inference. Its model
 * (an AI SDK `LanguageModelV4`, so it runs in the agent worker like any other) decides
 * which template answers with a decision model, fills the holes it can without
 * generating, and replies (a reply template) or runs the script (a script template, through
 * the `bash` tool and its approval). Only what cannot be decided is generated, through
 * tools that never ask: writing a template when none fits, filling a template's text
 * holes, and rewriting one rated harmful. A written template is a file in the virtual
 * filesystem, so the next similar request costs no inference.
 */
import type {
  JSONValue,
  LanguageModelV4,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";
import { createIdGenerator, generateText, Output, simulateReadableStream, tool } from "ai";
import type { ToolApprovalStatus, ToolSet } from "ai";
import { z } from "zod";
import { collectParts, fillTemplate, finishReason, usage } from "@harness/cognitive";
import { chooseTemplate, holeNames, holeOf, resolveHoles } from "./decide.ts";
import type { Decider } from "./decide.ts";
import type { Facts } from "./decide.ts";
import type { EngineSettings } from "./engine-settings.ts";
import { report } from "./shell-model.ts";
import { HOLE_SOURCES, parseTemplate, TEMPLATE_KINDS, templateFile } from "./templates.ts";
import type { Template, TemplateStore } from "./templates.ts";

/** Whether generating (local inference, never asked about) runs, or is off. */
export const GENERATIONS = ["auto", "off"] as const;
export type Generation = (typeof GENERATIONS)[number];

/** The tools that spend inference. */
export const GENERATION_TOOLS = ["write_template", "fill_template", "refine_template"] as const;
type GenerationTool = (typeof GENERATION_TOOLS)[number];
const isGeneration = (name: string): name is GenerationTool => (GENERATION_TOOLS as readonly string[]).includes(name);

export interface EngineOptions {
  readonly store: TemplateStore;
  readonly settings: EngineSettings;
  /** What the harness knows, for fact holes. */
  readonly facts: Facts;
  /** The decision models now, in the order they are asked (the lexical one last, and alone until a model has loaded). */
  readonly deciders: () => readonly Decider[];
  /** Models that can write templates, cheapest first; each is asked until one writes (the page waits for its local model). */
  readonly generators: () => readonly LanguageModelV4[] | Promise<readonly LanguageModelV4[]>;
  /** Models that answer a request themselves when no template can be written; the first that answers is kept to. */
  readonly answerers?: () => readonly LanguageModelV4[] | Promise<readonly LanguageModelV4[]>;
  readonly generation: () => Generation;
  /**
   * Runs a script on a throwaway copy of the files: a written script template is tried
   * this way before it is kept, and one that fails leaves the writing to the next generator.
   */
  readonly trial?: (script: string) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

/** A template as a generator writes it: the template, and the values of its text holes for the request (bounded by the settings). */
function writtenSchema(limits: EngineSettings["generation"]["limits"]) {
  const text = z.string().min(1).max(limits.text);
  return z.object({
    id: z.string().max(limits.id).regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/).describe("kebab-case"),
    description: text.describe("what a request it answers asks for, as the asker would put it, e.g. \"Today's date\" or \"To see the contents of a file\": a decision model picks templates by it"),
    examples: z.array(text).min(1).max(limits.examples),
    kind: z.enum(TEMPLATE_KINDS),
    body: z.string().min(1).max(limits.body),
    holes: z.record(z.string(), z.object({ description: text, source: z.enum(HOLE_SOURCES).default("text"), fact: z.string().optional(), pattern: z.string().optional(), options: z.array(z.string()).optional() })).default({}),
    values: z.record(z.string(), z.string()).default({}),
  });
}
type Written = z.output<ReturnType<typeof writtenSchema>>;

/** What a generation tool returns: the template and the values it wrote, or why it could not; and why the generators before it did not. */
type Generated = ({ readonly id: string; readonly values: Readonly<Record<string, string>>; readonly by: string } | { readonly answer: string; readonly by: string } | { readonly error: string }) & { readonly problems?: readonly string[] };

interface Reply {
  readonly text?: string;
  readonly call?: { readonly toolName: string; readonly input: unknown };
  readonly meta: Record<string, JSONValue>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const modelName = (m: LanguageModelV4) => `${m.provider}/${m.modelId}`;

export class TemplateEngine {
  readonly #options: EngineOptions;
  readonly #id = createIdGenerator({ prefix: "tpl" });
  readonly #written: ReturnType<typeof writtenSchema>;
  /** The template that answered last, for feedback. */
  last: { readonly templateId: string; readonly request: string } | undefined;
  /** What the decision models failed with in the last decision (and its holes), when a later one decided. */
  lastProblems: readonly string[] = [];
  /** What the generators failed with in the last generation, when a later one wrote (or none did). */
  lastWriteProblems: readonly string[] = [];

  constructor(options: EngineOptions) {
    this.#options = options;
    this.#written = writtenSchema(options.settings.generation.limits);
  }

  /** The approval a generation tool needs under the generation setting (other tools: not this engine's to say). */
  approval(toolName: string): ToolApprovalStatus {
    if (!isGeneration(toolName)) return undefined;
    const generation = this.#options.generation();
    return generation === "auto" ? "not-applicable" : "denied";
  }

  /** The engine's model: decides, fills, replies or calls a tool; never generates text itself. */
  model(): LanguageModelV4 {
    const parts = async (prompt: LanguageModelV4Prompt): Promise<LanguageModelV4StreamPart[]> => {
      const reply = await this.#respond(prompt);
      const body: LanguageModelV4StreamPart[] = reply.call
        ? [{ type: "tool-call", toolCallId: this.#id(), toolName: reply.call.toolName, input: JSON.stringify(reply.call.input) }]
        : [
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: reply.text ?? "" },
            { type: "text-end", id: "0" },
          ];
      return [{ type: "stream-start", warnings: [] }, ...body, { type: "finish", finishReason: finishReason(reply.call ? "tool-calls" : "stop"), usage: usage(), providerMetadata: { harness: reply.meta } }];
    };
    return {
      specificationVersion: "v4",
      provider: "harness.templates",
      modelId: "templates",
      supportedUrls: {},
      doGenerate: async (options) => collectParts(await parts(options.prompt)),
      doStream: async (options) => ({ stream: simulateReadableStream({ chunks: await parts(options.prompt), initialDelayInMs: null, chunkDelayInMs: null }) }),
    };
  }

  /** The tools that generate: each asks the first generator, and writes what it wrote into the template files. */
  tools(): ToolSet {
    return {
      write_template: tool({
        description: "Write a new reply template for a request no template answers; when none can be written, answer the request itself (local inference).",
        inputSchema: z.object({ request: z.string() }),
        execute: async ({ request }) => this.#orAnswer(request, await this.#generate(this.#options.generators, async (model) => this.#store(await this.#write(model, this.#options.settings.generation.write, request, await this.#factList()), model, request))),
      }),
      fill_template: tool({
        description: "Write the text holes of a template for a request (spends inference on the holes only).",
        inputSchema: z.object({ id: z.string(), request: z.string(), holes: z.array(z.string()) }),
        execute: async ({ id, request, holes }) => this.#orAnswer(request, await this.#generate(this.#options.generators, (model) => this.#fill(model, id, request, holes))),
      }),
      refine_template: tool({
        description: "Rewrite a template rated harmful, following the feedback (spends inference).",
        inputSchema: z.object({ id: z.string(), request: z.string(), note: z.string() }),
        execute: async ({ id, request, note }) => this.#orAnswer(request, await this.#generate(this.#options.generators, (model) => this.#refine(model, id, request, note))),
      }),
    };
  }

  /** A generation that could not write (no local model enforces a JSON Schema, or its answer was refused): the local model answers the request itself, and nothing is kept. */
  async #orAnswer(request: string, written: Generated): Promise<Generated> {
    const answerers = "error" in written ? ((await this.#options.answerers?.()) ?? []) : [];
    if (answerers.length === 0) return written;
    const refused = this.lastWriteProblems;
    const answered = await this.#generate(() => answerers, async (model) => ({ answer: await this.#answer(model, request), by: modelName(model) }));
    this.lastWriteProblems = [...refused, ...this.lastWriteProblems];
    return { ...answered, problems: [...refused, ...(answered.problems ?? [])] };
  }

  async #respond(prompt: LanguageModelV4Prompt): Promise<Reply> {
    const last = prompt.at(-1)!;
    const request = [...prompt].reverse().find((m) => m.role === "user");
    const text = request?.role === "user" ? request.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim() : "";
    if (last.role === "tool") return this.#after(last.content.flatMap((p) => (p.type === "tool-result" ? [p] : [])), text);
    return this.#decide(text);
  }

  async #decide(request: string): Promise<Reply> {
    const { store, settings, deciders } = this.#options;
    const decision = await chooseTemplate(deciders(), request, (await store.list()).templates, settings);
    this.lastProblems = decision.problems ?? [];
    const meta = { template: decision.template?.id ?? null, by: decision.by, probability: decision.probability, ...(decision.problems ? { problems: [...decision.problems] } : {}) };
    const generation = this.#options.generation();
    const template = decision.template;
    if (!template) {
      if (generation === "off") return { text: "No template answers this, and generation is off: /generate auto lets the local model write one or answer, or add one under ~/agent/templates.", meta };
      return { call: { toolName: "write_template", input: { request } }, meta };
    }
    // A note already written into the body is the answer. Refine stays for a note that has not been applied.
    if (template.refine !== undefined && generation !== "off") {
      const applied = (await store.preferences()).some((record) => record.artifact.id === template.id && record.action !== "rating");
      if (!applied) return { call: { toolName: "refine_template", input: { id: template.id, request, note: template.refine } }, meta };
    }
    return this.#render(template, request, {}, meta);
  }

  /** Fill what needs no generator; generate the rest (or say why not); then reply or run the script. */
  async #render(template: Template, request: string, written: Readonly<Record<string, string>>, meta: Record<string, JSONValue>): Promise<Reply> {
    const { facts, deciders, settings } = this.#options;
    const resolved = await resolveHoles(template, request, facts, deciders(), settings);
    const values = { ...resolved.values, ...written };
    const missing = resolved.missing.filter((h) => values[h] === undefined);
    const problems = [...((meta["problems"] as string[] | undefined) ?? []), ...resolved.problems];
    this.lastProblems = problems;
    const holes = { ...meta, ...(problems.length > 0 ? { problems } : {}), holes: Object.fromEntries(Object.keys(values).map((h) => [h, written[h] === undefined ? holeOf(template, h, facts).source : "generated"])) };
    if (missing.length > 0) {
      if (Object.keys(written).length > 0 || this.#options.generation() === "off") return { text: `Template ${template.id} needs text for ${missing.join(", ")}, and generation is off or did not write it: /generate auto lets the local model fill it.`, meta: holes };
      return { call: { toolName: "fill_template", input: { id: template.id, request, holes: missing } }, meta: holes };
    }
    this.last = { templateId: template.id, request };
    const rendered = fillTemplate(template.constraint, values);
    return template.kind === "script" ? { call: { toolName: "bash", input: { command: rendered.trimEnd() } }, meta: holes } : { text: rendered, meta: holes };
  }

  /** After a tool: a generation's template answers; a script's outcome is the reply. */
  async #after(results: readonly { readonly toolName: string; readonly output: LanguageModelV4ToolResultOutput }[], request: string): Promise<Reply> {
    const result = results[0];
    if (!result) return { text: "", meta: {} };
    const meta = { after: result.toolName };
    if (!isGeneration(result.toolName)) return { text: results.map((r) => report(r.output)).join("\n"), meta };
    const [verb, done] = ({ write_template: ["write", "written"], fill_template: ["fill", "filled"], refine_template: ["rewrite", "rewritten"] } as const)[result.toolName];
    if (result.output.type === "execution-denied") return { text: `Not generated: declined, so no template was ${done}.`, meta };
    const generated = (result.output.type === "json" ? result.output.value : { error: "the tool gave no result" }) as Generated;
    const problems = generated.problems && generated.problems.length > 0 ? { problems: [...generated.problems] } : {};
    if ("error" in generated) return { text: `Could not ${verb} a template: ${generated.error}`, meta: { ...meta, ...problems } };
    if ("answer" in generated) return { text: generated.answer, meta: { ...meta, answered: true, by: generated.by, ...problems } };
    const template = await this.#options.store.get(generated.id);
    if (!template) return { text: `Could not ${verb} a template: ${generated.id} is gone.`, meta };
    return this.#render(template, request, generated.values, { template: template.id, by: generated.by, after: result.toolName, ...problems });
  }

  /** Ask each generator in order until one writes: one that throws, or whose answer is not a template, leaves it to the next. */
  async #generate(models: () => readonly LanguageModelV4[] | Promise<readonly LanguageModelV4[]>, run: (model: LanguageModelV4) => Promise<Generated>): Promise<Generated> {
    const problems: string[] = [];
    // The page hears every failure; the result carries those before the one that answered (or failed last).
    const done = (generated: Generated, before: readonly string[]): Generated => {
      this.lastWriteProblems = [...problems];
      return before.length === 0 ? generated : { ...generated, problems: before };
    };
    let last: string | undefined;
    for (const model of await models()) {
      try {
        return done(await run(model), [...problems]);
      } catch (e) {
        last = message(e);
        problems.push(`${modelName(model)}: ${last}`);
      }
    }
    return last === undefined ? done({ error: "no generator is available here" }, []) : done({ error: last }, problems.slice(0, -1));
  }

  /** The model's own answer to a request, briefly: what a question gets when no template can be written. */
  async #answer(model: LanguageModelV4, request: string): Promise<string> {
    const { generation } = this.#options.settings;
    const { text } = await generateText({ model, system: generation.answer, prompt: request, maxOutputTokens: generation.answerTokens, maxRetries: 0 });
    if (text.trim() === "") throw new Error("it gave no answer");
    return text.trim();
  }

  async #factList(): Promise<string> {
    const lines = await Promise.all(Object.entries(this.#options.facts).map(async ([name, value]) => `- ${name}: ${(await value()).split("\n")[0]!.slice(0, 80)}`));
    return `Facts a hole can take its value from (name: its value now, first line):\n${lines.join("\n")}`;
  }

  async #write(model: LanguageModelV4, instructions: string, request: string, context: string): Promise<Written> {
    const system = `${instructions}\n\n${await this.#examples()}${context}`;
    const { output } = await generateText({ model, system, prompt: `Request: ${request}`, output: Output.object({ schema: this.#written }), maxOutputTokens: this.#options.settings.generation.maxTokens, maxRetries: 0 });
    return output;
  }

  /** The seed templates the settings name, written as a generator writes one: worked examples of the form. */
  async #examples(): Promise<string> {
    const templates = await Promise.all(this.#options.settings.generation.examples.map((id) => this.#options.store.get(id)));
    const shown = templates.flatMap((t) => (t ? [JSON.stringify({ id: t.id, description: t.description, examples: t.examples, kind: t.kind, body: t.body, holes: t.holes }, null, 1)] : []));
    return shown.length === 0 ? "" : `Templates written this way:\n${shown.join("\n")}\n\n`;
  }

  /** Keep a written template (under a free id when the one it chose is taken), and hand back its values. */
  async #store(written: Written, model: LanguageModelV4, request: string): Promise<Generated> {
    const { values, ...rest } = written;
    const { store } = this.#options;
    let id = written.id;
    for (let n = 2; await store.get(id); n++) id = `${written.id}-${n}`;
    const template = parseTemplate(id, templateFile({ ...rest, id, helpful: 0, harmful: 0, version: 1, origin: `generated:${modelName(model)}` }));
    await this.#vet(template, request, values);
    await store.put(template);
    return { id, values, by: modelName(model) };
  }

  async #fill(model: LanguageModelV4, id: string, request: string, holes: readonly string[]): Promise<Generated> {
    const template = await this.#options.store.get(id);
    if (!template) return { error: `no template ${id}` };
    const described = holes.map((h) => `- ${h}: ${holeOf(template, h, this.#options.facts).description}`).join("\n");
    const schema = z.object(Object.fromEntries(holes.map((h) => [h, z.string()])));
    const system = `${this.#options.settings.generation.fill}\n\nThe template:\n${template.body}\n\nThe holes to fill:\n${described}`;
    const { output } = await generateText({ model, system, prompt: `Request: ${request}`, output: Output.object({ schema }), maxOutputTokens: this.#options.settings.generation.maxTokens, maxRetries: 0 });
    return { id, values: output as Record<string, string>, by: modelName(model) };
  }

  async #refine(model: LanguageModelV4, id: string, request: string, note: string): Promise<Generated> {
    const template = await this.#options.store.get(id);
    if (!template) return { error: `no template ${id}` };
    const context = `The template now:\n${templateFile(template)}\n\nFeedback: ${note}\n\n${await this.#factList()}`;
    const { values, ...written } = await this.#write(model, this.#options.settings.generation.refine, request, context);
    const { refine: _applied, ...kept } = template;
    const rewritten = parseTemplate(id, templateFile({ ...kept, ...written, id, origin: `generated:${modelName(model)}` }));
    await this.#vet(rewritten, request, values);
    await this.#options.store.put(rewritten);
    return { id, values, by: modelName(model) };
  }

  /** Try a written template before it is kept: every hole has a value for this request, and a script runs cleanly on a copy of the files. */
  async #vet(template: Template, request: string, written: Readonly<Record<string, string>>): Promise<void> {
    const { facts, deciders, settings, trial, store } = this.#options;
    const same = (await store.list()).templates.find((t) => t.id !== template.id && t.kind === template.kind && t.body.trim() === template.body.trim());
    if (same) throw new Error(`it repeats ${same.id}`);
    const resolved = await resolveHoles(template, request, facts, deciders(), settings);
    const values = { ...resolved.values, ...written };
    const missing = [...new Set(holeNames(template))].filter((h) => values[h] === undefined);
    if (missing.length > 0) throw new Error(`it leaves ${missing.join(", ")} without a value`);
    if (template.kind !== "script" || !trial) return;
    const ran = await trial(fillTemplate(template.constraint, values).trimEnd());
    const said = (ran.stderr.trim() || ran.stdout.trim()).split("\n")[0]!.slice(0, 160);
    if (ran.exitCode !== 0) throw new Error(`its script failed on a copy of the files (exit ${ran.exitCode}: ${said})`);
  }
}
