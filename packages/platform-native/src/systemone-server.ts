import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleModels, handleSystemOne, systemOneError, systemOneInvalidJson, SYSTEMONE_CONCURRENCY, SYSTEMONE_MAX_QUESTIONS } from "@harness/decision";
import type { SystemOneModels, SystemOneReply } from "@harness/decision";

export interface SystemOneServerOptions {
  /** The models served: `POST /v1/systemone` asks them, `GET /v1/models` lists them. */
  readonly models: SystemOneModels;
  /** The TCP port; 0 takes a free one. */
  readonly port: number;
  /** The address to listen on (default `127.0.0.1`: this machine only). A host that is not loopback needs a token. */
  readonly host?: string;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  readonly token?: string;
  /** Largest request body in bytes (default 1 MiB). */
  readonly maxBodyBytes?: number;
  readonly maxQuestions?: number;
  readonly concurrency?: number;
  /** Requests answered by the models at the same time, across all connections (default 8); the next gets a 503 with `Retry-After` until one ends. */
  readonly maxInFlight?: number;
  /** Open connections at the same time (default 64); a connection past it is closed unanswered. */
  readonly maxConnections?: number;
  /** One line per request (method, path, status, milliseconds); never a body or a token. */
  readonly log?: (message: string) => void;
}

export interface SystemOneServer {
  /** Where the server listens, e.g. `http://127.0.0.1:41235`. */
  readonly url: string;
  /** Stops listening and ends open connections. */
  close(): Promise<void>;
}

const DEFAULT_MAX_BODY = 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 8;
const DEFAULT_MAX_CONNECTIONS = 64;
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json$/i;
const PATH_SYSTEMONE = "/v1/systemone";
const PATH_MODELS = "/v1/models";

/**
 * Whether the header's token is the expected one. Node hands header bytes over as Latin-1
 * text, so the bytes are recovered first and compared with the token's UTF-8 bytes. Both
 * are hashed, so the comparison takes the same time whatever the lengths.
 */
function sameSecret(header: string, expected: string): boolean {
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
  return timingSafeEqual(digest(Buffer.from(header, "latin1")), digest(Buffer.from(expected, "utf8")));
}

/** Where a server listening on `host` and `port` is reached: an IPv6 address goes in brackets. */
export function systemOneUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** The path of a request, without its query string. */
const pathOf = (req: IncomingMessage): string => req.url!.split("?")[0]!;

/** The host name in a `Host` header, without its port. */
function hostName(header: string): string {
  return header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : header.split(":")[0]!;
}

type BodyRead = { readonly kind: "text"; readonly text: string } | { readonly kind: "too-large" } | { readonly kind: "aborted" } | { readonly kind: "not-utf8" };

/** Reads a body up to `max` bytes, and stops reading at the first byte past it. */
function readBody(req: IncomingMessage, max: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (result: BodyRead) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onAborted);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        req.pause();
        done({ kind: "too-large" });
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        done({ kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) });
      } catch {
        done({ kind: "not-utf8" });
      }
    };
    const onAborted = () => done({ kind: "aborted" });
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onAborted);
  });
}

/**
 * Serves the models as a TypeSafe-compatible System One provider over HTTP:
 * `POST /v1/systemone` and `GET /v1/models` (see `handleSystemOne` for the wire).
 *
 * The server is for this machine unless told otherwise: it listens on loopback, and
 * (without a token) refuses a request whose `Host` is not a loopback name, which stops a
 * web page from reaching it through DNS rebinding. Requests must be JSON, so a browser's
 * cross-site "simple" requests cannot carry one, and there are no CORS headers. A host
 * that is not loopback must have a token. A bad request is answered and never brings the
 * process down.
 */
export async function serveSystemOne(options: SystemOneServerOptions): Promise<SystemOneServer> {
  const host = options.host ?? "127.0.0.1";
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new RangeError(`port must be a whole number from 0 to 65535, not ${options.port}`);
  if (!Number.isInteger(maxBody) || maxBody < 1) throw new RangeError(`maxBodyBytes must be a positive whole number, not ${maxBody}`);
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) throw new RangeError(`maxInFlight must be a positive whole number, not ${maxInFlight}`);
  if (!Number.isInteger(maxConnections) || maxConnections < 1) throw new RangeError(`maxConnections must be a positive whole number, not ${maxConnections}`);
  if (options.token === "") throw new RangeError("token must not be empty");
  if (!LOOPBACK.test(host) && options.token === undefined) throw new Error(`refusing to serve System One on ${host} without a token: only loopback is served without one`);
  const log = options.log ?? (() => {});

  const send = (res: ServerResponse, reply: SystemOneReply, headers: Record<string, string> = {}, close = false): void => {
    const payload = Buffer.from(JSON.stringify(reply.body));
    res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8", "content-length": payload.length, "cache-control": "no-store", "x-content-type-options": "nosniff", ...(close ? { connection: "close" } : {}), ...headers });
    res.end(payload);
  };

  let inFlight = 0;

  const authorised = (req: IncomingMessage): boolean => {
    if (options.token === undefined) return req.headers.host === undefined || LOOPBACK.test(hostName(req.headers.host));
    const given = /^Bearer +(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    return given !== undefined && sameSecret(given, options.token);
  };

  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = pathOf(req);
    if (!authorised(req)) {
      if (options.token === undefined) return send(res, systemOneError(403, "forbidden_host", "this server answers requests for a loopback host name only"));
      return send(res, systemOneError(401, "authentication_error", "a valid bearer token is required"), { "www-authenticate": "Bearer" });
    }
    if (path === PATH_MODELS) {
      if (req.method !== "GET") return send(res, systemOneError(405, "method_not_allowed", "use GET"), { allow: "GET" });
      return send(res, handleModels(options.models));
    }
    if (path !== PATH_SYSTEMONE) return send(res, systemOneError(404, "not_found", `no such path: ${path}`));
    if (req.method !== "POST") return send(res, systemOneError(405, "method_not_allowed", "use POST"), { allow: "POST" });
    if (!JSON_TYPE.test((req.headers["content-type"] ?? "").split(";")[0]!.trim())) return send(res, systemOneError(415, "unsupported_media_type", "send the request as application/json"));
    const tooLarge = () => {
      // Nothing more is read; the connection ends once the answer is out.
      send(res, systemOneError(413, "payload_too_large", `the request body is over ${maxBody} bytes`), {}, true);
      res.once("finish", () => req.socket.destroy());
    };
    const declared = Number(req.headers["content-length"]);
    if (declared > maxBody) return tooLarge();
    const body = await readBody(req, maxBody);
    if (body.kind === "aborted") return;
    if (body.kind === "too-large") return tooLarge();
    if (body.kind === "not-utf8") return send(res, systemOneInvalidJson("the request body is not valid UTF-8"));
    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch (error) {
      return send(res, systemOneInvalidJson((error as SyntaxError).message));
    }
    if (inFlight >= maxInFlight) return send(res, systemOneError(503, "overloaded", `${maxInFlight} requests are being answered already; try again shortly`), { "retry-after": "1" });
    // The answer is for a client that may be gone by the time the models have it: its departure ends the work.
    const gone = new AbortController();
    const onClose = () => gone.abort();
    res.once("close", onClose);
    inFlight++;
    try {
      send(res, await handleSystemOne({ body: json, models: options.models, maxQuestions: options.maxQuestions ?? SYSTEMONE_MAX_QUESTIONS, concurrency: options.concurrency ?? SYSTEMONE_CONCURRENCY, signal: gone.signal }));
    } finally {
      inFlight--;
      res.off("close", onClose);
    }
  };

  const server = createServer((req, res) => {
    const started = Date.now();
    res.once("finish", () => log(`${req.method} ${pathOf(req)} ${res.statusCode} ${Date.now() - started}ms`));
    serve(req, res).catch((error: unknown) => {
      log(`${req.method} ${pathOf(req)} failed: ${error instanceof Error ? error.message : String(error)}`);
      // Sending the answer is the last thing serve does, so nothing has been sent yet.
      send(res, systemOneError(500, "internal_error", "the server failed to handle the request"), {}, true);
    });
  });
  server.maxConnections = maxConnections;
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
  return {
    url: systemOneUrl(host, address.port),
    async close() {
      if (server.listening) server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
