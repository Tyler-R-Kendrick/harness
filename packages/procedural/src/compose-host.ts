/**
 * Composition on a host (plan §7.6): what a host gives dream and its session workers so
 * that dream composes and sessions get the workflows their pinned core binds.
 *
 * - `staging` keeps compiled workflows in the host's own durable files (never the shared
 *   workflow library), and runs them on a session's base tools;
 * - `composer` is dream's `Composer` port over the session tools' specs;
 * - `sessionTools` is a worker's per-turn tools: the base plus `revisionTools` on the
 *   core the step hook pins for the turn.
 *
 * Portable: the host brings the files, the code mode and the model that answers `tools.ask`.
 */
import { asSchema } from "ai";
import type { ToolSet } from "ai";
import type { SnapshotStorage } from "@harness/core";
import { WorkflowHost } from "@harness/workflows";
import type { CodeMode, Effects, ToolSpec, WorkflowLibrary } from "@harness/workflows";
import { revisionTools, StagingLibrary } from "./compose.ts";
import type { CompositionSettings } from "./compose.ts";
import type { Composer } from "./dream-runner.ts";
import type { ProceduralStepHook, StepScope } from "./step.ts";

/**
 * Where a host keeps staged workflows, with a journal per run (a directory of its own
 * natively, an IndexedDB database of its own in a browser). Never the shared library.
 */
export interface StagingFiles extends WorkflowLibrary {
  journal(run: string): SnapshotStorage;
}

/** A host's staging: the staging library over its files, and a workflow host over it per set of base tools. */
export interface Staging {
  readonly library: StagingLibrary;
  /** Runs staged workflows durably (journaled in the files), their code calling `tools`: a session's base tools. */
  host(tools: ToolSet): WorkflowHost;
}

export function staging(options: { readonly files: StagingFiles; readonly codeMode: CodeMode; readonly ask: Effects["ask"] }): Staging {
  const { files, codeMode, ask } = options;
  const library = new StagingLibrary(files);
  return { library, host: (tools) => new WorkflowHost({ library, journal: (run) => files.journal(run), codeMode, ask, tools }) };
}

/** Each tool's input JSON Schema, and its description when it has one: what `compilePath` types a workflow's arguments by. */
export async function toolSpecs(tools: ToolSet): Promise<Record<string, ToolSpec>> {
  const specs: Record<string, ToolSpec> = {};
  for (const [name, t] of Object.entries(tools)) {
    const inputSchema = (await asSchema(t.inputSchema).jsonSchema) as Record<string, unknown>;
    // A description may be a function of the call's context, which a spec cannot carry.
    specs[name] = typeof t.description === "string" ? { description: t.description, inputSchema } : { inputSchema };
  }
  return specs;
}

/** Dream's composer: the composition settings, the specs of the session tools a compiled path calls, and the staging library. */
export async function composer(options: { readonly settings: CompositionSettings; readonly staging: Pick<Staging, "library">; readonly tools: ToolSet; readonly runs?: number }): Promise<Composer> {
  const { settings, tools, runs } = options;
  return { settings, toolSpecs: await toolSpecs(tools), staging: options.staging.library, ...(runs === undefined ? {} : { runs }) };
}

/**
 * A session worker's tools, per turn (`sessionAgent({ tools })`): the base tools (given
 * per turn, told its scope, or once) plus exactly the workflows the core the session reads
 * this turn binds (`step.core`, pinned as the turn's steps read it), each offered only
 * while its staged code hashes to the binding. A session without a graph gets the base.
 */
export function sessionTools(options: {
  readonly step: Pick<ProceduralStepHook, "core">;
  readonly staging: Staging;
  readonly base?: ToolSet | ((scope: StepScope) => ToolSet | Promise<ToolSet>);
}): (scope: StepScope) => Promise<ToolSet> {
  const { step, base = {} } = options;
  return async (scope) => {
    const tools = typeof base === "function" ? await base(scope) : base;
    const core = await step.core(scope);
    return core === undefined ? tools : revisionTools({ base: tools, pinnedCore: core, staging: options.staging.host(tools) });
  };
}

/** What a host hands out for composition: see `composition`. */
export interface HostComposition {
  readonly staging: Staging;
  /** A session worker's per-turn tools (`sessionTools`). */
  readonly tools: (scope: StepScope) => Promise<ToolSet>;
  /** Dream's composer over the base tools as they are when it is called: once per dream. */
  readonly composer: () => Promise<Composer>;
  /** Dream's tool catalog: the base tools' names, when it is called. */
  readonly catalog: () => Promise<string[]>;
}

/**
 * Composition on a host whose sessions share one set of base tools (the host's own, read
 * anew each time): each session's per-turn tools, and for each dream its composer and its
 * tool catalog, so dream compiles paths of the tools sessions have and its catalog check
 * sees them.
 */
export function composition(options: {
  readonly staging: Staging;
  readonly settings: CompositionSettings;
  readonly step: Pick<ProceduralStepHook, "core">;
  readonly base?: () => ToolSet | Promise<ToolSet>;
}): HostComposition {
  const { staging: s, settings, step, base = () => ({}) } = options;
  return {
    staging: s,
    tools: sessionTools({ step, staging: s, base }),
    composer: async () => composer({ settings, staging: s, tools: await base() }),
    catalog: async () => Object.keys(await base()),
  };
}
