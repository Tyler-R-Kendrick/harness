/**
 * The playground's harness: the browser host (the portable daemon runtime) started in
 * the page, and one ACP client of it over a `MessageChannel`, as any tab would connect.
 * Its workers run AI SDK agents whose tools work in the terminal's filesystem; every
 * ACP message, worker command, model call and hook event is traced, and every turn
 * reports what it changed.
 */
import { ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type { Client, RequestPermissionRequest, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import { isStepCount, wrapLanguageModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Bash } from "just-bash";
import type { DaemonSnapshot, Identity, SnapshotStorage } from "@harness/core";
import { BrowserHost, portStream } from "@harness/platform-browser";
import { AgentWorker, EchoWorker, sessionAgent } from "@harness/workers";
import type { ConversationStore, Worker } from "@harness/workers";
import { hookEvents, hookTrace, tracedPort, tracedTools, tracedWorker, tracingMiddleware } from "./trace.ts";
import type { Tracer } from "./trace.ts";
import { diffVfs, HOME, vfsApproval, vfsTools, walk } from "./vfs.ts";
import type { ApprovalPolicy, VfsDiff } from "./vfs.ts";

export const INSTRUCTIONS = [
  "You are an agent running inside the harness daemon, in a browser playground.",
  `You work in a sandboxed bash shell with a virtual filesystem; your working directory is ${HOME}, which the person also sees in their terminal.`,
  "Use the tools to inspect and change files when the request calls for it, then say briefly what you did. Keep replies short: they are shown in a terminal.",
].join(" ");

export interface PlaygroundOptions {
  /** The terminal's shell: the agent's tools work in its filesystem. */
  readonly bash: Bash;
  readonly tracer: Tracer;
  /** Models the agent worker can run, by name; `echo` is always there too (no model). */
  readonly models: Readonly<Record<string, LanguageModelV4>>;
  /** The worker the next turn runs on. */
  readonly worker: () => string;
  readonly approval: () => ApprovalPolicy;
  /** Where the daemon's snapshots persist (IndexedDB); without one they are only observed. */
  readonly storage?: SnapshotStorage;
  /** Where the agent workers keep each session's conversation, so it continues after a reload. */
  readonly conversations?: ConversationStore;
  readonly instructions?: string;
  /** Every snapshot the daemon saves (after each change). */
  readonly onSnapshot?: (snapshot: DaemonSnapshot) => void;
  readonly identity?: Identity;
}

export interface TurnHandlers {
  update(update: SessionUpdate): void;
  /** The option the person picks, or undefined to dismiss the question (which cancels the turn). */
  permission(request: RequestPermissionRequest): Promise<string | undefined>;
}

export interface TurnReport {
  readonly stopReason: StopReason;
  readonly diff: VfsDiff;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly ms: number;
}

/** A worker that runs each turn on the worker named when it starts, and sends its cancel and answers there. */
export function switchWorker(workers: Readonly<Record<string, Worker>>, current: () => string): Worker {
  const running = new Map<string, Worker>();
  const pick = () => {
    const name = current();
    const worker = workers[name];
    if (!worker) throw new Error(`no worker named ${name}`);
    return worker;
  };
  const key = (sessionId: string, turnId: string) => `${sessionId}/${turnId}`;
  return {
    run: async (command, emit) => {
      const worker = pick();
      running.set(key(command.sessionId, command.turnId), worker);
      try {
        await worker.run(command, emit);
      } finally {
        running.delete(key(command.sessionId, command.turnId));
      }
    },
    cancel: (sessionId, turnId) => running.get(key(sessionId, turnId))?.cancel(sessionId, turnId),
    permission: (command) => running.get(key(command.sessionId, command.turnId))?.permission(command),
    event: (command, emit) => pick().event?.(command, emit),
  };
}

/** Where the client sends what the daemon says: the running turn's handlers, or a replay's. */
interface Routes {
  update?: ((update: SessionUpdate) => void) | undefined;
  permission?: TurnHandlers["permission"] | undefined;
}

export class Playground {
  readonly host: BrowserHost;
  readonly #acp: ClientSideConnection;
  readonly #options: PlaygroundOptions;
  readonly #routes: Routes;
  #session: string | undefined;

  private constructor(host: BrowserHost, acp: ClientSideConnection, options: PlaygroundOptions, routes: Routes) {
    this.host = host;
    this.#acp = acp;
    this.#options = options;
    this.#routes = routes;
  }

  static async start(options: PlaygroundOptions): Promise<Playground> {
    const { tracer, bash } = options;
    const agentWorker = (model: LanguageModelV4) =>
      new AgentWorker({
        agent: sessionAgent({
          model: wrapLanguageModel({ model, middleware: tracingMiddleware(tracer) }),
          instructions: options.instructions ?? INSTRUCTIONS,
          tools: () => tracedTools(vfsTools(bash), tracer),
          toolApproval: vfsApproval(options.approval),
          stopWhen: isStepCount(12),
        }),
        ...(options.conversations ? { conversations: options.conversations } : {}),
      });
    const workers: Record<string, Worker> = { echo: new EchoWorker() };
    for (const [name, model] of Object.entries(options.models)) workers[name] = agentWorker(model);
    let hooks = 0;
    const storage: SnapshotStorage = {
      load: async () => {
        const snapshot = await options.storage?.load();
        // Hook events the restored daemon already had were traced before the reload.
        hooks = hookEvents(snapshot, 0).length;
        return snapshot;
      },
      save: async (snapshot) => {
        await options.storage?.save(snapshot);
        for (const e of hookEvents(snapshot, hooks)) {
          hooks = e.offset + 1;
          tracer.record(hookTrace(e));
        }
        options.onSnapshot?.(snapshot as DaemonSnapshot);
      },
    };
    const host = await BrowserHost.start({
      worker: tracedWorker(switchWorker(workers, options.worker), tracer),
      identity: options.identity ?? { principal: "you", kind: "human" },
      storage,
      agentInfo: { name: "harness playground", version: "0.0.0" },
      // One page is both ends: there is no other context to outlive.
      locks: undefined,
      log: (message) => tracer.record({ kind: "host", name: "log", detail: message }),
    });
    const channel = new MessageChannel();
    host.accept(channel.port2);
    const routes: Routes = {};
    const client: Client = {
      sessionUpdate: async ({ update }) => routes.update?.(update),
      requestPermission: async (request) => {
        const optionId = await routes.permission?.(request);
        return { outcome: optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId } };
      },
    };
    const acp = new ClientSideConnection(() => client, portStream(tracedPort(channel.port1, tracer), { locks: undefined }));
    await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    return new Playground(host, acp, options, routes);
  }

  /** The session prompts go to (the last one made or used). */
  get sessionId(): string | undefined {
    return this.#session;
  }

  async newSession(): Promise<string> {
    const { sessionId } = await this.#acp.newSession({ cwd: HOME, mcpServers: [] });
    this.#session = sessionId;
    return sessionId;
  }

  async sessions(): Promise<string[]> {
    return (await this.#acp.listSessions({})).sessions.map((s) => s.sessionId);
  }

  /** Attach to another session, replaying its log to `onUpdate`. */
  async use(sessionId: string, onUpdate: (update: SessionUpdate) => void): Promise<void> {
    this.#routes.update = onUpdate;
    try {
      await this.#acp.loadSession({ sessionId, cwd: HOME, mcpServers: [] });
      this.#session = sessionId;
    } finally {
      this.#routes.update = undefined;
    }
  }

  /** Run one turn in the current session (a new one if there is none) and report its effect. */
  async prompt(text: string, handlers: TurnHandlers): Promise<TurnReport> {
    const { tracer, bash } = this.#options;
    const sessionId = this.#session ?? (await this.newSession());
    const before = await walk(bash.fs, HOME);
    const from = tracer.last;
    const started = Date.now();
    this.#routes.update = handlers.update;
    this.#routes.permission = handlers.permission;
    let stopReason: StopReason;
    try {
      ({ stopReason } = await this.#acp.prompt({ sessionId, prompt: [{ type: "text", text }] }));
    } finally {
      this.#routes.update = undefined;
      this.#routes.permission = undefined;
    }
    const diff = diffVfs(before, await walk(bash.fs, HOME));
    tracer.record({ kind: "vfs", name: `changes · ${diff.added.length} added, ${diff.modified.length} modified, ${diff.removed.length} removed`, detail: diff, sessionId });
    const events = tracer.events().filter((e) => e.seq > from);
    return {
      stopReason,
      diff,
      toolCalls: events.filter((e) => e.kind === "worker" && e.name === "update · tool_call").length,
      modelCalls: events.filter((e) => e.kind === "model" && e.phase === "start").length,
      ms: Date.now() - started,
    };
  }

  async cancel(): Promise<void> {
    if (this.#session !== undefined) await this.#acp.cancel({ sessionId: this.#session });
  }

  snapshot(): DaemonSnapshot {
    return this.host.daemon.snapshot();
  }

  async close(): Promise<void> {
    await this.host.close();
  }
}
