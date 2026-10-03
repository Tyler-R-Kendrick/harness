import { describe, expect, it } from "vitest";
import { Daemon } from "@harness/core";
import type { Identity, PermissionOptionSpec, WorkerCommand } from "@harness/core";
import { DaemonDriver, ManualClock, SeededEntropy } from "@harness/testkit";

const ALICE: Identity = { principal: "alice", kind: "human" };
const BOB: Identity = { principal: "bob", kind: "human" };

const OPTIONS: PermissionOptionSpec[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

function setup(options: { permissionTimeoutMs?: number } = {}) {
  const clock = new ManualClock(1_000);
  const deps = { clock, entropy: new SeededEntropy(5), agentInfo: { name: "h", version: "1" }, ...options };
  const daemon = new Daemon(deps);
  return { d: new DaemonDriver(daemon), daemon, clock, deps };
}

function open(d: DaemonDriver, conn: string, identity: Identity, cwd = "/w"): string {
  d.connect(conn, identity);
  d.initialize(conn);
  return (d.request(conn, "session/new", { cwd, mcpServers: [] }).result as { sessionId: string }).sessionId;
}

/** Starts a turn on the session and returns its id. */
function startTurn(d: DaemonDriver, conn: string, sessionId: string): string {
  d.send(conn, { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId, prompt: [] } });
  const command = d.commands().find((c) => c.type === "prompt") as Extract<WorkerCommand, { type: "prompt" }>;
  return command.turnId;
}

function ask(d: DaemonDriver, sessionId: string, turnId: string, requestId: string, title = "rm -rf build"): void {
  d.worker({ type: "permission", sessionId, turnId, requestId, toolCall: { toolCallId: `call-${requestId}`, title, rawInput: { path: "/w/build" } }, options: OPTIONS });
}

describe("Daemon accessors for permission requests", () => {
  it("DCP1.1 an open request is described by its turn, tool call and options", () => {
    const { d, daemon } = setup();
    const sessionId = open(d, "c1", ALICE);
    const turnId = startTurn(d, "c1", sessionId);
    ask(d, sessionId, turnId, "p1");
    expect(daemon.pendingPermission(sessionId, "p1")).toEqual({
      turnId,
      toolCall: { toolCallId: "call-p1", title: "rm -rf build", rawInput: { path: "/w/build" } },
      options: OPTIONS,
    });
  });

  it("DCP1.2 a session, request or already answered request that is not open has no description", () => {
    const { d, daemon } = setup();
    const sessionId = open(d, "c1", ALICE);
    const turnId = startTurn(d, "c1", sessionId);
    expect(daemon.pendingPermission(sessionId, "p1")).toBeUndefined();
    expect(daemon.pendingPermission("session-nope", "p1")).toBeUndefined();
    ask(d, sessionId, turnId, "p1");
    expect(daemon.pendingPermission(sessionId, "p1")).toBeDefined();
    expect(daemon.pendingPermission(sessionId, "p2")).toBeUndefined();
    const asked = d.inbox("c1").find((m) => m.method === "session/request_permission")!;
    d.send("c1", { jsonrpc: "2.0", id: asked.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    expect(daemon.pendingPermission(sessionId, "p1")).toBeUndefined();
  });

  it("DCP1.3 what is returned is a copy: changing it changes neither later answers nor what the client is asked", () => {
    const { d, daemon } = setup();
    const sessionId = open(d, "c1", ALICE);
    const turnId = startTurn(d, "c1", sessionId);
    d.inbox("c1");
    ask(d, sessionId, turnId, "p1");
    const first = daemon.pendingPermission(sessionId, "p1")!;
    first.options[0]!.name = "Changed";
    (first.toolCall as { title: string }).title = "changed";
    (first.toolCall.rawInput as { path: string }).path = "/";
    (first.options as PermissionOptionSpec[]).length = 0;
    expect(daemon.pendingPermission(sessionId, "p1")).toEqual({
      turnId,
      toolCall: { toolCallId: "call-p1", title: "rm -rf build", rawInput: { path: "/w/build" } },
      options: OPTIONS,
    });
    const listed = daemon.pendingPermissions(sessionId)[0]!;
    listed.options[1]!.name = "Changed";
    expect(daemon.pendingPermissions()[0]!.options).toEqual(OPTIONS);
  });

  it("DCP1.4 the open requests are listed with their session and request ids, in the order they were opened", () => {
    const { d, daemon } = setup();
    const s1 = open(d, "c1", ALICE, "/one");
    const s2 = open(d, "c2", BOB, "/two");
    const t1 = startTurn(d, "c1", s1);
    const t2 = startTurn(d, "c2", s2);
    ask(d, s1, t1, "a", "first");
    ask(d, s2, t2, "b", "second");
    ask(d, s1, t1, "c", "third");
    expect(daemon.pendingPermissions().map((p) => [p.sessionId, p.requestId, p.turnId])).toEqual([
      [s1, "a", t1],
      [s1, "c", t1],
      [s2, "b", t2],
    ]);
    expect(daemon.pendingPermissions()[0]).toEqual({
      sessionId: s1,
      requestId: "a",
      turnId: t1,
      toolCall: { toolCallId: "call-a", title: "first", rawInput: { path: "/w/build" } },
      options: OPTIONS,
    });
  });

  it("DCP1.5 listing for one session leaves out the others, and a session with none (or none at all) lists none", () => {
    const { d, daemon } = setup();
    const s1 = open(d, "c1", ALICE);
    const s2 = open(d, "c2", BOB);
    const t1 = startTurn(d, "c1", s1);
    expect(daemon.pendingPermissions()).toEqual([]);
    ask(d, s1, t1, "a");
    expect(daemon.pendingPermissions(s1).map((p) => p.requestId)).toEqual(["a"]);
    expect(daemon.pendingPermissions(s2)).toEqual([]);
    expect(daemon.pendingPermissions("session-nope")).toEqual([]);
  });

  it("DCP1.6 a request answered, cancelled with its turn or expired is no longer listed", () => {
    const { d, daemon, clock } = setup({ permissionTimeoutMs: 500 });
    const sessionId = open(d, "c1", ALICE);
    const turnId = startTurn(d, "c1", sessionId);
    ask(d, sessionId, turnId, "late");
    clock.advance(600);
    d.tick();
    expect(daemon.pendingPermissions(sessionId)).toEqual([]);
    ask(d, sessionId, turnId, "open");
    expect(daemon.pendingPermissions(sessionId)).toHaveLength(1);
    d.worker({ type: "end", sessionId, turnId, stopReason: "end_turn" });
    expect(daemon.pendingPermissions()).toEqual([]);
  });

  it("DCP1.7 sessions lists every session with its owner and working directory, and the turn running in it", () => {
    const { d, daemon } = setup();
    expect(daemon.sessions()).toEqual([]);
    const s1 = open(d, "c1", ALICE, "/one");
    const s2 = open(d, "c2", BOB, "/two");
    const turnId = startTurn(d, "c2", s2);
    expect(daemon.sessions()).toEqual([
      { id: s1, cwd: "/one", owner: "alice" },
      { id: s2, cwd: "/two", owner: "bob", turnId },
    ]);
    expect("turnId" in daemon.sessions()[0]!).toBe(false);
    d.worker({ type: "end", sessionId: s2, turnId, stopReason: "end_turn" });
    expect(daemon.sessions()[1]).toEqual({ id: s2, cwd: "/two", owner: "bob" });
  });

  it("DCP1.8 the accessors read without changing the daemon: the snapshot is the same and carries no permission requests", () => {
    const { d, daemon } = setup();
    const sessionId = open(d, "c1", ALICE);
    const turnId = startTurn(d, "c1", sessionId);
    ask(d, sessionId, turnId, "p1");
    const before = JSON.stringify(daemon.snapshot());
    daemon.pendingPermission(sessionId, "p1");
    daemon.pendingPermissions();
    daemon.sessions();
    expect(JSON.stringify(daemon.snapshot())).toBe(before);
    expect(Object.keys(daemon.snapshot().sessions[0]!).sort()).toEqual(["cwd", "id", "log", "owner", "tree", "turnId"]);
  });

  it("DCP1.9 a restored daemon lists its sessions, with no turn and no open request", () => {
    const { d, daemon, deps } = setup();
    const sessionId = open(d, "c1", ALICE, "/one");
    const turnId = startTurn(d, "c1", sessionId);
    ask(d, sessionId, turnId, "p1");
    const restored = Daemon.restore(JSON.parse(JSON.stringify(daemon.snapshot())), deps);
    expect(restored.sessions()).toEqual([{ id: sessionId, cwd: "/one", owner: "alice" }]);
    expect(restored.pendingPermissions()).toEqual([]);
  });
});
