import { describe, expect, it } from "vitest";
import { Daemon } from "@harness/core";
import type { Identity, WorkerCommand } from "@harness/core";
import { DaemonDriver, ManualClock, SeededEntropy } from "@harness/testkit";

const ALICE: Identity = { principal: "alice", kind: "human" };
const PLUGIN: Identity = { principal: "audit", kind: "plugin" };

function setup(extra: { hookDepth?: number; flowCapacity?: number } = {}) {
  const clock = new ManualClock(1_000);
  const daemon = new Daemon({ clock, entropy: new SeededEntropy(3), agentInfo: { name: "h", version: "1" }, ...extra });
  return { d: new DaemonDriver(daemon), daemon, clock };
}

function open(d: DaemonDriver, conn = "c1", identity: Identity = ALICE, harness = false): string {
  d.connect(conn, identity);
  d.initialize(conn, harness);
  const sessionId = (d.request(conn, "session/new", { cwd: "/w", mcpServers: [] }).result as { sessionId: string }).sessionId;
  return sessionId;
}

function prompt(d: DaemonDriver, conn: string, sessionId: string, id = 1): string {
  d.send(conn, { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [] } });
  const cmd = d.commands().find((c) => c.type === "prompt") as Extract<WorkerCommand, { type: "prompt" }>;
  return cmd.turnId;
}

const offer = [{ optionId: "ok", name: "OK", kind: "allow_once" }, { optionId: "no", name: "No", kind: "reject_once" }];

describe("Daemon hardening: responses and validation", () => {
  it("DH1.1 initialize advertises session listing and no auth methods", () => {
    const { d } = setup();
    d.connect("c1", ALICE);
    const res = d.initialize("c1").result as Record<string, unknown>;
    expect(res["authMethods"]).toEqual([]);
    expect(res["agentCapabilities"]).toEqual({ loadSession: true, sessionCapabilities: { list: {} }, promptCapabilities: {} });
  });

  it("DH1.2 offsets and limits must be non-negative integers", () => {
    const { d } = setup();
    const sessionId = open(d, "c1", ALICE, true);
    for (const offset of [-1, 1.5, "2"]) expect(d.request("c1", "_harness/session/ack", { sessionId, offset }).error, String(offset)).toMatchObject({ code: -32602 });
    expect(d.request("c1", "_harness/session/attach", { sessionId, from: -3 }).error).toMatchObject({ code: -32602 });
    expect(d.request("c1", "_harness/session/attach", { sessionId, from: 999 }).error).toMatchObject({ code: -32602 });
    d.connect("p", PLUGIN);
    d.initialize("p");
    d.request("p", "_harness/hooks/subscribe", { types: ["*"] });
    expect(d.request("p", "_harness/hooks/poll", { max: -1 }).error).toMatchObject({ code: -32602 });
    expect(d.request("p", "_harness/hooks/subscribe", { types: ["ok", 5] }).error).toMatchObject({ code: -32602 });
    expect(d.request("p", "_harness/hooks/subscribe", { types: ["*"], from: -1 }).error).toMatchObject({ code: -32602 });
  });

  it("DH1.3 the session tree is visible only to the owner", () => {
    const { d } = setup();
    const sessionId = open(d);
    d.connect("m", { principal: "mallory", kind: "human" });
    d.initialize("m");
    expect(d.request("m", "_harness/session/tree", { sessionId }).error).toMatchObject({ code: -32003 });
  });

  it("DH1.4 the worker node can only observe", () => {
    const { d } = setup();
    const sessionId = open(d);
    const tree = d.request("c1", "_harness/session/tree", { sessionId }).result as { nodes: { id: string; grants: string[]; state: string }[] };
    expect(tree.nodes.find((n) => n.id === "worker")).toMatchObject({ grants: ["observe"], state: "active" });
  });

  it("DH1.5 attach grants are the intersection of what was asked and what the owner may hold", () => {
    const { d } = setup();
    const sessionId = open(d);
    d.connect("c2", ALICE);
    d.initialize("c2");
    const res = d.request("c2", "_harness/session/attach", { sessionId, grants: ["observe", "approve", "spawn"] });
    expect((res.result as { grants: string[] }).grants.sort()).toEqual(["approve", "observe"]);
  });

  it("DH1.6 the creating client does not get the creation event replayed to it", () => {
    const { d } = setup();
    open(d, "c1", ALICE, true);
    expect(d.inbox("c1")).toEqual([]);
  });
});

describe("Daemon hardening: disconnects and detaches", () => {
  it("DH2.1 disconnecting detaches the client's node and nothing is sent to it afterwards", () => {
    const { d, daemon } = setup();
    const sessionId = open(d);
    const turnId = prompt(d, "c1", sessionId);
    d.disconnect("c1");
    const outputs = daemon.workerEvent({ type: "end", sessionId, turnId, stopReason: "end_turn" });
    expect(outputs.filter((o) => o.kind === "send")).toEqual([]);
    d.connect("c2", ALICE);
    d.initialize("c2");
    const tree = d.request("c2", "_harness/session/tree", { sessionId }).result as { nodes: { id: string; state: string }[] };
    expect(tree.nodes.find((n) => n.id === "conn:c1")?.state).toBe("detached");
  });

  it("DH2.2 detaching releases the input lease", () => {
    const { d } = setup();
    const sessionId = open(d, "human", ALICE);
    const t1 = prompt(d, "human", sessionId, 1);
    d.worker({ type: "end", sessionId, turnId: t1, stopReason: "end_turn" });
    d.request("human", "_harness/session/detach", { sessionId });
    d.connect("bot", { principal: "alice", kind: "agent" });
    d.initialize("bot");
    d.request("bot", "_harness/session/attach", { sessionId });
    d.send("bot", { jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId, prompt: [] } });
    expect(d.commands().map((c) => c.type)).toEqual(["prompt"]);
  });

  it("DH2.3 a detached approver is not told to cancel a request it no longer holds", () => {
    const { d } = setup();
    const sessionId = open(d, "c1");
    d.connect("c2", ALICE);
    d.initialize("c2");
    d.request("c2", "session/load", { sessionId, cwd: "/w", mcpServers: [] });
    const turnId = prompt(d, "c1", sessionId);
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: {}, options: offer });
    const req = d.inbox("c2").find((m) => m.method === "session/request_permission")!;
    d.request("c1", "_harness/session/detach", { sessionId });
    d.inbox("c1");
    d.send("c2", { jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    expect(d.inbox("c1")).toEqual([]);
    expect(d.inbox("c2").filter((m) => m.method === "$/cancel_request")).toEqual([]);
  });
});

describe("Daemon hardening: permissions", () => {
  it("DH3.1 a duplicate permission request id from the worker is ignored", () => {
    const { d } = setup();
    const sessionId = open(d);
    const turnId = prompt(d, "c1", sessionId);
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: {}, options: offer });
    d.inbox("c1");
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: {}, options: offer });
    expect(d.inbox("c1")).toEqual([]);
  });

  it("DH3.2 an approver can answer with an explicit cancellation", () => {
    const { d } = setup();
    const sessionId = open(d);
    const turnId = prompt(d, "c1", sessionId);
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: {}, options: offer });
    const req = d.inbox("c1").find((m) => m.method === "session/request_permission")!;
    d.send("c1", { jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "cancelled" } } });
    expect(d.commands()).toEqual([{ type: "permission", sessionId, turnId, requestId: "p", outcome: { outcome: "cancelled" } }]);
  });

  it("DH3.3 answers without a valid outcome shape are ignored", () => {
    for (const outcome of [{ outcome: "selected" }, { outcome: "maybe", optionId: "ok" }, { outcome: "selected", optionId: 7 }, "selected"]) {
      const { d } = setup();
      const sessionId = open(d);
      const turnId = prompt(d, "c1", sessionId);
      d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: {}, options: offer });
      const req = d.inbox("c1").find((m) => m.method === "session/request_permission")!;
      d.send("c1", { jsonrpc: "2.0", id: req.id, result: { outcome } });
      expect(d.commands(), JSON.stringify(outcome)).toEqual([]);
    }
  });

  it("DH3.7 after a turn is cancelled, an approver who attaches later is not asked about the cancelled request", () => {
    const { d } = setup();
    const sessionId = open(d);
    const turnId = prompt(d, "c1", sessionId);
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: {}, options: offer });
    d.notify("c1", "session/cancel", { sessionId });
    d.connect("late", ALICE);
    d.initialize("late");
    d.request("late", "_harness/session/attach", { sessionId });
    expect(d.inbox("late").filter((m) => m.method === "session/request_permission")).toEqual([]);
  });

  it("DH3.4 an approver cannot answer a request that was sent to a different connection", () => {
    const { d } = setup();
    const sessionId = open(d, "c1");
    d.connect("c2", ALICE);
    d.initialize("c2");
    d.request("c2", "session/load", { sessionId, cwd: "/w", mcpServers: [] });
    const turnId = prompt(d, "c1", sessionId);
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: {}, options: offer });
    const toC1 = d.inbox("c1").find((m) => m.method === "session/request_permission")!;
    d.send("c2", { jsonrpc: "2.0", id: toC1.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    expect(d.commands()).toEqual([]);
  });

  it("DH3.5 the answering approver is not asked to cancel its own request", () => {
    const { d } = setup();
    const sessionId = open(d, "c1");
    const turnId = prompt(d, "c1", sessionId);
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: {}, options: offer });
    const req = d.inbox("c1").find((m) => m.method === "session/request_permission")!;
    d.send("c1", { jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    expect(d.inbox("c1")).toEqual([]);
  });

  it("DH3.6 a client holding only the cancel grant can cancel; an observer cannot", () => {
    const { d } = setup();
    const sessionId = open(d, "c1");
    const turnId = prompt(d, "c1", sessionId);
    d.connect("obs", ALICE);
    d.initialize("obs");
    d.request("obs", "_harness/session/attach", { sessionId, grants: ["observe"] });
    d.notify("obs", "session/cancel", { sessionId });
    expect(d.commands()).toEqual([]);
    d.connect("stop", ALICE);
    d.initialize("stop");
    d.request("stop", "_harness/session/attach", { sessionId, grants: ["observe", "cancel"] });
    d.notify("stop", "session/cancel", { sessionId });
    expect(d.commands()).toEqual([{ type: "cancel", sessionId, turnId }]);
  });
});

describe("Daemon hardening: events and hooks carry their data", () => {
  it("DH4.1 session log events carry their payloads", () => {
    const { d } = setup();
    const sessionId = open(d, "c1");
    const turnId = prompt(d, "c1", sessionId);
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: {}, options: offer });
    const req = d.inbox("c1").find((m) => m.method === "session/request_permission")!;
    d.send("c1", { jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    d.worker({ type: "end", sessionId, turnId, stopReason: "end_turn" });
    d.connect("h", ALICE);
    d.initialize("h", true);
    d.request("h", "_harness/session/attach", { sessionId, from: 0 });
    const events = d.inbox("h").filter((m) => m.method === "_harness/session/event").map((m) => [m.params?.["event"], m.params?.["data"]]);
    expect(events).toEqual([
      ["session.created", { cwd: "/w", owner: "alice" }],
      ["turn.started", { turnId, by: "conn:c1" }],
      ["permission.requested", { requestId: "p" }],
      ["permission.resolved", { requestId: "p", outcome: { outcome: "selected", optionId: "ok" }, by: "conn:c1" }],
      ["turn.ended", { turnId, stopReason: "end_turn" }],
    ]);
  });

  it("DH4.2 hook events carry their payloads", () => {
    const { d } = setup();
    d.connect("p", PLUGIN);
    d.initialize("p");
    d.request("p", "_harness/hooks/subscribe", { types: ["session.*", "turn.*", "permission.*"] });
    const sessionId = open(d, "c1");
    const turnId = prompt(d, "c1", sessionId);
    d.worker({ type: "permission", sessionId, turnId, requestId: "p", toolCall: {}, options: offer });
    const req = d.inbox("c1").find((m) => m.method === "session/request_permission")!;
    d.send("c1", { jsonrpc: "2.0", id: req.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    d.worker({ type: "end", sessionId, turnId, stopReason: "end_turn" });
    d.disconnect("c1");
    const events = (d.request("p", "_harness/hooks/poll", {}).result as { events: { type: string; payload: unknown }[] }).events;
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["session.created", { cwd: "/w" }],
      ["session.attached", { nodeId: "conn:c1" }],
      ["turn.started", { turnId }],
      ["permission.requested", { requestId: "p" }],
      ["permission.resolved", { requestId: "p", by: "conn:c1" }],
      ["turn.ended", { turnId, stopReason: "end_turn" }],
      ["session.detached", { nodeId: "conn:c1" }],
    ]);
  });

  it("DH4.3 hook polling honours max; subscriptions honour session filters and start offsets", () => {
    const { d } = setup();
    d.connect("p", PLUGIN);
    d.initialize("p");
    const s1 = open(d, "c1");
    open(d, "c2");
    d.request("p", "_harness/hooks/subscribe", { types: ["*"], sessionId: s1, from: 0 });
    const all = (d.request("p", "_harness/hooks/poll", {}).result as { events: { sessionId?: string }[] }).events;
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((e) => e.sessionId === s1)).toBe(true);
    expect((d.request("p", "_harness/hooks/poll", { max: 1 }).result as { events: unknown[] }).events).toHaveLength(1);
  });

  it("DH4.4 withdrawing a capability publishes the revocation; plugin offers are marked as plugin provenance", () => {
    const { d, daemon } = setup();
    d.connect("audit", PLUGIN);
    d.initialize("audit");
    d.request("audit", "_harness/hooks/subscribe", { types: ["capability.revoked"] });
    d.connect("tool", { principal: "tools", kind: "plugin" });
    d.initialize("tool");
    d.request("tool", "_harness/capabilities/offer", { name: "search", version: 2 });
    expect(daemon.capabilities()).toEqual([{ providerId: "conn:tool", name: "search", version: 2, provenance: "plugin", trust: "untrusted" }]);
    d.request("tool", "_harness/capabilities/withdraw", { name: "search" });
    expect((d.request("audit", "_harness/hooks/poll", {}).result as { events: { type: string }[] }).events.map((e) => e.type)).toEqual(["capability.revoked"]);
  });

  it("DH4.5 a lagging profile client is told to resync exactly once", () => {
    const { d } = setup({ flowCapacity: 1 });
    const sessionId = open(d, "c1", ALICE, true);
    const turnId = prompt(d, "c1", sessionId);
    for (let i = 0; i < 4; i++) d.worker({ type: "update", sessionId, turnId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${i}` } } });
    expect(d.inbox("c1").filter((m) => m.method === "_harness/session/resync")).toHaveLength(1);
  });
});

describe("Daemon hardening: more validation and hook timing", () => {
  it("DH6.1 a prompt that is not an array is invalid", () => {
    const { d } = setup();
    const sessionId = open(d);
    expect(d.request("c1", "session/prompt", { sessionId, prompt: "hello" }).error).toMatchObject({ code: -32602 });
  });

  it("DH6.2 polling before subscribing is invalid", () => {
    const { d } = setup();
    d.connect("p", PLUGIN);
    d.initialize("p");
    expect(d.request("p", "_harness/hooks/poll", {}).error).toMatchObject({ code: -32602 });
  });

  it("DH6.3 capability additions are published as soon as they happen", () => {
    const { d, daemon } = setup();
    d.connect("audit", PLUGIN);
    d.initialize("audit");
    d.request("audit", "_harness/hooks/subscribe", { types: ["capability.added"] });
    daemon.offerPlatformCapability({ name: "pty", version: 1, trust: "trusted" });
    d.connect("ext", { principal: "alice", kind: "client" });
    d.initialize("ext");
    d.request("ext", "_harness/capabilities/offer", { name: "tabs", version: 1 });
    const events = (d.request("audit", "_harness/hooks/poll", {}).result as { events: { payload: { providerId: string } }[] }).events;
    expect(events.map((e) => e.payload.providerId)).toEqual(["platform", "conn:ext"]);
  });
});

describe("Daemon hardening: restore", () => {
  it("DH5.1 restore detaches connection nodes, keeps daemon nodes active and records the interrupted turn", () => {
    const { d, daemon, clock } = setup();
    const sessionId = open(d, "c1");
    const turnId = prompt(d, "c1", sessionId);
    const quiet = open(d, "c2");
    const restored = Daemon.restore(JSON.parse(JSON.stringify(daemon.snapshot())), { clock, entropy: new SeededEntropy(4), agentInfo: { name: "h", version: "1" } });
    const r = new DaemonDriver(restored);
    r.connect("x", ALICE);
    r.initialize("x", true);
    const tree = r.request("x", "_harness/session/tree", { sessionId }).result as { nodes: { id: string; state: string }[] };
    expect(Object.fromEntries(tree.nodes.map((n) => [n.id, n.state]))).toEqual({ daemon: "active", worker: "active", "conn:c1": "detached" });
    r.request("x", "_harness/session/attach", { sessionId, from: 0 });
    const events = r.inbox("x").filter((m) => m.method === "_harness/session/event").map((m) => [m.params?.["event"], m.params?.["data"]]);
    expect(events.at(-1)).toEqual(["turn.interrupted", { turnId }]);
    r.request("x", "_harness/session/attach", { sessionId: quiet, from: 0 });
    expect(r.inbox("x").some((m) => m.params?.["event"] === "turn.interrupted")).toBe(false);
  });

  it("DH5.2 the hook depth limit applies to restored daemons too", () => {
    const { daemon, clock } = setup({ hookDepth: 0 });
    const snap = JSON.parse(JSON.stringify(daemon.snapshot()));
    expect(() => Daemon.restore({ ...snap, sessions: "nope" }, { clock, entropy: new SeededEntropy(1), agentInfo: { name: "h", version: "1" } })).toThrow(/invalid daemon snapshot/);
  });
});
