import { Daemon, newId } from "@harness/core";
import type { AgentInfo, Clock, CognitiveWork, Entropy, Identity, Output, SnapshotStorage, WorkerCommand } from "@harness/core";
import { invokeCognitive, mirrorCapabilities } from "@harness/cognitive";
import type { Ensemble } from "@harness/cognitive";
import type { Worker } from "@harness/workers";

export interface RuntimeOptions {
  readonly worker: Worker;
  readonly clock: Clock;
  readonly entropy: Entropy;
  readonly storage?: SnapshotStorage;
  readonly agentInfo?: AgentInfo;
  readonly flowCapacity?: number;
  readonly permissionTimeoutMs?: number;
  /** The cognitive core's model ensemble; its tasks become `cognitive.*` capabilities. */
  readonly cognitive?: Ensemble;
  /** Without an ensemble, how to turn the cognitive core on here (said with every refusal of cognitive work). */
  readonly cognitiveOff?: string;
  /** Where the runtime reports what it cannot hand to anyone (a worker crash, a failed save). */
  readonly log?: (message: string) => void;
}

/** One peer's connection to the daemon: messages in, and a way to hang up. */
export interface RuntimeConnection {
  readonly id: string;
  receive(message: unknown): void;
  disconnect(): void;
}

/**
 * The portable daemon runtime every host wraps: the pure daemon core, driven by its
 * outputs — messages to connections, commands to the worker, cognitive work on the
 * ensemble — with snapshots saved after every change. Hosts supply the transports
 * (stdio, a socket, a MessagePort), the ports (clock, entropy, storage) and a ticker.
 */
export class DaemonRuntime {
  readonly daemon: Daemon;
  readonly #worker: Worker;
  readonly #storage: SnapshotStorage | undefined;
  readonly #ensemble: Ensemble | undefined;
  readonly #off: string;
  readonly #entropy: Entropy;
  readonly #log: (message: string) => void;
  readonly #stopMirror: () => void;
  readonly #connections = new Map<string, (message: object) => void>();
  readonly #turns = new Set<Promise<void>>();
  #saving: Promise<void> = Promise.resolve();
  #savePending = false;

  private constructor(daemon: Daemon, options: RuntimeOptions) {
    this.daemon = daemon;
    this.#worker = options.worker;
    this.#storage = options.storage;
    this.#ensemble = options.cognitive;
    this.#off = `the cognitive core is not enabled on this host${options.cognitiveOff === undefined ? "" : ` (${options.cognitiveOff})`}`;
    this.#entropy = options.entropy;
    this.#log = options.log ?? (() => {});
    // Capability changes publish hook events, which snapshots keep: save after each.
    this.#stopMirror = this.#ensemble
      ? mirrorCapabilities(this.#ensemble, {
          offer: (name) => (this.daemon.offerPlatformCapability({ name, version: 1, trust: "trusted" }), this.#persist()),
          withdraw: (name) => (this.daemon.withdrawPlatformCapability(name), this.#persist()),
        })
      : () => {};
  }

  /** Restore the daemon from its last snapshot (turns it was running are marked interrupted), or start fresh. */
  static async start(options: RuntimeOptions): Promise<DaemonRuntime> {
    const deps = { ...options, agentInfo: options.agentInfo ?? { name: "harness", version: "0.0.0" } };
    const snapshot = await options.storage?.load();
    const runtime = new DaemonRuntime(snapshot === undefined ? new Daemon(deps) : Daemon.restore(snapshot, deps), options);
    if (snapshot !== undefined) runtime.#persist(); // record interrupted turns promptly
    return runtime;
  }

  /** A new connection for a peer with this (host-verified) identity; `send` delivers the daemon's messages to it. */
  connect(identity: Identity, send: (message: object) => void): RuntimeConnection {
    const id = newId("connection", this.#entropy);
    this.#connections.set(id, send);
    this.daemon.connect(id, identity);
    return {
      id,
      // The daemon ignores messages from a connection it no longer has, and disconnecting twice.
      receive: (message) => this.#apply(this.daemon.receive(id, message)),
      disconnect: () => {
        // Stryker disable next-line all: equivalent; the daemon never sends to a connection it dropped, so keeping it only leaks
        this.#connections.delete(id);
        this.#apply(this.daemon.disconnect(id));
      },
    };
  }

  /** Expire deadlines; hosts call this periodically. */
  tick(): void {
    this.#apply(this.daemon.tick());
  }

  /** Turns and cognitive work in flight. */
  get busy(): number {
    return this.#turns.size;
  }

  /** Let running turns and cognitive work finish, and their saves land. */
  async close(): Promise<void> {
    this.#stopMirror();
    await Promise.allSettled([...this.#turns]);
    await this.#saving;
  }

  #apply(outputs: Output[]): void {
    for (const o of outputs) {
      // The daemon sends only to connections it has, and it has the runtime's; `?.` guards a bug, not a case.
      // Stryker disable next-line OptionalChaining: equivalent while that holds
      if (o.kind === "send") this.#connections.get(o.connectionId)?.(o.message);
      else if (o.kind === "cognitive") this.#think(o.work);
      else this.#dispatch(o.command);
    }
    if (outputs.length > 0) this.#persist();
  }

  #dispatch(command: WorkerCommand): void {
    const emit = (event: Parameters<Daemon["workerEvent"]>[0]) => this.#apply(this.daemon.workerEvent(event));
    if (command.type === "cancel") this.#worker.cancel(command.sessionId, command.turnId);
    else if (command.type === "permission") this.#worker.permission(command);
    else if (command.type === "event") this.#worker.event?.(command, emit);
    else {
      const turn = this.#worker
        .run(command, emit)
        .catch((e: unknown) => {
          this.#log(`worker failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
          // Stryker disable next-line StringLiteral: equivalent; the daemon ends the turn on any event that is not an update or a permission request
          emit({ type: "end", sessionId: command.sessionId, turnId: command.turnId, stopReason: "refusal" });
        })
        .finally(() => this.#turns.delete(turn));
      this.#turns.add(turn);
    }
  }

  /** Run cognitive work on the ensemble and report the result to the daemon. */
  #think(work: CognitiveWork): void {
    const ensemble = this.#ensemble;
    const job = (ensemble ? invokeCognitive(ensemble, work.op, work.input) : Promise.reject(new Error(this.#off)))
      .then(
        (value) => this.#apply(this.daemon.cognitiveResult(work.requestId, { ok: true, value })),
        (e: unknown) => this.#apply(this.daemon.cognitiveResult(work.requestId, { ok: false, message: e instanceof Error ? e.message : String(e) })),
      )
      .finally(() => this.#turns.delete(job));
    this.#turns.add(job);
  }

  /** Coalesce snapshot saves; each save captures the state at the time it runs. */
  #persist(): void {
    const storage = this.#storage;
    if (!storage || this.#savePending) return;
    this.#savePending = true;
    this.#saving = this.#saving
      .then(() => {
        this.#savePending = false;
        return storage.save(this.daemon.snapshot());
      })
      .catch((e: unknown) => this.#log(`snapshot save failed: ${String(e)}`));
  }
}
