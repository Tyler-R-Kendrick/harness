import { getRandomValues, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { chmod, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import type { AgentInfo, Daemon, Identity, SnapshotStorage } from "@harness/core";
import type { Ensemble } from "@harness/cognitive";
import { ERROR_CODES, failure } from "@harness/protocol";
import { DaemonRuntime } from "@harness/runtime";
import type { Worker } from "@harness/workers";
import { FileStorage } from "./file-storage.ts";
import { lineLimit } from "./line-limit.ts";

/** The subprotocol prefix a browser sends its token in. */
const PROTOCOL_TOKEN = "harness.token.";

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
  #webSockets: WebSocketServer | undefined;

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

  /**
   * Listen for ACP over WebSocket on this machine's loopback, one JSON-RPC message per text
   * frame. Every connection must present `token`: as an `Authorization: Bearer` header, or
   * (browsers cannot set headers) as the subprotocol `harness.token.<token>`. A browser
   * page is refused unless its origin is one of `origins`, so no web page can drive the daemon.
   */
  async listenWebSocket(options: { readonly port?: number; readonly token: string; readonly origins?: readonly string[] }): Promise<{ url: string; port: number }> {
    const expected = Buffer.from(options.token);
    // Compared as bytes: equal lengths in characters can differ in bytes, which timingSafeEqual refuses.
    const matches = (token: string | undefined) => {
      const got = Buffer.from(token ?? "");
      return token !== undefined && got.length === expected.length && timingSafeEqual(got, expected);
    };
    const offered = (req: IncomingMessage) =>
      (req.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((p) => p.trim())
        .find((p) => p.startsWith(PROTOCOL_TOKEN));
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: options.port ?? 0,
      maxPayload: this.#maxLineBytes,
      verifyClient: ({ req }, done) => {
        const origin = req.headers.origin;
        if (origin !== undefined && !(options.origins ?? []).includes(origin)) return done(false, 403, "origin not allowed");
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
        const token = bearer ?? offered(req)?.slice(PROTOCOL_TOKEN.length);
        done(matches(token), 401, "a token is required");
      },
      // Echo the token subprotocol a browser offered (its handshake requires one back).
      handleProtocols: (protocols) => [...protocols].find((p) => p.startsWith(PROTOCOL_TOKEN)) ?? false,
    });
    server.on("connection", (socket: WebSocket) => this.#attachWebSocket(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => resolve());
    });
    this.#webSockets = server;
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { url: `ws://127.0.0.1:${port}`, port };
  }

  #attachWebSocket(socket: WebSocket): void {
    const send = (message: object) => socket.send(JSON.stringify(message));
    const connection = this.runtime.connect(this.#identity, send);
    this.#closers.set(connection.id, () => socket.close(1001, "the daemon is shutting down"));
    socket.on("message", (data: Buffer, binary: boolean) => {
      if (binary) return send(failure(null, ERROR_CODES.invalidRequest, "binary frames are not ACP messages"));
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return send(failure(null, ERROR_CODES.parseError, "a frame is not JSON"));
      }
      connection.receive(message);
    });
    socket.on("close", () => {
      this.#closers.delete(connection.id);
      connection.disconnect();
    });
  }

  /** Stop accepting connections, let running turns finish, and flush state. */
  async close(): Promise<void> {
    clearInterval(this.#ticker);
    const server = this.#server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // The WebSocket server closes once its connections have: hang every connection up, then wait.
    const webSockets = this.#webSockets;
    const listening = webSockets ? new Promise<void>((resolve) => webSockets.close(() => resolve())) : undefined;
    for (const close of this.#closers.values()) close();
    await listening;
    await this.runtime.close();
    if (this.#socketPath !== undefined && process.platform !== "win32") await unlink(this.#socketPath).catch(() => {});
  }

}
