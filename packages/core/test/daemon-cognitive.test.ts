import { describe, expect, it } from "vitest";
import { Daemon } from "@harness/core";
import { DaemonDriver, ManualClock, SeededEntropy } from "@harness/testkit";

const ALICE = { principal: "alice", kind: "human" as const };

function setup() {
  const daemon = new Daemon({ clock: new ManualClock(1_000), entropy: new SeededEntropy(1), agentInfo: { name: "harness", version: "0.0.0" } });
  const d = new DaemonDriver(daemon);
  d.connect("c1", ALICE);
  d.initialize("c1", true);
  d.inbox("c1");
  return { d, daemon };
}

const invoke = "_harness/cognitive/invoke";

describe("Daemon: cognitive core over ACP", () => {
  it("DM9.1 an invoke for an offered task is handed to the host and answered with the host's result", () => {
    const { d, daemon } = setup();
    daemon.offerPlatformCapability({ name: "cognitive.text-embedding", version: 1, trust: "trusted" });
    d.send("c1", { jsonrpc: "2.0", id: 7, method: invoke, params: { op: "embed", input: { inputs: [{ kind: "query", text: "hi" }] } } });
    expect(d.inbox("c1")).toEqual([]);
    const [work] = d.cognitive();
    expect(work).toEqual({ requestId: expect.any(String), op: "embed", task: "text-embedding", input: { inputs: [{ kind: "query", text: "hi" }] } });
    d.cognitiveResult(work!.requestId, { ok: true, value: { vectors: [[1, 0]] } });
    expect(d.inbox("c1")).toEqual([{ jsonrpc: "2.0", id: 7, result: { vectors: [[1, 0]] } }]);
  });

  it("DM9.2 a task no model serves here is refused without bothering the host", () => {
    const { d } = setup();
    expect(d.request("c1", invoke, { op: "judge", input: {} }).error).toMatchObject({ code: -32005, message: expect.stringMatching(/judgment/) });
    expect(d.cognitive()).toEqual([]);
  });

  it("DM9.3 a host failure is a JSON-RPC error carrying the reason", () => {
    const { d, daemon } = setup();
    daemon.offerPlatformCapability({ name: "cognitive.judgment", version: 1, trust: "trusted" });
    d.send("c1", { jsonrpc: "2.0", id: 1, method: invoke, params: { op: "judge", input: { state: "s", questions: {} } } });
    d.cognitiveResult(d.cognitive()[0]!.requestId, { ok: false, message: "AI Gateway credential missing" });
    expect(d.inbox("c1")[0]).toMatchObject({ id: 1, error: { code: -32603, message: "AI Gateway credential missing" } });
  });

  it("DM9.4 each op maps to its task; unknown ops and missing input are invalid params", () => {
    const { d, daemon } = setup();
    for (const t of ["judgment", "tool-calling", "text-embedding", "prompt-compression", "document-parsing"]) daemon.offerPlatformCapability({ name: `cognitive.${t}`, version: 1, trust: "trusted" });
    for (const op of ["judge", "route", "decide-tools", "embed", "compress", "parse"]) d.send("c1", { jsonrpc: "2.0", id: op, method: invoke, params: { op, input: {} } });
    expect(d.cognitive().map((w) => [w.op, w.task])).toEqual([
      ["judge", "judgment"],
      ["route", "tool-calling"],
      ["decide-tools", "tool-calling"],
      ["embed", "text-embedding"],
      ["compress", "prompt-compression"],
      ["parse", "document-parsing"],
    ]);
    expect(d.request("c1", invoke, { op: "dream", input: {} }).error).toMatchObject({ code: -32602 });
    expect(d.request("c1", invoke, { op: "embed" }).error).toMatchObject({ code: -32602, message: expect.stringMatching(/input/) });
  });

  it("DM9.5 status goes to the host whatever is offered", () => {
    const { d } = setup();
    d.send("c1", { jsonrpc: "2.0", id: 3, method: "_harness/cognitive/status", params: {} });
    const [work] = d.cognitive();
    expect(work).toMatchObject({ op: "status", task: undefined });
    d.cognitiveResult(work!.requestId, { ok: true, value: { members: [] } });
    expect(d.inbox("c1")).toEqual([{ jsonrpc: "2.0", id: 3, result: { members: [] } }]);
  });

  it("DM9.6 a result for a client that has gone, or for an unknown request, is dropped", () => {
    const { d, daemon } = setup();
    daemon.offerPlatformCapability({ name: "cognitive.text-embedding", version: 1, trust: "trusted" });
    d.send("c1", { jsonrpc: "2.0", id: 1, method: invoke, params: { op: "embed", input: {} } });
    const [work] = d.cognitive();
    d.disconnect("c1");
    d.cognitiveResult(work!.requestId, { ok: true, value: {} });
    d.cognitiveResult("nope", { ok: true, value: {} });
    expect(d.cognitive()).toEqual([]);
  });

  it("DM9.7 the platform can withdraw a capability it offered, and plugins hear about it", () => {
    const { d, daemon } = setup();
    daemon.offerPlatformCapability({ name: "cognitive.document-parsing", version: 1, trust: "trusted" });
    d.connect("p1", { principal: "indexer", kind: "plugin" });
    d.initialize("p1", true);
    d.request("p1", "_harness/hooks/subscribe", { types: ["capability.revoked"] });
    daemon.withdrawPlatformCapability("cognitive.document-parsing");
    expect(daemon.capabilities().map((c) => c.name)).not.toContain("cognitive.document-parsing");
    const polled = d.request("p1", "_harness/hooks/poll", {}).result as { events: { type: string; payload: { name?: string } }[] };
    expect(polled.events.map((e) => [e.type, e.payload.name])).toContainEqual(["capability.revoked", "cognitive.document-parsing"]);
    expect(d.request("c1", invoke, { op: "parse", input: {} }).error).toMatchObject({ code: -32005 });
  });

  it("DM9.8 initialize advertises the cognitive methods", () => {
    const daemon = new Daemon({ clock: new ManualClock(0), entropy: new SeededEntropy(2), agentInfo: { name: "h", version: "0" } });
    const d = new DaemonDriver(daemon);
    d.connect("c", ALICE);
    const methods = (d.initialize("c", true).result as { _meta: { harness: { methods: string[] } } })._meta.harness.methods;
    expect(methods).toEqual(expect.arrayContaining(["_harness/cognitive/invoke", "_harness/cognitive/status"]));
  });

  it("DM9.9 disconnecting drops only that connection's pending work, even if its id is reused", () => {
    const { d, daemon } = setup();
    daemon.offerPlatformCapability({ name: "cognitive.text-embedding", version: 1, trust: "trusted" });
    d.connect("c2", ALICE);
    d.initialize("c2", true);
    d.inbox("c2");
    d.send("c1", { jsonrpc: "2.0", id: 1, method: invoke, params: { op: "embed", input: {} } });
    d.send("c2", { jsonrpc: "2.0", id: 2, method: invoke, params: { op: "embed", input: {} } });
    const [w1, w2] = d.cognitive();
    d.disconnect("c1");
    d.connect("c1", ALICE);
    d.initialize("c1", true);
    d.inbox("c1");
    d.cognitiveResult(w1!.requestId, { ok: true, value: "old" });
    d.cognitiveResult(w2!.requestId, { ok: true, value: "two" });
    expect(d.inbox("c1")).toEqual([]);
    expect(d.inbox("c2")).toEqual([{ jsonrpc: "2.0", id: 2, result: "two" }]);
  });

  it("DM9.10 a request is answered once; a result for a gone client produces no output; an empty failure message gets a default", () => {
    const { d, daemon } = setup();
    daemon.offerPlatformCapability({ name: "cognitive.text-embedding", version: 1, trust: "trusted" });
    d.send("c1", { jsonrpc: "2.0", id: 1, method: invoke, params: { op: "embed", input: {} } });
    d.send("c1", { jsonrpc: "2.0", id: 2, method: invoke, params: { op: "embed", input: {} } });
    const [w1, w2] = d.cognitive();
    d.cognitiveResult(w1!.requestId, { ok: false, message: "" });
    d.cognitiveResult(w1!.requestId, { ok: true, value: "again" });
    expect(d.inbox("c1")).toEqual([{ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "cognitive operation failed" } }]);
    d.disconnect("c1");
    expect(daemon.cognitiveResult(w2!.requestId, { ok: true, value: {} })).toEqual([]);
  });

  it("DM9.11 only the capability for the op's own task admits it; the op error lists the ops", () => {
    const { d, daemon } = setup();
    daemon.offerPlatformCapability({ name: "cognitive.text-embedding", version: 1, trust: "trusted" });
    expect(d.request("c1", invoke, { op: "judge", input: {} }).error).toMatchObject({ code: -32005, message: "no model serves judgment on this platform" });
    expect(d.request("c1", invoke, { op: "toString", input: {} }).error).toMatchObject({ code: -32602, message: expect.stringContaining("judge, route, decide-tools, embed, compress, parse") });
  });
});
