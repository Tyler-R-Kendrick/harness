/**
 * Dynamic workflow composition, a dream output (plan §7.6). A well-trodden chain of
 * action nodes becomes a durable workflow (`@harness/workflows`):
 *
 * - `pathCandidates` finds the chains live turns walk, in enough distinct sessions and
 *   scoring well enough, whose interior nodes leave the agent no choice;
 * - `recordedRuns` takes the calls that walked such a chain from recorded turns;
 * - `compilePath` compiles those calls, keeping data flow: constant arguments are
 *   written in, the first call's other arguments are the workflow's inputs, and each
 *   later call's other arguments are asked of the model (`tools.ask`), constrained to
 *   that tool's input schema, with the input and the results so far;
 * - `StagingLibrary` keeps compiled workflows apart from the shared library, so no
 *   session sees one until a core revision binds it;
 * - `composeCandidate` is the candidate core that binds one, beside the old path, for
 *   dream's gates to decide;
 * - `revisionTools` gives a session its base tools plus exactly the workflows its pinned
 *   core binds, each only while its code still hashes to the binding (I5).
 */
import { z } from "zod";
import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";
import { Sha256Schema } from "@harness/cognitive";
import { checkWorkflow, MemoryLibrary, parseWorkflow } from "@harness/workflows";
import type { ToolSpec, Workflow, WorkflowHost, WorkflowLibrary } from "@harness/workflows";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { applyEdits } from "./edits.ts";
import { EditSetSchema, incoming, nodeById, NodeNameSchema, outgoing, ScoreSchema } from "./graph.ts";
import type { Binding, CandidateDocument, EditSet, GraphEdge, NodeName, ProceduralGraph, Score } from "./graph.ts";
import { match } from "./locate.ts";
import type { MatchMode } from "./locate.ts";
import { coreView } from "./overlay-types.ts";
import type { OverlayEvent } from "./overlay-types.ts";
import type { ScoredTrajectory } from "./trajectory.ts";

// ---- settings (data: data/composition.json) ---------------------------------------------

export const CompositionSettingsSchema = z.strictObject({
  $schema: z.string().optional(),
  /** Distinct sessions that walked a path, at least. */
  support: z.int().min(1),
  /** The path's mean score over its scored turns, at least. */
  minScore: ScoreSchema,
  /** The longest path compiled, in nodes. */
  maxLength: z.int().min(2),
});
export type CompositionSettings = z.output<typeof CompositionSettingsSchema>;

export function parseCompositionSettings(input: unknown): CompositionSettings {
  const result = CompositionSettingsSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid composition settings\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for the settings file, for editors (data/composition.schema.json). */
export const compositionJsonSchema = (): object => z.toJSONSchema(CompositionSettingsSchema);

// ---- candidates ---------------------------------------------------------------------------

/** A path to compile, with the evidence for it. */
export interface PathCandidate {
  path: NodeName[];
  /** Distinct sessions whose turns walked it. */
  support: number;
  /** Distinct turns that walked it. */
  turns: number;
  /** The mean score of its scored turns. */
  meanScore: Score;
}

const unconditional = (g: ProceduralGraph, from: NodeName, to: NodeName): boolean => outgoing(g, from).some((e) => e.to === to && e.condition === null);
/** An interior node leaves no choice: one way out, unconditional, to the next node. */
const forced = (g: ProceduralGraph, node: NodeName, next: NodeName): boolean => {
  const out = outgoing(g, node);
  return out.length === 1 && out[0]!.to === next && out[0]!.condition === null;
};
const isAction = (g: ProceduralGraph, node: NodeName): boolean => nodeById(g, node)?.type === "ACTION";

/**
 * The chains of the core that live turns walked (the overlay's `observed` events): paths
 * of distinct action nodes, each consecutive pair joined by an unconditional edge, whose
 * interior nodes have out-degree 1. A path is a candidate when turns of at least
 * `support` distinct sessions walked it and its mean over scored turns is at least
 * `minScore`. A redelivered turn counts once (its first delivery), and a turn that walks
 * a path twice counts once. Candidates come longest first, then by support, mean score
 * and path; a candidate lying inside one already kept is dropped.
 */
export function pathCandidates(core: ProceduralGraph, events: readonly OverlayEvent[], settings: CompositionSettings): PathCandidate[] {
  const turns = new Map<string, { session: string; path: readonly NodeName[]; score: Score | null }>();
  for (const e of events) {
    if (e.kind !== "observed" || turns.has(e.turnKey)) continue;
    turns.set(e.turnKey, { session: e.turnKey.slice(0, e.turnKey.indexOf("/")), path: e.path, score: e.score });
  }
  const tally = new Map<string, { path: NodeName[]; sessions: Set<string>; turns: number; scored: number; sum: number }>();
  for (const { session, path, score } of turns.values()) {
    const walked = new Set<string>();
    for (const [i, first] of path.entries()) {
      if (!isAction(core, first)) continue;
      const segment = [first];
      for (const next of path.slice(i + 1, i + settings.maxLength)) {
        const previous = segment.at(-1)!;
        if (!isAction(core, next) || segment.includes(next)) break;
        if (segment.length > 1 ? !forced(core, previous, next) : !unconditional(core, previous, next)) break;
        segment.push(next);
        const key = JSON.stringify(segment);
        if (walked.has(key)) continue;
        walked.add(key);
        const t = tally.get(key) ?? { path: [...segment], sessions: new Set<string>(), turns: 0, scored: 0, sum: 0 };
        t.sessions.add(session);
        t.turns++;
        if (score !== null) {
          t.scored++;
          t.sum += score;
        }
        tally.set(key, t);
      }
    }
  }
  const ranked = [...tally.values()]
    // A path with no scored turn has a mean of NaN, which no minimum admits.
    .filter((t) => t.sessions.size >= settings.support && t.sum / t.scored >= settings.minScore)
    .map((t): PathCandidate => ({ path: t.path, support: t.sessions.size, turns: t.turns, meanScore: ScoreSchema.parse(t.sum / t.scored) }))
    .sort(rank);
  const kept: PathCandidate[] = [];
  const inside = (small: readonly NodeName[], big: readonly NodeName[]) => `\u0000${big.join("\u0000")}\u0000`.includes(`\u0000${small.join("\u0000")}\u0000`);
  for (const c of ranked) if (!kept.some((k) => inside(c.path, k.path))) kept.push(c);
  return kept;
}

/** Longest first, then by support, mean score and path. */
function rank(a: PathCandidate, b: PathCandidate): number {
  // Stryker disable next-line EqualityOperator: equivalent; candidates' paths are distinct, so < and <= order them alike
  return b.path.length - a.path.length || b.support - a.support || b.meanScore - a.meanScore || (JSON.stringify(a.path) < JSON.stringify(b.path) ? -1 : 1);
}

// ---- recorded runs ------------------------------------------------------------------------

/** A tool call as recorded (learning's step `call`). */
export interface RecordedCall {
  name: string;
  arguments: Readonly<Record<string, unknown>>;
}

/**
 * The runs of a path in recorded turns: each window of consecutive tool calls whose
 * names match (under the preset's match mode, by node id or binding name) the path's
 * nodes in order.
 */
export function recordedRuns(core: ProceduralGraph, trajectories: readonly ScoredTrajectory[], path: readonly NodeName[], mode: MatchMode): RecordedCall[][] {
  const view = coreView(core);
  const runs: RecordedCall[][] = [];
  for (const t of trajectories) {
    const calls = t.steps.flatMap((s) => (s.call ? [{ name: s.call.name, arguments: s.call.arguments }] : []));
    const nodes = calls.map((c) => match(c.name, view, mode));
    // A window running past the last call matches nothing: there, every node is undefined.
    nodes.forEach((_, i) => {
      if (path.every((n, k) => nodes[i + k] === n)) runs.push(calls.slice(i, i + path.length));
    });
  }
  return runs;
}

// ---- compiling --------------------------------------------------------------------------

export type CompileResult = { ok: true; workflow: Workflow } | { ok: false; error: string };

const ASK = "ask";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A kebab-case name for a path, with a hash of it so distinct paths never share one. */
function nameOf(path: readonly NodeName[]): string {
  const words = path
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/-$/, "");
  return `${words}-${sha256Hex(canonicalJson(path)).slice(0, 8)}`;
}

/** The object schema of some of a tool's arguments, cut from its input schema (its definitions travel along). */
function argumentsSchema(spec: ToolSpec, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  const schema = spec.inputSchema ?? {};
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const defs = Object.fromEntries(["$defs", "definitions"].filter((k) => k in schema).map((k) => [k, schema[k]]));
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, properties[k] ?? {}])),
    required,
    additionalProperties: false,
    ...defs,
  };
}

/** Each argument's keys at one step: those equal in every run (with their value) and those that vary (and which every run has). */
function split(calls: readonly RecordedCall[]): { constants: Record<string, unknown>; varying: string[]; required: string[] } {
  const keys = [...new Set(calls.flatMap((c) => Object.keys(c.arguments)))].sort();
  const constants: Record<string, unknown> = {};
  const varying: string[] = [];
  for (const k of keys) {
    const values = new Set(calls.map((c) => (Object.hasOwn(c.arguments, k) ? canonicalJson(c.arguments[k]) : undefined)));
    // Every key is some run's, so one value among the runs is never "absent".
    if (values.size === 1) constants[k] = calls[0]!.arguments[k];
    else varying.push(k);
  }
  return { constants, varying, required: varying.filter((k) => calls.every((c) => Object.hasOwn(c.arguments, k))) };
}

/**
 * Compile a path's recorded runs into a workflow that keeps their data flow. At each
 * step, an argument equal in every run is written in. The first call's other arguments
 * are the workflow's inputs, typed by that tool's input schema (required when every
 * run had them). Each later call's other arguments are asked of the model with one
 * `tools.ask`, constrained to the JSON Schema of those arguments cut from the tool's
 * input schema, and given the workflow's input and the results so far. The workflow
 * returns every call's result, in order. Deterministic: the same runs and specs give
 * the same workflow.
 */
export function compilePath(path: readonly NodeName[], recordedCalls: readonly (readonly RecordedCall[])[], toolSpecs: Readonly<Record<string, ToolSpec>>): CompileResult {
  if (path.length === 0) return { ok: false, error: "the path is empty" };
  if (recordedCalls.length === 0) return { ok: false, error: "no recorded runs of the path" };
  const wrong = recordedCalls.findIndex((run) => run.length !== path.length);
  if (wrong >= 0) return { ok: false, error: `recorded run ${wrong + 1} has ${recordedCalls[wrong]!.length} calls for a path of ${path.length} nodes` };
  const steps = path.map((_, i) => recordedCalls.map((run) => run[i]!));
  const tools: string[] = [];
  for (const [i, calls] of steps.entries()) {
    const names = [...new Set(calls.map((c) => c.name))];
    if (names.length > 1) return { ok: false, error: `step ${i + 1} calls ${names[0]} in one run and ${names[1]} in another` };
    const name = names[0]!;
    if (name === ASK) return { ok: false, error: `a tool named ${ASK} cannot be called: tools.ask is the model` };
    if (!Object.hasOwn(toolSpecs, name)) return { ok: false, error: `no input schema is known for tool ${name}` };
    tools.push(name);
  }
  const route = path.join(" → ");
  const name = nameOf(path);
  let inputs: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const [i, calls] of steps.entries()) {
    const tool = tools[i]!;
    const spec = toolSpecs[tool]!;
    const { constants, varying, required } = split(calls);
    const fixed = canonicalJson(constants);
    lines.push(`// ${i + 1}. ${path[i]}: tool ${tool}`);
    let args: string;
    if (i === 0) {
      inputs = argumentsSchema(spec, varying, required);
      args = `{ ...${fixed}, ...given(${JSON.stringify(varying)}) }`;
    } else if (varying.length === 0) args = fixed;
    else {
      const prompt = `Fill in the arguments of tool ${tool}, step ${i + 1} of ${path.length} of ${route}. Answer with JSON that follows the schema. The workflow's input and the results so far:\n`;
      const constraint = { type: "json-schema", schema: argumentsSchema(spec, varying, required) };
      args = `{ ...JSON.parse(await tools.ask({ prompt: ${JSON.stringify(prompt)} + JSON.stringify({ input, steps }), constraint: ${JSON.stringify(constraint)} })), ...${fixed} }`;
    }
    lines.push(`steps.push(await tools[${JSON.stringify(tool)}](${args}));`);
  }
  const code = [
    `// ${name}: ${route}, compiled by dream from ${recordedCalls.length} recorded runs.`,
    "// Constant arguments are written in; the first call's others are the inputs; each later call's others are asked of the model.",
    "const given = (keys) => Object.fromEntries(keys.filter((k) => input != null && input[k] !== undefined).map((k) => [k, input[k]]));",
    "const steps = [];",
    ...lines,
    "return { steps };",
    "",
  ].join("\n");
  const workflow = parseWorkflow({ name, description: `Runs ${route} in one call (compiled from ${recordedCalls.length} recorded runs).`, inputs, code });
  return { ok: true, workflow };
}

// ---- staging --------------------------------------------------------------------------------

export type WorkflowBinding = Extract<Binding, { kind: "workflow" }>;

/** The binding a core node takes to run a workflow: its name and the sha256 of its code. */
export function workflowBinding(workflow: Workflow): WorkflowBinding {
  return { kind: "workflow", name: workflow.name, code: Sha256Schema.parse(sha256Hex(workflow.code)) };
}

/**
 * Where dream keeps the workflows it compiles: a library of its own, never the shared
 * one that `workflowTools` offers every session (a session reaches a staged workflow
 * only through `revisionTools`, once a core revision binds it). A staged workflow must
 * compile and is immutable: its name keeps its code, so a binding by name and hash
 * stays good. `staged` is where they are kept (memory by default; a host may give a
 * durable library of their own).
 */
export class StagingLibrary implements WorkflowLibrary {
  readonly #staged: WorkflowLibrary;

  constructor(staged: WorkflowLibrary = new MemoryLibrary()) {
    this.#staged = staged;
  }

  get(name: string): Promise<Workflow | undefined> {
    return this.#staged.get(name);
  }

  list(): Promise<Workflow[]> {
    return this.#staged.list();
  }

  async put(input: Workflow): Promise<void> {
    const workflow = parseWorkflow(input);
    const checked = checkWorkflow(workflow.code);
    if (!checked.ok) throw new Error(`staged workflow ${workflow.name} does not compile: ${checked.error}`);
    const existing = await this.#staged.get(workflow.name);
    if (existing === undefined) return this.#staged.put(workflow);
    if (existing.code !== workflow.code) throw new Error(`staged workflow ${workflow.name} is immutable: stage changed code under a new name`);
  }

  /** Stage a workflow and return the binding a core node takes to run it. */
  async stage(workflow: Workflow): Promise<WorkflowBinding> {
    await this.put(workflow);
    return workflowBinding(workflow);
  }
}

// ---- the candidate core --------------------------------------------------------------------

export type Composition =
  | { ok: true; node: NodeName; binding: WorkflowBinding; edits: EditSet; document: CandidateDocument }
  | { ok: false; error: string };

/**
 * The candidate core that binds a compiled path: a node W (named as the workflow, of the
 * first node's type, bound to it) with an edge from each predecessor of the path's first
 * node (its relation, condition and pitfalls, and guidance to call W) and an edge to each
 * successor of its last node (copied as it is). The old path stays, so dream's gates
 * decide as for any edit. The edit set is the refiner's shape, which carries no binding;
 * `document` is the edited core with the binding set.
 */
export function composeCandidate(core: ProceduralGraph, path: readonly NodeName[], workflow: Workflow): Composition {
  if (path.length === 0) return { ok: false, error: "the path is empty" };
  const missing = path.find((n) => nodeById(core, n) === undefined);
  if (missing !== undefined) return { ok: false, error: `${missing} is not a node of the core` };
  const gap = path.findIndex((n, i) => i > 0 && !outgoing(core, path[i - 1]!).some((e) => e.to === n));
  if (gap !== -1) return { ok: false, error: `${path[gap - 1]} → ${path[gap]} is not an edge of the core` };
  const id = NodeNameSchema.safeParse(workflow.name);
  if (!id.success) return { ok: false, error: `${workflow.name} is not a node name` };
  if (nodeById(core, id.data) !== undefined) return { ok: false, error: `the core already has a node ${id.data}` };
  const node = id.data;
  const binding = workflowBinding(workflow);
  const via = `Call ${node}: it runs ${path.join(" → ")} in one call.`;
  const edge = (e: GraphEdge, source: string, target: string, guidance: string) => ({ source, target, relation: e.relation, condition: e.condition, guidance, pitfalls: e.pitfalls });
  const edits = EditSetSchema.parse({
    add_nodes: [{ id: node, type: nodeById(core, path[0]!)!.type, description: workflow.description }],
    add_edges: [...incoming(core, path[0]!).map((e) => edge(e, e.from, node, via)), ...outgoing(core, path.at(-1)!).map((e) => edge(e, node, e.to, e.guidance))],
  });
  const edited = applyEdits(core, edits);
  const document: CandidateDocument = { ...edited, nodes: edited.nodes.map((n) => (n.id === node ? { ...n, binding } : n)) };
  return { ok: true, node, binding, edits, document };
}

// ---- tools per session ---------------------------------------------------------------------

/**
 * A session's tools: its base tools plus exactly the workflows its pinned core binds,
 * run durably on `staging` (a `WorkflowHost` over the staging library) under the tool
 * call's id. A workflow is offered only while the staged code's sha256 is the binding's;
 * otherwise, or when a base tool has its name, it is not offered and its node is inert.
 * The hash is checked again at each call, so code changed since is refused.
 */
export async function revisionTools(options: { base: ToolSet; pinnedCore: ProceduralGraph; staging: WorkflowHost }): Promise<ToolSet> {
  const { base, pinnedCore, staging } = options;
  const tools: ToolSet = { ...base };
  const current = async (binding: WorkflowBinding): Promise<Workflow | undefined> => {
    const w = await staging.library.get(binding.name);
    return w !== undefined && sha256Hex(w.code) === binding.code ? w : undefined;
  };
  for (const n of pinnedCore.nodes) {
    const binding = n.binding;
    if (binding?.kind !== "workflow" || Object.hasOwn(tools, binding.name)) continue;
    const w = await current(binding);
    if (w === undefined) continue;
    tools[binding.name] = tool({
      description: w.description,
      inputSchema: jsonSchema(w.inputs),
      execute: async (input: unknown, { toolCallId }) => {
        if ((await current(binding)) === undefined) throw new Error(`workflow ${binding.name} no longer matches the revision that binds it`);
        const result = await staging.run(binding.name, input ?? {}, `tool/${toolCallId}`);
        if (result.status === "failed") throw new Error(`workflow ${binding.name} failed: ${result.error}`);
        return result.output;
      },
    });
  }
  return tools;
}
