/**
 * What hosts share to run the decision layer beside the daemon in their own process: a
 * plugin's connection to the daemon that never leaves the process, the pump that drives the
 * plugin, the dispatch fork as a step planner for session agents, and the settings files
 * parsed into the layer's settings. Everything here is pure: the connection is made through
 * the host's runtime (`connect`), the pump is called by the host's timer, and the planner is
 * called by the session agent.
 *
 * - `connectPeer`: a JSON-RPC client over `runtime.connect`, speaking the daemon's ACP and
 *   `_harness` methods as one more peer (initialized, with the identity the host gives it).
 *   `hookSourceOver(peer.call)` makes it the plugin's hook bus.
 * - `PluginPump`: steps the plugin until the bus is empty, one pump at a time. A host calls
 *   `pump()` on its ticker; events that arrive while a pump runs make it run one more round.
 * - `startPlugin`: all of that together for a running host: the peer, the plugin on the
 *   daemon's hook bus (facts read from the daemon), the pump on the host's timer.
 * - `layerDispatch`: the dispatch fork as the session agent's `StepDispatch` (structurally:
 *   this package does not depend on the workers). It keeps, for each session, the tier the
 *   last step ran on, because the fork's question is "stay or switch", and a step that stays
 *   on the small tier must say `small` (the agent's `stay` is the session's own model).
 * - `parseLayerSettings`: the settings files, parsed.
 */
import type { Ensemble } from "@harness/cognitive";
import { parseAttentionSettings } from "./attention.ts";
import type { DecisionLayer, LayerSettings } from "./compose.ts";
import type { DecisionEvent } from "./fork.ts";
import { deriveFacts, parseDispatchSettings } from "./dispatch.ts";
import type { DispatchInput } from "./dispatch.ts";
import { ensembleMember } from "./ensemble-member.ts";
import { parseEvolveSettings } from "./evolve.ts";
import { parseLifecycleSettings } from "./lifecycle.ts";
import { parsePermissionRiskSettings } from "./permission.ts";
import { daemonFacts, DecisionPlugin, hookSourceOver } from "./plugin.ts";
import type { DaemonReads, HookCall } from "./plugin.ts";
import { scrubText } from "./scrub.ts";
import { parseStuckSettings } from "./stuck.ts";
import type { Member } from "./types.ts";
import type { Identity } from "@harness/core";

/** What went wrong, in words: an error's message, anything else as it reads. */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---- the verifier -----------------------------------------------------------------------------------------------

/**
 * A verifier for the judge rung that is distinct from the layer's member, when the ensemble
 * has one: more than one judgment model that can serve, so that failing over has somewhere to
 * go. It is the ensemble again, asked a different question (is this verdict right?), under an
 * identity of its own (`ensemble-verifier`) so that records and calibration tell it apart.
 */
export function ensembleVerifier(ensemble: Pick<Ensemble, "candidates" | "evaluationModel" | "members">): Member | undefined {
  const judges = ensemble.candidates("judgment").filter((c) => c.descriptor.ports.includes("judge"));
  return judges.length > 1 ? ensembleMember(ensemble, { id: "ensemble-verifier" }) : undefined;
}

// ---- the connection -----------------------------------------------------------------------------------------------

/** What of a host's runtime a peer connects through (`DaemonRuntime` has it). */
export interface PeerRuntimeLike {
  connect(identity: Identity, send: (message: object) => void): { receive(message: unknown): void; disconnect(): void };
}

export interface Peer {
  /** Calls a method of the daemon and returns its result; a refused call is an error with the daemon's message. */
  readonly call: HookCall;
  /** Hangs up (once); calls in flight fail. */
  close(): void;
}

/** A new connection of this identity, initialized: the daemon sees one more peer. */
export async function connectPeer(runtime: PeerRuntimeLike, identity: Identity): Promise<Peer> {
  const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }>();
  let closed = false;
  let seq = 0;
  const connection = runtime.connect(identity, (message) => {
    // Only a response to one of its own calls matters; the daemon's notifications, and requests to a peer that serves none (they carry a method), do not.
    const { id, method, result, error } = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
    // the calls are numbered, so an id of another kind finds none
    const waiting = method === undefined ? pending.get(id as number) : undefined;
    if (waiting === undefined) return;
    // Stryker disable next-line all: equivalent; a settled promise ignores a second settling, so the entry only holds memory until the connection closes
    pending.delete(id as number);
    const said = (error as { message?: unknown } | null)?.message;
    if (error === undefined) waiting.resolve(result);
    else waiting.reject(new Error(typeof said === "string" ? said : `request failed (${JSON.stringify(error)})`));
  });
  const call: HookCall = (method, params) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(new Error("the connection is closed"));
      const id = ++seq;
      pending.set(id, { resolve, reject });
      connection.receive({ jsonrpc: "2.0", id, method, params });
    });
  const peer: Peer = {
    call,
    close() {
      if (closed) return;
      closed = true;
      connection.disconnect();
      for (const waiting of pending.values()) waiting.reject(new Error("the connection is closed"));
      // Stryker disable next-line all: equivalent; the connection is closed, so nothing looks the entries up again
      pending.clear();
    },
  };
  try {
    await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  } catch (e) {
    peer.close();
    throw new Error(`initialize failed (${(e as Error).message})`);
  }
  return peer;
}

// ---- the pump -----------------------------------------------------------------------------------------------------

export interface PumpOptions {
  /** Steps in one pump at most (default 32), so a bus that never empties cannot hold the host. */
  readonly maxRounds?: number;
}

const DEFAULT_ROUNDS = 32;

/** Drives a plugin's `step`: until a step handles nothing, one pump at a time. */
export class PluginPump {
  readonly #plugin: { step(): Promise<number> };
  readonly #maxRounds: number;
  #running: Promise<number> | undefined;
  // Stryker disable next-line BooleanLiteral: equivalent; every round clears it before it steps
  #again = false;

  constructor(plugin: { step(): Promise<number> }, options: PumpOptions = {}) {
    this.#plugin = plugin;
    this.#maxRounds = options.maxRounds ?? DEFAULT_ROUNDS;
  }

  /** Handles what is on the bus; returns how many events were handled. A pump asked for while one runs joins it. */
  pump(): Promise<number> {
    if (this.#running !== undefined) {
      this.#again = true;
      return this.#running;
    }
    const run = this.#run().finally(() => {
      this.#running = undefined;
    });
    this.#running = run;
    return run;
  }

  /** Resolves when the pump in flight (if any) has finished, whether it failed or not. */
  async idle(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }

  async #run(): Promise<number> {
    let handled = 0;
    for (let round = 0; round < this.#maxRounds; round++) {
      this.#again = false;
      const n = await this.#plugin.step();
      handled += n;
      if (n === 0 && !this.#again) break;
    }
    return handled;
  }
}

// ---- the plugin on a running host --------------------------------------------------------------------------------

/** What of a running host the layer needs: connections for the plugin, the hook bus to publish on, and what the daemon knows. */
export interface PluginRuntimeLike extends PeerRuntimeLike {
  publish(event: { readonly type: string; readonly payload: Record<string, unknown>; readonly sessionId?: string }): void;
  readonly daemon: DaemonReads;
}

/** The sink for the layer's `publish`: decisions as events on the host's hook bus. */
export const publishOn =
  (runtime: Pick<PluginRuntimeLike, "publish">) =>
  (event: DecisionEvent): void =>
    runtime.publish({ type: event.type, payload: { ...event.payload }, ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }) });

/** A timer's tick for a pump: it pumps and never throws (a pump that fails is told to `onError`, and the next tick pumps again). */
export function tickOf(pump: { pump(): Promise<number> }, onError: (error: unknown) => void): () => void {
  return () => void pump.pump().catch(onError);
}

export interface StartPluginOptions {
  readonly layer: DecisionLayer;
  readonly runtime: PluginRuntimeLike;
  /** Calls `tick` every `ms` milliseconds (the host's timer); returns the function that stops it. */
  readonly every: (tick: () => void, ms: number) => () => void;
  readonly tickMs: number;
  /** Told of what could not be done, and where: the hook bus, or the handling of an event. */
  readonly onError: (where: string, error: unknown) => void;
  /** Also ask the `attention` fork how urgent each inbox item is. */
  readonly assess?: boolean;
}

export interface RunningPlugin {
  /** Handles what is on the hook bus now; resolves when it is empty. */
  pump(): Promise<number>;
  /** Stops the timer, lets the pump in flight finish, stops the plugin and hangs up its connection. */
  stop(): Promise<void>;
}

/** The identity the plugin connects with. */
const PLUGIN_IDENTITY: Identity = { principal: "decision", kind: "plugin" };

/**
 * Connects the decision plugin to a running daemon as an ordinary peer, subscribes it, and
 * pumps it at once and then on every tick of the host's timer. The plugin only reads and
 * annotates: it never answers a permission request.
 */
export async function startPlugin(options: StartPluginOptions): Promise<RunningPlugin> {
  const { layer, runtime, onError } = options;
  const peer = await connectPeer(runtime, PLUGIN_IDENTITY);
  const plugin = new DecisionPlugin({
    layer,
    source: hookSourceOver(peer.call),
    facts: daemonFacts(runtime.daemon),
    onError: (error, event) => onError(event === undefined ? "the hook bus" : `handling ${event.type} (${event.eventId})`, error),
    assess: options.assess ?? false,
  });
  try {
    await plugin.start();
  } catch (e) {
    peer.close();
    throw e;
  }
  const pump = new PluginPump(plugin);
  // Stryker disable next-line all: equivalent; the plugin reports its own failures, so its pump never rejects (tickOf is tested on its own)
  const tick = tickOf(pump, (e) => onError("the hook bus", e));
  const stopTimer = options.every(tick, options.tickMs);
  tick();
  return {
    pump: () => pump.pump(),
    async stop() {
      stopTimer();
      await pump.idle();
      plugin.stop();
      peer.close();
    },
  };
}

// ---- dispatch -----------------------------------------------------------------------------------------------------

/** A step as the session agent describes it to its dispatch (`DispatchStepContext` has all of this). */
export interface DispatchStepLike {
  readonly sessionId: string;
  /** From 0 within a turn. */
  readonly stepNumber: number;
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
  readonly toolNames: readonly string[];
  /** The estimate of the context's size in tokens. */
  readonly contextTokens: number;
  /** The tool calls of the step before: their names, and what they were given (a `command` is read for words that hold a step on the large tier). */
  readonly lastToolInputs?: readonly { readonly toolName: string; readonly input?: unknown }[];
}

export type DispatchChoiceName = "stay" | "small" | "large";

export interface LayerDispatchOptions<Model> {
  /** The layer; its settings (when it says them) hold the words that derive a step's facts. */
  readonly layer: Pick<DecisionLayer, "decideNamed"> & Partial<Pick<DecisionLayer, "settings">>;
  /** The models of the tiers the agent can move a step to; a tier that is absent is never chosen. */
  readonly tiers: { readonly small?: Model; readonly large?: Model };
  /** Told of a failure of the dispatch (the agent reports it: a step never fails because its dispatch did). */
  readonly onError?: (error: unknown, step: DispatchStepLike) => void;
  /** Sessions remembered at a time (default 256), oldest forgotten first. */
  readonly remember?: number;
}

export interface LayerDispatch<Model> {
  readonly tiers: { readonly small?: Model; readonly large?: Model };
  plan(step: DispatchStepLike): Promise<DispatchChoiceName>;
  /** Told what each step ran on, so the next step knows where the session is. */
  onDispatch(record: { readonly sessionId: string; readonly stepNumber: number; readonly choice: DispatchChoiceName }): void;
  readonly onError?: (error: unknown, step: DispatchStepLike) => void;
}

const TASK_CHARS = 400;
const DEFAULT_REMEMBER = 256;

/** The words of a message's content: a string as it is, a list of parts by its text parts. */
function wordsOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { type?: unknown; text?: unknown } | null) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

/**
 * What the fork is shown of a step: the last thing the person said, and the tools the agent
 * just used, with their secrets removed (a person pastes keys into a prompt, and a tool's
 * name can be its command line), each cut to length first.
 */
function taskOf(step: DispatchStepLike): string {
  const user = [...step.messages].reverse().find((message) => message.role === "user");
  const goal = user === undefined ? "" : scrubText(wordsOf(user.content), TASK_CHARS);
  const calls = (step.lastToolInputs ?? []).map((call) => call.toolName);
  return [goal, calls.length === 0 ? "" : scrubText(`last tool calls: ${calls.join(", ")}`, TASK_CHARS)].filter((part) => part !== "").join("\n");
}

/**
 * The dispatch fork as a session agent's per-step planner. A step that moves tier, or stays
 * on the small one, answers `small`; one that goes (or returns) to the session's own model
 * answers `large` or `stay`. A decision in shadow mode is recorded and the step stays. A
 * new turn starts on the large tier: the agent's own model.
 */
export function layerDispatch<Model>(options: LayerDispatchOptions<Model>): LayerDispatch<Model> {
  const onTier = new Map<string, "small" | "large">();
  const limit = options.remember ?? DEFAULT_REMEMBER;
  return {
    tiers: options.tiers,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    async plan(step) {
      const current = step.stepNumber === 0 ? "large" : (onTier.get(step.sessionId) ?? "large");
      // The facts the settings' `protect` condition tests, from the step's tool calls: without them the floor could never hold a step on the large tier.
      const facts = deriveFacts(options.layer.settings?.dispatch.derive, step.lastToolInputs ?? []);
      const input: DispatchInput = { context: step.contextTokens, current, task: taskOf(step), ...(facts === undefined ? {} : { facts }) };
      const decision = await options.layer.decideNamed("dispatch", input, { session: step.sessionId });
      const action = decision.active ? decision.action : "stay";
      return action === "stay" ? (current === "small" ? "small" : "stay") : (action as DispatchChoiceName);
    },
    onDispatch({ sessionId, choice }) {
      onTier.delete(sessionId);
      onTier.set(sessionId, choice === "small" ? "small" : "large");
      while (onTier.size > limit) onTier.delete(onTier.keys().next().value!);
    },
  };
}

// ---- settings -----------------------------------------------------------------------------------------------------

/** The settings files as read (JSON), by what they are. */
export interface RawLayerSettings {
  readonly attention: unknown;
  readonly stuck: unknown;
  readonly dispatch: unknown;
  readonly lifecycle: unknown;
  readonly evolve: unknown;
  readonly permission?: unknown;
}

/** The layer's settings from the files `data/{attention,stuck,dispatch,lifecycle,evolve,permission-questions}.json` (each parse names the settings that are wrong). */
export function parseLayerSettings(raw: RawLayerSettings): LayerSettings {
  return {
    attention: parseAttentionSettings(raw.attention),
    stuck: parseStuckSettings(raw.stuck),
    dispatch: parseDispatchSettings(raw.dispatch),
    lifecycle: parseLifecycleSettings(raw.lifecycle),
    evolve: parseEvolveSettings(raw.evolve),
    ...(raw.permission === undefined ? {} : { permission: parsePermissionRiskSettings(raw.permission) }),
  };
}
