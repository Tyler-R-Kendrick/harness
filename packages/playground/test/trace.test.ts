import { describe, expect, it } from "vitest";
import { generateText, streamText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { AcpPort } from "@harness/platform-browser";
import type { Worker } from "@harness/workers";
import { acpSummary, hookEvents, hookTrace, tracedPort, tracedTools, tracedWorker, Tracer, tracingMiddleware } from "../src/trace.ts";
import { jsonSchema, tool } from "ai";

function clock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("the tracer", () => {
  it("TR1.1 records events in order with a sequence number and the time, and tells subscribers until they leave", () => {
    const c = clock();
    const tracer = new Tracer(c.now);
    const seen: string[] = [];
    const leave = tracer.subscribe((e) => seen.push(e.name));
    tracer.record({ kind: "host", name: "a" });
    c.advance(5);
    const b = tracer.record({ kind: "host", name: "b", detail: { x: 1 } });
    leave();
    tracer.record({ kind: "host", name: "c" });
    expect(b).toMatchObject({ seq: 2, at: 1005, kind: "host", name: "b", detail: { x: 1 } });
    expect(seen).toEqual(["a", "b"]);
    expect(tracer.events().map((e) => e.name)).toEqual(["a", "b", "c"]);
  });

  it("TR1.2 a span records its end with how long it took", () => {
    const c = clock();
    const tracer = new Tracer(c.now);
    const span = tracer.span({ kind: "model", name: "call", detail: { asked: 1 } });
    c.advance(42);
    const end = span.end({ said: "hi" });
    expect(tracer.events().map((e) => [e.name, e.duration])).toEqual([
      ["call", undefined],
      ["call", 42],
    ]);
    expect(end).toMatchObject({ phase: "end", detail: { said: "hi" }, spanOf: 1 });
  });

  it("TR1.3 keeps only the newest events past its limit, and clears", () => {
    const tracer = new Tracer(() => 0, { limit: 2 });
    for (const name of ["a", "b", "c"]) tracer.record({ kind: "host", name });
    expect(tracer.events().map((e) => e.name)).toEqual(["b", "c"]);
    tracer.clear();
    expect(tracer.events()).toEqual([]);
  });
});

describe("restoring a timeline", () => {
  it("TR1.4 older events go before the ones recorded since, which are renumbered after them (their spans too); numbering continues", () => {
    const tracer = new Tracer(() => 5);
    const span = tracer.span({ kind: "model", name: "call" });
    span.end();
    tracer.restore([
      { seq: 7, at: 1, kind: "acp", name: "old" },
      { seq: 8, at: 2, kind: "host", name: "older" },
    ]);
    expect(tracer.events().map((e) => [e.seq, e.name, e.spanOf])).toEqual([
      [7, "old", undefined],
      [8, "older", undefined],
      [9, "call", undefined],
      [10, "call", 9],
    ]);
    expect(tracer.record({ kind: "host", name: "next" }).seq).toBe(11);
    expect(tracer.last).toBe(11);
  });

  it("TR1.5 restoring nothing changes nothing, and the limit still holds", () => {
    const tracer = new Tracer(() => 0, { limit: 2 });
    tracer.record({ kind: "host", name: "a" });
    tracer.restore([]);
    expect(tracer.events().map((e) => e.seq)).toEqual([1]);
    tracer.restore([{ seq: 1, at: 0, kind: "host", name: "x" }, { seq: 2, at: 0, kind: "host", name: "y" }]);
    expect(tracer.events().map((e) => e.name)).toEqual(["y", "a"]);
  });
});

describe("summaries of ACP messages", () => {
  it("TR2.1 names requests, notifications (with the update kind), results and errors", () => {
    expect(acpSummary({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: {} })).toBe("session/prompt #3");
    expect(acpSummary({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } })).toBe("session/update · agent_message_chunk");
    expect(acpSummary({ jsonrpc: "2.0", method: "_harness/session/event", params: { event: "turn.started" } })).toBe("_harness/session/event · turn.started");
    expect(acpSummary({ jsonrpc: "2.0", id: 3, result: {} })).toBe("result #3");
    expect(acpSummary({ jsonrpc: "2.0", id: 4, error: { code: -32601, message: "unknown method x" } })).toBe("error #4: unknown method x");
    expect(acpSummary("nonsense")).toBeUndefined();
  });
});

describe("tracing the ACP port", () => {
  function fakePort() {
    const listeners: ((e: { data?: unknown }) => void)[] = [];
    const sent: unknown[] = [];
    const port: AcpPort = { postMessage: (m) => void sent.push(m), addEventListener: (type, l) => void (type === "message" && listeners.push(l)), start: () => {}, close: () => {} };
    return { port, sent, deliver: (data: unknown) => listeners.forEach((l) => l({ data })) };
  }

  it("TR3.1 what the client sends is recorded as going in to the daemon, what arrives as coming out of it; port control is passed through unrecorded", () => {
    const tracer = new Tracer(() => 0);
    const raw = fakePort();
    const port = tracedPort(raw.port, tracer);
    const got: unknown[] = [];
    port.addEventListener("message", (e) => got.push(e.data));
    port.postMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    port.postMessage({ "_harness/port": "close" });
    raw.deliver({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    expect(raw.sent).toHaveLength(2);
    expect(got).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
    expect(tracer.events().map((e) => [e.kind, e.direction, e.name])).toEqual([
      ["acp", "in", "initialize #1"],
      ["acp", "out", "result #1"],
    ]);
    expect(tracer.events()[1]!.detail).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("TR3.2 a session id in a message's params is kept on its event", () => {
    const tracer = new Tracer(() => 0);
    tracedPort(fakePort().port, tracer).postMessage({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s1" } });
    expect(tracer.events()[0]!.sessionId).toBe("s1");
  });
});

describe("tracing the worker", () => {
  it("TR4.1 commands from the daemon and events back are recorded with the turn they belong to", async () => {
    const tracer = new Tracer(() => 0);
    const inner: Worker = {
      run: async (command, emit) => {
        emit({ type: "update", sessionId: command.sessionId, turnId: command.turnId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } });
        emit({ type: "permission", sessionId: command.sessionId, turnId: command.turnId, requestId: "r", toolCall: { toolCallId: "c" }, options: [] });
        emit({ type: "behavior", sessionId: command.sessionId, change: { state: "calm" } });
        emit({ type: "end", sessionId: command.sessionId, turnId: command.turnId, stopReason: "end_turn" });
      },
      cancel: () => {},
      permission: () => {},
    };
    const worker = tracedWorker(inner, tracer);
    const emitted: string[] = [];
    await worker.run({ type: "prompt", sessionId: "s", turnId: "t", cwd: "/", prompt: [{ type: "text", text: "hi" }] }, (e) => emitted.push(e.type));
    worker.cancel("s", "t");
    worker.permission({ type: "permission", sessionId: "s", turnId: "t", requestId: "r", outcome: { outcome: "cancelled" } });
    worker.permission({ type: "permission", sessionId: "s", turnId: "t", requestId: "r", outcome: { outcome: "selected", optionId: "allow" } });
    expect(emitted).toEqual(["update", "permission", "behavior", "end"]);
    expect(tracer.events().map((e) => [e.direction, e.name, e.turnId])).toEqual([
      ["in", "prompt", "t"],
      ["out", "update · agent_message_chunk", "t"],
      ["out", "permission · ", "t"],
      ["out", "behavior · calm", undefined],
      ["out", "end · end_turn", "t"],
      ["in", "cancel", "t"],
      ["in", "permission · cancelled", "t"],
      ["in", "permission · allow", "t"],
    ]);
  });

  it("TR4.2 host events reach a worker that takes them, and are recorded", () => {
    const tracer = new Tracer(() => 0);
    const got: string[] = [];
    const worker = tracedWorker({ run: async () => {}, cancel: () => {}, permission: () => {}, event: (c) => void got.push(c.name) }, tracer);
    worker.event!({ type: "event", sessionId: "s", name: "focus" }, () => {});
    tracedWorker({ run: async () => {}, cancel: () => {}, permission: () => {} }, tracer).event!({ type: "event", sessionId: "s", name: "ignored" }, () => {});
    expect(got).toEqual(["focus"]);
    expect(tracer.events().map((e) => e.name)).toEqual(["event · focus", "event · ignored"]);
  });
});

describe("tracing model calls (AI SDK middleware)", () => {
  const usage = { inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: undefined, reasoning: undefined } };

  it("TR5.1 a generate call is a span: the prompt going in, the text, tool calls, finish and usage coming out", async () => {
    const c = clock();
    const tracer = new Tracer(c.now);
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        c.advance(30);
        return { content: [{ type: "text", text: "hello" }, { type: "tool-call", toolCallId: "1", toolName: "bash", input: '{"command":"ls"}' }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] };
      },
    });
    await generateText({ model: wrapLanguageModel({ model, middleware: tracingMiddleware(tracer) }), prompt: "hi" });
    const [start, end] = tracer.events();
    expect(start).toMatchObject({ kind: "model", phase: "start", name: "generate" });
    expect((start!.detail as { prompt: unknown[] }).prompt).toHaveLength(1);
    expect(end).toMatchObject({ phase: "end", duration: 30, detail: { text: "hello", toolCalls: [{ toolName: "bash", input: { command: "ls" } }], finishReason: "tool-calls", usage: { input: 5, output: 2 } } });
  });

  it("TR5.2 a streamed call is recorded when its stream ends, with the text it streamed", async () => {
    const tracer = new Tracer(() => 0);
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: "he" },
          { type: "text-delta", id: "0", delta: "llo" },
          { type: "text-end", id: "0" },
          { type: "tool-call", toolCallId: "1", toolName: "t", input: "not json" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
        ]),
      }),
    });
    await streamText({ model: wrapLanguageModel({ model, middleware: tracingMiddleware(tracer) }), prompt: "hi" }).text;
    expect(tracer.events().at(-1)).toMatchObject({ phase: "end", name: "stream", detail: { text: "hello", toolCalls: [{ toolName: "t", input: "not json" }], finishReason: "stop" } });
  });

  it("TR5.3 a failed call is recorded as failed and still fails", async () => {
    const tracer = new Tracer(() => 0);
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("down");
      },
      doStream: async () => ({ stream: convertArrayToReadableStream([{ type: "error", error: new Error("mid-stream") }]) }),
    });
    const wrapped = wrapLanguageModel({ model, middleware: tracingMiddleware(tracer) });
    await expect(generateText({ model: wrapped, prompt: "hi", maxRetries: 0 })).rejects.toThrow("down");
    expect(tracer.events().at(-1)).toMatchObject({ phase: "end", detail: { error: "down" } });
    await streamText({ model: wrapped, prompt: "hi", onError: () => {} }).consumeStream();
    expect(tracer.events().at(-1)).toMatchObject({ phase: "end", name: "stream", detail: { error: "mid-stream" } });
  });
  it("TR5.4 a streamed call that fails to start is recorded as failed and still fails", async () => {
    const tracer = new Tracer(() => 0);
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("no stream");
      },
    });
    const wrapped = wrapLanguageModel({ model, middleware: tracingMiddleware(tracer) });
    await expect(wrapped.doStream({ prompt: [] })).rejects.toThrow("no stream");
    expect(tracer.events().at(-1)).toMatchObject({ phase: "end", name: "stream", detail: { error: "no stream" } });
  });

  it("TR5.6 a stream that breaks while being read is recorded as failed, and its reader still sees the failure", async () => {
    const tracer = new Tracer(() => 0);
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          pull(controller) {
            controller.error(new Error("connection lost"));
          },
        }),
      }),
    });
    const { stream } = await wrapLanguageModel({ model, middleware: tracingMiddleware(tracer) }).doStream({ prompt: [] });
    await expect(stream.getReader().read()).rejects.toThrow("connection lost");
    expect(tracer.events().at(-1)).toMatchObject({ phase: "end", name: "stream", detail: { error: "connection lost" } });
  });

  it("TR5.5 a streamed call its reader cancels (a cancelled turn) is recorded as cancelled, with what it streamed so far", async () => {
    const tracer = new Tracer(() => 0);
    let cancelled = false;
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-start", id: "0" });
            controller.enqueue({ type: "text-delta", id: "0", delta: "so far" });
          },
          cancel() {
            cancelled = true;
          },
        }),
      }),
    });
    const { stream } = await wrapLanguageModel({ model, middleware: tracingMiddleware(tracer) }).doStream({ prompt: [] });
    const reader = stream.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel("stop");
    expect(cancelled).toBe(true);
    expect(tracer.events().at(-1)).toMatchObject({ phase: "end", name: "stream", detail: { cancelled: true, text: "so far" } });
  });
});

describe("hook events from a daemon snapshot", () => {
  it("TR6.2 become trace events, with their session when they have one", () => {
    expect(hookTrace({ offset: 0, type: "turn.started", sessionId: "s" })).toEqual({ kind: "hook", name: "turn.started", detail: { offset: 0, type: "turn.started", sessionId: "s" }, sessionId: "s" });
    expect(hookTrace({ offset: 1, type: "capability.offered" })).toEqual({ kind: "hook", name: "capability.offered", detail: { offset: 1, type: "capability.offered" } });
  });

  it("TR6.3 the tracer's last sequence number is 0 before any event", () => {
    const tracer = new Tracer(() => 0);
    expect(tracer.last).toBe(0);
    tracer.record({ kind: "host", name: "a" });
    expect(tracer.last).toBe(1);
  });

  it("TR6.1 are the events at or past an offset", () => {
    const events = [{ offset: 0, type: "a" }, { offset: 1, type: "b" }, { offset: 2, type: "c" }];
    expect(hookEvents({ hooks: { events } }, 1).map((e) => e.type)).toEqual(["b", "c"]);
    expect(hookEvents({ hooks: {} }, 0)).toEqual([]);
    expect(hookEvents({}, 0)).toEqual([]);
  });
});

describe("tracing tool runs", () => {
  const opts = { toolCallId: "c1", messages: [], context: undefined };
  const schema = jsonSchema<{ n: number }>({ type: "object", properties: { n: { type: "number" } } });

  it("TR7.1 each run is a span with its input and output; a failure is recorded and rethrown", async () => {
    const c = clock();
    const tracer = new Tracer(c.now);
    const { execute: _, ...bare } = tool({ inputSchema: schema, execute: async () => 0 });
    const tools = tracedTools(
      {
        double: tool({ inputSchema: schema, execute: async ({ n }) => (c.advance(3), n * 2) }),
        fail: tool({ inputSchema: schema, execute: async (): Promise<number> => { throw new Error("nope"); } }),
        odd: tool({ inputSchema: schema, execute: async (): Promise<number> => { throw "odd"; } }),
        bare,
      },
      tracer,
    );
    expect(await tools.double.execute!({ n: 2 }, opts)).toBe(4);
    await expect(tools.fail.execute!({ n: 1 }, opts)).rejects.toThrow("nope");
    await expect(tools.odd.execute!({ n: 1 }, opts)).rejects.toBe("odd");
    expect("execute" in tools.bare).toBe(false);
    expect(tracer.events().map((e) => [e.kind, e.name, e.phase, e.detail, e.duration])).toEqual([
      ["tool", "double", "start", { toolCallId: "c1", input: { n: 2 } }, undefined],
      ["tool", "double", "end", { output: 4 }, 3],
      ["tool", "fail", "start", { toolCallId: "c1", input: { n: 1 } }, undefined],
      ["tool", "fail", "end", { error: "nope" }, 0],
      ["tool", "odd", "start", { toolCallId: "c1", input: { n: 1 } }, undefined],
      ["tool", "odd", "end", { error: "odd" }, 0],
    ]);
  });
});
