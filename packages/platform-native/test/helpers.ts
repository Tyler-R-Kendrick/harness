import { connect } from "node:net";
import type { Socket } from "node:net";
import { NdjsonDecoder, encodeFrame } from "@harness/protocol";

export interface Msg {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Minimal raw ACP client over a Unix socket, for multi-client integration tests. */
export class RawClient {
  readonly received: Msg[] = [];
  readonly #socket: Socket;
  #nextId = 1;
  #waiters: { match: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  private constructor(socket: Socket) {
    this.#socket = socket;
    const decoder = new TextDecoder();
    const framer = new NdjsonDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const r of framer.push(decoder.decode(chunk, { stream: true }))) {
        if (r.kind !== "message") continue;
        const m = r.value as Msg;
        this.received.push(m);
        this.#waiters = this.#waiters.filter((w) => (w.match(m) ? (w.resolve(m), false) : true));
      }
    });
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
    this.#socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
    return this.waitFor((m) => m.id === id && m.method === undefined);
  }

  send(message: unknown): void {
    this.#socket.write(encodeFrame(message));
  }

  close(): void {
    this.#socket.destroy();
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
