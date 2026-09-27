export type JsonRpcId = string | number;

export type JsonRpcMessage =
  | { readonly kind: "request"; readonly id: JsonRpcId; readonly method: string; readonly params?: unknown }
  | { readonly kind: "notification"; readonly method: string; readonly params?: unknown }
  | { readonly kind: "response"; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly kind: "error"; readonly id: JsonRpcId | null; readonly error: JsonRpcErrorObject };

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  // Implementation-defined server errors (-32000..-32099).
  notInitialized: -32002,
  forbidden: -32003,
  conflict: -32004,
  notFound: -32005,
} as const;

type ParseResult = { ok: true; value: JsonRpcMessage } | { ok: false; error: { code: "invalid_message"; message: string } };

const invalid = (message: string): ParseResult => ({ ok: false, error: { code: "invalid_message", message } });

function isId(v: unknown): v is JsonRpcId {
  return typeof v === "string" || (typeof v === "number" && Number.isInteger(v));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate and classify a decoded JSON value. Never throws. */
export function parseMessage(value: unknown): ParseResult {
  if (!isRecord(value)) return invalid("message must be an object");
  if (value["jsonrpc"] !== "2.0") return invalid('jsonrpc must be "2.0"');
  const hasId = "id" in value;
  const id = value["id"];
  const params = value["params"];
  if ("params" in value && !isRecord(params) && !Array.isArray(params)) return invalid("params must be an object or array");
  if ("method" in value) {
    if (typeof value["method"] !== "string") return invalid("method must be a string");
    if ("result" in value || "error" in value) return invalid("a request cannot carry result or error");
    const base = { method: value["method"], ...("params" in value ? { params } : {}) };
    if (!hasId) return { ok: true, value: { kind: "notification", ...base } };
    if (!isId(id)) return invalid("request id must be a string or integer");
    return { ok: true, value: { kind: "request", id, ...base } };
  }
  if ("result" in value === "error" in value) return invalid("a response carries exactly one of result or error");
  if ("result" in value) {
    if (!isId(id)) return invalid("response id must be a string or integer");
    return { ok: true, value: { kind: "response", id, result: value["result"] } };
  }
  const error = value["error"];
  if (!isRecord(error) || typeof error["code"] !== "number" || typeof error["message"] !== "string") return invalid("malformed error object");
  if (id !== null && !isId(id)) return invalid("error id must be a string, integer or null");
  const errorObject: JsonRpcErrorObject = { code: error["code"], message: error["message"], ...("data" in error ? { data: error["data"] } : {}) };
  return { ok: true, value: { kind: "error", id: id as JsonRpcId | null, error: errorObject } };
}

export function request(id: JsonRpcId, method: string, params?: unknown): object {
  return params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
}

export function notification(method: string, params?: unknown): object {
  return params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
}

export function success(id: JsonRpcId, result: unknown): object {
  return { jsonrpc: "2.0", id, result };
}

export function failure(id: JsonRpcId | null, code: number, message: string, data?: unknown): object {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}
