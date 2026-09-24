import { randomUUID, getRandomValues } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { Daemon } from "@harness/core";
import type { AgentInfo, Identity, Output, SnapshotStorage, WorkerCommand } from "@harness/core";
import { ERROR_CODES, NdjsonDecoder, encodeFrame, failure } from "@harness/protocol";
import type { Worker } from "@harness/workers";
import { FileStorage } from "./file-storage.ts";

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
}

interface ConnectionIo {
  readonly output: Writable;
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
  readonly #connections = new Map<string, ConnectionIo>();
  readonly #turns = new Set<Promise<void>>();
  readonly #ticker: ReturnType<typeof setInterval>;
  #server: Server | undefined;
  #socketPath: string | undefined;
  #saving: Promise<void> = Promise.resolve();
  #savePending = false;

  private constructor(daemon: Daemon, options: NodeHostOptions, storage: SnapshotStorage | undefined) {
    this.daemon = daemon;
    this.#worker = options.worker;
    this.#identity = options.identity;
    this.#storage = storage;
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

  /** Bind one ACP connection to a byte stream pair (stdio, a socket, a pipe). */
  attach(input: Readable, output: Writable, close: () => void = () => output.end(), identity: Identity = this.#identity): string {
    const id = `c-${randomUUID()}`;
    this.#connections.set(id, { output, close });
    this.daemon.connect(id, identity);
    const text = new TextDecoder();
    const framer = new NdjsonDecoder();
    const handle = (results: ReturnType<NdjsonDecoder["push"]>) => {
      for (const r of results) {
        if (r.kind === "message") this.#apply(this.daemon.receive(id, r.value));
        else this.#write(id, failure(null, r.code === "parse_error" ? ERROR_CODES.parseError : ERROR_CODES.invalidRequest, r.detail));
      }
    };
    input.on("data", (chunk: Buffer) => handle(framer.push(text.decode(chunk, { stream: true }))));
    const end = () => {
      if (!this.#connections.has(id)) return;
      handle(framer.push(text.decode()));
      handle(framer.end());
      this.#connections.delete(id);
      this.#apply(this.daemon.disconnect(id));
    };
    input.on("end", end);
    input.on("close", end);
    input.on("error", end);
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
      else this.#dispatch(o.command);
    }
    if (outputs.length > 0) this.#persist();
  }

  #dispatch(command: WorkerCommand): void {
    if (command.type === "cancel") this.#worker.cancel(command.sessionId, command.turnId);
    else if (command.type === "permission") this.#worker.permission(command);
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

  #write(connectionId: string, message: object): void {
    const io = this.#connections.get(connectionId);
    if (io?.output.writable) io.output.write(encodeFrame(message));
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
