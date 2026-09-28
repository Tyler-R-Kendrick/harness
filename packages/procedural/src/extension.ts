import { z } from "zod";
import type { CognitiveExtension } from "@harness/cognitive";
import { GraphIdSchema, RevisionIdSchema, ScoreSchema } from "./graph.ts";
import type { GraphId, Score } from "./graph.ts";
import { exportGraph, graphHistory, importGraph, readGraph, revertGraph } from "./import-export.ts";
import type { ClockLike } from "./import-export.ts";
import { presetOf } from "./settings.ts";
import type { Settings } from "./settings.ts";
import type { ProceduralStore } from "./store.ts";

/** What an operation does to a graph, as the access policy sees it (plan §8.3); `approve` decides candidates waiting for approval. */
export type ProceduralAction = "read" | "write" | "dream" | "revert" | "import" | "approve";

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
  /** Scores a session's turn (P11's `LiveLearner.feedback`). */
  readonly feedback?: (session: string, turn: string, score: Score) => Promise<unknown>;
}

/** Each operation's input. Built per extension, not at module load. */
function inputSchemas() {
  const graph = GraphIdSchema;
  return {
    graph: z.strictObject({ graph, revision: RevisionIdSchema.exactOptional(), overlay: z.boolean().exactOptional() }),
    history: z.strictObject({ graph }),
    feedback: z.strictObject({ session: z.string().min(1), turn: z.string().min(1), score: ScoreSchema }),
    dream: z.strictObject({ graph }),
    revert: z.strictObject({ graph, to: RevisionIdSchema.exactOptional() }),
    import: z.strictObject({ graph, document: z.unknown().exactOptional() }),
    export: z.strictObject({ graph, revision: RevisionIdSchema.exactOptional(), format: z.enum(["json", "mermaid"]).default("json"), overlay: z.boolean().exactOptional() }),
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

/**
 * Procedural graphs as a cognitive-core extension (plan §8.3, P12). It brings no models.
 * Operations, through `_harness/cognitive/invoke`, each checked against the access policy
 * for its action on its graph before anything runs:
 *
 * - `procedural.graph` (read): a revision (the head by default) with its effective graph
 * - `procedural.history` (read): the heads and every recorded revision
 * - `procedural.export` (read): a revision as JSON, or the effective graph as Mermaid
 * - `procedural.feedback` (write): a score for a session's turn, on the graph it is pinned to
 * - `procedural.dream` (dream): run a dream on the graph
 * - `procedural.revert` (revert): move the head back to an earlier head
 * - `procedural.import` (import): a seed or expert graph; head only for a graph with none
 *
 * Results a caller handles (a missing graph, an invalid document, a refused revert) are
 * values; a refused authorization or malformed input throws.
 */
export function proceduralExtension(options: ProceduralExtensionOptions): CognitiveExtension {
  const { store, clock } = options;
  const cycles = presetOf(options.settings, options.preset ?? "harness").dream.cycles;
  const authorize = options.authorize ?? (() => true);
  const schemas = inputSchemas();
  const input = <O extends Op>(op: O, value: unknown) => parseInput(schemas, op, value);
  const check = (op: Op, action: ProceduralAction, g: GraphId) => {
    if (!authorize(action, g)) throw new Error(`procedural.${op}: ${action} on graph ${g} is not allowed`);
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
        if (!pin) return { status: "missing", reason: `session ${session} is not pinned to a graph` };
        check("feedback", "write", pin.graph);
        if (!options.feedback) return unavailable("live learner");
        await options.feedback(session, turn, score);
        return { status: "recorded", graph: pin.graph };
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
        return revertGraph({ store, clock, ...request });
      },
      import: async (value) => {
        const request = input("import", value);
        check("import", "import", request.graph);
        return importGraph({ store, clock, cycles, ...request });
      },
    },
  };
}
