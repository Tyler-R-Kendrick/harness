import { z } from "zod";
import { generateText, jsonSchema, Output, tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { constrain } from "@harness/cognitive";
import type { CognitiveExtension, Constraint } from "@harness/cognitive";
import type { SnapshotStorage } from "@harness/core";
import { ASK, runWorkflow } from "./run.ts";
import type { Effects, RunResult, ToolSpec } from "./run.ts";

/** A workflow as kept: named, described, its input's JSON Schema, and its code. */
export const WorkflowSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a kebab-case name")
    .refine((n) => n !== ASK, `a workflow cannot be named ${ASK}: tools.ask is the model`),
  description: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  code: z.string().min(1),
});
export type Workflow = z.output<typeof WorkflowSchema>;

const parse = <T>(schema: z.ZodType<T>, what: string, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`invalid ${what}\n${z.prettifyError(result.error)}`);
  return result.data;
};

export const parseWorkflow = (input: unknown): Workflow => parse(WorkflowSchema, "workflow", input);

/** Where workflows are kept; the host brings one (a directory natively). */
export interface WorkflowLibrary {
  get(name: string): Promise<Workflow | undefined>;
  put(workflow: Workflow): Promise<void>;
  list(): Promise<Workflow[]>;
}

export class MemoryLibrary implements WorkflowLibrary {
  readonly #workflows = new Map<string, Workflow>();
  constructor(workflows: readonly Workflow[] = []) {
    for (const w of workflows) this.#workflows.set(w.name, w);
  }
  async get(name: string): Promise<Workflow | undefined> {
    return this.#workflows.get(name);
  }
  async put(workflow: Workflow): Promise<void> {
    this.#workflows.set(workflow.name, parseWorkflow(workflow));
  }
  async list(): Promise<Workflow[]> {
    return [...this.#workflows.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}

/**
 * Runs library workflows durably. The code calls `tools.<name>(args)`: another library
 * workflow (run as a nested durable run, journaled under the parent's run id) or one of
 * the host's AI SDK tools; `tools.ask` puts a question to a model.
 */
export class WorkflowHost {
  readonly #options: { readonly library: WorkflowLibrary; readonly journal: (run: string) => SnapshotStorage; readonly ask: Effects["ask"]; readonly tools?: ToolSet };

  constructor(options: { readonly library: WorkflowLibrary; readonly journal: (run: string) => SnapshotStorage; readonly ask: Effects["ask"]; readonly tools?: ToolSet }) {
    this.#options = options;
  }

  get library(): WorkflowLibrary {
    return this.#options.library;
  }

  async run(name: string, input: unknown, run: string): Promise<RunResult> {
    const { library, tools = {} } = this.#options;
    const workflow = await library.get(name);
    if (!workflow) throw new Error(`no workflow ${name}`);
    const specs: Record<string, ToolSpec> = {};
    for (const [n, t] of Object.entries(tools)) specs[n] = typeof t.description === "string" ? { description: t.description } : {};
    for (const w of await library.list()) if (w.name !== name) specs[w.name] = { description: w.description, inputSchema: w.inputs };
    let calls = 0;
    return runWorkflow({
      name,
      code: workflow.code,
      input,
      tools: specs,
      journal: this.#options.journal(run),
      effects: {
        ask: this.#options.ask,
        tool: async (name, args) => {
          calls++;
          if (await library.get(name)) {
            const nested = await this.run(name, args, `${run}/${calls}:${name}`);
            if (nested.status === "failed") throw new Error(`workflow ${name} failed: ${nested.error}`);
            return nested.output;
          }
          const execute = tools[name]?.execute;
          if (!execute) throw new Error(`no tool ${name} is available to workflows`);
          return execute(args, { toolCallId: `${run}/${calls}:${name}`, messages: [], context: undefined });
        },
      },
    });
  }
}

/**
 * The library's workflows as AI SDK tools, for agents: calling one runs it durably (the
 * tool call's id is its run id, so a repeated call resumes rather than reruns), and a
 * failed run is a failed tool call.
 */
export async function workflowTools(host: WorkflowHost): Promise<ToolSet> {
  return Object.fromEntries(
    (await host.library.list()).map((w) => [
      w.name,
      tool({
        description: w.description,
        inputSchema: jsonSchema(w.inputs),
        execute: async (input: unknown, { toolCallId }) => {
          const result = await host.run(w.name, input ?? {}, `tool/${toolCallId}`);
          if (result.status === "failed") throw new Error(`workflow ${w.name} failed: ${result.error}`);
          return result.output;
        },
      }),
    ]),
  );
}

/**
 * Put a question to an AI SDK model (usually the ensemble's chat model) and take its
 * answer's text. A JSON Schema constraint is asked for as structured output; any other
 * constraint goes as our provider options, for models that enforce it.
 */
export function askModel(model: LanguageModel): (prompt: string, constraint?: Constraint) => Promise<string> {
  return async (prompt, constraint) => {
    const settings = constraint?.type === "json-schema" ? { output: Output.object({ schema: jsonSchema(constraint.schema) }) } : constraint ? constrain(constraint) : {};
    return (await generateText({ model, prompt, maxRetries: 0, ...settings })).text;
  };
}

const RunInput = z.strictObject({ name: z.string().min(1), input: z.unknown().optional(), run: z.string().min(1) });
const GetInput = z.strictObject({ name: z.string().min(1) });

/**
 * Workflows for the cognitive core, as an extension: `workflows.list`, `workflows.get`
 * and `workflows.run` (durable: running the same run id again resumes it, or returns
 * its result) through `_harness/cognitive/invoke`, on `host`.
 */
export function workflowsExtension(options: { readonly host: WorkflowHost }): CognitiveExtension {
  const { host } = options;
  const library = host.library;
  return {
    id: "workflows",
    models: [],
    operations: {
      list: async () => ({ workflows: (await library.list()).map(({ name, description, inputs }) => ({ name, description, inputs })) }),
      get: async (input) => {
        const { name } = parse(GetInput, "workflows.get input", input ?? {});
        const workflow = await library.get(name);
        if (!workflow) throw new Error(`no workflow ${name}`);
        return workflow;
      },
      run: async (input) => {
        const { name, input: value, run } = parse(RunInput, "workflows.run input", input ?? {});
        return host.run(name, value ?? {}, run);
      },
    },
  };
}
