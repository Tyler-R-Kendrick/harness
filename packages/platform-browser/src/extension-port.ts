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
 * which extensions report reliably.
 */
export function extensionPort(port: ExtensionPort): AcpPort {
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
    addEventListener: (type, listener) => {
      if (type === "message") port.onMessage.addListener((data) => listener({ data }));
      else port.onDisconnect.addListener(() => listener({}));
    },
    start: () => {},
    close: () => port.disconnect(),
  };
}
