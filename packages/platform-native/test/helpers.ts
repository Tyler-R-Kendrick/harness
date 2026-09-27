import { connect } from "node:net";
import type { Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { AnyMessage } from "@agentclientprotocol/sdk";

export interface Msg {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Minimal raw ACP client over a Unix socket (the ACP SDK's NDJSON stream), for multi-client integration tests. */
export class RawClient {
  readonly received: Msg[] = [];
  readonly #socket: Socket;
  readonly #writer: WritableStreamDefaultWriter<AnyMessage>;
  #nextId = 1;
  #waiters: { match: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  private constructor(socket: Socket) {
    this.#socket = socket;
    const acp = ndJsonStream(Writable.toWeb(socket), Readable.toWeb(socket) as ReadableStream<Uint8Array>);
    this.#writer = acp.writable.getWriter();
    void (async () => {
      try {
        for await (const message of acp.readable) {
          const m = message as Msg;
          this.received.push(m);
          this.#waiters = this.#waiters.filter((w) => (w.match(m) ? (w.resolve(m), false) : true));
        }
      } catch {
        // the socket closed
      }
    })();
  }

  static connect(path: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path, () => resolve(new RawClient(socket)));
      socket.once("error", reject);
    });
  }

  waitFor(match: (m: Msg) => boolean, timeoutMs = 5_000): Promise<Msg> {
    const found = this.received.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), timeoutMs);
      this.#waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  async request(method: string, params: unknown = {}): Promise<Msg> {
    const id = this.#nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.waitFor((m) => m.id === id && m.method === undefined);
  }

  send(message: unknown): void {
    void this.#writer.write(message as AnyMessage).catch(() => undefined);
  }

  close(): void {
    this.#socket.destroy();
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
