import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  ERROR_CODES,
  HARNESS_METHODS,
  HARNESS_PROFILE_VERSION,
  failure,
  notification,
  parseMessage,
  request as rpcRequest,
  success,
} from "@harness/protocol";
import type { JsonRpcId } from "@harness/protocol";
import type {
  StopReason as AcpStopReason,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { CapabilityRegistry } from "./capabilities.ts";
import type { CapabilityOffer, Trust } from "./capabilities.ts";
import { FlowController } from "./flow.ts";
import { HookBus } from "./hooks.ts";
import { newId } from "./ids.ts";
import { InputLease } from "./input-lease.ts";
import type { Clock, Entropy } from "./ports.ts";
import { CallbackRouter } from "./routing.ts";
import type { CallbackOption, CallbackOutcome } from "./routing.ts";
import { SessionLog } from "./session-log.ts";
import type { LogEntry } from "./session-log.ts";
import { SubagentTree } from "./subagents.ts";
import type { Grant, NodeKind } from "./subagents.ts";

/** Trusted identity of a connection, supplied by the platform layer, never by the peer. */
export interface Identity {
  readonly principal: string;
  readonly kind: NodeKind;
}

export interface AgentInfo {
  readonly name: string;
  readonly version: string;
}

export interface DaemonDeps {
  readonly clock: Clock;
  readonly entropy: Entropy;
  readonly agentInfo: AgentInfo;
  /** Max unacknowledged log entries per `_harness` subscriber before it must resync. */
  readonly flowCapacity?: number;
  /** Cancel unanswered permission requests after this long. Unset means wait indefinitely. */
  readonly permissionTimeoutMs?: number;
  readonly leaseTtlMs?: number;
  readonly hookDepth?: number;
}

/** Why a turn ended, as ACP defines it. */
export type StopReason = AcpStopReason;

/** A choice offered with a permission request, as ACP defines it. */
export type PermissionOptionSpec = PermissionOption;

/** Instructions for the host to carry out against the session's worker. */
export type WorkerCommand =
  | { readonly type: "prompt"; readonly sessionId: string; readonly turnId: string; readonly prompt: readonly unknown[]; readonly cwd: string }
  | { readonly type: "cancel"; readonly sessionId: string; readonly turnId: string }
  | { readonly type: "permission"; readonly sessionId: string; readonly turnId: string; readonly requestId: string; readonly outcome: CallbackOutcome };

/** What a worker reports back through the host. */
export type WorkerEvent =
  | { readonly type: "update"; readonly sessionId: string; readonly turnId: string; readonly update: SessionUpdate }
  | {
      readonly type: "permission";
      readonly sessionId: string;
      readonly turnId: string;
      readonly requestId: string;
      readonly toolCall: ToolCallUpdate;
      readonly options: readonly PermissionOptionSpec[];
    }
  | { readonly type: "end"; readonly sessionId: string; readonly turnId: string; readonly stopReason: StopReason };

/** Cognitive-core operations clients can ask for, and the task each one needs a model for. */
export const COGNITIVE_OPS = {
  judge: "judgment",
  route: "tool-calling",
  "decide-tools": "tool-calling",
  embed: "text-embedding",
  compress: "prompt-compression",
  parse: "document-parsing",
} as const;
/** An installed cognitive extension's operation, e.g. `memory.recall`; the extension's id is its capability. */
const EXTENSION_OP = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
export type CognitiveOp = keyof typeof COGNITIVE_OPS | "status" | `${string}.${string}`;

/** Model work the daemon hands to the host, which runs its ensemble and reports back. */
export interface CognitiveWork {
  readonly requestId: string;
  readonly op: CognitiveOp;
  /** The task whose `cognitive.<task>` capability gated this work; undefined for status. */
  readonly task: string | undefined;
  readonly input: unknown;
}

export type CognitiveResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string };

export type Output =
  | { readonly kind: "send"; readonly connectionId: string; readonly message: object }
  | { readonly kind: "worker"; readonly command: WorkerCommand }
  | { readonly kind: "cognitive"; readonly work: CognitiveWork };

type LogPayload =
  | { readonly update: Readonly<Record<string, unknown>>; readonly origin?: string }
  | { readonly event: string; readonly data: Readonly<Record<string, unknown>> };

interface Connection {
  readonly id: string;
  readonly identity: Identity;
  initialized: boolean;
  harness: boolean;
}

interface Subscriber {
  readonly nodeId: string;
  readonly flowControlled: boolean;
}

interface PendingPermission {
  readonly turnId: string;
  readonly toolCall: ToolCallUpdate;
  readonly options: readonly PermissionOptionSpec[];
  /** connectionId -> outbound JSON-RPC request id */
  readonly outbound: Map<string, string>;
}

interface Session {
  readonly id: string;
  readonly cwd: string;
  readonly owner: string;
  readonly log: SessionLog<LogPayload>;
  readonly tree: SubagentTree;
  readonly router: CallbackRouter;
  readonly lease: InputLease;
  readonly flow: FlowController;
  readonly subscribers: Map<string, Subscriber>;
  readonly permissions: Map<string, PendingPermission>;
  turn: { readonly turnId: string; readonly prompt?: { readonly connectionId: string; readonly id: JsonRpcId } } | undefined;
}

interface SessionSnapshot {
  readonly id: string;
  readonly cwd: string;
  readonly owner: string;
  readonly log: unknown;
  readonly tree: unknown;
  readonly turnId?: string;
}

export interface DaemonSnapshot {
  readonly version: 1;
  readonly sessions: readonly SessionSnapshot[];
  readonly hooks: unknown;
}

const OWNER_GRANTS: readonly Grant[] = ["observe", "control", "approve", "cancel"];
const DAEMON_NODE = "daemon";
const WORKER_NODE = "worker";

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    if (message === "") throw new Error(`rpc error ${code} needs a message`);
    super(message);
    this.code = code;
  }
}

const invalidParams = (message: string) => new RpcError(ERROR_CODES.invalidParams, message);

/** Returned by handlers whose response is sent later (a prompt is answered when its turn ends). */
const DEFER = Symbol("defer");

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw invalidParams(`${name} must be a string`);
  return v;
}

function int(v: unknown, name: string): number {
  if (!Number.isInteger(v) || (v as number) < 0) throw invalidParams(`${name} must be a non-negative integer`);
  return v as number;
}

/**
 * The portable daemon core. Sans-I/O: hosts pass in decoded ACP messages and worker
 * events and carry out the returned outputs (messages to connections, commands to
 * workers). Time and randomness come from injected ports, so identical inputs yield
 * identical outputs on every platform.
 */
export class Daemon {
  readonly #deps: DaemonDeps;
  readonly #connections = new Map<string, Connection>();
  readonly #sessions = new Map<string, Session>();
  readonly #outbound = new Map<string, { connectionId: string; sessionId: string; requestId: string }>();
  readonly #capabilities = new CapabilityRegistry();
  /** Cognitive work awaiting the host: requestId -> the client request to answer. */
  readonly #cognitive = new Map<string, { connectionId: string; id: JsonRpcId }>();
  #hooks: HookBus;
  #outboundSeq = 0;
  #cognitiveSeq = 0;
  #out: Output[] = [];

  constructor(deps: DaemonDeps) {
    this.#deps = deps;
    this.#hooks = new HookBus({ maxDepth: deps.hookDepth ?? 8 });
  }

  // ---- host-facing API ----------------------------------------------------------

  connect(connectionId: string, identity: Identity): void {
    this.#connections.set(connectionId, { id: connectionId, identity, initialized: false, harness: false });
  }

  disconnect(connectionId: string): Output[] {
    return this.#run(() => {
      for (const session of this.#sessions.values()) if (session.subscribers.has(connectionId)) this.#detach(session, connectionId);
      this.#capabilities.withdraw(`conn:${connectionId}`, this.#now());
      this.#publishCapabilityEvents();
      for (const [requestId, pending] of this.#cognitive) if (pending.connectionId === connectionId) this.#cognitive.delete(requestId);
      this.#connections.delete(connectionId);
    });
  }

  receive(connectionId: string, raw: unknown): Output[] {
    const conn = this.#connections.get(connectionId);
    if (!conn) return [];
    return this.#run(() => {
      const parsed = parseMessage(raw);
      if (!parsed.ok) {
        this.#send(connectionId, failure(null, ERROR_CODES.invalidRequest, parsed.error.message));
        return;
      }
      const m = parsed.value;
      if (m.kind === "request") this.#handleRequest(conn, m.id, m.method, m.params);
      else if (m.kind === "notification") this.#handleNotification(conn, m.method, m.params);
      else this.#handleClientResponse(conn, m.id, m.kind === "response" ? m.result : undefined);
    });
  }

  workerEvent(event: WorkerEvent): Output[] {
    return this.#run(() => {
      const session = this.#sessions.get(event.sessionId);
      if (!session || session.turn?.turnId !== event.turnId) return;
      if (event.type === "update") this.#append(session, "update", { update: event.update });
      else if (event.type === "permission") this.#openPermission(session, event);
      else this.#endTurn(session, event.stopReason);
    });
  }

  /** Expire deadlines. Hosts call this periodically. */
  tick(): Output[] {
    return this.#run(() => {
      for (const session of this.#sessions.values()) {
        for (const r of session.router.expire(this.#now())) this.#resolvePermission(session, r.requestId, r.outcome, r.by);
      }
    });
  }

  offerPlatformCapability(offer: { name: string; version: number; trust: Trust }): void {
    this.#capabilities.offer({ providerId: "platform", provenance: "platform", ...offer }, this.#now());
    this.#publishCapabilityEvents();
  }

  /** Withdraw a capability the platform offered, e.g. when the model behind it fails or the hardware goes away. */
  withdrawPlatformCapability(name: string): void {
    this.#capabilities.withdraw("platform", this.#now(), name);
    this.#publishCapabilityEvents();
  }

  capabilities(): CapabilityOffer[] {
    return this.#capabilities.inventory();
  }

  /** The host finished cognitive work; answer the client that asked, if it is still connected. */
  cognitiveResult(requestId: string, result: CognitiveResult): Output[] {
    return this.#run(() => {
      const pending = this.#cognitive.get(requestId);
      if (!pending) return;
      this.#cognitive.delete(requestId);
      if (!this.#connections.has(pending.connectionId)) return;
      this.#send(pending.connectionId, result.ok ? success(pending.id, result.value) : failure(pending.id, ERROR_CODES.internalError, result.message || "cognitive operation failed"));
    });
  }

  snapshot(): DaemonSnapshot {
    return {
      version: 1,
      sessions: [...this.#sessions.values()].map((s) => ({
        id: s.id,
        cwd: s.cwd,
        owner: s.owner,
        log: s.log.toJSON(),
        tree: s.tree.toJSON(),
        ...(s.turn ? { turnId: s.turn.turnId } : {}),
      })),
      hooks: this.#hooks.toJSON(),
    };
  }

  /** Rebuild after a restart. Connections are gone, and a turn in flight is marked interrupted. */
  static restore(data: unknown, deps: DaemonDeps): Daemon {
    const snap = record(data) as Partial<DaemonSnapshot>;
    if (!Array.isArray(snap.sessions)) throw new Error("invalid daemon snapshot");
    const daemon = new Daemon(deps);
    daemon.#hooks = HookBus.fromJSON(snap.hooks, { maxDepth: deps.hookDepth ?? 8 });
    for (const s of snap.sessions) {
      const tree = SubagentTree.fromJSON(s.tree);
      for (const node of tree.toJSON().nodes) if (node.id.startsWith("conn:") && node.state === "active") tree.detach(node.id);
      const session = daemon.#newSession(s.id, s.cwd, s.owner, tree, SessionLog.fromJSON<LogPayload>(s.log));
      if (s.turnId !== undefined) {
        daemon.#append(session, "event", { event: "turn.interrupted", data: { turnId: s.turnId } });
        daemon.#append(session, "update", { update: { sessionUpdate: "notice", severity: "warning", title: "Turn interrupted by daemon restart" } });
      }
    }
    daemon.#out = [];
    return daemon;
  }

  // ---- request handling -----------------------------------------------------------

  #handleRequest(conn: Connection, id: JsonRpcId, method: string, rawParams: unknown): void {
    const params = record(rawParams);
    try {
      if (method !== ACP_METHODS.initialize && !conn.initialized) throw new RpcError(ERROR_CODES.notInitialized, "initialize first");
      const result = this.#dispatch(conn, id, method, params);
      if (result !== DEFER) this.#send(conn.id, success(id, result));
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      this.#send(conn.id, failure(id, e.code, e.message));
    }
  }

  #dispatch(conn: Connection, id: JsonRpcId, method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case ACP_METHODS.initialize:
        return this.#initialize(conn, params);
      case ACP_METHODS.sessionNew:
        return this.#sessionNew(conn, params);
      case ACP_METHODS.sessionLoad:
        return this.#sessionLoad(conn, params);
      case ACP_METHODS.sessionList:
        return {
          sessions: [...this.#sessions.values()].filter((s) => s.owner === conn.identity.principal).map((s) => ({ sessionId: s.id, cwd: s.cwd })),
        } satisfies ListSessionsResponse;
      case ACP_METHODS.sessionPrompt:
        return this.#prompt(conn, id, params);
      case HARNESS_METHODS.sessionAttach:
        return this.#sessionAttach(conn, params);
      case HARNESS_METHODS.sessionDetach: {
        const session = this.#session(str(params["sessionId"], "sessionId"));
        this.#detach(session, conn.id);
        return {};
      }
      case HARNESS_METHODS.sessionAck: {
        const session = this.#session(str(params["sessionId"], "sessionId"));
        const r = session.flow.ack(conn.id, int(params["offset"], "offset") + 1);
        if (!r.ok) throw invalidParams(r.error.message);
        return {};
      }
      case HARNESS_METHODS.sessionTree: {
        const session = this.#session(str(params["sessionId"], "sessionId"));
        this.#authorize(conn, session);
        return session.tree.toJSON();
      }
      case HARNESS_METHODS.capabilitiesList:
        return { capabilities: this.#capabilities.inventory() };
      case HARNESS_METHODS.capabilitiesOffer:
        return this.#offer(conn, params);
      case HARNESS_METHODS.capabilitiesWithdraw:
        this.#capabilities.withdraw(`conn:${conn.id}`, this.#now(), str(params["name"], "name"));
        this.#publishCapabilityEvents();
        return {};
      case HARNESS_METHODS.hooksSubscribe:
        return this.#hooksSubscribe(conn, params);
      case HARNESS_METHODS.cognitiveInvoke:
        return this.#cognitiveInvoke(conn, id, params);
      case HARNESS_METHODS.cognitiveStatus:
        return this.#cognitiveWork(conn, id, "status", undefined, params);
      case HARNESS_METHODS.hooksPoll: {
        const r = this.#hooks.poll(this.#plugin(conn), params["max"] === undefined ? Number.POSITIVE_INFINITY : int(params["max"], "max"));
        if (!r.ok) throw invalidParams(r.error.message);
        return { events: r.value };
      }
      case HARNESS_METHODS.hooksAck: {
        const r = this.#hooks.ack(this.#plugin(conn), int(params["offset"], "offset"));
        if (!r.ok) throw invalidParams(r.error.message);
        return {};
      }
      default:
        throw new RpcError(ERROR_CODES.methodNotFound, `unknown method ${method}`);
    }
  }

  #initialize(conn: Connection, params: Record<string, unknown>): unknown {
    if (!Number.isInteger(params["protocolVersion"])) throw invalidParams("protocolVersion must be an integer");
    conn.initialized = true;
    conn.harness = record(record(params["_meta"])["harness"])["profileVersion"] === HARNESS_PROFILE_VERSION;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: {} },
      agentInfo: { name: this.#deps.agentInfo.name, version: this.#deps.agentInfo.version },
      authMethods: [],
      _meta: {
        harness: { profileVersion: HARNESS_PROFILE_VERSION, methods: Object.values(HARNESS_METHODS), capabilities: this.#capabilities.inventory() },
      },
    } satisfies InitializeResponse;
  }

  #sessionNew(conn: Connection, params: Record<string, unknown>): unknown {
    const cwd = str(params["cwd"], "cwd");
    const tree = new SubagentTree();
    tree.createRoot(DAEMON_NODE, "agent", ["observe", "control", "approve", "cancel", "spawn"]);
    tree.spawn(DAEMON_NODE, WORKER_NODE, "agent", ["observe"]);
    const session = this.#newSession(newId("session", this.#deps.entropy), cwd, conn.identity.principal, tree, new SessionLog());
    this.#append(session, "event", { event: "session.created", data: { cwd, owner: conn.identity.principal } });
    this.#publish("session.created", session.id, { cwd });
    this.#attach(conn, session, OWNER_GRANTS, session.log.head(), false);
    return { sessionId: session.id } satisfies NewSessionResponse;
  }

  #sessionLoad(conn: Connection, params: Record<string, unknown>): unknown {
    const session = this.#session(str(params["sessionId"], "sessionId"));
    this.#authorize(conn, session);
    this.#attach(conn, session, OWNER_GRANTS, session.log.base(), true);
    return {} satisfies LoadSessionResponse;
  }

  #sessionAttach(conn: Connection, params: Record<string, unknown>): unknown {
    const session = this.#session(str(params["sessionId"], "sessionId"));
    this.#authorize(conn, session);
    const requested = Array.isArray(params["grants"]) ? (params["grants"] as unknown[]) : OWNER_GRANTS;
    const grants = OWNER_GRANTS.filter((g) => requested.includes(g));
    const from = params["from"] === undefined ? session.log.head() : int(params["from"], "from");
    const nodeId = this.#attach(conn, session, grants, from, true);
    return { sessionId: session.id, head: session.log.head(), base: session.log.base(), grants: [...session.tree.grants(nodeId)] };
  }

  #prompt(conn: Connection, id: JsonRpcId, params: Record<string, unknown>): typeof DEFER {
    const sessionId = str(params["sessionId"], "sessionId");
    if (!Array.isArray(params["prompt"])) throw invalidParams("prompt must be an array");
    const prompt = params["prompt"] as unknown[];
    const session = this.#session(sessionId);
    const sub = session.subscribers.get(conn.id);
    if (!sub || !session.tree.hasGrant(sub.nodeId, "control")) throw new RpcError(ERROR_CODES.forbidden, "not attached with control");
    if (session.turn) throw new RpcError(ERROR_CODES.conflict, "a turn is already running");
    const priority = conn.identity.kind === "human" ? "human" : "agent";
    const lease = session.lease.acquire(sub.nodeId, priority, this.#now(), this.#deps.leaseTtlMs ?? 300_000);
    if (!lease.ok) throw new RpcError(ERROR_CODES.conflict, lease.error.message);
    const turnId = newId("task", this.#deps.entropy);
    session.turn = { turnId, prompt: { connectionId: conn.id, id } };
    this.#append(session, "event", { event: "turn.started", data: { turnId, by: sub.nodeId } });
    for (const block of prompt) this.#append(session, "update", { update: { sessionUpdate: "user_message_chunk", content: block }, origin: conn.id });
    this.#publish("turn.started", session.id, { turnId });
    this.#out.push({ kind: "worker", command: { type: "prompt", sessionId, turnId, prompt, cwd: session.cwd } });
    return DEFER;
  }

  #offer(conn: Connection, params: Record<string, unknown>): unknown {
    const name = str(params["name"], "name");
    if (!Number.isInteger(params["version"])) throw invalidParams("version must be an integer");
    const r = this.#capabilities.offer(
      { providerId: `conn:${conn.id}`, name, version: params["version"] as number, provenance: conn.identity.kind === "plugin" ? "plugin" : "client", trust: "untrusted" },
      this.#now(),
    );
    if (!r.ok) throw new RpcError(ERROR_CODES.conflict, r.error.message);
    this.#publishCapabilityEvents();
    return {};
  }

  #cognitiveInvoke(conn: Connection, id: JsonRpcId, params: Record<string, unknown>): typeof DEFER {
    const op = params["op"];
    const core = typeof op === "string" && Object.hasOwn(COGNITIVE_OPS, op);
    if (typeof op !== "string" || !(core || EXTENSION_OP.test(op))) {
      throw invalidParams(`op must be one of ${Object.keys(COGNITIVE_OPS).join(", ")}, or <extension>.<operation>`);
    }
    if (!("input" in params)) throw invalidParams("input is required");
    const task = core ? COGNITIVE_OPS[op as keyof typeof COGNITIVE_OPS] : undefined;
    const capability = task ? `cognitive.${task}` : op.split(".")[0]!;
    if (!this.#capabilities.inventory().some((c) => c.name === capability)) {
      throw new RpcError(ERROR_CODES.notFound, task ? `no model serves ${task} on this platform` : `no extension ${capability} is installed on this host`);
    }
    return this.#cognitiveWork(conn, id, op as CognitiveOp, task, params["input"]);
  }

  #cognitiveWork(conn: Connection, id: JsonRpcId, op: CognitiveOp, task: string | undefined, input: unknown): typeof DEFER {
    const requestId = `cog-${++this.#cognitiveSeq}`;
    this.#cognitive.set(requestId, { connectionId: conn.id, id });
    this.#out.push({ kind: "cognitive", work: { requestId, op, task, input } });
    return DEFER;
  }

  #hooksSubscribe(conn: Connection, params: Record<string, unknown>): unknown {
    const plugin = this.#plugin(conn);
    const types = params["types"];
    if (!Array.isArray(types) || !types.every((t) => typeof t === "string")) throw invalidParams("types must be an array of strings");
    const sessionId = params["sessionId"];
    this.#hooks.subscribe(plugin, typeof sessionId === "string" ? { types, sessionId } : { types }, params["from"] === undefined ? undefined : int(params["from"], "from"));
    return {};
  }

  #handleNotification(conn: Connection, method: string, rawParams: unknown): void {
    if (!conn.initialized || method !== ACP_METHODS.sessionCancel) return;
    const session = this.#sessions.get(String(record(rawParams)["sessionId"]));
    const sub = session?.subscribers.get(conn.id);
    if (!session || !sub || !session.turn) return;
    if (!session.tree.hasGrant(sub.nodeId, "cancel") && !session.tree.hasGrant(sub.nodeId, "control")) return;
    this.#cancelPermissions(session, session.turn.turnId);
    this.#out.push({ kind: "worker", command: { type: "cancel", sessionId: session.id, turnId: session.turn.turnId } });
  }

  /** A client's answer (or error) to a request the daemon sent it. Errors withdraw that target. */
  #handleClientResponse(conn: Connection, id: JsonRpcId | null, result: unknown): void {
    const pending = this.#outbound.get(String(id));
    if (!pending || pending.connectionId !== conn.id) return;
    this.#outbound.delete(String(id));
    const session = this.#sessions.get(pending.sessionId);
    const sub = session?.subscribers.get(conn.id);
    const outcome = parseOutcome(record(result)["outcome"]);
    if (!session || !sub || !outcome) return;
    const r = session.router.answer(pending.requestId, sub.nodeId, outcome, this.#now());
    if (r.ok) this.#resolvePermission(session, pending.requestId, outcome, sub.nodeId, conn.id);
  }

  // ---- sessions, attachment, delivery --------------------------------------------

  #newSession(id: string, cwd: string, owner: string, tree: SubagentTree, log: SessionLog<LogPayload>): Session {
    const session: Session = {
      id,
      cwd,
      owner,
      log,
      tree,
      router: new CallbackRouter(tree, { exclude: [DAEMON_NODE] }),
      lease: new InputLease(),
      flow: new FlowController(this.#deps.flowCapacity ?? 256),
      subscribers: new Map(),
      permissions: new Map(),
      turn: undefined,
    };
    this.#sessions.set(id, session);
    return session;
  }

  #attach(conn: Connection, session: Session, grants: readonly Grant[], from: number, replay: boolean): string {
    const nodeId = `conn:${conn.id}`;
    const existing = session.tree.get(nodeId);
    if (existing?.state === "closed") throw new RpcError(ERROR_CODES.forbidden, "attachment was closed");
    if (existing) session.tree.reattach(nodeId);
    else session.tree.spawn(DAEMON_NODE, nodeId, conn.identity.kind, grants);
    if (replay) {
      const r = session.log.read(from);
      if (r.kind === "out-of-range") throw invalidParams(`offset ${from} is outside the log (head ${r.head})`);
      if (r.kind === "entries") for (const entry of r.entries) this.#deliver(session, conn, entry);
    }
    const flowControlled = conn.harness;
    session.subscribers.set(conn.id, { nodeId, flowControlled });
    if (flowControlled) session.flow.subscribe(conn.id, session.log.head());
    this.#publish("session.attached", session.id, { nodeId });
    for (const requestId of session.router.pendingFor(nodeId)) this.#sendPermission(session, requestId, conn.id);
    return nodeId;
  }

  #detach(session: Session, connectionId: string): void {
    const sub = session.subscribers.get(connectionId);
    if (!sub) return;
    session.tree.detach(sub.nodeId);
    session.subscribers.delete(connectionId);
    session.flow.unsubscribe(connectionId);
    session.lease.release(sub.nodeId, this.#now());
    for (const perm of session.permissions.values()) {
      const outboundId = perm.outbound.get(connectionId);
      if (outboundId !== undefined) this.#outbound.delete(outboundId);
      perm.outbound.delete(connectionId);
    }
    this.#publish("session.detached", session.id, { nodeId: sub.nodeId });
  }

  #append(session: Session, kind: "update" | "event", payload: LogPayload): void {
    const entry = session.log.append(kind, payload, this.#now());
    const routed = session.flow.route(entry.offset);
    for (const [connId, sub] of session.subscribers) {
      const conn = this.#connections.get(connId);
      if (!conn) continue;
      if (sub.flowControlled) {
        if (routed.send.includes(connId)) this.#deliver(session, conn, entry);
        else if (routed.resync.includes(connId)) {
          this.#send(connId, notification(HARNESS_METHODS.sessionResync, { sessionId: session.id, head: session.log.head() }));
        }
      } else if ("update" in entry.payload && entry.payload.origin !== connId) {
        this.#deliver(session, conn, entry);
      }
    }
  }

  #deliver(session: Session, conn: Connection, entry: LogEntry<LogPayload>): void {
    const meta = { harness: { offset: entry.offset } };
    if ("update" in entry.payload) {
      this.#send(conn.id, notification(ACP_METHODS.sessionUpdate, { sessionId: session.id, update: entry.payload.update, _meta: meta }));
    } else if (conn.harness) {
      this.#send(conn.id, notification(HARNESS_METHODS.sessionEvent, { sessionId: session.id, event: entry.payload.event, data: entry.payload.data, _meta: meta }));
    }
  }

  #endTurn(session: Session, stopReason: StopReason): void {
    const turn = session.turn!;
    this.#cancelPermissions(session, turn.turnId);
    session.turn = undefined;
    this.#append(session, "event", { event: "turn.ended", data: { turnId: turn.turnId, stopReason } });
    this.#publish("turn.ended", session.id, { turnId: turn.turnId, stopReason });
    if (turn.prompt && this.#connections.has(turn.prompt.connectionId)) {
      this.#send(turn.prompt.connectionId, success(turn.prompt.id, { stopReason } satisfies PromptResponse));
    }
  }

  // ---- permissions ------------------------------------------------------------------

  #openPermission(session: Session, event: Extract<WorkerEvent, { type: "permission" }>): void {
    const options: CallbackOption[] = event.options.map((o) => ({ optionId: o.optionId, kind: o.kind }));
    const timeout = this.#deps.permissionTimeoutMs;
    const opened = session.router.open({
      requestId: event.requestId,
      from: WORKER_NODE,
      options,
      at: this.#now(),
      ...(timeout === undefined ? {} : { deadline: this.#now() + timeout }),
    });
    if (!opened.ok) return;
    session.permissions.set(event.requestId, { turnId: event.turnId, toolCall: event.toolCall, options: event.options, outbound: new Map() });
    this.#append(session, "event", { event: "permission.requested", data: { requestId: event.requestId } });
    this.#publish("permission.requested", session.id, { requestId: event.requestId });
    for (const [connId, sub] of session.subscribers) if (opened.value.targets.includes(sub.nodeId)) this.#sendPermission(session, event.requestId, connId);
  }

  #cancelPermissions(session: Session, turnId: string): void {
    for (const [requestId, perm] of session.permissions) {
      if (perm.turnId !== turnId) continue;
      session.router.cancel(requestId, this.#now());
      this.#resolvePermission(session, requestId, { outcome: "cancelled" }, "system");
    }
  }

  #sendPermission(session: Session, requestId: string, connectionId: string): void {
    const perm = session.permissions.get(requestId)!;
    const outboundId = `hr-${++this.#outboundSeq}`;
    this.#outbound.set(outboundId, { connectionId, sessionId: session.id, requestId });
    perm.outbound.set(connectionId, outboundId);
    this.#send(connectionId, rpcRequest(outboundId, ACP_METHODS.requestPermission, { sessionId: session.id, toolCall: perm.toolCall, options: [...perm.options] } satisfies RequestPermissionRequest));
  }

  /** The router has already recorded the resolution; tell the worker and withdraw the other requests. */
  #resolvePermission(session: Session, requestId: string, outcome: CallbackOutcome, by: string, answeredBy?: string): void {
    const perm = session.permissions.get(requestId)!;
    session.permissions.delete(requestId);
    this.#out.push({ kind: "worker", command: { type: "permission", sessionId: session.id, turnId: perm.turnId, requestId, outcome } });
    for (const [connId, outboundId] of perm.outbound) {
      this.#outbound.delete(outboundId);
      if (connId !== answeredBy) this.#send(connId, notification(ACP_METHODS.cancelRequest, { requestId: outboundId }));
    }
    this.#append(session, "event", { event: "permission.resolved", data: { requestId, outcome, by } });
    this.#publish("permission.resolved", session.id, { requestId, by });
  }

  // ---- helpers ------------------------------------------------------------------------

  #session(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new RpcError(ERROR_CODES.notFound, `no session ${id}`);
    return session;
  }

  #authorize(conn: Connection, session: Session): void {
    if (session.owner !== conn.identity.principal) throw new RpcError(ERROR_CODES.forbidden, "not the session owner");
  }

  #plugin(conn: Connection): string {
    if (conn.identity.kind !== "plugin") throw new RpcError(ERROR_CODES.forbidden, "only plugins use the hook bus");
    return conn.identity.principal;
  }

  #publish(type: string, sessionId: string, payload: Record<string, unknown>): void {
    this.#hooks.publish({ type, source: "daemon", sessionId, payload }, this.#now());
  }

  #publishCapabilityEvents(): void {
    for (const e of this.#capabilities.drainEvents()) this.#hooks.publish({ type: e.type, source: "daemon", payload: e }, e.at);
  }

  #send(connectionId: string, message: object): void {
    this.#out.push({ kind: "send", connectionId, message });
  }

  #now(): number {
    return this.#deps.clock.now();
  }

  #run(fn: () => void): Output[] {
    this.#out = [];
    fn();
    const out = this.#out;
    this.#out = [];
    return out;
  }
}

function parseOutcome(v: unknown): CallbackOutcome | undefined {
  const o = record(v);
  if (o["outcome"] === "cancelled") return { outcome: "cancelled" };
  if (o["outcome"] === "selected" && typeof o["optionId"] === "string") return { outcome: "selected", optionId: o["optionId"] };
  return undefined;
}
