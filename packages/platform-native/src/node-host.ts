import { getRandomValues } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import type { AgentInfo, Daemon, Identity, SnapshotStorage } from "@harness/core";
import type { Ensemble } from "@harness/cognitive";
import { ERROR_CODES, failure } from "@harness/protocol";
import { DaemonRuntime } from "@harness/runtime";
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

/**
 * Native platform layer: runs the portable daemon runtime in a Node process, binds ACP
 * to stdio or a user-private Unix socket, and persists snapshots to a file.
 */
export class NodeHost {
  readonly runtime: DaemonRuntime;
  readonly #identity: Identity;
  readonly #closers = new Map<string, () => void>();
  readonly #ticker: ReturnType<typeof setInterval>;
  readonly #maxLineBytes: number;
  #server: Server | undefined;
  #socketPath: string | undefined;

  private constructor(runtime: DaemonRuntime, options: NodeHostOptions) {
    this.runtime = runtime;
    this.#identity = options.identity;
    this.#maxLineBytes = options.maxLineBytes ?? 16 * 1024 * 1024;
    this.#ticker = setInterval(() => runtime.tick(), options.tickMs ?? 1_000);
    this.#ticker.unref();
  }

  get daemon(): Daemon {
    return this.runtime.daemon;
  }

  static async start(options: NodeHostOptions): Promise<NodeHost> {
    const storage = options.storage ?? (options.statePath === undefined ? undefined : new FileStorage(options.statePath));
    const runtime = await DaemonRuntime.start({
      ...options,
      clock: { now: () => Date.now() },
      entropy: { bytes: (n: number) => getRandomValues(new Uint8Array(n)) },
      log: (message) => process.stderr.write(`${message}\n`),
      cognitiveOff: "start with --cognitive",
      ...(storage === undefined ? {} : { storage }),
    });
    return new NodeHost(runtime, options);
  }

  /**
   * Bind one ACP connection to a byte stream pair (stdio, a socket, a pipe). Framing is
   * the ACP SDK's NDJSON stream (a line that is not JSON gets a parse error from it);
   * each message goes to the daemon runtime, which multiplexes every connection.
   */
  attach(input: Readable, output: Writable, close: () => void = () => output.end(), identity: Identity = this.#identity): string {
    const bytes = Readable.toWeb(input) as ReadableStream<Uint8Array>;
    const acp = ndJsonStream(Writable.toWeb(output), bytes.pipeThrough(lineLimit(this.#maxLineBytes, () => send(failure(null, ERROR_CODES.invalidRequest, `message line exceeds ${this.#maxLineBytes} bytes`)))));
    const writer = acp.writable.getWriter();
    const send = (message: object) => void writer.write(message as AnyMessage).catch(() => undefined);
    const connection = this.runtime.connect(identity, send);
    this.#closers.set(connection.id, close);
    void (async () => {
      try {
        for await (const message of acp.readable) connection.receive(message);
      } catch {
        // the peer's stream failed; treat it as a disconnect
      }
      this.#closers.delete(connection.id);
      connection.disconnect();
    })();
    return connection.id;
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
    for (const close of this.#closers.values()) close();
    await this.runtime.close();
    if (this.#socketPath !== undefined && process.platform !== "win32") await unlink(this.#socketPath).catch(() => {});
  }
}
