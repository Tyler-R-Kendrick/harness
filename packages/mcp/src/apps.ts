import { UI_PROTOCOL_VERSION } from "./constants.ts";

export interface SandboxFrame {
  /** Iframe sandbox tokens. Scripts may run; the frame is not same-origin with the host. */
  readonly sandbox: string;
  readonly srcdoc: string;
}

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

type CallTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Host side of an MCP App. The frame is sandboxed and talks JSON-RPC over a MessagePort. */
export class AppHost {
  readonly frame: SandboxFrame;
  private port: MessagePort | undefined;
  private readonly tools: { callTool: CallTool };

  constructor(html: string, tools: { callTool: CallTool }) {
    this.tools = tools;
    this.frame = { sandbox: "allow-scripts", srcdoc: html };
  }

  attach(port: MessagePort): void {
    this.port = port;
    port.onmessage = (event: { data: RpcRequest }) => {
      void this.onMessage(event.data);
    };
    port.start();
  }

  private async onMessage(message: RpcRequest): Promise<void> {
    if (!message || message.jsonrpc !== "2.0" || typeof message.id !== "number") return;
    if (message.method === "ui/initialize") {
      this.reply(message.id, {
        protocolVersion: UI_PROTOCOL_VERSION,
        hostInfo: { name: "harness", version: "0.0.0" },
        hostCapabilities: {},
      });
      return;
    }
    if (message.method === "tools/call") {
      const params = message.params;
      const name = params && typeof params === "object" && "name" in params && typeof params.name === "string" ? params.name : "";
      const args =
        params && typeof params === "object" && "arguments" in params && params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const result = await this.tools.callTool(name, args);
        this.reply(message.id, result);
      } catch (error) {
        // A throwing tool is an error reply, not a dropped message: the guest's request must settle.
        this.fail(message.id, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private reply(id: number, result: unknown): void {
    this.port?.postMessage({ jsonrpc: "2.0", id, result } satisfies RpcResponse);
  }

  private fail(id: number, message: string): void {
    this.port?.postMessage({ jsonrpc: "2.0", id, error: { code: -32603, message } } satisfies RpcResponse);
  }
}

/** Guest side of an MCP App. It speaks the same postMessage channel as a sandboxed frame. */
export class AppView {
  private port: MessagePort | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly appInfo: { name: string; version: string };

  constructor(appInfo: { name: string; version: string }) {
    this.appInfo = appInfo;
  }

  attach(port: MessagePort): void {
    this.port = port;
    port.onmessage = (event: { data: RpcResponse }) => {
      const message = event.data;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    };
    port.start();
  }

  initialize(): Promise<unknown> {
    return this.request("ui/initialize", {
      protocolVersion: UI_PROTOCOL_VERSION,
      appInfo: this.appInfo,
      appCapabilities: {},
    });
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const port = this.port;
    if (!port) return Promise.reject(new Error("App view is not attached"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      port.postMessage({ jsonrpc: "2.0", id, method, params } satisfies RpcRequest);
    });
  }
}
