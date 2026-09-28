/**
 * The template engine: `/ask` answered from templates before any inference. Its model
 * (an AI SDK `LanguageModelV4`, so it runs in the agent worker like any other) decides
 * which template answers with a decision model, fills the holes it can without
 * generating, and replies (a reply template) or runs the script (a script template, through
 * the `bash` tool and its approval). Only what cannot be decided is generated, through
 * tools that ask first: writing a template when none fits, filling a template's text
 * holes, and rewriting one rated harmful. A written template is a file in the virtual
 * filesystem, so the next similar request costs no inference.
 */
import type {
  Experimental_EvaluationModelV4 as EvaluationModelV4,
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
import { chooseTemplate, holeOf, resolveHoles } from "./decide.ts";
import type { Facts } from "./decide.ts";
import type { EngineSettings } from "./engine-settings.ts";
import { report } from "./shell-model.ts";
import { HOLE_SOURCES, parseTemplate, TEMPLATE_KINDS, templateFile } from "./templates.ts";
import type { Template, TemplateStore } from "./templates.ts";

/** Whether generating (spending inference) asks first, runs on its own, or is off. */
export const GENERATIONS = ["ask", "auto", "off"] as const;
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
  /** The decision model now (the lexical one until a better one is loaded). */
  readonly judge: () => EvaluationModelV4;
  /** Models that can write templates, cheapest first; the first is asked. */
  readonly generators: () => readonly LanguageModelV4[];
  readonly generation: () => Generation;
}

/** A template as a generator writes it: the template, and the values of its text holes for the request. */
const WrittenSchema = z.object({
  id: z.string().describe("kebab-case"),
  description: z.string(),
  examples: z.array(z.string()),
  kind: z.enum(TEMPLATE_KINDS),
  body: z.string(),
  holes: z.record(z.string(), z.object({ description: z.string(), source: z.enum(HOLE_SOURCES).default("text"), fact: z.string().optional(), pattern: z.string().optional(), options: z.array(z.string()).optional() })).default({}),
  values: z.record(z.string(), z.string()).default({}),
});
type Written = z.output<typeof WrittenSchema>;

/** What a generation tool returns: the template and the values it wrote, or why it could not. */
type Generated = { readonly id: string; readonly values: Readonly<Record<string, string>>; readonly by: string } | { readonly error: string };

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
  /** The template that answered last, for feedback. */
  last: { readonly templateId: string; readonly request: string } | undefined;

  constructor(options: EngineOptions) {
    this.#options = options;
  }

  /** The approval a generation tool needs under the generation setting (other tools: not this engine's to say). */
  approval(toolName: string): ToolApprovalStatus {
    if (!isGeneration(toolName)) return undefined;
    const generation = this.#options.generation();
    return generation === "ask" ? "user-approval" : generation === "auto" ? "not-applicable" : "denied";
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
        description: "Write a new reply template for a request no template answers (spends inference).",
        inputSchema: z.object({ request: z.string() }),
        execute: ({ request }) => this.#generate(async (model) => this.#store(await this.#write(model, this.#options.settings.generation.write, request, await this.#factList()), model)),
      }),
      fill_template: tool({
        description: "Write the text holes of a template for a request (spends inference on the holes only).",
        inputSchema: z.object({ id: z.string(), request: z.string(), holes: z.array(z.string()) }),
        execute: ({ id, request, holes }) => this.#generate((model) => this.#fill(model, id, request, holes)),
      }),
      refine_template: tool({
        description: "Rewrite a template rated harmful, following the feedback (spends inference).",
        inputSchema: z.object({ id: z.string(), request: z.string(), note: z.string() }),
        execute: ({ id, request, note }) => this.#generate((model) => this.#refine(model, id, request, note)),
      }),
    };
  }

  async #respond(prompt: LanguageModelV4Prompt): Promise<Reply> {
    const last = prompt.at(-1)!;
    const request = [...prompt].reverse().find((m) => m.role === "user");
    const text = request?.role === "user" ? request.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim() : "";
    if (last.role === "tool") return this.#after(last.content.flatMap((p) => (p.type === "tool-result" ? [p] : [])), text);
    return this.#decide(text);
  }

  async #decide(request: string): Promise<Reply> {
    const { store, settings, judge } = this.#options;
    const decision = await chooseTemplate(judge(), request, (await store.list()).templates, settings);
    const meta = { template: decision.template?.id ?? null, by: decision.by, probability: decision.probability };
    const generation = this.#options.generation();
    const template = decision.template;
    if (!template) {
      if (generation === "off") return { text: "No template answers this, and generation is off: /generate ask lets a generator write one (asking first), or add one under ~/agent/templates.", meta };
      return { call: { toolName: "write_template", input: { request } }, meta };
    }
    if (template.refine !== undefined && generation !== "off") return { call: { toolName: "refine_template", input: { id: template.id, request, note: template.refine } }, meta };
    return this.#render(template, request, {}, meta);
  }

  /** Fill what needs no generator; generate the rest (or say why not); then reply or run the script. */
  async #render(template: Template, request: string, written: Readonly<Record<string, string>>, meta: Record<string, JSONValue>): Promise<Reply> {
    const { facts, judge, settings } = this.#options;
    const resolved = await resolveHoles(template, request, facts, judge(), settings);
    const values = { ...resolved.values, ...written };
    const missing = resolved.missing.filter((h) => values[h] === undefined);
    const holes = { ...meta, holes: Object.fromEntries(Object.keys(values).map((h) => [h, written[h] === undefined ? holeOf(template, h, facts).source : "generated"])) };
    if (missing.length > 0) {
      if (Object.keys(written).length > 0 || this.#options.generation() === "off") return { text: `Template ${template.id} needs text for ${missing.join(", ")}, and generation is off or did not write it: /generate ask lets a generator fill it.`, meta: holes };
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
    if ("error" in generated) return { text: `Could not ${verb} a template: ${generated.error}`, meta };
    const template = await this.#options.store.get(generated.id);
    if (!template) return { text: `Could not ${verb} a template: ${generated.id} is gone.`, meta };
    return this.#render(template, request, generated.values, { template: template.id, by: generated.by, after: result.toolName });
  }

  async #generate(run: (model: LanguageModelV4) => Promise<Generated>): Promise<Generated> {
    const model = this.#options.generators()[0];
    if (!model) return { error: "no generator is available here" };
    try {
      return await run(model);
    } catch (e) {
      return { error: message(e) };
    }
  }

  async #factList(): Promise<string> {
    const lines = await Promise.all(Object.entries(this.#options.facts).map(async ([name, value]) => `- ${name}: ${(await value()).split("\n")[0]!.slice(0, 80)}`));
    return `Facts a hole can take its value from (name: its value now, first line):\n${lines.join("\n")}`;
  }

  async #write(model: LanguageModelV4, instructions: string, request: string, context: string): Promise<Written> {
    const { output } = await generateText({ model, system: `${instructions}\n\n${context}`, prompt: `Request: ${request}`, output: Output.object({ schema: WrittenSchema }), maxRetries: 0 });
    return output;
  }

  /** Keep a written template (under a free id when the one it chose is taken), and hand back its values. */
  async #store(written: Written, model: LanguageModelV4): Promise<Generated> {
    const { values, ...rest } = written;
    const { store } = this.#options;
    let id = written.id;
    for (let n = 2; await store.get(id); n++) id = `${written.id}-${n}`;
    const template = parseTemplate(id, templateFile({ ...rest, id, helpful: 0, harmful: 0, version: 1, origin: `generated:${modelName(model)}` }));
    await store.put(template);
    return { id, values, by: modelName(model) };
  }

  async #fill(model: LanguageModelV4, id: string, request: string, holes: readonly string[]): Promise<Generated> {
    const template = await this.#options.store.get(id);
    if (!template) return { error: `no template ${id}` };
    const described = holes.map((h) => `- ${h}: ${holeOf(template, h, this.#options.facts).description}`).join("\n");
    const schema = z.object(Object.fromEntries(holes.map((h) => [h, z.string()])));
    const system = `${this.#options.settings.generation.fill}\n\nThe template:\n${template.body}\n\nThe holes to fill:\n${described}`;
    const { output } = await generateText({ model, system, prompt: `Request: ${request}`, output: Output.object({ schema }), maxRetries: 0 });
    return { id, values: output as Record<string, string>, by: modelName(model) };
  }

  async #refine(model: LanguageModelV4, id: string, request: string, note: string): Promise<Generated> {
    const template = await this.#options.store.get(id);
    if (!template) return { error: `no template ${id}` };
    const context = `The template now:\n${templateFile(template)}\n\nFeedback: ${note}\n\n${await this.#factList()}`;
    const { values, ...written } = await this.#write(model, this.#options.settings.generation.refine, request, context);
    const { refine: _applied, ...kept } = template;
    await this.#options.store.put(parseTemplate(id, templateFile({ ...kept, ...written, id, origin: `generated:${modelName(model)}` })));
    return { id, values, by: modelName(model) };
  }
}
