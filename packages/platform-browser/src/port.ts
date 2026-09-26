import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import type { DaemonLink } from "@harness/client";

/**
 * The part of a `MessagePort` ACP travels over: one port per connection, one
 * structured message per JSON-RPC message (no framing).
 */
export interface AcpPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message" | "close", listener: (event: { readonly data?: unknown }) => void): void;
  start(): void;
  close(): void;
}

/** The part of the Web Locks API (`navigator.locks`) liveness needs. */
export interface Locks {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}

/**
 * Messages about the port itself, beside ACP's (never JSON-RPC, so they cannot clash).
 * A port has no reliable close event across browsers, so the end that hangs up says
 * so; and since a tab can die without saying anything, a client holds a Web Lock for
 * as long as it lives and names it, and the host waits on that lock.
 */
export const PORT_CONTROL = "_harness/port";
export type PortControl = { readonly [PORT_CONTROL]: "close" } | { readonly [PORT_CONTROL]: "alive"; readonly lock: string };

export function portControl(data: unknown): PortControl | undefined {
  if (typeof data !== "object" || data === null || !(PORT_CONTROL in data)) return undefined;
  const control = data as Record<string, unknown>;
  if (control[PORT_CONTROL] === "close") return { [PORT_CONTROL]: "close" };
  if (control[PORT_CONTROL] === "alive" && typeof control["lock"] === "string") return { [PORT_CONTROL]: "alive", lock: control["lock"] };
  return undefined;
}

/** The context's Web Locks, where it has them. */
export function ambientLocks(): Locks | undefined {
  return (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;
}

function lockName(): string {
  return `harness-port-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** An ACP SDK `Stream` over a port, and a way to hang up (the SDK's connections hold its ends). */
export type PortStream = Stream & { hangUp(): void };

/**
 * ACP messages over a port, as the ACP SDK's `Stream`: for a client in a tab, or for
 * `daemonHarness`. Hanging up (or closing the stream's ends) tells the other end; with
 * Web Locks (the context's, by default) the host also learns when this context dies
 * without hanging up.
 */
export function portStream(port: AcpPort, options: { readonly locks?: Locks | undefined } = {}): PortStream {
  const locks = "locks" in options ? options.locks : ambientLocks();
  let closed = false;
  let release = () => {};
  let reading: ReadableStreamDefaultController<AnyMessage> | undefined;
  const end = () => {
    if (closed) return;
    closed = true;
    release();
    reading?.close();
  };
  const hangUp = () => {
    if (closed) return;
    port.postMessage({ [PORT_CONTROL]: "close" });
    port.close();
    end();
  };
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      reading = controller;
      port.addEventListener("message", (event) => {
        if (closed) return;
        if (portControl(event.data)?.[PORT_CONTROL] === "close") {
          port.close();
          end();
        } else controller.enqueue(event.data as AnyMessage);
      });
      port.addEventListener("close", end);
      port.start();
    },
    cancel: () => {
      // A cancelled stream is already closed for its reader.
      reading = undefined;
      hangUp();
    },
  });
  const writable = new WritableStream<AnyMessage>({
    write(message) {
      if (closed) throw new Error("the port is closed");
      port.postMessage(message);
    },
    close: hangUp,
    abort: hangUp,
  });
  if (locks) {
    const lock = lockName();
    void locks.request(lock, () =>
      new Promise<void>((resolve) => {
        release = resolve;
        if (closed) resolve();
        else port.postMessage({ [PORT_CONTROL]: "alive", lock });
      }),
    );
  }
  return { readable, writable, hangUp };
}

/** A daemon reached over a port, for `daemonHarness({ connect })`. */
export function daemonPort(port: AcpPort, options: { readonly locks?: Locks | undefined } = {}): DaemonLink {
  const stream = portStream(port, options);
  return { stream, close: stream.hangUp };
}
