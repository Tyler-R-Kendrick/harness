import { describe, expect, it } from "vitest";
import { ERROR_CODES, failure, notification, parseMessage, request, success } from "@harness/protocol";

describe("parseMessage", () => {
  it("JR1.1 classifies a request", () => {
    expect(parseMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1 } })).toEqual({
      ok: true,
      value: { kind: "request", id: 1, method: "initialize", params: { a: 1 } },
    });
    expect(parseMessage({ jsonrpc: "2.0", id: "x", method: "m" })).toMatchObject({ ok: true, value: { kind: "request", id: "x" } });
  });

  it("JR1.2 classifies a notification", () => {
    expect(parseMessage({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } })).toEqual({
      ok: true,
      value: { kind: "notification", method: "session/cancel", params: { sessionId: "s" } },
    });
  });

  it("JR1.3 classifies success and error responses", () => {
    expect(parseMessage({ jsonrpc: "2.0", id: 3, result: null })).toEqual({ ok: true, value: { kind: "response", id: 3, result: null } });
    expect(parseMessage({ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "nope", data: 1 } })).toEqual({
      ok: true,
      value: { kind: "error", id: 3, error: { code: -32601, message: "nope", data: 1 } },
    });
    expect(parseMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse" } })).toMatchObject({ ok: true, value: { kind: "error", id: null } });
  });

  it("JR1.4 rejects envelopes that are not JSON-RPC 2.0", () => {
    const bad: unknown[] = [
      null,
      [],
      "x",
      { jsonrpc: "1.0", id: 1, method: "m" },
      { id: 1, method: "m" },
      { jsonrpc: "2.0", id: {}, method: "m" },
      { jsonrpc: "2.0", id: 1.5, method: "m" },
      { jsonrpc: "2.0", id: null, method: "m" },
      { jsonrpc: "2.0", id: 1, method: 5 },
      { jsonrpc: "2.0", id: 1, method: "m", params: 3 },
      { jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "x" } },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: 1, error: { code: "x", message: "m" } },
      { jsonrpc: "2.0", id: 1, error: { code: 1 } },
      { jsonrpc: "2.0", id: 1, error: null },
      { jsonrpc: "2.0", id: null, result: 1 },
      { jsonrpc: "2.0", id: 1, method: "m", result: 1 },
    ];
    for (const b of bad) expect(parseMessage(b), JSON.stringify(b)).toMatchObject({ ok: false, error: { code: "invalid_message" } });
  });

  it("JR1.5 accepts array params", () => {
    expect(parseMessage({ jsonrpc: "2.0", method: "m", params: [1] })).toMatchObject({ ok: true, value: { params: [1] } });
  });

  it("JR2.1 builders produce messages that parse back", () => {
    expect(parseMessage(request(7, "session/new", { cwd: "/" }))).toMatchObject({ ok: true, value: { kind: "request", id: 7, method: "session/new" } });
    expect(parseMessage(notification("session/update", { u: 1 }))).toMatchObject({ ok: true, value: { kind: "notification" } });
    expect(parseMessage(success(7, { ok: true }))).toMatchObject({ ok: true, value: { kind: "response", result: { ok: true } } });
    expect(parseMessage(failure(7, ERROR_CODES.methodNotFound, "no such method"))).toMatchObject({ ok: true, value: { kind: "error", error: { code: -32601 } } });
    expect(failure(null, ERROR_CODES.parseError, "bad", { at: 1 })).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad", data: { at: 1 } } });
    expect(request(1, "m")).toEqual({ jsonrpc: "2.0", id: 1, method: "m" });
    expect(notification("m")).toEqual({ jsonrpc: "2.0", method: "m" });
  });

  it("JR2.2 standard error codes match JSON-RPC 2.0", () => {
    expect(ERROR_CODES).toMatchObject({ parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603 });
  });
});
