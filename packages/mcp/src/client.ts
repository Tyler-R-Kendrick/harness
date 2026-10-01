import { spawn } from "node:child_process";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ClientCapabilities, ProgressCallback, Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { EXTENSIONS, META, PROTOCOL_VERSION } from "./constants.ts";
import { textOf, withResultType } from "./results.ts";

const Loose = z.looseObject({});

export interface ClientConnectOptions {
  name?: string;
  version?: string;
  /** When omitted, tasks, skills, apps, and events are negotiated. */
  capabilities?: ClientCapabilities;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export function negotiatedCapabilities(include: {
  tasks?: boolean;
  skills?: boolean;
  ui?: boolean;
  events?: boolean;
} = {}): ClientCapabilities {
  const tasks = include.tasks ?? true;
  const skills = include.skills ?? true;
  const ui = include.ui ?? true;
  const events = include.events ?? true;
  const extensions: Record<string, Record<string, never> | { mimeTypes: string[] } | { listChanged: boolean }> = {};
  if (tasks) extensions[EXTENSIONS.tasks] = {};
  if (skills) extensions[EXTENSIONS.skills] = {};
  if (ui) extensions[EXTENSIONS.ui] = { mimeTypes: ["text/html;profile=mcp-app"] };
  if (events) extensions[EXTENSIONS.events] = { listChanged: true };
  return { extensions, elicitation: { form: {} } } as ClientCapabilities;
}

function rpcError(error: unknown): Error | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined;
  const data = error.data;
  if (!data || typeof data !== "object" || !("text" in data) || typeof data.text !== "string") return undefined;
  try {
    const parsed = JSON.parse(data.text) as { error?: { code?: number; message?: string } };
    if (!parsed.error || typeof parsed.error.code !== "number") return undefined;
    const wrapped = new Error(parsed.error.message ?? "JSON-RPC error");
    return Object.assign(wrapped, { code: parsed.error.code });
  } catch {
    return undefined;
  }
}

function isDroppedStream(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  return /terminated|socket|ECONNRESET|other side closed|fetch failed|network|incomplete|aborted/i.test(message);
}

export class HarnessClient {
  private readonly sdk: Client;
  constructor(sdk: Client) {
    this.sdk = sdk;
  }

  async discover(): Promise<Record<string, unknown> & { resultType: string }> {
    const result = await this.sdk.discover();
    return withResultType(result as unknown as Record<string, unknown>);
  }

  listTools(): ReturnType<Client["listTools"]> {
    return this.sdk.listTools();
  }

  listResources(): ReturnType<Client["listResources"]> {
    return this.sdk.listResources();
  }

  listPrompts(): ReturnType<Client["listPrompts"]> {
    return this.sdk.listPrompts();
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: {
      onprogress?: ProgressCallback;
      logLevel?: string;
      allowInputRequired?: boolean;
      inputResponses?: Record<string, unknown>;
      /** Retry once when the response stream drops. Only for tools safe to run twice: a dropped response does not prove the first call never ran. */
      idempotent?: boolean;
    } = {},
  ): Promise<unknown> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (options.inputResponses) params["inputResponses"] = options.inputResponses;
    if (options.logLevel) params["_meta"] = { [META.logLevel]: options.logLevel };
    const send = (): Promise<unknown> =>
      this.sdk.callTool(params as { name: string; arguments: Record<string, unknown> }, {
        ...(options.onprogress ? { onprogress: options.onprogress } : {}),
        ...(options.allowInputRequired ? { allowInputRequired: true } : {}),
      });
    try {
      return await send();
    } catch (error) {
      if (!options.idempotent || !isDroppedStream(error)) throw error;
      return await send();
    }
  }

  readResource(uri: string): ReturnType<Client["readResource"]> {
    return this.sdk.readResource({ uri });
  }

  listen(filter: { toolsListChanged?: boolean }): ReturnType<Client["listen"]> {
    return this.sdk.listen(filter);
  }

  onNotification(method: string, handler: (params: Record<string, unknown>) => void): void {
    const deliver = (value: unknown): void => {
      if (value && typeof value === "object" && "params" in value && value.params && typeof value.params === "object") {
        handler(value.params as Record<string, unknown>);
        return;
      }
      handler((value ?? {}) as Record<string, unknown>);
    };
    if (method.startsWith("notifications/events/")) {
      this.sdk.setNotificationHandler(method, { params: Loose }, deliver);
      return;
    }
    this.sdk.setNotificationHandler(method as "notifications/progress", deliver as never);
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return withResultType((await this.sdk.request({ method, params }, Loose)) as Record<string, unknown>);
    } catch (error) {
      const rpc = rpcError(error);
      if (rpc) throw rpc;
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.sdk.close();
  }
}

/** Tasks stay an extension on 2026-07-28; the SDK still treats `tasks/*` as removed 2025 vocabulary. */
function allowTaskMethods(sdk: Client): void {
  const client = sdk as unknown as {
    _assertOutboundRequestInEra: (codec: { hasRequestMethod: (method: string) => boolean }, method: string) => void;
  };
  const original = client._assertOutboundRequestInEra.bind(client);
  client._assertOutboundRequestInEra = (codec, method) => {
    if (method.startsWith("tasks/")) return;
    original(codec, method);
  };
}

async function connect(transport: Transport, options: ClientConnectOptions): Promise<HarnessClient> {
  const sdk = new Client(
    { name: options.name ?? "harness", version: options.version ?? "0.0.0" },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  allowTaskMethods(sdk);
  sdk.registerCapabilities(options.capabilities ?? negotiatedCapabilities());
  await sdk.connect(transport);
  return new HarnessClient(sdk);
}

export function connectStdio(
  server: { command: string; args: string[]; env?: NodeJS.ProcessEnv },
  options: ClientConnectOptions = {},
): Promise<HarnessClient> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.env ?? process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env["NODE_OPTIONS"] = env["NODE_OPTIONS"] ?? "--max-old-space-size=8192";
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env, stderr: "pipe" });
  return connect(transport, options);
}

export function connectHttp(url: string, options: ClientConnectOptions = {}): Promise<HarnessClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    ...(options.headers ? { requestInit: { headers: options.headers } } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return connect(transport, options);
}

export async function readRpc(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Record<string, unknown>;
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if ("result" in parsed || "error" in parsed) return parsed;
  }
  throw new Error(trimmed.slice(0, 300));
}

/** Send one discover with an explicit protocol version and return the JSON-RPC error code. */
export async function probeProtocolVersion(
  target: { url: string } | { command: string; args: string[] },
  version: string,
): Promise<number> {
  const message = {
    jsonrpc: "2.0",
    id: "probe-1",
    method: "server/discover",
    params: {
      _meta: {
        [META.protocolVersion]: version,
        [META.clientCapabilities]: {},
        [META.clientInfo]: { name: "probe", version: "0.0.0" },
      },
    },
  };
  if ("url" in target) {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": version,
        "mcp-method": "server/discover",
      },
      body: JSON.stringify(message),
    });
    const body = await readRpc(response);
    const error = body["error"];
    if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "number") {
      throw new Error(`expected an error, got ${JSON.stringify(body).slice(0, 300)}`);
    }
    return error.code;
  }
  const child = spawn(target.command, target.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" },
  });
  const line = new Promise<string>((resolve, reject) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) resolve(buffer.slice(0, newline));
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`probe process exited ${code}`)));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    const parsed = JSON.parse(await line) as { error?: { code?: number } };
    if (typeof parsed.error?.code !== "number") throw new Error("probe response had no error code");
    return parsed.error.code;
  } finally {
    child.kill();
  }
}

export { textOf };
