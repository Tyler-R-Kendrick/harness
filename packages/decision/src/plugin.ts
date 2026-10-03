/**
 * The decision layer as a plugin actor on the hook bus: an external actor that reacts to the
 * daemon's broadcast events and coordinates as a saga, like any other plugin. It reads; it
 * never answers anything. In particular it never resolves a permission request, approves,
 * or denies: it says how careful a person should be, puts the request in front of them in
 * the attention inbox, and later records what they decided as ground truth for calibration.
 *
 * It is written against small interfaces so that it runs anywhere:
 *
 * - `HookSource`: the shape of the daemon's `_harness/hooks/*` methods (`hookSourceOver`
 *   makes one from a function that calls them over ACP);
 * - `Facts`: what the daemon knows that the events do not carry (`daemonFacts` makes one
 *   from `Daemon.pendingPermission`, `readLog` and `sessions`);
 * - the layer, which publishes `decision.made` itself.
 *
 * What it does with each event (everything else is ignored):
 *
 * - `permission.requested`: the request goes in the inbox as a blocked `permission` item at
 *   once, then the `permission.risk` fork annotates it (the risk level is in the item's
 *   text, unless the fork is in shadow mode);
 * - `permission.resolved`: the item leaves the inbox, and the person's choice becomes an
 *   outcome of the risk decision (`approved` or `denied`, from the person). It is judged
 *   `correct` only where the choice says something about the level: approving a `routine`
 *   request or denying a `critical` one is right, the opposite is wrong, and a `careful`
 *   request (look before you decide) is right either way, so says nothing. A request
 *   cancelled or timed out by the system gives no outcome;
 * - `turn.ended`: the turn's tool calls are read from the session's log and the `stuck`
 *   fork is run over the recent ones. A repeat, loop or stall becomes an `idle` item
 *   (warn) or a `failure` item (escalate); a session that is making progress clears it.
 *   A `review` item says the turn is done;
 * - `turn.started` and `session.detached`: the session's review, failure and idle items
 *   are cleared (the person has looked). Permission items stay until they are resolved.
 *
 * Delivery is at least once, so handling is idempotent per event id (a bounded set of seen
 * ids) and an event is acknowledged after it was handled. A handler that fails is reported
 * through `onError` and never stops the loop or the acknowledgement of the others. State
 * is in memory: after a restart the plugin resumes from the bus's stored cursor, and a
 * permission request that was open across the restart gets no outcome.
 */
import { Deduper } from "@harness/core";
import { z } from "zod";
import { ATTENTION_LEVELS } from "./attention.ts";
import type { AttentionItem } from "./attention.ts";
import type { DecisionLayer } from "./compose.ts";
import { fnv1a32 } from "./distill.ts";
import { describePermission } from "./permission.ts";
import type { PermissionFacts } from "./permission.ts";
import { canonicalJson } from "./records.ts";
import { SCAN_LIMIT, scrubText } from "./scrub.ts";
import type { StuckInput } from "./stuck.ts";
import type { DecisionId, Json, Outcome } from "./types.ts";

type MaybePromise<T> = T | Promise<T>;

// ---- the interfaces it is written against ---------------------------------------------------------------

/** A hook event as the daemon delivers it (`HookEvent`): only what the plugin reads is required. */
export interface HookEventLike {
  readonly eventId: string;
  readonly offset: number;
  readonly type: string;
  readonly source?: string;
  readonly sessionId?: string;
  readonly correlationId?: string;
  readonly at?: number;
  readonly payload?: unknown;
}

/** The daemon's hook bus as one plugin sees it: subscribe, poll what is new, acknowledge what was handled. */
export interface HookSource {
  /** Subscribe to event types (`from` is an offset; the stored cursor when absent). */
  subscribe(filter: { readonly types: string[] }, from?: number): Promise<void>;
  poll(max?: number): Promise<{ readonly events: readonly HookEventLike[] }>;
  /** Everything up to and including this offset has been handled. */
  ack(offset: number): Promise<void>;
}

/** An entry of a session's log (`Daemon.readLog`). */
export interface LogEntryLike {
  readonly offset: number;
  readonly at: number;
  readonly kind: string;
  readonly payload: unknown;
}

/** A choice offered with a permission request: the ACP kinds are `allow_once`, `allow_always`, `reject_once` and `reject_always`. */
export interface PermissionOptionLike {
  readonly optionId: string;
  readonly kind: string;
}

/** What the daemon knows that its events do not say. */
export interface Facts {
  /** What an open permission request is about; undefined when it is not open (already answered). */
  permission(sessionId: string, requestId: string): MaybePromise<PermissionFacts | undefined>;
  /** The choices offered with an open request, to tell what a person chose (read together with `permission`, before the person may have answered). */
  permissionOptions?(sessionId: string, requestId: string): MaybePromise<readonly PermissionOptionLike[] | undefined>;
  /** The session's log entries after this offset (all of them when absent). */
  log(sessionId: string, afterOffset?: number): MaybePromise<readonly LogEntryLike[]>;
  /** The sessions that exist. */
  sessions(): MaybePromise<readonly { readonly id: string }[]>;
}

// ---- adapters -------------------------------------------------------------------------------------------------

/** Calls an ACP method of the daemon on the plugin's connection and returns its result. */
export type HookCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const PolledEventSchema = z.looseObject({
  eventId: z.string(),
  offset: z.int().min(0),
  type: z.string(),
  source: z.string().exactOptional(),
  sessionId: z.string().exactOptional(),
  correlationId: z.string().exactOptional(),
  at: z.number().exactOptional(),
  payload: z.unknown().exactOptional(),
});
const PollSchema = z.looseObject({ events: z.array(PolledEventSchema) });

/** A `HookSource` that speaks the daemon's `_harness/hooks/subscribe`, `poll` and `ack` through `call`. */
export function hookSourceOver(call: HookCall): HookSource {
  return {
    async subscribe(filter, from) {
      await call("_harness/hooks/subscribe", { types: filter.types, ...(from === undefined ? {} : { from }) });
    },
    async poll(max) {
      const parsed = PollSchema.safeParse(await call("_harness/hooks/poll", max === undefined ? {} : { max }));
      if (!parsed.success) throw new Error(`the daemon's poll result is not a list of events\n${z.prettifyError(parsed.error)}`);
      return { events: parsed.data.events as HookEventLike[] };
    },
    async ack(offset) {
      await call("_harness/hooks/ack", { offset });
    },
  };
}

/** The tool call of a permission request, as ACP gives it. */
export interface ToolCallLike {
  readonly toolCallId: string;
  readonly title?: string | null | undefined;
  readonly kind?: string | null | undefined;
  readonly rawInput?: unknown;
  readonly locations?: readonly { readonly path: string }[] | null | undefined;
}

/** What of the daemon `daemonFacts` reads (`Daemon` has all of it). */
export interface DaemonReads {
  pendingPermission(sessionId: string, requestId: string): { readonly toolCall: ToolCallLike; readonly options: readonly PermissionOptionLike[] } | undefined;
  /** The entries from offset `from` on (`Daemon.readLog`). */
  readLog(sessionId: string, from?: number): readonly LogEntryLike[];
  sessions(): readonly { readonly id: string; readonly cwd: string }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** Values that are JSON, as JSON: anything else (null, a function, undefined, a non-finite number, what lies deeper than eight levels) is null. */
function jsonOf(value: unknown, depth = 0): Json {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 8) return null;
  if (Array.isArray(value)) return value.map((item) => jsonOf(item, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonOf(item, depth + 1)]));
  return null;
}

/**
 * The facts of a permission request from its ACP tool call: the tool is its title, the
 * kind is its kind, and the command, path and url come from what the tool was given (a
 * location of the call stands in for a path); `cwd` is the session's working directory.
 */
export function permissionFactsOf(sessionId: string, cwd: string | undefined, toolCall: ToolCallLike): PermissionFacts {
  const raw = isRecord(toolCall.rawInput) ? toolCall.rawInput : undefined;
  const command = text(raw?.["command"]);
  const path = text(raw?.["path"]) ?? text(raw?.["file_path"]) ?? text(raw?.["filePath"]) ?? text(toolCall.locations?.[0]?.path);
  const url = text(raw?.["url"]);
  const kind = text(toolCall.kind);
  return {
    tool: text(toolCall.title) ?? toolCall.toolCallId,
    ...(kind === undefined ? {} : { kind }),
    ...(command === undefined ? {} : { command }),
    ...(path === undefined ? {} : { path }),
    ...(url === undefined ? {} : { url }),
    ...(cwd === undefined ? {} : { cwd }),
    session: sessionId,
    ...(raw === undefined ? {} : { input: jsonOf(raw) as { readonly [key: string]: Json } }),
  };
}

/** `Facts` read from the daemon (`pendingPermission`, `readLog` and `sessions`). */
export function daemonFacts(daemon: DaemonReads): Facts {
  return {
    permission: (sessionId, requestId) => {
      const open = daemon.pendingPermission(sessionId, requestId);
      return open === undefined ? undefined : permissionFactsOf(sessionId, daemon.sessions().find((s) => s.id === sessionId)?.cwd, open.toolCall);
    },
    permissionOptions: (sessionId, requestId) => daemon.pendingPermission(sessionId, requestId)?.options.map((o) => ({ optionId: o.optionId, kind: o.kind })),
    log: (sessionId, afterOffset) => daemon.readLog(sessionId, afterOffset === undefined ? 0 : afterOffset + 1),
    sessions: () => daemon.sessions().map((s) => ({ id: s.id })),
  };
}

// ---- the plugin ------------------------------------------------------------------------------------------------

/** The event types the plugin subscribes to. */
export const PLUGIN_EVENTS = ["permission.requested", "permission.resolved", "turn.started", "turn.ended", "session.detached"] as const;

export interface DecisionPluginOptions {
  readonly layer: DecisionLayer;
  readonly source: HookSource;
  readonly facts: Facts;
  /** Told of every failure (of a handler, of the poll, of an acknowledgement) with the event it was handling. */
  readonly onError?: (error: unknown, event?: HookEventLike) => void;
  /** Subscribe from this offset instead of the bus's stored cursor. */
  readonly from?: number;
  /** Events taken from the bus at a time (default 100). */
  readonly batch?: number;
  /** Event ids remembered to drop duplicates (default 1024). */
  readonly seenWindow?: number;
  /** Open permission requests remembered, oldest forgotten first (default 1024). */
  readonly pendingLimit?: number;
  /** Tool calls remembered for each session (default 64). */
  readonly maxSteps?: number;
  /** Also ask the `attention` fork how urgent each inbox item is, and rank by it when a model answers (default false). */
  readonly assess?: boolean;
}

/** What a tool call said of itself, over its updates: these fields of its `tool_call` and `tool_call_update` entries. */
const STEP_FIELDS = ["rawInput", "status", "rawOutput"] as const;

interface Step {
  readonly id: string;
  readonly action: string;
  readonly fields: Record<(typeof STEP_FIELDS)[number], Json>;
}

interface SessionState {
  /** The offset of the last log entry read. */
  offset: number | undefined;
  /** What the person asked for in the turn that started last. */
  goal: string;
  steps: Step[];
}

interface Pending {
  readonly decision: DecisionId;
  /** The risk level the decision gave. */
  readonly risk: Json;
  readonly options: readonly PermissionOptionLike[] | undefined;
  /** The log's record of how it was resolved. */
  resolution?: { readonly optionId: string | undefined; readonly by: string | undefined };
}

const TEXT_CHARS = 200;

/** A short, stable digest of what a step was given and left behind: same action and digest again is a repeat. */
const digestOf = (step: Step): string => fnv1a32(canonicalJson(step.fields)).toString(16);

/**
 * Whether a person's choice was right for the risk level the layer gave: approving a
 * routine request or denying a critical one is, the opposite is not, and a careful one
 * (check before deciding) can go either way, so it says nothing.
 */
function correctness(kind: "approved" | "denied", risk: Json): boolean | undefined {
  if (risk === "routine") return kind === "approved";
  if (risk === "critical") return kind === "denied";
  return undefined;
}

export class DecisionPlugin {
  readonly #layer: DecisionLayer;
  readonly #source: HookSource;
  readonly #facts: Facts;
  readonly #options: DecisionPluginOptions;
  readonly #seen: Deduper;
  readonly #sessions = new Map<string, SessionState>();
  readonly #pending = new Map<string, Pending>();
  #running = false;

  constructor(options: DecisionPluginOptions) {
    this.#options = options;
    this.#layer = options.layer;
    this.#source = options.source;
    this.#facts = options.facts;
    this.#seen = new Deduper(options.seenWindow ?? 1024);
  }

  get running(): boolean {
    return this.#running;
  }

  /** Subscribe to the events it reacts to, from the bus's stored cursor. Starting a started plugin does nothing. */
  async start(): Promise<void> {
    if (this.#running) return;
    await this.#source.subscribe({ types: [...PLUGIN_EVENTS] }, this.#options.from);
    this.#running = true;
  }

  /** Stop handling events (`step` then does nothing). Stopping a stopped plugin does nothing. */
  stop(): void {
    this.#running = false;
  }

  /** Take what is new from the bus, handle each event and acknowledge it; returns how many events were handled without failing (duplicates and failures are not counted). */
  async step(): Promise<number> {
    if (!this.#running) return 0;
    let events: readonly HookEventLike[];
    try {
      events = (await this.#source.poll(this.#options.batch ?? 100)).events;
    } catch (e) {
      this.#report(e);
      return 0;
    }
    let handled = 0;
    for (const event of events) {
      if (!this.#seen.seen(event.eventId)) {
        try {
          await this.#handle(event);
          handled += 1;
        } catch (e) {
          this.#report(e, event);
        }
      }
      try {
        await this.#source.ack(event.offset);
      } catch (e) {
        this.#report(e, event);
      }
    }
    return handled;
  }

  #report(error: unknown, event?: HookEventLike): void {
    try {
      // Stryker disable next-line OptionalChaining: equivalent; a missing handler would throw here, and the catch below swallows it
      this.#options.onError?.(error, event);
    } catch {
      // a failing error handler must not stop the loop it reports on
    }
  }

  // ---- events ------------------------------------------------------------------------------------------------

  async #handle(event: HookEventLike): Promise<void> {
    switch (event.type) {
      case "permission.requested":
        return this.#requested(event);
      case "permission.resolved":
        return this.#resolved(event);
      case "turn.ended":
        return this.#ended(event);
      case "turn.started":
      case "session.detached":
        this.#layer.inbox.clearSession(this.#sessionOf(event), ["review", "failure", "idle"]);
        return;
    }
    // session.created, capability changes, behavior changes and the rest are not its business
  }

  #ctx(session: string, event: HookEventLike): { readonly session: string; readonly correlation: string | undefined } {
    return { session, correlation: event.correlationId };
  }

  #sessionOf(event: HookEventLike): string {
    if (event.sessionId === undefined) throw new Error(`${event.type} (${event.eventId}) names no session`);
    return event.sessionId;
  }

  #requestOf(event: HookEventLike): string {
    const requestId = isRecord(event.payload) ? text(event.payload["requestId"]) : undefined;
    if (requestId === undefined) throw new Error(`${event.type} (${event.eventId}) names no request`);
    return requestId;
  }

  #now(event: HookEventLike): number {
    return event.at ?? this.#layer.clock.now();
  }

  async #requested(event: HookEventLike): Promise<void> {
    const session = this.#sessionOf(event);
    const requestId = this.#requestOf(event);
    // The choices on offer are read in the same step as the facts, before anything is awaited: a person may answer while the risk
    // model thinks, and the daemon forgets a request's choices as it is answered. Without them the answer could not be told as an
    // approval or a denial, and the outcome would be lost for exactly the fast answers.
    const offered = this.#facts.permissionOptions?.(session, requestId);
    const asked = this.#facts.permission(session, requestId);
    const [facts, options] = await Promise.all([asked, offered]);
    if (facts === undefined) return; // answered before the plugin looked
    const described = describePermission(facts, TEXT_CHARS) as { readonly [key: string]: Json };
    const what = [described["tool"], described["command"] ?? described["path"] ?? described["url"]].filter((part) => typeof part === "string").join(": ");
    const item: AttentionItem = { id: `permission:${session}:${requestId}`, session, kind: "permission", since: this.#now(event), blocked: true, text: what };
    // A request that blocks the session is in front of the person whatever happens to the annotation.
    await this.#add(item, event);
    const decision = await this.#layer.decideNamed("permission.risk", facts, this.#ctx(session, event));
    this.#remember(`${session}\0${requestId}`, { decision: decision.id, risk: decision.action, options });
    if (decision.active) await this.#add({ ...item, text: `${what} (risk: ${String(decision.action)})` }, event);
  }

  async #resolved(event: HookEventLike): Promise<void> {
    const session = this.#sessionOf(event);
    const requestId = this.#requestOf(event);
    this.#layer.inbox.resolve(`permission:${session}:${requestId}`);
    const key = `${session}\0${requestId}`;
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    await this.#read(session);
    this.#pending.delete(key);
    const { resolution } = pending;
    if (resolution?.optionId === undefined) return; // cancelled or timed out: nobody decided
    const chosen = pending.options?.find((option) => option.optionId === resolution.optionId)?.kind;
    const kind = chosen?.startsWith("allow") ? "approved" : chosen?.startsWith("reject") ? "denied" : undefined;
    if (kind === undefined) return;
    const correct = correctness(kind, pending.risk);
    const by = resolution.by ?? (isRecord(event.payload) ? text(event.payload["by"]) : undefined);
    const outcome: Outcome = { at: this.#now(event), source: "human", kind, ...(correct === undefined ? {} : { correct }), ...(by === undefined ? {} : { by }) };
    await this.#layer.outcome(pending.decision, outcome);
  }

  async #ended(event: HookEventLike): Promise<void> {
    const session = this.#sessionOf(event);
    const known = await this.#facts.sessions();
    for (const id of this.#sessions.keys()) if (!known.some((s) => s.id === id)) this.#sessions.delete(id);
    if (!known.some((s) => s.id === session)) return; // the session is gone: nothing to read and nothing to look at
    const since = this.#now(event);
    const stopReason = isRecord(event.payload) ? text(event.payload["stopReason"]) : undefined;
    await this.#add({ id: `review:${session}`, session, kind: "review", since, blocked: false, text: stopReason === undefined ? "the turn ended" : `the turn ended (${stopReason})` }, event);
    if (!(await this.#read(session))) return;
    const state = this.#state(session);
    // The person's words and a tool's title can carry secrets: the fork gets them removed (a step's `state` is a digest, so steps that differ in what they were given stay different).
    const input: StuckInput = { goal: scrubText(state.goal, SCAN_LIMIT), steps: state.steps.map((step) => ({ action: scrubText(step.action, SCAN_LIMIT), state: digestOf(step) })) };
    const decision = await this.#layer.decideNamed("stuck", input, this.#ctx(session, event));
    if (!decision.active) return;
    const id = `stuck:${session}`;
    if (decision.action === "continue") {
      this.#layer.inbox.resolve(id);
      return;
    }
    const escalate = decision.action === "escalate";
    const what = escalate ? "the agent looks stuck and needs a person" : "the agent may be going in circles";
    await this.#add({ id, session, kind: escalate ? "failure" : "idle", since, blocked: false, text: `${what} after ${state.steps.length} tool calls` }, event);
  }

  // ---- the inbox -----------------------------------------------------------------------------------------------------

  async #add(item: AttentionItem, event: HookEventLike): Promise<void> {
    let urgency: number | undefined;
    if (this.#options.assess === true) {
      const decision = await this.#layer.decideNamed("attention", item, this.#ctx(item.session, event));
      const level = ATTENTION_LEVELS.indexOf(decision.action as (typeof ATTENTION_LEVELS)[number]);
      // a fallback is not a judgment: only a rule or a model's urgency ranks the item
      // Stryker disable next-line ConditionalExpression: equivalent; the attention fork's actions are its levels, so the index is never -1
      if (decision.active && decision.rung !== "human" && level >= 0) urgency = level / (ATTENTION_LEVELS.length - 1);
    }
    this.#layer.inbox.add(urgency === undefined ? item : { ...item, urgency });
  }

  #remember(key: string, pending: Pending): void {
    this.#pending.delete(key);
    this.#pending.set(key, pending);
    const limit = this.#options.pendingLimit ?? 1024;
    while (this.#pending.size > limit) this.#pending.delete(this.#pending.keys().next().value!);
  }

  // ---- reading a session's log ------------------------------------------------------------------------------------------

  #state(session: string): SessionState {
    let state = this.#sessions.get(session);
    if (state === undefined) {
      state = { offset: undefined, goal: "", steps: [] };
      this.#sessions.set(session, state);
    }
    return state;
  }

  /** Read what is new in the session's log; returns whether it held a new tool call. */
  async #read(session: string): Promise<boolean> {
    const state = this.#state(session);
    let found = false;
    for (const entry of await this.#facts.log(session, state.offset)) {
      state.offset = entry.offset;
      if (this.#absorb(session, state, entry)) found = true;
    }
    return found;
  }

  /** Take in a log entry; returns whether it was a new tool call. */
  #absorb(session: string, state: SessionState, entry: LogEntryLike): boolean {
    const payload = isRecord(entry.payload) ? entry.payload : {};
    if (entry.kind === "event") {
      const data = isRecord(payload["data"]) ? payload["data"] : {};
      switch (payload["event"]) {
        case "turn.started":
          state.goal = "";
          break;
        case "permission.resolved": {
          // Stryker disable next-line StringLiteral: equivalent; no request is named with an empty id, whatever stands for none
          const pending = this.#pending.get(`${session}\0${text(data["requestId"]) ?? ""}`);
          const outcome = isRecord(data["outcome"]) ? data["outcome"] : {};
          // a cancelled outcome has no option
          if (pending !== undefined) pending.resolution = { optionId: text(outcome["optionId"]), by: text(data["by"]) };
          break;
        }
      }
      return false;
    }
    const update = isRecord(payload["update"]) ? payload["update"] : {};
    const toolCallId = text(update["toolCallId"]);
    switch (update["sessionUpdate"]) {
      case "user_message_chunk": {
        const said = text((isRecord(update["content"]) ? update["content"] : {})["text"]);
        if (said !== undefined) state.goal = state.goal === "" ? said : `${state.goal}\n${said}`;
        return false;
      }
      case "tool_call": {
        if (toolCallId === undefined) return false;
        state.steps.push({
          id: toolCallId,
          action: text(update["title"]) ?? text(update["kind"]) ?? "tool",
          fields: { rawInput: jsonOf(update["rawInput"]), status: jsonOf(update["status"]), rawOutput: jsonOf(update["rawOutput"]) },
        });
        state.steps.splice(0, Math.max(0, state.steps.length - (this.#options.maxSteps ?? 64)));
        return true;
      }
      case "tool_call_update": {
        // a tool call's id is its own within the session, so the update is to the one step that has it
        const step = state.steps.find((s) => s.id === toolCallId);
        if (step !== undefined) for (const field of STEP_FIELDS) if (update[field] !== undefined) step.fields[field] = jsonOf(update[field]);
        return false;
      }
    }
    return false;
  }
}
