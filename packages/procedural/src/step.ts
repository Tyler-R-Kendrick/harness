/**
 * The live path (plan §5, paper §3.2 eq. 2–3) as a worker step hook: on each step of a
 * session's agent loop it resolves the session's graph, reads the pinned
 * `(core, overlay)` pair, localizes the last action from the messages, serializes the
 * neighborhood of the effective graph (or the whole graph), asks the guidance model,
 * delivers the guidance, and reports a step record. Structurally a `StepHook` of
 * `@harness/workers` (`sessionAgent({ step })`); its `turn` variant guides opaque
 * harness workers (`harnessSessions({ step })`) once per turn.
 */
import type { Instructions, LanguageModel, ModelMessage, SystemModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { HARNESS, Sha256Schema } from "@harness/cognitive";
import type { ScoredTrajectory } from "./trajectory.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { EntryIdSchema, GraphIdSchema, nodeById, NodeNameSchema, parseGraph, RevisionIdSchema } from "./graph.ts";
import type { GraphId } from "./graph.ts";
import { guide, GuidanceCache } from "./guide.ts";
import { match, neighborhood } from "./locate.ts";
import { effectiveGraph, emptyOverlay, entryId } from "./overlay.ts";
import { coreView } from "./overlay-types.ts";
import type { EffectiveEdge, EffectiveGraph, EffectiveNode } from "./overlay-types.ts";
import { pinSession, readOverlay } from "./pinning.ts";
import { resolveGraph, routeGraph, routes } from "./resolver.ts";
import type { GraphRouter, ResolveContext, Resolver, RouteAnswer } from "./resolver.ts";
import { serializeGraph, serializeNeighborhood, serializeWindow } from "./serialize.ts";
import { guidancePromptOf, HOPS, presetOf, WINDOW } from "./settings.ts";
import type { Preset, Settings } from "./settings.ts";
import type { ProceduralStore } from "./store.ts";

/** What one step read and was told, as `_meta.harness.procedural.step` on a notice (plan §5.2). */
export const StepRecordSchema = z.strictObject({
  graph: GraphIdSchema,
  /** The version pair the step read (I3). */
  core: RevisionIdSchema,
  overlay: z.int().min(0).nullable(),
  /** The active node; null when nothing matched and the whole graph was shown. */
  node: NodeNameSchema.nullable(),
  /** The last action, a tool name; null before the first. */
  action: z.string().nullable(),
  matched: z.boolean(),
  /** The active node is an action whose tool the session lacks (plan §5.1): guidance there cannot be followed. */
  inert: z.boolean(),
  /** The other calls of a parallel batch, in emission order (the last one is `action`). */
  others: z.array(z.string()),
  cached: z.boolean(),
  /** Where the guidance text is kept (the store's guidance texts); the record holds only its digest. */
  guidanceId: Sha256Schema,
  digest: Sha256Schema,
  /** The probationary overlay entries the step showed (plan §6.3). */
  exposure: z.array(EntryIdSchema),
  usage: z.strictObject({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) }),
});
export type StepRecord = z.output<typeof StepRecordSchema>;

/** The notice a step record travels in: an ACP `notice` session update. */
export interface StepNotice {
  readonly sessionUpdate: "notice";
  readonly severity: "info";
  readonly title: string;
  readonly description: string;
  readonly _meta: { readonly harness: { readonly procedural: { readonly step: StepRecord } } };
}

/** The session and turn a step belongs to (the workers' `TurnScope`). */
export interface StepScope {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly cwd?: string;
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
  readonly report: (update: StepNotice) => void;
}

/** One step, as the workers' `StepContext` gives it. */
export interface StepInput extends StepScope {
  readonly messages: readonly ModelMessage[];
  readonly initialInstructions: Instructions | undefined;
  readonly stepNumber: number;
  readonly model: LanguageModel;
  /** The names of the tools the session offers; unknown when absent. */
  readonly tools?: readonly string[];
}

/** One harness turn, as the workers' `TurnContext` gives it. */
export interface TurnInput extends StepScope {
  readonly messages: readonly ModelMessage[];
  readonly lastAction: string | undefined;
  readonly tools?: readonly string[];
}

/** A step hook: structurally the workers' `StepHook`. */
export interface ProceduralStepHook {
  prepare(input: StepInput): Promise<{ instructions?: Instructions; messages?: ModelMessage[] } | undefined>;
  turn(input: TurnInput): Promise<string | undefined>;
}

export interface ProceduralStepDeps {
  readonly store: ProceduralStore;
  /** Maps a session's meta and cwd (and the principal) to its graph, or to none. */
  readonly resolver: Resolver;
  /** The owner principal the resolver sees for every session (the host's). */
  readonly principal?: string;
  readonly settings: Settings;
  /** Stamps pins (the core's `Clock`). */
  readonly clock: { now(): number };
  /** Draws a session's exposure salt (the core's `Entropy`). */
  readonly entropy: { bytes(length: number): Uint8Array };
  /** The preset by name; `harness` when not given. */
  readonly preset?: string;
  /** The guidance model; the step's own model when not given. */
  readonly model?: LanguageModel;
  /** Chooses a graph for a session whose resolver rule routes (`modelGraphRouter`); without one such a session has no graph. */
  readonly router?: GraphRouter;
}

/** The tag on the advisory message `trailing-message` delivery adds (under `providerOptions.harness`). */
export const ADVISORY = { advisory: "procedural" } as const;
/** The guidance slot of the paper's solver prompt (App. B.5). */
export const GUIDANCE_LABEL = "Procedural Graph Guidance: ";

type Step = ScoredTrajectory["steps"][number];
type Content = Exclude<ModelMessage["content"], string>[number];

const isAdvisory = (m: ModelMessage): boolean => m.providerOptions?.[HARNESS]?.["advisory"] === ADVISORY.advisory;

const textOf = (m: ModelMessage): string => (typeof m.content === "string" ? m.content : (m.content as readonly Content[]).map((p) => (p.type === "text" ? p.text : "")).join(""));

/**
 * The messages localization and the window read: the conversation without system and
 * advisory messages; under `start` only the current turn, from its last user message.
 */
function scoped(messages: readonly ModelMessage[], boundary: Preset["turnBoundary"]): ModelMessage[] {
  const own = messages.filter((m) => m.role !== "system" && !isAdvisory(m));
  if (boundary === "carry") return own;
  let from = 0;
  for (let i = 0; i < own.length; i++) if (own[i]!.role === "user") from = i;
  return own.slice(from);
}

/** The last action: the last tool call of the last assistant message that has one, with the rest of its batch. */
function lastCall(messages: readonly ModelMessage[]): { name: string; others: string[] } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const names = m.content.flatMap((p) => (p.type === "tool-call" ? [p.toolName] : []));
    if (names.length > 0) return { name: names.at(-1)!, others: names.slice(0, -1) };
  }
  return undefined;
}

const outputText = (output: ToolResultPart["output"]): string => (output.type === "text" || output.type === "error-text" ? output.value : canonicalJson(output.type === "json" || output.type === "error-json" ? output.value : output));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Messages as learning's steps, for the trajectory window. */
function stepsOf(messages: readonly ModelMessage[]): Step[] {
  return messages.flatMap((m): Step[] => {
    if (m.role === "user") return [{ role: "user", content: textOf(m) }];
    if (m.role === "tool") return m.content.flatMap((p): Step[] => (p.type === "tool-result" ? [{ role: "tool", content: outputText(p.output) }] : []));
    if (typeof m.content === "string") return [{ role: "assistant", content: m.content }];
    // Stryker disable next-line ConditionalExpression: equivalent because the other parts have no text, and join renders undefined as ""
    const said = m.content.map((p) => (p.type === "text" || p.type === "reasoning" ? p.text : "")).join("");
    const calls = m.content.flatMap((p): Step[] => (p.type === "tool-call" ? [{ role: "assistant", content: "", call: { name: p.toolName, arguments: isRecord(p.input) ? p.input : { input: p.input } } }] : []));
    // An empty thought renders nothing, and stays in the same decision as its calls.
    return [{ role: "assistant", content: said }, ...calls];
  });
}

/** Instructions with the guidance slot, rebuilt from the turn's own so guidance never stacks. */
function withGuidance(initial: Instructions | undefined, block: string): Instructions {
  if (initial === undefined) return block;
  if (typeof initial === "string") return `${initial}\n\n${block}`;
  const slot: SystemModelMessage = { role: "system", content: block };
  return Array.isArray(initial) ? [...initial, slot] : [initial, slot];
}

/** The probationary overlay entries among what the step showed, once each. */
function exposureOf(nodes: readonly EffectiveNode[], edges: readonly EffectiveEdge[]): StepRecord["exposure"] {
  const ids = new Set<StepRecord["exposure"][number]>();
  for (const n of nodes) if (n.status === "probation") ids.add(entryId({ kind: "node", id: n.id, type: n.type, description: n.description }));
  for (const e of edges) {
    if (e.status === "probation") ids.add(entryId({ kind: "edge", from: e.from, relation: e.relation, to: e.to, condition: e.condition, guidance: e.guidance, pitfalls: e.pitfalls }));
    for (const note of e.notes) if (note.status === "probation") ids.add(entryId({ kind: "note", on: { from: e.from, to: e.to }, text: note.text }));
    for (const caution of e.cautions) if (caution.status === "probation") ids.add(entryId({ kind: "caution", on: { from: e.from, to: e.to }, text: caution.text }));
  }
  return [...ids];
}

/** What a session reads until its next turn boundary: one version pair (I3). */
interface View {
  readonly graph: GraphId;
  readonly effective: EffectiveGraph;
}

interface Session {
  readonly turnId: string | undefined;
  readonly view: View | undefined;
  readonly cache: GuidanceCache;
  /** The router's answers for this session, by request, so a session unrouted at one turn is not asked again for the same prompt. */
  readonly routed: Map<string, RouteAnswer>;
}

/**
 * The procedural step hook (plan §5): resolve, pin, match, neighborhood, serialize,
 * cache, guide, deliver, record. A session re-resolves and re-pins at each turn
 * boundary (a new turn id); an approval round restarts the agent's stream but not the
 * turn, so the node is not reset. A session without a graph is left unguided.
 */
export function proceduralStep(deps: ProceduralStepDeps): ProceduralStepHook {
  const preset = presetOf(deps.settings, deps.preset ?? "harness");
  const sessions = new Map<string, Session>();

  /** The session's graph: resolved, or routed by its first prompt (asking the router once per request, and not again once pinned). */
  const resolve = async (scope: StepScope, messages: readonly ModelMessage[], routed: Map<string, RouteAnswer>): Promise<GraphId | undefined> => {
    // Stryker disable next-line ConditionalExpression: equivalent because the resolver reads an undefined meta, cwd or principal as an absent one
    const context: ResolveContext = { ...(scope.sessionMeta ? { meta: scope.sessionMeta } : {}), ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }), ...(deps.principal === undefined ? {} : { principal: deps.principal }) };
    if (!routes(deps.resolver, context)) return resolveGraph(deps.resolver, context);
    const first = scoped(messages, "carry").find((m) => m.role === "user");
    const pin = await deps.store.pins.get(scope.sessionId);
    const router = deps.router;
    const ask: GraphRouter | undefined =
      router &&
      (async (request) => {
        const key = canonicalJson(request);
        const known = routed.get(key) ?? (await router(request));
        routed.set(key, known);
        return known;
      });
    return routeGraph(deps.resolver, { ...context, ...(first === undefined ? {} : { prompt: textOf(first) }), ...(pin === undefined ? {} : { pinned: pin.graph }) }, ask);
  };

  const load = async (scope: StepScope, messages: readonly ModelMessage[], routed: Map<string, RouteAnswer>): Promise<View | undefined> => {
    const graph = await resolve(scope, messages, routed);
    if (graph === undefined) return undefined;
    const pin = await pinSession({ store: deps.store, session: scope.sessionId, graph, repinOnDream: preset.repinOnDream, overlayRefresh: preset.overlayRefresh, clock: deps.clock, entropy: deps.entropy });
    const record = await deps.store.revisions.get(pin.core);
    if (record === undefined) throw new Error(`the pinned core revision ${pin.core} of graph ${graph} is missing`);
    const parsed = parseGraph(record.document);
    if (!parsed.ok) throw new Error(`the pinned core revision ${pin.core} of graph ${graph} does not parse: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
    const live = preset.live;
    if (!preset.overlay || live === undefined) return { graph, effective: coreView(parsed.graph) };
    const state = await readOverlay(deps.store, pin);
    // A session never pairs a core with an overlay built on another core.
    return { graph, effective: effectiveGraph(parsed.graph, state.base === pin.core ? state : emptyOverlay(pin.core), { salt: pin.salt, probationShare: live.probationShare }) };
  };

  /** The session's state for this step, re-resolved and re-pinned unless the step is in the turn it knows. */
  const enter = async (scope: StepScope & { readonly messages: readonly ModelMessage[] }, sameTurn: (known: Session) => boolean): Promise<Session> => {
    const known = sessions.get(scope.sessionId);
    if (known !== undefined && sameTurn(known)) return known;
    const routed = known?.routed ?? new Map<string, RouteAnswer>();
    const session: Session = { turnId: scope.turnId, view: await load(scope, scope.messages, routed), cache: known?.cache ?? new GuidanceCache(), routed };
    sessions.set(scope.sessionId, session);
    return session;
  };

  /** Guidance for the step at `action`, reported as a step record; the delivered text is returned. */
  const advise = async (scope: StepInput | TurnInput, session: Session & { view: View }, action: string | undefined, others: string[], model: LanguageModel): Promise<string> => {
    const { messages, tools } = scope;
    const view = session.view.effective;
    const node = match(action, view, preset.match);
    const active = node === undefined ? undefined : nodeById(view, node);
    const inert = tools !== undefined && active?.type === "ACTION" && !tools.includes(active.id) && !(active.binding !== undefined && tools.includes(active.binding.name));
    const around = node === undefined ? undefined : neighborhood(view, node, HOPS);
    const shownEdges = around === undefined ? view.edges : around.hops.flat();
    const named = new Set<string>(around === undefined ? view.nodes.map((n) => n.id) : [around.active, ...shownEdges.flatMap((e) => [e.from, e.to])]);
    const words = around === undefined ? deps.settings.graphContext.full : deps.settings.graphContext.local;
    const own = scoped(messages, "carry");
    const users = own.filter((m) => m.role === "user");
    const task = users.length > 0 ? textOf(users[0]!) : "";
    const query = users.length > 0 ? textOf(users.at(-1)!) : "";
    const window = serializeWindow(stepsOf(scoped(messages, preset.turnBoundary)), WINDOW);
    const key = session.cache.key({ core: view.core, overlay: view.overlay, node, query, window, model });
    const hit = preset.guidanceCache ? session.cache.get(key) : undefined;
    let text = hit;
    let usage = { inputTokens: 0, outputTokens: 0 };
    if (text === undefined) {
      const answer = await guide({
        model,
        template: guidancePromptOf(deps.settings, preset),
        task,
        graphContext: around === undefined ? serializeGraph(view) : serializeNeighborhood(view, around),
        graphContextDesc: words.desc,
        graphSource: words.source,
        query,
        recent: window,
        temperature: deps.settings.decoding.temperature,
        topK: deps.settings.decoding.topK,
      });
      text = answer.text;
      usage = { inputTokens: answer.usage.inputTokens ?? 0, outputTokens: answer.usage.outputTokens ?? 0 };
      session.cache.set(key, text);
    }
    const digest = sha256Hex(text);
    const guidanceId = sha256Hex(canonicalJson([key, digest]));
    await deps.store.guidance.put(guidanceId, text);
    const step: StepRecord = {
      graph: session.view.graph,
      core: view.core,
      overlay: view.overlay,
      node: node ?? null,
      action: action ?? null,
      matched: node !== undefined,
      inert,
      others,
      cached: hit !== undefined,
      guidanceId: Sha256Schema.parse(guidanceId),
      digest: Sha256Schema.parse(digest),
      exposure: exposureOf(
        view.nodes.filter((n) => named.has(n.id)),
        shownEdges,
      ),
      usage,
    };
    scope.report({ sessionUpdate: "notice", severity: "info", title: "Procedural step", description: node === undefined ? "No node matched: the whole graph" : `At ${node}`, _meta: { harness: { procedural: { step } } } });
    return `${GUIDANCE_LABEL}${text}`;
  };

  return {
    async prepare(input) {
      // A new turn id is a boundary; without one, the first step of a stream is.
      const session = await enter(input, (known) => (input.turnId === undefined ? input.stepNumber > 0 : known.turnId === input.turnId));
      if (session.view === undefined) return undefined;
      const call = lastCall(scoped(input.messages, preset.turnBoundary));
      const block = await advise(input, { ...session, view: session.view }, call?.name, call?.others ?? [], deps.model ?? input.model);
      if (preset.delivery === "system") return { instructions: withGuidance(input.initialInstructions, block) };
      const advisory: ModelMessage = { role: "user", content: block, providerOptions: { [HARNESS]: ADVISORY } };
      return { messages: [...input.messages.filter((m) => !isAdvisory(m)), advisory] };
    },

    async turn(input) {
      const session = await enter(input, () => false);
      if (session.view === undefined) return undefined;
      if (deps.model === undefined) throw new Error("turn-level guidance needs a guidance model");
      return advise(input, { ...session, view: session.view }, preset.turnBoundary === "start" ? undefined : input.lastAction, [], deps.model);
    },
  };
}
