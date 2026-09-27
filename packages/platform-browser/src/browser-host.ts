import type { AgentInfo, Daemon, Identity, SnapshotStorage } from "@harness/core";
import type { Ensemble } from "@harness/cognitive";
import { DaemonRuntime } from "@harness/runtime";
import type { Worker } from "@harness/workers";
import { extensionPort } from "./extension-port.ts";
import type { ExtensionPort, ExtensionPortSource } from "./extension-port.ts";
import { ambientLocks, PORT_CONTROL, portControl } from "./port.ts";
import type { AcpPort, Locks } from "./port.ts";

export interface BrowserHostOptions {
  readonly worker: Worker;
  /** The identity of connections the host accepts (the browser profile's user). */
  readonly identity: Identity;
  /** Where snapshots persist (an `IndexedDbStorage`); without one the daemon lives in memory. */
  readonly storage?: SnapshotStorage;
  readonly agentInfo?: AgentInfo;
  readonly flowCapacity?: number;
  readonly permissionTimeoutMs?: number;
  readonly tickMs?: number;
  /** The cognitive core's model ensemble; its tasks become `cognitive.*` capabilities. */
  readonly cognitive?: Ensemble;
  readonly log?: (message: string) => void;
  /** Web Locks, to learn when a client's context dies without hanging up (default: the context's). */
  readonly locks?: Locks | undefined;
}

/** Where ports arrive: a shared worker's global scope (`connect` events carry them). */
export interface PortSource {
  addEventListener(type: "connect", listener: (event: { readonly ports: readonly AcpPort[] }) => void): void;
}

/**
 * Browser platform layer: runs the portable daemon runtime in a tab, a PWA, a shared
 * worker or an extension's background, with ACP over `MessagePort`s (one per
 * connection), time from `Date.now`, entropy from Web Crypto and snapshots wherever
 * `storage` keeps them (IndexedDB).
 */
export class BrowserHost {
  readonly runtime: DaemonRuntime;
  readonly #identity: Identity;
  readonly #ticker: ReturnType<typeof setInterval>;
  readonly #ports = new Map<string, AcpPort>();
  readonly #locks: Locks | undefined;

  private constructor(runtime: DaemonRuntime, options: BrowserHostOptions) {
    this.runtime = runtime;
    this.#identity = options.identity;
    this.#locks = "locks" in options ? options.locks : ambientLocks();
    this.#ticker = setInterval(() => runtime.tick(), options.tickMs ?? 1_000);
  }

  get daemon(): Daemon {
    return this.runtime.daemon;
  }

  static async start(options: BrowserHostOptions): Promise<BrowserHost> {
    const runtime = await DaemonRuntime.start({
      log: (message) => console.error(message),
      ...options,
      clock: { now: () => Date.now() },
      entropy: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
      cognitiveOff: "give the browser host an ensemble",
    });
    return new BrowserHost(runtime, options);
  }

  /**
   * Accept one ACP connection on a port. It ends when either end hangs up (says so, or
   * the port closes where ports report that) or when the client's context dies (its
   * Web Lock is released).
   */
  accept(port: AcpPort, identity: Identity = this.#identity): string {
    const connection = this.runtime.connect(identity, (message) => port.postMessage(message));
    const id = connection.id;
    this.#ports.set(id, port);
    const hangUp = () => {
      if (this.#ports.delete(id)) connection.disconnect();
    };
    port.addEventListener("message", (event) => {
      const control = portControl(event.data);
      if (control === undefined) connection.receive(event.data);
      else if (control[PORT_CONTROL] === "close") hangUp();
      else void this.#locks?.request(control.lock, async () => hangUp());
    });
    port.addEventListener("close", hangUp);
    port.start();
    return id;
  }

  /**
   * Start a host that accepts every port arriving from `source` (in a shared worker:
   * `self`), including ports that arrive while it starts: a shared worker's first
   * `connect` comes as soon as its script runs.
   */
  static serve(source: PortSource, options: BrowserHostOptions): Promise<BrowserHost> {
    return BrowserHost.#serving((accept) => source.addEventListener("connect", (event) => event.ports.forEach(accept)), options);
  }

  /**
   * Start a host in an extension's background (its service worker) that accepts every
   * runtime port named `portName` (default `acp`) from `onConnect`
   * (`chrome.runtime.onConnect`), including ports that connect while it starts.
   */
  static serveExtension(onConnect: ExtensionPortSource, options: BrowserHostOptions & { readonly portName?: string }): Promise<BrowserHost> {
    const name = options.portName ?? "acp";
    return BrowserHost.#serving((accept) => onConnect.addListener((port: ExtensionPort) => (port.name === name ? accept(extensionPort(port)) : undefined)), options);
  }

  /** Start a host, taking ports from `subscribe` at once and queueing those that arrive before it is up. */
  static #serving(subscribe: (accept: (port: AcpPort) => void) => void, options: BrowserHostOptions): Promise<BrowserHost> {
    const early: AcpPort[] = [];
    let accept = (port: AcpPort) => void early.push(port);
    subscribe((port) => accept(port));
    return BrowserHost.start(options).then((host) => {
      accept = (port) => void host.accept(port);
      for (const port of early.splice(0)) accept(port);
      return host;
    });
  }

  /** Hang up every connection, let running turns finish, and flush state. */
  async close(): Promise<void> {
    clearInterval(this.#ticker);
    for (const port of this.#ports.values()) {
      port.postMessage({ [PORT_CONTROL]: "close" });
      port.close();
    }
    this.#ports.clear();
    await this.runtime.close();
  }
}
