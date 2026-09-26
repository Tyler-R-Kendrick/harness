import { randomUUID, getRandomValues } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { Daemon } from "@harness/core";
import type { AgentInfo, CognitiveWork, Identity, Output, SnapshotStorage, WorkerCommand } from "@harness/core";
import { invokeCognitive, mirrorCapabilities } from "@harness/cognitive";
import type { Ensemble } from "@harness/cognitive";
import { ERROR_CODES, failure } from "@harness/protocol";
import type { Worker } from "@harness/workers";
import { FileStorage } from "./file-storage.ts";
import { lineLimit } from "./line-limit.ts";

export interface NodeHostOptions {
  readonly worker: Worker;
  /** Trusted identity for local connections (the OS user who owns the socket). */
  readonly identity: Identity;
  readonly statePath?: string;
  readonly storage?: SnapshotStorage;
  readonly agentInfo?: AgentInfo;
  readonly flowCapacity?: number;
  readonly permissionTimeoutMs?: number;
  readonly tickMs?: number;
  /** The cognitive core's model ensemble; its tasks become `cognitive.*` capabilities. */
  readonly cognitive?: Ensemble;
  /** The longest ACP message line a peer may send, in bytes (default 16 MiB). */
  readonly maxLineBytes?: number;
}

interface ConnectionIo {
  readonly send: (message: object) => void;
  readonly close: () => void;
}

/**
 * Native platform layer: runs the portable daemon core in a Node process, binds ACP
 * to stdio or a user-private Unix socket, executes worker commands and persists
 * snapshots after every change.
 */
export class NodeHost {
  readonly daemon: Daemon;
  readonly #worker: Worker;
  readonly #identity: Identity;
  readonly #storage: SnapshotStorage | undefined;
  readonly #ensemble: Ensemble | undefined;
  readonly #stopMirror: () => void;
  readonly #connections = new Map<string, ConnectionIo>();
  readonly #turns = new Set<Promise<void>>();
  readonly #ticker: ReturnType<typeof setInterval>;
  readonly #maxLineBytes: number;
  #server: Server | undefined;
  #socketPath: string | undefined;
  #saving: Promise<void> = Promise.resolve();
  #savePending = false;

  private constructor(daemon: Daemon, options: NodeHostOptions, storage: SnapshotStorage | undefined) {
    this.daemon = daemon;
    this.#worker = options.worker;
    this.#identity = options.identity;
    this.#storage = storage;
    this.#ensemble = options.cognitive;
    this.#maxLineBytes = options.maxLineBytes ?? 16 * 1024 * 1024;
    this.#stopMirror = this.#ensemble
      ? mirrorCapabilities(this.#ensemble, {
          offer: (name) => this.daemon.offerPlatformCapability({ name, version: 1, trust: "trusted" }),
          withdraw: (name) => this.daemon.withdrawPlatformCapability(name),
        })
      : () => {};
    this.#ticker = setInterval(() => this.#apply(this.daemon.tick()), options.tickMs ?? 1_000);
    this.#ticker.unref();
  }

  static async start(options: NodeHostOptions): Promise<NodeHost> {
    const storage = options.storage ?? (options.statePath === undefined ? undefined : new FileStorage(options.statePath));
    const deps = {
      clock: { now: () => Date.now() },
      entropy: { bytes: (n: number) => getRandomValues(new Uint8Array(n)) },
      agentInfo: options.agentInfo ?? { name: "harness", version: "0.0.0" },
      ...(options.flowCapacity === undefined ? {} : { flowCapacity: options.flowCapacity }),
      ...(options.permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs: options.permissionTimeoutMs }),
    };
    const snapshot = await storage?.load();
    const daemon = snapshot === undefined ? new Daemon(deps) : Daemon.restore(snapshot, deps);
    const host = new NodeHost(daemon, options, storage);
    if (snapshot !== undefined) host.#persist(); // record interrupted turns promptly
    return host;
  }

  /**
   * Bind one ACP connection to a byte stream pair (stdio, a socket, a pipe). Framing is
   * the ACP SDK's NDJSON stream (a line that is not JSON gets a parse error from it);
   * each message goes to the daemon core, which multiplexes every connection.
   */
  attach(input: Readable, output: Writable, close: () => void = () => output.end(), identity: Identity = this.#identity): string {
    const id = `c-${randomUUID()}`;
    const bytes = Readable.toWeb(input) as ReadableStream<Uint8Array>;
    const acp = ndJsonStream(Writable.toWeb(output), bytes.pipeThrough(lineLimit(this.#maxLineBytes, () => send(failure(null, ERROR_CODES.invalidRequest, `message line exceeds ${this.#maxLineBytes} bytes`)))));
    const writer = acp.writable.getWriter();
    const send = (message: object) => void writer.write(message as AnyMessage).catch(() => undefined);
    this.#connections.set(id, { send, close });
    this.daemon.connect(id, identity);
    void (async () => {
      try {
        for await (const message of acp.readable) this.#apply(this.daemon.receive(id, message));
      } catch {
        // the peer's stream failed; treat it as a disconnect
      }
      if (!this.#connections.delete(id)) return;
      this.#apply(this.daemon.disconnect(id));
    })();
    return id;
  }

  /** Listen on a Unix socket (or Windows named pipe) readable only by the owning user. */
  async listen(path: string): Promise<void> {
    await unlink(path).catch(() => {});
    const server = createServer((socket: Socket) => this.attach(socket, socket, () => socket.destroy()));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => resolve());
    });
    if (process.platform !== "win32") await chmod(path, 0o600);
    this.#server = server;
    this.#socketPath = path;
  }

  /** Stop accepting connections, let running turns finish, and flush state. */
  async close(): Promise<void> {
    clearInterval(this.#ticker);
    this.#stopMirror();
    const server = this.#server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const io of this.#connections.values()) io.close();
    await Promise.allSettled([...this.#turns]);
    this.#persist();
    await this.#saving;
    if (this.#socketPath !== undefined && process.platform !== "win32") await unlink(this.#socketPath).catch(() => {});
  }

  #apply(outputs: Output[]): void {
    for (const o of outputs) {
      if (o.kind === "send") this.#write(o.connectionId, o.message);
      else if (o.kind === "cognitive") this.#think(o.work);
      else this.#dispatch(o.command);
    }
    if (outputs.length > 0) this.#persist();
  }

  #dispatch(command: WorkerCommand): void {
    if (command.type === "cancel") this.#worker.cancel(command.sessionId, command.turnId);
    else if (command.type === "permission") this.#worker.permission(command);
    else if (command.type === "event") this.#worker.event?.(command, (event) => this.#apply(this.daemon.workerEvent(event)));
    else {
      const turn = this.#worker
        .run(command, (event) => this.#apply(this.daemon.workerEvent(event)))
        .catch((e: unknown) => {
          process.stderr.write(`worker failed: ${e instanceof Error ? e.stack : String(e)}\n`);
          this.#apply(this.daemon.workerEvent({ type: "end", sessionId: command.sessionId, turnId: command.turnId, stopReason: "refusal" }));
        })
        .finally(() => this.#turns.delete(turn));
      this.#turns.add(turn);
    }
  }

  /** Run cognitive work on the ensemble and report the result to the daemon. */
  #think(work: CognitiveWork): void {
    const ensemble = this.#ensemble;
    const job = (ensemble ? invokeCognitive(ensemble, work.op, work.input) : Promise.reject(new Error("the cognitive core is not enabled on this host (start with --cognitive)")))
      .then(
        (value) => this.#apply(this.daemon.cognitiveResult(work.requestId, { ok: true, value })),
        (e: unknown) => this.#apply(this.daemon.cognitiveResult(work.requestId, { ok: false, message: e instanceof Error ? e.message : String(e) })),
      )
      .finally(() => this.#turns.delete(job));
    this.#turns.add(job);
  }

  #write(connectionId: string, message: object): void {
    this.#connections.get(connectionId)?.send(message);
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
      .catch((e: unknown) => {
        process.stderr.write(`snapshot save failed: ${String(e)}\n`);
      });
  }
}
