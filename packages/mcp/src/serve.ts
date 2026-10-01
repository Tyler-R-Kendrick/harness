import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Transform, type Readable, type Writable } from "node:stream";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createHandler, createHarnessServer, type SharedState, createSharedState } from "./runtime.ts";

export interface ResourceProtection {
  /** Issuer of the authorization server this resource trusts. */
  authorizationServer: string;
  verifyToken: (token: string) => { clientId: string; scopes: string[] } | undefined;
  /** When set, requests must carry a DPoP proof. */
  demandDpop?: boolean;
}

export interface HttpServer {
  url: string;
  port: number;
  state: SharedState;
  close: () => Promise<void>;
}

/** The 2026 wire codec rejects `tasks/*` before a handler can run. Carry them under `harness/`. */
export function rewriteTaskMethod(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return body;
  try {
    const message = JSON.parse(trimmed) as { method?: unknown };
    if (typeof message.method === "string" && message.method.startsWith("tasks/")) {
      message.method = `harness/${message.method}`;
      return JSON.stringify(message);
    }
  } catch {
    return body;
  }
  return body;
}

function rewriteTaskStream(input: Readable): Readable {
  let buffer = "";
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        this.push(`${rewriteTaskMethod(buffer.slice(0, newline))}\n`);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      callback();
    },
    flush(callback) {
      if (buffer.length > 0) this.push(rewriteTaskMethod(buffer));
      callback();
    },
  });
  input.pipe(transform);
  return transform;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function challengeHeader(port: number, error?: { error: string }, dpop = false): string {
  const metadata = `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`;
  if (dpop) return `DPoP realm="mcp", algs="ES256", resource_metadata="${metadata}"`;
  const parts = [`Bearer realm="mcp"`, `resource_metadata="${metadata}"`];
  if (error) parts.push(`error="${error.error}"`);
  return parts.join(", ");
}

function metadataBody(port: number, authorizationServer: string, scopes: string[]): string {
  return JSON.stringify({
    resource: `http://127.0.0.1:${port}/mcp`,
    authorization_servers: [authorizationServer],
    bearer_methods_supported: ["header"],
    scopes_supported: scopes,
  });
}

async function writeWeb(res: ServerResponse, response: Response): Promise<void> {
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

export async function serveHttp(options: {
  port?: number;
  host?: string;
  state?: SharedState;
  protection?: ResourceProtection;
} = {}): Promise<HttpServer> {
  const state = options.state ?? createSharedState();
  const { handler } = createHandler(state);
  const host = options.host ?? "127.0.0.1";
  const protection = options.protection;
  const scopes = ["read", "write"];

  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (req.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) {
        if (!protection) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(metadataBody(port, protection.authorizationServer, scopes));
        return;
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else headers.set(key, value);
      }
      const taskMethod = headers.get("mcp-method");
      if (taskMethod?.startsWith("tasks/")) headers.set("mcp-method", `harness/${taskMethod}`);
      const taskBody = body && body.length > 0 ? Buffer.from(rewriteTaskMethod(body.toString("utf8"))) : undefined;
      if (protection && url.pathname === "/mcp") {
        const header = headers.get("authorization") ?? "";
        const proof = headers.get("dpop");
        if (protection.demandDpop && !proof) {
          res.writeHead(401, { "www-authenticate": challengeHeader(port, undefined, true) });
          res.end();
          return;
        }
        const match = /^DPoP\s+(\S+)$/i.exec(header) ?? /^Bearer\s+(\S+)$/i.exec(header);
        if (!match) {
          res.writeHead(401, { "www-authenticate": challengeHeader(port, undefined, protection.demandDpop === true) });
          res.end();
          return;
        }
        const token = match[1] ?? "";
        const verified = protection.verifyToken(token);
        if (!verified) {
          res.writeHead(401, { "www-authenticate": challengeHeader(port, { error: "invalid_token" }, protection.demandDpop === true) });
          res.end();
          return;
        }
        const request = new Request(new URL("/mcp", `http://127.0.0.1:${port}`), {
          method: req.method ?? "GET",
          headers,
          ...(taskBody && taskBody.length > 0 ? { body: taskBody } : {}),
        });
        const authInfo: AuthInfo = { token, clientId: verified.clientId, scopes: verified.scopes };
        await writeWeb(res, await handler.fetch(request, { authInfo }));
        return;
      }
      const request = new Request(url, {
        method: req.method ?? "GET",
        headers,
        ...(taskBody && taskBody.length > 0 ? { body: taskBody } : {}),
      });
      await writeWeb(res, await handler.fetch(request));
    } catch (error) {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : "error");
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, () => resolve()));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    state,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function serveOnStdio(
  state: SharedState = createSharedState(),
  streams?: { stdin: Readable; stdout: Writable },
): ReturnType<typeof serveStdio> {
  const transport = new StdioServerTransport(rewriteTaskStream(streams?.stdin ?? process.stdin), streams?.stdout ?? process.stdout);
  return serveStdio(() => createHarnessServer(state), { legacy: "reject", transport });
}

/** Process entry: `stdio` (default) or `http [--port n]`. HTTP prints `MCP_HTTP_PORT=` on stderr. */
export async function serveArgs(
  argv: string[],
  streams?: { stdin: Readable; stdout: Writable },
): Promise<{ close: () => Promise<void>; url?: string; port?: number }> {
  const command = argv[0] ?? "stdio";
  if (command === "http") {
    const flag = argv.indexOf("--port");
    const raw = flag >= 0 ? argv[flag + 1] : undefined;
    const port = raw !== undefined && raw !== "" ? Number(raw) : 0;
    const server = await serveHttp({ port });
    console.error(`MCP_HTTP_PORT=${server.port}`);
    return server;
  }
  if (command === "stdio") {
    const handle = serveOnStdio(createSharedState(), streams);
    return { close: () => handle.close() };
  }
  throw new Error(`unknown mcp command ${command}`);
}
