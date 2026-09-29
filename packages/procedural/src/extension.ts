import { z } from "zod";
import type { CognitiveExtension } from "@harness/cognitive";
import { approveCandidate, declineCandidate, decidedNotice, listApprovals, requestedNotice } from "./approvals.ts";
import type { ApprovalNotice, ApprovalResult } from "./approvals.ts";
import { GraphIdSchema, RevisionIdSchema, ScoreSchema } from "./graph.ts";
import type { GraphId, RevisionId, RevisionRecord, Score } from "./graph.ts";
import { exportGraph, graphHistory, importGraph, readGraph, revertGraph } from "./import-export.ts";
import type { ClockLike } from "./import-export.ts";
import type { LearnerResult } from "./learner.ts";
import { parsePlan, planFromSubgraph } from "./plan.ts";
import type { PlanRunner } from "./plan-runner.ts";
import { presetOf } from "./settings.ts";
import type { Settings } from "./settings.ts";
import type { ProceduralStore } from "./store.ts";

/** What an operation does to a graph, as the access policy sees it (plan §8.3); `approve` decides candidates waiting for approval, `run` runs plans. */
export type ProceduralAction = "read" | "write" | "dream" | "revert" | "import" | "approve" | "run";

export interface ProceduralExtensionOptions {
  readonly store: ProceduralStore;
  readonly settings: Settings;
  /** The preset whose dream settings apply (import checks cycles under its policy). Default `harness`. */
  readonly preset?: string;
  readonly clock: ClockLike;
  /**
   * The access policy, bound by the host to its configuration and the caller's context
   * (P9's `authorize(policy, action, graph, context)`). Default: allow.
   */
  readonly authorize?: (action: ProceduralAction, graph: GraphId) => boolean;
  /** Runs a dream for a graph (P6's `runDream`, with the host's ports). */
  readonly dream?: (graph: GraphId) => Promise<unknown>;
  /** Scores a session's turn (P11's `LiveLearner.feedback`); undefined when no learner is running yet. */
  readonly feedback?: (session: string, turn: string, score: Score) => Promise<LearnerResult | undefined>;
  /** Announces the approvals inbox's changes (an import proposal, a decision); the host publishes them on its hook bus. */
  readonly notify?: (notice: ApprovalNotice) => void | Promise<void>;
  /** Runs plans (`planRunner`, with the host's model and tools), announcing each run's end itself. */
  readonly plans?: Pick<PlanRunner, "run">;
}

/** Each operation's input. Built per extension, not at module load. */
function inputSchemas() {
  const graph = GraphIdSchema;
  /** A plan's end: a node of the graph, which the plan checks. */
  const end = z.string().min(1);
  return {
    graph: z.strictObject({ graph, revision: RevisionIdSchema.exactOptional(), overlay: z.boolean().exactOptional() }),
    history: z.strictObject({ graph }),
    feedback: z.strictObject({ session: z.string().min(1), turn: z.string().min(1), score: ScoreSchema }),
    dream: z.strictObject({ graph }),
    revert: z.strictObject({ graph, to: RevisionIdSchema.exactOptional() }),
    import: z.strictObject({ graph, document: z.unknown().exactOptional() }),
    export: z.strictObject({ graph, revision: RevisionIdSchema.exactOptional(), format: z.enum(["json", "mermaid"]).default("json"), overlay: z.boolean().exactOptional() }),
    approvals: z.strictObject({ graph }),
    approve: z.strictObject({ graph, candidate: RevisionIdSchema }),
    decline: z.strictObject({ graph, candidate: RevisionIdSchema }),
    plan: z.strictObject({ graph, from: end, to: end }),
    run: z
      .strictObject({ graph, plan: z.unknown().exactOptional(), from: end.exactOptional(), to: end.exactOptional() })
      .refine((r) => (r.plan === undefined ? r.from !== undefined && r.to !== undefined : r.from === undefined && r.to === undefined), "run takes a plan, or from and to"),
  };
}
type Inputs = ReturnType<typeof inputSchemas>;
type Op = keyof Inputs;

function parseInput<O extends Op>(schemas: Inputs, op: O, value: unknown): z.output<Inputs[O]> {
  const result = schemas[op].safeParse(value ?? {});
  if (!result.success) throw new Error(`invalid procedural.${op} input\n${z.prettifyError(result.error)}`);
  return result.data as z.output<Inputs[O]>;
}

const unavailable = (what: string) => ({ status: "unavailable" as const, reason: `no ${what} is configured` });

/** The plan between two nodes of a graph's head and overlay (`planFromSubgraph`), or why there is none. */
async function buildPlan(store: ProceduralStore, graph: GraphId, from: string, to: string) {
  const view = await readGraph({ store, graph });
  if (view.status !== "ok") return view;
  const built = planFromSubgraph(view.effective, from, to);
  if (!built.ok) return { status: "invalid" as const, diagnostics: built.diagnostics };
  return { status: "ok" as const, revision: view.revision, overlay: view.effective.overlay, plan: built.plan };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * What `procedural.feedback` answers for the learner's result: `recorded` when the score
 * is in the overlay (observed, re-observed, or already there), the skip's code when it
 * was skipped, and `unavailable` when no learner answered or its preset keeps no overlay.
 */
function feedbackOutcome(graph: GraphId, result: LearnerResult | undefined) {
  if (result === undefined) return { status: "unavailable" as const, graph, reason: "no live learner is running" };
  switch (result.kind) {
    case "ignored":
      return { status: "unavailable" as const, graph, reason: result.reason };
    case "skipped":
      // A skip for no pin or an invalid input stands on no graph; an unknown turn is on the pin's.
      return result.code === "unknown-turn" ? { status: result.code, graph, reason: result.reason } : { status: result.code, reason: result.reason };
    default:
      return { status: "recorded" as const, graph };
  }
}

/**
 * Procedural graphs as a cognitive-core extension (plan §8.3, P12). It brings no models.
 * Operations, through `_harness/cognitive/invoke`, each checked against the access policy
 * for its action on its graph before anything runs:
 *
 * - `procedural.graph` (read): a revision (the head by default) with its effective graph
 * - `procedural.history` (read): the heads and every recorded revision
 * - `procedural.export` (read): a revision as JSON, or the effective graph as Mermaid
 * - `procedural.feedback` (write): a score for a session's turn, on the graph it is pinned to;
 *   it answers what the learner did with it (`recorded`, `unknown-turn`, `no-pin`, `invalid`)
 * - `procedural.dream` (dream): run a dream on the graph
 * - `procedural.revert` (revert): move the head back to an earlier head
 * - `procedural.import` (import): a seed or expert graph; head only for a graph with none,
 *   otherwise a proposal waiting for approval
 * - `procedural.approvals` (approve): the candidates waiting for approval
 * - `procedural.approve` (approve, on the graph named): commit the graph's candidate after the
 *   structure and evidence gates pass against the current head
 * - `procedural.decline` (approve, on the graph named): reject the graph's candidate
 * - `procedural.plan` (read): the plan between two nodes of the head with its overlay
 *   (`planFromSubgraph`), as JSON, or its diagnostics
 * - `procedural.run` (run, and read when it builds the plan): run a plan, built between
 *   two nodes or given as JSON (`parsePlan`), with the host's plan runner; it answers each
 *   task's outcome, and the runner announces the run's end (`procedural.plan.completed`)
 *
 * A new proposal and each decision are announced through `notify`.
 *
 * Results a caller handles (a missing graph, an invalid document, a refused revert) are
 * values; a refused authorization or malformed input throws.
 */
export function proceduralExtension(options: ProceduralExtensionOptions): CognitiveExtension {
  const { store, clock } = options;
  const preset = presetOf(options.settings, options.preset ?? "harness");
  const cycles = preset.dream.cycles;
  const notify = async (notice: ApprovalNotice | undefined): Promise<void> => {
    if (notice !== undefined) await options.notify?.(notice);
  };
  const authorize = options.authorize ?? (() => true);
  const schemas = inputSchemas();
  const input = <O extends Op>(op: O, value: unknown) => parseInput(schemas, op, value);
  const check = (op: Op, action: ProceduralAction, g: GraphId) => {
    if (!authorize(action, g)) throw new Error(`procedural.${op}: ${action} on graph ${g} is not allowed`);
  };
  /** Decide a candidate: the caller allowed to approve on its graph, and it recorded there (records are keyed by graph and id). */
  const decide = async (op: "approve" | "decline", request: { graph: GraphId; candidate: RevisionId }, run: (record: RevisionRecord) => Promise<ApprovalResult>) => {
    const { graph: g, candidate } = request;
    check(op, "approve", g);
    const record = await store.revisions.get(g, candidate);
    if (record === undefined) return { status: "missing", reason: `no candidate ${candidate} is recorded in graph ${g}` };
    const result = await run(record);
    await notify(decidedNotice(result));
    return result;
  };
  return {
    id: "procedural",
    models: [],
    operations: {
      graph: async (value) => {
        const request = input("graph", value);
        check("graph", "read", request.graph);
        const view = await readGraph({ store, ...request });
        if (view.status !== "ok") return view;
        return { status: "ok", head: view.head, revision: view.revision, origin: view.record.origin, document: view.record.document, effective: view.effective };
      },
      history: async (value) => {
        const { graph: g } = input("history", value);
        check("history", "read", g);
        return graphHistory({ store, graph: g });
      },
      export: async (value) => {
        const request = input("export", value);
        check("export", "read", request.graph);
        return exportGraph({ store, ...request });
      },
      feedback: async (value) => {
        const { session, turn, score } = input("feedback", value);
        const pin = await store.pins.get(session);
        if (!pin) return { status: "no-pin", reason: `session ${session} is not pinned to a graph` };
        check("feedback", "write", pin.graph);
        if (!options.feedback) return unavailable("live learner");
        return feedbackOutcome(pin.graph, await options.feedback(session, turn, score));
      },
      dream: async (value) => {
        const { graph: g } = input("dream", value);
        check("dream", "dream", g);
        if (!options.dream) return unavailable("dream runner");
        return { status: "done", result: await options.dream(g) };
      },
      revert: async (value) => {
        const request = input("revert", value);
        check("revert", "revert", request.graph);
        return revertGraph({ store, ...request });
      },
      import: async (value) => {
        const request = input("import", value);
        check("import", "import", request.graph);
        const result = await importGraph({ store, clock, cycles, ...request });
        if (result.status === "proposed") await notify(requestedNotice((await store.revisions.get(request.graph, result.revision))!));
        return result;
      },
      approvals: async (value) => {
        const { graph: g } = input("approvals", value);
        check("approvals", "approve", g);
        return listApprovals({ store, graph: g });
      },
      approve: async (value) => decide("approve", input("approve", value), (record) => approveCandidate({ store, record, preset, clock })),
      decline: async (value) => decide("decline", input("decline", value), (record) => declineCandidate({ store, record })),
      plan: async (value) => {
        const { graph: g, from, to } = input("plan", value);
        check("plan", "read", g);
        const built = await buildPlan(store, g, from, to);
        return built.status === "ok" ? { ...built, plan: built.plan.toJSON() } : built;
      },
      run: async (value) => {
        const request = input("run", value);
        const g = request.graph;
        check("run", "run", g);
        if (request.plan === undefined) check("run", "read", g);
        if (!options.plans) return unavailable("plan runner");
        if (request.plan !== undefined) {
          let plan: ReturnType<typeof parsePlan>;
          try {
            plan = parsePlan(request.plan);
          } catch (e) {
            return { status: "invalid", reason: messageOf(e) };
          }
          return options.plans.run(g, plan);
        }
        const built = await buildPlan(store, g, request.from!, request.to!);
        return built.status === "ok" ? options.plans.run(g, built.plan) : built;
      },
    },
  };
}
