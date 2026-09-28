/**
 * The live path (plan §5, paper §3.2 eq. 2–3) as a worker step hook: on each step of a
 * session's agent loop it resolves the session's graph, reads the pinned
 * `(core, overlay)` pair, localizes the last action from the messages, serializes the
 * neighborhood of the effective graph (or the whole graph), asks the guidance model,
 * delivers the guidance, and reports a step record. Structurally a `StepHook` of
 * `@harness/workers` (`sessionAgent({ step })`); its `turn` variant guides opaque
 * harness workers (`harnessSessions({ step })`) once per turn, and its `end` records each
 * step's model usage once the step ends (a step record precedes its model call).
 */
import type { Instructions, LanguageModel, ModelMessage, SystemModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { HARNESS, Sha256Schema } from "@harness/cognitive";
import type { ScoredTrajectory } from "./trajectory.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { EntryIdSchema, GraphIdSchema, nodeById, NodeNameSchema, parseGraph, RevisionIdSchema } from "./graph.ts";
import type { GraphId, ProceduralGraph } from "./graph.ts";
import { guide, GuidanceCache } from "./guide.ts";
import { match, neighborhood } from "./locate.ts";
import { effectiveGraph, emptyOverlay, entryId } from "./overlay.ts";
import { coreView } from "./overlay-types.ts";
import type { EffectiveEdge, EffectiveGraph, EffectiveNode } from "./overlay-types.ts";
import { pinSession, readOverlay } from "./pinning.ts";
import { authorize } from "./policy.ts";
import type { AccessPolicy } from "./policy.ts";
import { resolveGraph } from "./resolver.ts";
import type { ResolveContext, Resolver } from "./resolver.ts";
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

/** A step's model usage, as `_meta.harness.procedural.usage` on a notice reported once the step ends. */
export const StepUsageSchema = z.strictObject({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) });
export type StepUsage = z.output<typeof StepUsageSchema>;

/** The notice a step's usage travels in. */
export interface StepUsageNotice {
  readonly sessionUpdate: "notice";
  readonly severity: "info";
  readonly title: string;
  readonly description: string;
  readonly _meta: { readonly harness: { readonly procedural: { readonly usage: StepUsage } } };
}

/** The notice a step record travels in: an ACP `notice` session update. */
export interface StepNotice {
  readonly sessionUpdate: "notice";
  readonly severity: "info";
  readonly title: string;
  readonly description: string;
  readonly _meta: { readonly harness: { readonly procedural: { readonly step: StepRecord } } };
}

/** The session and turn a step belongs to (the workers' `TurnScope`), and what it reports. */
export interface StepScope<N = StepNotice> {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly cwd?: string;
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
  readonly report: (update: N) => void;
}

/** A step that ended, as the workers' `StepEndContext` gives it: its model usage. */
export interface StepEndInput extends StepScope<StepUsageNotice> {
  readonly stepNumber: number;
  readonly usage: { readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined };
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
  /**
   * The core revision the session reads this turn, or undefined when it has no graph. It
   * resolves and pins at a turn boundary as a step does, so the turn's steps read the same
   * core: a host builds the turn's tools from it (`sessionTools`, plan §7.6). Without a
   * turn id every call is a boundary. Given the turn's conversation, a call for a session
   * evicted meanwhile whose conversation resumes its turn (a stream restarted after an
   * approval round) reads the pin it had, as a step does.
   */
  core(scope: StepScope & { readonly messages?: readonly ModelMessage[] }): Promise<ProceduralGraph | undefined>;
  /** Records a step's model usage in the session log, for a session with a graph (the trajectory's input and output tokens). */
  end(input: StepEndInput): Promise<void>;
  /** Evicts a session's state (its pinned view and guidance cache), e.g. when it is detached. */
  forget(sessionId: string): void;
}

export interface ProceduralStepDeps {
  readonly store: ProceduralStore;
  /** Maps a session's meta and cwd (and the principal) to its graph, or to none. */
  readonly resolver: Resolver;
  /** The owner principal the resolver sees for every session (the host's). */
  readonly principal?: string;
  /**
   * The access policy (plan §8.3). A guided session is pinned and its turns feed the
   * graph's overlay, so it is guided only when the policy allows both `read` and `write`
   * on its graph for its context. Without one, every graph the resolver names is allowed.
   */
  readonly policy?: AccessPolicy;
  readonly settings: Settings;
  /** Stamps pins (the core's `Clock`). */
  readonly clock: { now(): number };
  /** Draws a session's exposure salt (the core's `Entropy`). */
  readonly entropy: { bytes(length: number): Uint8Array };
  /** The preset by name; `harness` when not given. */
  readonly preset?: string;
  /** The guidance model; the step's own model when not given. */
  readonly model?: LanguageModel;
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

/** Messages as learning's steps (a trajectory's), for the trajectory window and for rollouts. */
export function trajectorySteps(messages: readonly ModelMessage[]): Step[] {
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
  /** The pinned core revision. */
  readonly core: ProceduralGraph;
  readonly effective: EffectiveGraph;
}

interface Session {
  readonly turnId: string | undefined;
  readonly view: View | undefined;
  readonly cache: GuidanceCache;
  /** The Clock time of the session's last step. */
  readonly seen: number;
}

/**
 * Whether a step continues the turn it is in rather than starting one: a later step of
 * the stream, or a restarted stream (after an approval round) whose conversation ends
 * with tool results rather than a new prompt.
 */
const continues = (input: StepInput): boolean => input.stepNumber > 0 || resumes(input.messages);

/** Whether a conversation resumes its turn: it ends with something other than a new prompt (advisories and system messages aside). */
const resumes = (messages: readonly ModelMessage[]): boolean => messages.filter((m) => m.role !== "system" && !isAdvisory(m)).at(-1)?.role !== "user";

/**
 * The procedural step hook (plan §5): resolve, pin, match, neighborhood, serialize,
 * cache, guide, deliver, record. A session re-resolves and re-pins at each turn
 * boundary (a new turn id); an approval round restarts the agent's stream but not the
 * turn, so the node is not reset. A session without a graph is left unguided.
 *
 * Per-session state (the pinned view and the guidance cache) is kept for the sessions in
 * use: `forget` evicts one (the host calls it when a session is detached), a session idle
 * for longer than the settings' `sessions.idleMs` (by the Clock) is evicted at the next
 * step of any session, and beyond `sessions.max` the least recently used one is. A step
 * that continues its turn after its session was evicted reads the stored pin as it is,
 * so a turn still reads one version pair (I3).
 */
export function proceduralStep(deps: ProceduralStepDeps): ProceduralStepHook {
  const preset = presetOf(deps.settings, deps.preset ?? "harness");
  const { idleMs, max } = deps.settings.sessions;
  /** Each session's state, the least recently used first. */
  const sessions = new Map<string, Session>();

  /** Evict the sessions idle for longer than `idleMs`: the least recently used come first, so the first one in use ends the sweep. */
  const sweep = (now: number): void => {
    for (const [id, session] of sessions) {
      if (now - session.seen <= idleMs) return;
      sessions.delete(id);
    }
  };

  /** Keep a session's state as the most recently used, evicting the least recently used beyond `max`. */
  const keep = (id: string, session: Session): void => {
    sessions.delete(id);
    sessions.set(id, session);
    for (const old of sessions.keys()) {
      if (sessions.size <= max) return;
      sessions.delete(old);
    }
  };

  /** The graph a session resolves to now, or none. */
  const resolve = (scope: StepScope<never>): GraphId | undefined => {
    // Stryker disable next-line ConditionalExpression: equivalent because the resolver reads an undefined meta, cwd or principal as an absent one
    const context: ResolveContext = { ...(scope.sessionMeta ? { meta: scope.sessionMeta } : {}), ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }), ...(deps.principal === undefined ? {} : { principal: deps.principal }) };
    const graph = resolveGraph(deps.resolver, context);
    // A guided session is pinned and its turns feed the graph's overlay: the policy must allow both.
    return graph !== undefined && authorize(deps.policy, "read", graph, context) && authorize(deps.policy, "write", graph, context) ? graph : undefined;
  };

  /** The session's view: pinned for a new turn, or, for a turn it continues, at the pin it has on that graph. */
  const load = async (scope: StepScope, continuing: boolean): Promise<View | undefined> => {
    const graph = resolve(scope);
    if (graph === undefined) return undefined;
    // A graph nothing has been imported into yet has nothing to guide by.
    if ((await deps.store.heads.get(graph)) === undefined) return undefined;
    const stored = continuing ? await deps.store.pins.get(scope.sessionId) : undefined;
    const pin = stored?.graph === graph ? stored : await pinSession({ store: deps.store, session: scope.sessionId, graph, repinOnDream: preset.repinOnDream, overlayRefresh: preset.overlayRefresh, clock: deps.clock, entropy: deps.entropy });
    const record = await deps.store.revisions.get(graph, pin.core);
    if (record === undefined) throw new Error(`the pinned core revision ${pin.core} of graph ${graph} is missing`);
    const parsed = parseGraph(record.document);
    if (!parsed.ok) throw new Error(`the pinned core revision ${pin.core} of graph ${graph} does not parse: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
    const live = preset.live;
    if (!preset.overlay || live === undefined) return { graph, core: parsed.graph, effective: coreView(parsed.graph) };
    const state = await readOverlay(deps.store, pin);
    // A session never pairs a core with an overlay built on another core.
    return { graph, core: parsed.graph, effective: effectiveGraph(parsed.graph, state.base === pin.core ? state : emptyOverlay(pin.core), { salt: pin.salt, probationShare: live.probationShare }) };
  };

  /**
   * The session's state for this step, re-resolved and re-pinned unless the step is in
   * the turn it knows. `continuing` says the step continues its turn, for a session whose
   * state was evicted.
   */
  const enter = async (scope: StepScope, sameTurn: (known: Session) => boolean, continuing: boolean): Promise<Session> => {
    const now = deps.clock.now();
    sweep(now);
    const known = sessions.get(scope.sessionId);
    const session: Session =
      known !== undefined && sameTurn(known)
        ? { ...known, seen: now }
        : { turnId: scope.turnId, view: await load(scope, known === undefined && continuing), cache: known?.cache ?? new GuidanceCache(), seen: now };
    keep(scope.sessionId, session);
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
    const window = serializeWindow(trajectorySteps(scoped(messages, preset.turnBoundary)), WINDOW);
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
      const session = await enter(input, (known) => (input.turnId === undefined ? input.stepNumber > 0 : known.turnId === input.turnId), continues(input));
      if (session.view === undefined) return undefined;
      const call = lastCall(scoped(input.messages, preset.turnBoundary));
      const block = await advise(input, { ...session, view: session.view }, call?.name, call?.others ?? [], deps.model ?? input.model);
      if (preset.delivery === "system") return { instructions: withGuidance(input.initialInstructions, block) };
      const advisory: ModelMessage = { role: "user", content: block, providerOptions: { [HARNESS]: ADVISORY } };
      return { messages: [...input.messages.filter((m) => !isAdvisory(m)), advisory] };
    },

    async turn(input) {
      // Stryker disable next-line ArrowFunction: equivalent; undefined is as false as false
      const session = await enter(input, () => false, false);
      if (session.view === undefined) return undefined;
      if (deps.model === undefined) throw new Error("turn-level guidance needs a guidance model");
      return advise(input, { ...session, view: session.view }, preset.turnBoundary === "start" ? undefined : input.lastAction, [], deps.model);
    },

    async core(scope) {
      // Asked at the turn's start, before its steps: a boundary unless the turn is the one the session knows,
      // or, for a session evicted meanwhile, a restarted stream whose conversation resumes its turn.
      const continuing = scope.messages !== undefined && resumes(scope.messages);
      const session = await enter(scope, (known) => scope.turnId !== undefined && known.turnId === scope.turnId, continuing);
      return session.view?.core;
    },

    forget(sessionId) {
      sessions.delete(sessionId);
    },

    async end(input) {
      // The session's graph, not its state: a step's usage is kept for any session with a graph.
      if (resolve(input) === undefined) return;
      const usage: StepUsage = { inputTokens: input.usage.inputTokens ?? 0, outputTokens: input.usage.outputTokens ?? 0 };
      input.report({ sessionUpdate: "notice", severity: "info", title: "Procedural step usage", description: `${usage.inputTokens} input and ${usage.outputTokens} output tokens`, _meta: { harness: { procedural: { usage } } } });
    },
  };
}
