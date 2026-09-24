import type { Daemon, Identity, Output, WorkerCommand, WorkerEvent } from "@harness/core";

interface Envelope {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Drives a sans-I/O daemon in tests and collects what it sends to each connection. */
export class DaemonDriver {
  readonly daemon: Daemon;
  #inboxes = new Map<string, Envelope[]>();
  #commands: WorkerCommand[] = [];
  #nextId = 1;

  constructor(daemon: Daemon) {
    this.daemon = daemon;
  }

  connect(connectionId: string, identity: Identity): void {
    this.daemon.connect(connectionId, identity);
    this.#inboxes.set(connectionId, []);
  }

  disconnect(connectionId: string): void {
    this.#collect(this.daemon.disconnect(connectionId));
  }

  /** Send a raw message; returns nothing, outputs are collected. */
  send(connectionId: string, message: unknown): void {
    this.#collect(this.daemon.receive(connectionId, message));
  }

  /** Send a request and return its response (result or error envelope). */
  request(connectionId: string, method: string, params?: unknown): Envelope {
    const id = this.#nextId++;
    this.send(connectionId, params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
    const inbox = this.#inboxes.get(connectionId) ?? [];
    const i = inbox.findIndex((m) => m.id === id && m.method === undefined);
    if (i === -1) throw new Error(`no response to ${method}`);
    return inbox.splice(i, 1)[0]!;
  }

  notify(connectionId: string, method: string, params?: unknown): void {
    this.send(connectionId, params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  /** Initialize a connection, optionally advertising the `_harness` profile. */
  initialize(connectionId: string, harness = false): Envelope {
    return this.request(connectionId, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      ...(harness ? { _meta: { harness: { profileVersion: 1 } } } : {}),
    });
  }

  worker(event: WorkerEvent): void {
    this.#collect(this.daemon.workerEvent(event));
  }

  tick(): void {
    this.#collect(this.daemon.tick());
  }

  /** Drain messages delivered to a connection. */
  inbox(connectionId: string): Envelope[] {
    const messages = this.#inboxes.get(connectionId) ?? [];
    this.#inboxes.set(connectionId, []);
    return messages;
  }

  /** Drain worker commands. */
  commands(): WorkerCommand[] {
    const out = this.#commands;
    this.#commands = [];
    return out;
  }

  #collect(outputs: Output[]): void {
    for (const o of outputs) {
      if (o.kind === "worker") this.#commands.push(o.command);
      else this.#inboxes.get(o.connectionId)?.push(o.message as Envelope);
    }
  }
}
