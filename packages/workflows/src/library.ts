import { z } from "zod";
import { asSchema, generateText, jsonSchema, Output, tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { constrain } from "@harness/cognitive";
import type { ArtifactText, CognitiveExtension, Constraint } from "@harness/cognitive";
import type { SnapshotStorage } from "@harness/core";
import { ASK, runWorkflow } from "./run.ts";
import type { Effects, RunResult, ToolSpec } from "./run.ts";
import type { CodeMode } from "./code-mode.ts";

/**
 * A workflow as kept: named, described, its input's JSON Schema, and its code. A `flow`
 * is a workflow that talks with a person through tools a dialogue gives each run (see
 * @harness/dialogue): it is not a tool for agents or other workflows.
 */
export const WorkflowSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a kebab-case name")
    .refine((n) => n !== ASK, `a workflow cannot be named ${ASK}: tools.ask is the model`),
  kind: z.literal("flow").exactOptional(),
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
    // Stryker disable next-line EqualityOperator: equivalent; names are unique, so < and <= order them alike
    return [...this.#workflows.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}

/** The workflow's code, read and written through the library that already keeps it. */
export function workflowText(library: WorkflowLibrary): ArtifactText {
  return {
    async read(id) {
      return (await library.get(id))?.code;
    },
    async write(id, code) {
      const current = await library.get(id);
      if (!current) throw new Error(`no workflow ${id}`);
      await library.put({ ...current, code });
    },
  };
}

export interface WorkflowHostOptions {
  readonly library: WorkflowLibrary;
  /** Each run's journal, by run id. */
  readonly journal: (run: string) => SnapshotStorage;
  readonly ask: Effects["ask"];
  /** Where workflow code runs (`aiCodeMode` natively, `quickjsCodeMode()` anywhere). */
  readonly codeMode: CodeMode;
  readonly tools?: ToolSet;
  /** Delete a run's journal, once nothing will resume the run (see WorkflowHost.forget). */
  readonly forget?: (run: string) => Promise<void>;
}

/**
 * Runs library workflows durably. The code calls `tools.<name>(args)`: another library
 * workflow (run as a nested durable run, journaled under the parent's run id; not a
 * flow), one of the host's AI SDK tools, or one of the tools given for this run (a
 * dialogue's, for a flow); `tools.ask` puts a question to a model.
 */
export class WorkflowHost {
  readonly #options: WorkflowHostOptions;

  constructor(options: WorkflowHostOptions) {
    this.#options = options;
  }

  get library(): WorkflowLibrary {
    return this.#options.library;
  }

  /** Forget a run nothing will resume (it ended, or was given up): its journal goes, when the host can delete journals. */
  async forget(run: string): Promise<void> {
    await this.#options.forget?.(run);
  }

  /** Whether runs can call a tool of this name: one of the host's tools, or a library workflow that is not a flow. */
  async has(name: string): Promise<boolean> {
    if (this.#options.tools !== undefined && Object.hasOwn(this.#options.tools, name)) return true;
    const workflow = await this.#options.library.get(name);
    return workflow !== undefined && workflow.kind !== "flow";
  }

  async run(name: string, input: unknown, run: string, given: ToolSet = {}): Promise<RunResult> {
    const { library } = this.#options;
    const tools: ToolSet = { ...this.#options.tools, ...given };
    const workflow = await library.get(name);
    if (!workflow) throw new Error(`no workflow ${name}`);
    // The code may call the host's tools and the library's other workflows, each call
    // checked against the tool's own input schema or the workflow's inputs; not itself.
    const specs: Record<string, ToolSpec> = {};
    for (const [n, t] of Object.entries(tools)) specs[n] = { inputSchema: (await asSchema(t.inputSchema).jsonSchema) as Record<string, unknown> };
    for (const w of await library.list()) if (w.name !== name && w.kind !== "flow") specs[w.name] = { inputSchema: w.inputs };
    // A run's own tools come before the library's workflows of the same name.
    for (const [n, t] of Object.entries(given)) specs[n] = { inputSchema: (await asSchema(t.inputSchema).jsonSchema) as Record<string, unknown> };
    let calls = 0;
    return runWorkflow({
      name,
      code: workflow.code,
      input,
      tools: specs,
      journal: this.#options.journal(run),
      codeMode: this.#options.codeMode,
      effects: {
        ask: this.#options.ask,
        tool: async (name, args) => {
          calls++;
          if (!Object.hasOwn(given, name) && (await library.get(name))) {
            const nested = await this.run(name, args, `${run}/${calls}:${name}`);
            if (nested.status === "failed") throw new Error(`workflow ${name} failed: ${nested.error}`);
            return nested.output;
          }
          // Stryker disable next-line OptionalChaining: equivalent; a name that reaches here is a tool's (the code may call no other)
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
    (await host.library.list())
      .filter((w) => w.kind !== "flow")
      .map((w) => [
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
      list: async () => ({ workflows: (await library.list()).map(({ name, kind, description, inputs }) => ({ name, ...(kind === undefined ? {} : { kind }), description, inputs })) }),
      get: async (input) => {
        const { name } = parse(GetInput, "workflows.get input", input ?? {});
        const workflow = await library.get(name);
        if (!workflow) throw new Error(`no workflow ${name}`);
        return workflow;
      },
      run: async (input) => {
        const { name, input: value, run } = parse(RunInput, "workflows.run input", input ?? {});
        if ((await library.get(name))?.kind === "flow") throw new Error(`${name} is a flow: it runs in a dialogue`);
        return host.run(name, value ?? {}, run);
      },
    },
  };
}
