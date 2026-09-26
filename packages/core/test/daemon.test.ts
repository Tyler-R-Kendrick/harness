import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { Daemon, parseId } from "@harness/core";
import type { Identity, WorkerCommand } from "@harness/core";
import { DaemonDriver, ManualClock, SeededEntropy } from "@harness/testkit";

const ALICE = { principal: "alice", kind: "human" as const };

function setup(options: { flowCapacity?: number; permissionTimeoutMs?: number } = {}) {
  const clock = new ManualClock(1_000);
  const daemon = new Daemon({ clock, entropy: new SeededEntropy(1), agentInfo: { name: "harness", version: "0.0.0" }, ...options });
  const d = new DaemonDriver(daemon);
  return { d, clock, daemon };
}

/** Connect, initialize and create a session; returns the session id. */
function openSession(d: DaemonDriver, conn = "c1", identity: Identity = ALICE, harness = false): string {
  d.connect(conn, identity);
  d.initialize(conn, harness);
  const res = d.request(conn, "session/new", { cwd: "/work", mcpServers: [] });
  const sessionId = (res.result as { sessionId: string }).sessionId;
  d.inbox(conn);
  return sessionId;
}

function promptCommand(commands: WorkerCommand[]): Extract<WorkerCommand, { type: "prompt" }> {
  const c = commands.find((x) => x.type === "prompt");
  if (!c || c.type !== "prompt") throw new Error("no prompt command");
  return c;
}

const text = (t: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });

describe("Daemon: initialization and envelope handling", () => {
  it("DM1.1 initialize negotiates ACP v1 and advertises the _harness profile and capabilities", () => {
    const { d, daemon } = setup();
    daemon.offerPlatformCapability({ name: "process.spawn", version: 1, trust: "trusted" });
    d.connect("c1", ALICE);
    const res = d.initialize("c1");
    expect(res.result).toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: "harness", version: "0.0.0" },
      agentCapabilities: { loadSession: true },
      _meta: { harness: { profileVersion: 1, capabilities: [{ name: "process.spawn", version: 1, provenance: "platform" }] } },
    });
  });

  it("DM1.2 requests before initialize are refused", () => {
    const { d } = setup();
    d.connect("c1", ALICE);
    expect(d.request("c1", "session/new", { cwd: "/", mcpServers: [] }).error).toMatchObject({ code: -32002 });
  });

  it("DM1.3 unknown methods are errors; unknown notifications are ignored", () => {
    const { d } = setup();
    d.connect("c1", ALICE);
    d.initialize("c1");
    expect(d.request("c1", "nope/nope").error).toMatchObject({ code: -32601 });
    d.notify("c1", "_vendor/whatever", {});
    expect(d.inbox("c1")).toEqual([]);
  });

  it("DM1.4 a malformed envelope gets an invalid-request error with a null id", () => {
    const { d } = setup();
    d.connect("c1", ALICE);
    d.send("c1", { jsonrpc: "1.0", id: 1, method: "initialize" });
    expect(d.inbox("c1")).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32600, message: expect.any(String) } }]);
  });

  it("DM1.5 invalid params are rejected", () => {
    const { d } = setup();
    d.connect("c1", ALICE);
    d.initialize("c1");
    expect(d.request("c1", "session/new", { mcpServers: [] }).error).toMatchObject({ code: -32602 });
    expect(d.request("c1", "session/prompt", { sessionId: 5 }).error).toMatchObject({ code: -32602 });
  });

  it("DM1.6 messages from unknown connections are dropped", () => {
    const { daemon } = setup();
    expect(daemon.receive("ghost", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })).toEqual([]);
  });

  it("DM1.7 initialize requires a protocol version", () => {
    const { d } = setup();
    d.connect("c1", ALICE);
    expect(d.request("c1", "initialize", {}).error).toMatchObject({ code: -32602 });
  });
});

describe("Daemon: sessions and turns", () => {
  it("DM2.1 session/new returns a validated session id and attaches the creator with full grants", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    expect(parseId("session", sessionId)).toBe(sessionId);
    const tree = d.request("c1", "_harness/session/tree", { sessionId }).result as { nodes: { id: string; grants: string[] }[] };
    const me = tree.nodes.find((n) => n.id === "conn:c1")!;
    expect(me.grants.sort()).toEqual(["approve", "cancel", "control", "observe"]);
  });

  it("DM2.2 a prompt starts a turn: the worker is asked to run it", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.send("c1", { jsonrpc: "2.0", id: 50, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hi" }] } });
    const cmd = promptCommand(d.commands());
    expect(cmd).toMatchObject({ sessionId, prompt: [{ type: "text", text: "hi" }], cwd: "/work" });
    expect(parseId("task", cmd.turnId)).toBe(cmd.turnId);
    expect(d.inbox("c1")).toEqual([]);
  });

  it("DM2.3 worker updates stream to attached clients and the turn end answers the prompt", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.send("c1", { jsonrpc: "2.0", id: 50, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hi" }] } });
    const { turnId } = promptCommand(d.commands());
    d.worker({ type: "update", sessionId, turnId, update: text("hello") });
    d.worker({ type: "end", sessionId, turnId, stopReason: "end_turn" });
    expect(d.inbox("c1")).toEqual([
      { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: text("hello"), _meta: { harness: { offset: 3 } } } },
      { jsonrpc: "2.0", id: 50, result: { stopReason: "end_turn" } },
    ]);
  });

  it("DM2.5 a prompt while a turn is running is a conflict", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    expect(d.request("c1", "session/prompt", { sessionId, prompt: [] }).error).toMatchObject({ code: -32004 });
  });

  it("DM2.6 unknown sessions are not found", () => {
    const { d } = setup();
    d.connect("c1", ALICE);
    d.initialize("c1");
    expect(d.request("c1", "session/prompt", { sessionId: "ses_x", prompt: [] }).error).toMatchObject({ code: -32005 });
  });

  it("DM2.7 worker events for unknown sessions or stale turns are ignored", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.worker({ type: "update", sessionId: "ses_ghost", turnId: "t", update: text("x") });
    d.worker({ type: "update", sessionId, turnId: "not-the-turn", update: text("x") });
    d.worker({ type: "end", sessionId, turnId: "not-the-turn", stopReason: "end_turn" });
    expect(d.inbox("c1")).toEqual([]);
  });

  it("DM2.8 session/cancel asks the worker to stop the running turn", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = promptCommand(d.commands());
    d.notify("c1", "session/cancel", { sessionId });
    expect(d.commands()).toEqual([{ type: "cancel", sessionId, turnId }]);
    d.worker({ type: "end", sessionId, turnId, stopReason: "cancelled" });
    expect(d.inbox("c1")).toContainEqual({ jsonrpc: "2.0", id: 1, result: { stopReason: "cancelled" } });
  });

  it("DM2.9 cancelling when no turn is running does nothing", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.notify("c1", "session/cancel", { sessionId });
    expect(d.commands()).toEqual([]);
  });

  it("DM2.10 session/list shows only the caller's sessions", () => {
    const { d } = setup();
    const mine = openSession(d, "c1", ALICE);
    openSession(d, "c2", { principal: "bob", kind: "human" });
    expect(d.request("c1", "session/list", {}).result).toEqual({ sessions: [{ sessionId: mine, cwd: "/work" }] });
  });
});

describe("Daemon: multiplexing (MX1 detach/reattach)", () => {
  it("MX1.1 a turn outlives its prompting client; a new client replays everything once, in order", () => {
    const { d } = setup();
    const sessionId = openSession(d, "c1", ALICE, true);
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "go" }] } });
    const { turnId } = promptCommand(d.commands());
    d.worker({ type: "update", sessionId, turnId, update: text("one") });
    d.disconnect("c1");
    d.worker({ type: "update", sessionId, turnId, update: text("two") });
    d.worker({ type: "end", sessionId, turnId, stopReason: "end_turn" });

    d.connect("c2", { principal: "alice", kind: "client" });
    d.initialize("c2", true);
    const res = d.request("c2", "_harness/session/attach", { sessionId, from: 0 });
    expect(res.result).toMatchObject({ sessionId, head: 6 });
    const replay = d.inbox("c2");
    const offsets = replay.map((m) => (m.params?.["_meta"] as { harness: { offset: number } }).harness.offset);
    expect(offsets).toEqual([0, 1, 2, 3, 4, 5]);
    const updates = replay.filter((m) => m.method === "session/update").map((m) => m.params?.["update"]);
    expect(updates).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "go" } },
      text("one"),
      text("two"),
    ]);
    const events = replay.filter((m) => m.method === "_harness/session/event").map((m) => m.params?.["event"]);
    expect(events).toEqual(["session.created", "turn.started", "turn.ended"]);
  });

  it("MX1.2 attaching from an offset replays only the tail", () => {
    const { d } = setup();
    const sessionId = openSession(d, "c1", ALICE, true);
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = promptCommand(d.commands());
    d.worker({ type: "update", sessionId, turnId, update: text("a") });
    d.connect("c2", ALICE);
    d.initialize("c2", true);
    d.request("c2", "_harness/session/attach", { sessionId, from: 2 });
    const offsets = d.inbox("c2").map((m) => (m.params?.["_meta"] as { harness: { offset: number } }).harness.offset);
    expect(offsets).toEqual([2]);
  });

  it("MX1.3 other principals cannot attach", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.connect("c2", { principal: "mallory", kind: "human" });
    d.initialize("c2");
    expect(d.request("c2", "_harness/session/attach", { sessionId }).error).toMatchObject({ code: -32003 });
    expect(d.request("c2", "session/load", { sessionId, cwd: "/", mcpServers: [] }).error).toMatchObject({ code: -32003 });
  });

  it("MX1.4 a stock ACP client uses session/load to replay the conversation", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "q" }] } });
    const { turnId } = promptCommand(d.commands());
    d.worker({ type: "update", sessionId, turnId, update: text("answer") });
    d.worker({ type: "end", sessionId, turnId, stopReason: "end_turn" });
    d.connect("c2", ALICE);
    d.initialize("c2");
    const res = d.request("c2", "session/load", { sessionId, cwd: "/work", mcpServers: [] });
    expect(res.result).toEqual({});
    const updates = d.inbox("c2").map((m) => m.params?.["update"]);
    expect(updates).toEqual([{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "q" } }, text("answer")]);
  });

  it("MX1.5 observers receive the prompting client's messages; the prompter does not get an echo", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.connect("c2", ALICE);
    d.initialize("c2");
    d.request("c2", "session/load", { sessionId, cwd: "/work", mcpServers: [] });
    d.inbox("c2");
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "q" }] } });
    expect(d.inbox("c1")).toEqual([]);
    expect(d.inbox("c2").map((m) => m.params?.["update"])).toEqual([{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "q" } }]);
  });

  it("MX1.6 detaching explicitly stops delivery without affecting the turn", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = promptCommand(d.commands());
    expect(d.request("c1", "_harness/session/detach", { sessionId }).result).toEqual({});
    d.worker({ type: "update", sessionId, turnId, update: text("x") });
    expect(d.inbox("c1")).toEqual([]);
    expect(d.request("c1", "_harness/session/detach", { sessionId: "ses_nope" }).error).toMatchObject({ code: -32005 });
  });

  it("MX1.7 a detached client cannot prompt until it reattaches", () => {
    const { d } = setup();
    const sessionId = openSession(d);
    d.request("c1", "_harness/session/detach", { sessionId });
    expect(d.request("c1", "session/prompt", { sessionId, prompt: [] }).error).toMatchObject({ code: -32003 });
    d.request("c1", "_harness/session/attach", { sessionId });
    d.send("c1", { jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId, prompt: [] } });
    expect(d.commands().map((c) => c.type)).toEqual(["prompt"]);
  });
});

describe("Daemon: permission routing (MX3)", () => {
  function withPermission(d: DaemonDriver) {
    const sessionId = openSession(d, "c1");
    d.connect("c2", ALICE);
    d.initialize("c2");
    d.request("c2", "session/load", { sessionId, cwd: "/work", mcpServers: [] });
    d.connect("viewer", ALICE);
    d.initialize("viewer");
    d.request("viewer", "_harness/session/attach", { sessionId, grants: ["observe"] });
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = promptCommand(d.commands());
    ["c1", "c2", "viewer"].forEach((c) => d.inbox(c));
    d.worker({
      type: "permission",
      sessionId,
      turnId,
      requestId: "perm-1",
      toolCall: { toolCallId: "tc1", title: "rm -rf build" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    return { sessionId, turnId };
  }

  const permissionRequests = (d: DaemonDriver, conn: string) => d.inbox(conn).filter((m) => m.method === "session/request_permission");

  it("MX3.14 the request goes to approvers only, as ACP session/request_permission", () => {
    const { d } = setup();
    const { sessionId } = withPermission(d);
    const toC1 = permissionRequests(d, "c1");
    expect(toC1).toEqual([
      {
        jsonrpc: "2.0",
        id: expect.any(String),
        method: "session/request_permission",
        params: { sessionId, toolCall: { toolCallId: "tc1", title: "rm -rf build" }, options: expect.any(Array) },
      },
    ]);
    expect(permissionRequests(d, "c2")).toHaveLength(1);
    expect(permissionRequests(d, "viewer")).toHaveLength(0);
  });

  it("MX3.15 the first answer reaches the worker; other approvers are told to cancel; late answers are ignored", () => {
    const { d } = setup();
    const { sessionId, turnId } = withPermission(d);
    const a = permissionRequests(d, "c1")[0]!;
    const b = permissionRequests(d, "c2")[0]!;
    d.send("c2", { jsonrpc: "2.0", id: b.id, result: { outcome: { outcome: "selected", optionId: "deny" } } });
    expect(d.commands()).toEqual([{ type: "permission", sessionId, turnId, requestId: "perm-1", outcome: { outcome: "selected", optionId: "deny" } }]);
    expect(d.inbox("c1")).toEqual([{ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: a.id } }]);
    d.send("c1", { jsonrpc: "2.0", id: a.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    expect(d.commands()).toEqual([]);
  });

  it("MX3.16 an answer naming an option that was not offered is ignored", () => {
    const { d } = setup();
    withPermission(d);
    const a = permissionRequests(d, "c1")[0]!;
    d.send("c1", { jsonrpc: "2.0", id: a.id, result: { outcome: { outcome: "selected", optionId: "yolo" } } });
    expect(d.commands()).toEqual([]);
  });

  it("MX3.17 with no approver attached the request waits and is delivered when one attaches", () => {
    const { d } = setup();
    const sessionId = openSession(d, "c1");
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = promptCommand(d.commands());
    d.disconnect("c1");
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: { toolCallId: "t" }, options: [{ optionId: "ok", name: "OK", kind: "allow_once" }] });
    expect(d.commands()).toEqual([]);
    d.connect("c3", ALICE);
    d.initialize("c3");
    d.request("c3", "session/load", { sessionId, cwd: "/work", mcpServers: [] });
    const reqs = d.inbox("c3").filter((m) => m.method === "session/request_permission");
    expect(reqs).toHaveLength(1);
    d.send("c3", { jsonrpc: "2.0", id: reqs[0]!.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    expect(d.commands()).toEqual([{ type: "permission", sessionId, turnId, requestId: "p", outcome: { outcome: "selected", optionId: "ok" } }]);
  });

  it("MX3.18 cancelling the turn cancels pending permission requests", () => {
    const { d } = setup();
    const { sessionId, turnId } = withPermission(d);
    const a = permissionRequests(d, "c1")[0]!;
    d.notify("c1", "session/cancel", { sessionId });
    expect(d.commands()).toEqual([
      { type: "permission", sessionId, turnId, requestId: "perm-1", outcome: { outcome: "cancelled" } },
      { type: "cancel", sessionId, turnId },
    ]);
    expect(d.inbox("c1")).toEqual([{ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: a.id } }]);
  });

  it("MX3.19 permission requests past the timeout are cancelled on tick", () => {
    const { d, clock } = setup({ permissionTimeoutMs: 500 });
    const { sessionId, turnId } = withPermission(d);
    permissionRequests(d, "c1");
    clock.advance(499);
    d.tick();
    expect(d.commands()).toEqual([]);
    clock.advance(1);
    d.tick();
    expect(d.commands()).toEqual([{ type: "permission", sessionId, turnId, requestId: "perm-1", outcome: { outcome: "cancelled" } }]);
  });

  it("MX3.20 a client error response to a permission request is ignored", () => {
    const { d } = setup();
    withPermission(d);
    const a = permissionRequests(d, "c1")[0]!;
    d.send("c1", { jsonrpc: "2.0", id: a.id, error: { code: -32603, message: "ui closed" } });
    d.send("c1", { jsonrpc: "2.0", id: "unknown-id", result: {} });
    expect(d.commands()).toEqual([]);
  });

  it("MX3.21 a malformed permission answer is ignored", () => {
    const { d } = setup();
    withPermission(d);
    const a = permissionRequests(d, "c1")[0]!;
    d.send("c1", { jsonrpc: "2.0", id: a.id, result: { outcome: "yes" } });
    expect(d.commands()).toEqual([]);
  });
});

describe("Daemon: permission edge cases", () => {
  function pending(d: DaemonDriver) {
    const sessionId = openSession(d, "c1");
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = promptCommand(d.commands());
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: { toolCallId: "t" }, options: [{ optionId: "ok", name: "OK", kind: "allow_once" }] });
    const req = d.inbox("c1").find((m) => m.method === "session/request_permission")!;
    return { sessionId, turnId, req };
  }

  it("MX3.22 an approver that detaches loses its outstanding request; on reattach it gets a fresh one", () => {
    const { d } = setup();
    const { sessionId, turnId, req } = pending(d);
    d.request("c1", "_harness/session/detach", { sessionId });
    d.send("c1", { jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    expect(d.commands()).toEqual([]);
    d.request("c1", "_harness/session/attach", { sessionId });
    const fresh = d.inbox("c1").find((m) => m.method === "session/request_permission")!;
    expect(fresh.id).not.toBe(req.id);
    d.send("c1", { jsonrpc: "2.0", id: fresh.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    expect(d.commands()).toEqual([{ type: "permission", sessionId, turnId, requestId: "p", outcome: { outcome: "selected", optionId: "ok" } }]);
  });

  it("MX3.23 a turn that ends with a permission still open cancels it everywhere", () => {
    const { d } = setup();
    const { sessionId, turnId, req } = pending(d);
    d.worker({ type: "end", sessionId, turnId, stopReason: "end_turn" });
    expect(d.commands()).toEqual([{ type: "permission", sessionId, turnId, requestId: "p", outcome: { outcome: "cancelled" } }]);
    expect(d.inbox("c1")).toEqual([
      { jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: req.id } },
      { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } },
    ]);
  });

  it("MX3.24 a response from a different connection than the one asked is ignored", () => {
    const { d } = setup();
    const { sessionId, req } = pending(d);
    d.connect("c2", ALICE);
    d.initialize("c2");
    d.request("c2", "_harness/session/attach", { sessionId, grants: ["observe"] });
    d.send("c2", { jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    expect(d.commands()).toEqual([]);
  });
});

describe("Daemon: flow control (MX2)", () => {
  it("MX2.12 a profile client that stops acking is switched to resync; a stock client is not", () => {
    const { d } = setup({ flowCapacity: 2 });
    const sessionId = openSession(d, "slow", ALICE, true);
    d.connect("stock", ALICE);
    d.initialize("stock");
    d.request("stock", "session/load", { sessionId, cwd: "/work", mcpServers: [] });
    d.send("slow", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = promptCommand(d.commands());
    d.inbox("slow");
    d.inbox("stock");
    for (let i = 0; i < 5; i++) d.worker({ type: "update", sessionId, turnId, update: text(`${i}`) });
    const slow = d.inbox("slow");
    expect(slow.at(-1)).toEqual({ jsonrpc: "2.0", method: "_harness/session/resync", params: { sessionId, head: expect.any(Number) } });
    expect(slow.filter((m) => m.method === "session/update").length).toBeLessThan(5);
    expect(d.inbox("stock").filter((m) => m.method === "session/update")).toHaveLength(5);
  });

  it("MX2.13 acknowledging keeps a profile client streaming", () => {
    const { d } = setup({ flowCapacity: 2 });
    const sessionId = openSession(d, "c1", ALICE, true);
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = promptCommand(d.commands());
    const started = d.inbox("c1");
    expect(started.map((m) => m.method)).toEqual(["_harness/session/event"]);
    for (let i = 0; i < 6; i++) {
      d.worker({ type: "update", sessionId, turnId, update: text(`${i}`) });
      const got = d.inbox("c1");
      expect(got.map((m) => m.method)).toEqual(["session/update"]);
      const offset = (got[0]!.params!["_meta"] as { harness: { offset: number } }).harness.offset;
      expect(d.request("c1", "_harness/session/ack", { sessionId, offset }).result).toEqual({});
    }
  });

  it("MX2.14 acking an offset that was never delivered is invalid", () => {
    const { d } = setup({ flowCapacity: 2 });
    const sessionId = openSession(d, "c1", ALICE, true);
    expect(d.request("c1", "_harness/session/ack", { sessionId, offset: 99 }).error).toMatchObject({ code: -32602 });
  });
});

describe("Daemon: capabilities and hooks", () => {
  it("DM6.1 client-offered capabilities are listed and withdrawn when the client disconnects", () => {
    const { d, daemon } = setup();
    d.connect("ext", { principal: "alice", kind: "client" });
    d.initialize("ext");
    expect(d.request("ext", "_harness/capabilities/offer", { name: "browser.tabs", version: 1 }).result).toEqual({});
    expect(d.request("ext", "_harness/capabilities/list").result).toEqual({
      capabilities: [{ providerId: "conn:ext", name: "browser.tabs", version: 1, provenance: "client", trust: "untrusted" }],
    });
    d.disconnect("ext");
    expect(daemon.capabilities()).toEqual([]);
  });

  it("DM6.2 an offer with bad params or a duplicate offer is rejected", () => {
    const { d } = setup();
    d.connect("ext", { principal: "alice", kind: "client" });
    d.initialize("ext");
    expect(d.request("ext", "_harness/capabilities/offer", { name: "x" }).error).toMatchObject({ code: -32602 });
    d.request("ext", "_harness/capabilities/offer", { name: "x", version: 1 });
    expect(d.request("ext", "_harness/capabilities/offer", { name: "x", version: 1 }).error).toMatchObject({ code: -32004 });
  });

  it("DM6.3 a client can withdraw its own capability", () => {
    const { d, daemon } = setup();
    d.connect("ext", { principal: "alice", kind: "client" });
    d.initialize("ext");
    d.request("ext", "_harness/capabilities/offer", { name: "x", version: 1 });
    expect(d.request("ext", "_harness/capabilities/withdraw", { name: "x" }).result).toEqual({});
    expect(daemon.capabilities()).toEqual([]);
  });

  it("DM7.1 plugins subscribe to hook events and poll them with sagas intact", () => {
    const { d } = setup();
    d.connect("plg", { principal: "tracker", kind: "plugin" });
    d.initialize("plg");
    expect(d.request("plg", "_harness/hooks/subscribe", { types: ["session.*", "turn.*"] }).result).toEqual({});
    const sessionId = openSession(d);
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = promptCommand(d.commands());
    d.worker({ type: "end", sessionId, turnId, stopReason: "end_turn" });
    const events = (d.request("plg", "_harness/hooks/poll", {}).result as { events: { type: string; sessionId: string }[] }).events;
    expect(events.map((e) => e.type)).toEqual(["session.created", "session.attached", "turn.started", "turn.ended"]);
    expect(events.every((e) => e.sessionId === sessionId)).toBe(true);
  });

  it("DM7.2 acking advances the plugin cursor; non-plugins cannot subscribe", () => {
    const { d } = setup();
    d.connect("plg", { principal: "tracker", kind: "plugin" });
    d.initialize("plg");
    d.request("plg", "_harness/hooks/subscribe", { types: ["*"] });
    openSession(d);
    const first = (d.request("plg", "_harness/hooks/poll", { max: 1 }).result as { events: { offset: number }[] }).events;
    expect(d.request("plg", "_harness/hooks/ack", { offset: first[0]!.offset }).result).toEqual({});
    const rest = (d.request("plg", "_harness/hooks/poll", {}).result as { events: { offset: number }[] }).events;
    expect(rest[0]!.offset).toBe(first[0]!.offset + 1);
    expect(d.request("c1", "_harness/hooks/subscribe", { types: ["*"] }).error).toMatchObject({ code: -32003 });
    expect(d.request("plg", "_harness/hooks/ack", { offset: 999 }).error).toMatchObject({ code: -32602 });
    expect(d.request("plg", "_harness/hooks/subscribe", { types: "nope" }).error).toMatchObject({ code: -32602 });
  });

  it("DM7.3 capability changes are published as hook events", () => {
    const { d } = setup();
    d.connect("plg", { principal: "audit", kind: "plugin" });
    d.initialize("plg");
    d.request("plg", "_harness/hooks/subscribe", { types: ["capability.*"] });
    d.connect("ext", { principal: "alice", kind: "client" });
    d.initialize("ext");
    d.request("ext", "_harness/capabilities/offer", { name: "browser.tabs", version: 1 });
    d.disconnect("ext");
    const events = (d.request("plg", "_harness/hooks/poll", {}).result as { events: { type: string }[] }).events;
    expect(events.map((e) => e.type)).toEqual(["capability.added", "capability.revoked"]);
  });
});

describe("Daemon: restart (MX5)", () => {
  it("MX5.1 a restored daemon keeps sessions and history; interrupted turns are marked, never lost", () => {
    const { d, clock, daemon } = setup();
    const sessionId = openSession(d);
    d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "go" }] } });
    const { turnId } = promptCommand(d.commands());
    d.worker({ type: "update", sessionId, turnId, update: text("partial") });
    const snapshot = JSON.parse(JSON.stringify(daemon.snapshot()));

    const restored = Daemon.restore(snapshot, { clock, entropy: new SeededEntropy(2), agentInfo: { name: "harness", version: "0.0.0" } });
    const r = new DaemonDriver(restored);
    r.connect("c9", ALICE);
    r.initialize("c9");
    expect(r.request("c9", "session/list", {}).result).toEqual({ sessions: [{ sessionId, cwd: "/work" }] });
    r.request("c9", "session/load", { sessionId, cwd: "/work", mcpServers: [] });
    const updates = r.inbox("c9").map((m) => m.params?.["update"] as { sessionUpdate: string });
    expect(updates.map((u) => u.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk", "notice"]);
    expect(updates.at(-1)).toMatchObject({ sessionUpdate: "notice", severity: "warning", title: "Turn interrupted by daemon restart" });
    r.send("c9", { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [] } });
    expect(r.commands().map((c) => c.type)).toEqual(["prompt"]);
  });

  it("MX5.2 restore rejects malformed snapshots", () => {
    const { clock } = setup();
    const deps = { clock, entropy: new SeededEntropy(2), agentInfo: { name: "h", version: "0" } };
    expect(() => Daemon.restore(null, deps)).toThrow(/invalid/);
    expect(() => Daemon.restore({ sessions: 1 }, deps)).toThrow(/invalid/);
  });
});

describe("Daemon: determinism and input lease", () => {
  it("DM8.1 identical inputs and seeds give identical outputs (trace parity)", () => {
    const script = (daemon: Daemon) => {
      const d = new DaemonDriver(daemon);
      const sessionId = openSession(d);
      d.send("c1", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "x" }] } });
      const { turnId } = promptCommand(d.commands());
      d.worker({ type: "update", sessionId, turnId, update: text("y") });
      d.worker({ type: "end", sessionId, turnId, stopReason: "end_turn" });
      return JSON.stringify({ inbox: d.inbox("c1"), snapshot: daemon.snapshot() });
    };
    const make = () => new Daemon({ clock: new ManualClock(5), entropy: new SeededEntropy(9), agentInfo: { name: "h", version: "0" } });
    expect(script(make())).toBe(script(make()));
  });

  it("MX7.14 an agent client cannot take input from a human who holds the lease; a human can preempt an agent", () => {
    const { d } = setup();
    const sessionId = openSession(d, "bot", { principal: "alice", kind: "agent" });
    d.send("bot", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = promptCommand(d.commands());
    d.worker({ type: "end", sessionId, turnId, stopReason: "end_turn" });
    d.connect("me", ALICE);
    d.initialize("me");
    d.request("me", "session/load", { sessionId, cwd: "/work", mcpServers: [] });
    d.send("me", { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId, prompt: [] } });
    const t2 = promptCommand(d.commands()).turnId;
    d.worker({ type: "end", sessionId, turnId: t2, stopReason: "end_turn" });
    expect(d.request("bot", "session/prompt", { sessionId, prompt: [] }).error).toMatchObject({ code: -32004, message: expect.stringMatching(/lease/) });
  });
});
