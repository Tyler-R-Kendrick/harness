import { z } from "zod";
import type { CognitiveExtension, Ensemble } from "@harness/cognitive";
import type { SnapshotStorage } from "@harness/core";
import { runWorkflow } from "./run.ts";
import type { RunResult } from "./run.ts";

/** A workflow as kept: named, described, its input's JSON Schema, and its code. */
export const WorkflowSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a kebab-case name"),
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

/** Tools beyond the library's own workflows, e.g. the client's. */
export interface ToolExecutor {
  call(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/**
 * Runs library workflows durably. A tool call names another library workflow (which
 * runs as a nested durable run, journaled under the parent's run id) or a tool the host
 * provides; `ask` puts a question to a model.
 */
export class WorkflowHost {
  readonly #options: { readonly library: WorkflowLibrary; readonly journal: (run: string) => SnapshotStorage; readonly ask: (prompt: string) => Promise<string>; readonly tools?: ToolExecutor };

  constructor(options: { readonly library: WorkflowLibrary; readonly journal: (run: string) => SnapshotStorage; readonly ask: (prompt: string) => Promise<string>; readonly tools?: ToolExecutor }) {
    this.#options = options;
  }

  get library(): WorkflowLibrary {
    return this.#options.library;
  }

  async run(name: string, input: unknown, run: string): Promise<RunResult> {
    const workflow = await this.#options.library.get(name);
    if (!workflow) throw new Error(`no workflow ${name}`);
    let calls = 0;
    return runWorkflow({
      name,
      code: workflow.code,
      input,
      journal: this.#options.journal(run),
      effects: {
        ask: this.#options.ask,
        tool: async (tool, args) => {
          calls++;
          if (await this.#options.library.get(tool)) {
            const nested = await this.run(tool, args, `${run}/${calls}:${tool}`);
            if (nested.status === "failed") throw new Error(`workflow ${tool} failed: ${nested.error}`);
            return nested.output;
          }
          if (!this.#options.tools) throw new Error(`no tool ${tool} is available to workflows`);
          return this.#options.tools.call(tool, args);
        },
      },
    });
  }
}

/** Put a question to the ensemble's chat model and collect its answer. */
export function askEnsemble(ensemble: Pick<Ensemble, "generate">): (prompt: string) => Promise<string> {
  return async (prompt) => {
    let text = "";
    for await (const e of ensemble.generate({ messages: [{ role: "user", content: prompt }] }, "chat")) if (e.type === "text") text += e.text;
    return text;
  };
}

const RunInput = z.strictObject({ name: z.string().min(1), input: z.unknown().optional(), run: z.string().min(1) });
const GetInput = z.strictObject({ name: z.string().min(1) });

/**
 * Workflows for the cognitive core, as an extension: `workflows.list`, `workflows.get`
 * and `workflows.run` (durable: running the same run id again resumes it, or returns
 * its result) through `_harness/cognitive/invoke`. Questions go to the ensemble.
 */
export function workflowsExtension(options: { readonly library: WorkflowLibrary; readonly journal: (run: string) => SnapshotStorage; readonly ensemble: Pick<Ensemble, "generate">; readonly tools?: ToolExecutor }): CognitiveExtension {
  const host = new WorkflowHost({ library: options.library, journal: options.journal, ask: askEnsemble(options.ensemble), ...(options.tools ? { tools: options.tools } : {}) });
  return {
    id: "workflows",
    models: [],
    operations: {
      list: async () => ({ workflows: (await options.library.list()).map(({ name, description, inputs }) => ({ name, description, inputs })) }),
      get: async (input) => {
        const { name } = parse(GetInput, "workflows.get input", input ?? {});
        const workflow = await options.library.get(name);
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
