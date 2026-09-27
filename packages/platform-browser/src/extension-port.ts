import type { AcpPort } from "./port.ts";

/** The part of a browser extension's `chrome.runtime.Port` ACP travels over. */
export interface ExtensionPort {
  readonly name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
}

/** Where an extension's runtime ports arrive (`chrome.runtime.onConnect`). */
export interface ExtensionPortSource {
  addListener(listener: (port: ExtensionPort) => void): void;
}

/**
 * An extension's runtime port as a port ACP travels over: its messages are message
 * events, and its other end disconnecting (a page closing, a worker ending) is a close,
 * which extensions report reliably. Chrome drops a runtime port's messages while nothing
 * listens, so this listens from the start and holds what arrives until `start()`, as a
 * `MessagePort` does: a page may speak while the service worker's daemon is still
 * starting.
 */
export function extensionPort(port: ExtensionPort): AcpPort {
  type Event = { readonly type: "message"; readonly data: unknown } | { readonly type: "close" };
  const listeners: { readonly type: Event["type"]; readonly listener: (event: { readonly data?: unknown }) => void }[] = [];
  let held: Event[] | undefined = [];
  const deliver = (event: Event) => {
    for (const l of listeners) if (l.type === event.type) l.listener(event.type === "message" ? { data: event.data } : {});
  };
  const arrive = (event: Event) => (held ? held.push(event) : deliver(event));
  port.onMessage.addListener((data) => arrive({ type: "message", data }));
  port.onDisconnect.addListener(() => arrive({ type: "close" }));
  return {
    // A port whose other end is gone throws on posting (a MessagePort drops it): its
    // disconnect is on the way, so drop the message rather than throw into the daemon.
    postMessage: (message) => {
      try {
        port.postMessage(message);
      } catch {
        // disconnected
      }
    },
    addEventListener: (type, listener) => void listeners.push({ type, listener }),
    start: () => {
      const early = held ?? [];
      held = undefined;
      early.forEach(deliver);
    },
    close: () => port.disconnect(),
  };
}
