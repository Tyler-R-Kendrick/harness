import { describe, expect, it, vi } from "vitest";
import { Daemon, SessionLog } from "@harness/core";
import type { DaemonDeps, Identity, WorkerCommand } from "@harness/core";
import { DaemonDriver, ManualClock, SeededEntropy } from "@harness/testkit";

const ALICE: Identity = { principal: "alice", kind: "human" };
const PLUGIN: Identity = { principal: "learner", kind: "plugin" };

const deps = (clock = new ManualClock(1_000)): DaemonDeps => ({ clock, entropy: new SeededEntropy(3), agentInfo: { name: "h", version: "1" } });

function driver(daemon = new Daemon(deps())) {
  const d = new DaemonDriver(daemon);
  d.connect("c1", ALICE);
  d.initialize("c1");
  return d;
}

const newSession = (d: DaemonDriver, extra: Record<string, unknown> = {}) => d.request("c1", "session/new", { cwd: "/w", mcpServers: [], ...extra });

function prompt(d: DaemonDriver, sessionId: string, load = false): Extract<WorkerCommand, { type: "prompt" }> {
  if (load) d.request("c1", "session/load", { sessionId, cwd: "/w", mcpServers: [] });
  d.send("c1", { jsonrpc: "2.0", id: 900, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hi" }] } });
  return d.commands().find((c) => c.type === "prompt") as Extract<WorkerCommand, { type: "prompt" }>;
}

function endTurn(d: DaemonDriver, command: Extract<WorkerCommand, { type: "prompt" }>) {
  d.worker({ type: "end", sessionId: command.sessionId, turnId: command.turnId, stopReason: "end_turn" });
}

function subscribedPlugin(d: DaemonDriver, types: readonly string[] = ["*"]) {
  d.connect("p", PLUGIN);
  d.initialize("p");
  d.request("p", "_harness/hooks/subscribe", { types });
}

const poll = (d: DaemonDriver) => (d.request("p", "_harness/hooks/poll", {}).result as { events: Record<string, unknown>[] }).events;

describe("session meta from session/new", () => {
  it("DM10.1 _meta.harness.session is passed, unchanged, on every prompt command of the session", () => {
    const d = driver();
    const meta = { project: "harness", tags: ["a", "b"], nested: { depth: 2 } };
    const sessionId = (newSession(d, { _meta: { harness: { session: meta } } }).result as { sessionId: string }).sessionId;
    const first = prompt(d, sessionId);
    expect(first.sessionMeta).toStrictEqual(meta);
    endTurn(d, first);
    expect(prompt(d, sessionId).sessionMeta).toStrictEqual(meta);
  });

  it("DM10.2 a session made without it has no sessionMeta on its prompt commands", () => {
    const d = driver();
    const plain = (newSession(d).result as { sessionId: string }).sessionId;
    expect(Object.keys(prompt(d, plain))).not.toContain("sessionMeta");
    const otherHarnessMeta = (newSession(d, { _meta: { harness: { other: 1 } } }).result as { sessionId: string }).sessionId;
    expect(Object.keys(prompt(d, otherHarnessMeta))).not.toContain("sessionMeta");
    const noHarness = (newSession(d, { _meta: { vendor: { session: { a: 1 } } } }).result as { sessionId: string }).sessionId;
    expect(Object.keys(prompt(d, noHarness))).not.toContain("sessionMeta");
  });

  it("DM10.3 a session meta that is not a JSON object is rejected as invalid params, and no session is made", () => {
    const d = driver();
    for (const bad of [null, "project", 3, true, ["a"]]) {
      expect(newSession(d, { _meta: { harness: { session: bad } } }).error).toStrictEqual({ code: -32602, message: "_meta.harness.session must be a JSON object" });
    }
    expect((d.request("c1", "session/list", {}).result as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it("DM10.4 core does not interpret it: keys that look like session fields change nothing", () => {
    const d = driver();
    const meta = { cwd: "/elsewhere", owner: "mallory", sessionId: "ses_x" };
    const sessionId = (newSession(d, { _meta: { harness: { session: meta } } }).result as { sessionId: string }).sessionId;
    const command = prompt(d, sessionId);
    expect(command.cwd).toBe("/w");
    expect(command.sessionId).toBe(sessionId);
    expect((d.request("c1", "session/list", {}).result as { sessions: unknown[] }).sessions).toEqual([{ sessionId, cwd: "/w" }]);
  });

  it("DM10.5 it is kept in the snapshot and survives a restore", () => {
    const daemon = new Daemon(deps());
    const d = driver(daemon);
    const meta = { project: "harness" };
    const sessionId = (newSession(d, { _meta: { harness: { session: meta } } }).result as { sessionId: string }).sessionId;
    const plain = (newSession(d).result as { sessionId: string }).sessionId;
    const snapshot = JSON.parse(JSON.stringify(daemon.snapshot())) as { version: number; sessions: Record<string, unknown>[] };
    expect(snapshot.version).toBe(1);
    expect(snapshot.sessions.find((s) => s["id"] === sessionId)?.["sessionMeta"]).toStrictEqual(meta);
    expect(Object.keys(snapshot.sessions.find((s) => s["id"] === plain)!)).not.toContain("sessionMeta");
    const r = driver(Daemon.restore(snapshot, deps()));
    expect(prompt(r, sessionId, true).sessionMeta).toStrictEqual(meta);
  });

  it("DM10.6 an older snapshot without it restores, and a malformed one in a snapshot is dropped", () => {
    const daemon = new Daemon(deps());
    const d = driver(daemon);
    const a = (newSession(d).result as { sessionId: string }).sessionId;
    const b = (newSession(d).result as { sessionId: string }).sessionId;
    const snapshot = JSON.parse(JSON.stringify(daemon.snapshot())) as { sessions: Record<string, unknown>[] };
    expect(Object.keys(snapshot.sessions[0]!)).not.toContain("sessionMeta");
    snapshot.sessions[1]!["sessionMeta"] = ["not", "an", "object"];
    const r = driver(Daemon.restore(snapshot, deps()));
    expect(Object.keys(prompt(r, a, true))).not.toContain("sessionMeta");
    expect(Object.keys(prompt(r, b, true))).not.toContain("sessionMeta");
    expect(Object.keys(r.daemon.snapshot().sessions.find((s) => s.id === b)!)).not.toContain("sessionMeta");
  });
});

describe("host-side publish", () => {
  it("DM10.7 the host publishes a hook event under its own source; subscribed plugins receive it", () => {
    const clock = new ManualClock(5_000);
    const d = driver(new Daemon(deps(clock)));
    subscribedPlugin(d, ["procedural.*"]);
    const r = d.daemon.publish({ source: "host:procedural", type: "procedural.dreamed", sessionId: "ses_1", correlationId: "cor-dream", payload: { graph: "g" } });
    expect(r).toStrictEqual({
      ok: true,
      value: { eventId: "evt-0", offset: 0, type: "procedural.dreamed", source: "host:procedural", sessionId: "ses_1", correlationId: "cor-dream", depth: 0, at: 5_000, payload: { graph: "g" } },
    });
    expect(poll(d)).toStrictEqual([r.ok ? r.value : undefined]);
  });

  it("DM10.8 an event without session or correlation gets neither a session nor a borrowed correlation", () => {
    const d = driver();
    const r = d.daemon.publish({ source: "host", type: "x", payload: null });
    expect(r.ok && r.value).toStrictEqual({ eventId: "evt-0", offset: 0, type: "x", source: "host", correlationId: "cor-0", depth: 0, at: 1_000, payload: null });
  });

  it("DM10.9 a caused event joins its cause's saga; an unknown cause or too deep a chain is an error", () => {
    const d = new Daemon({ ...deps(), hookDepth: 1 });
    const root = d.publish({ source: "host", type: "a", correlationId: "saga", payload: 1 });
    const rootId = root.ok ? root.value.eventId : "";
    const child = d.publish({ source: "host", type: "b", cause: rootId, payload: 2 });
    expect(child.ok && [child.value.correlationId, child.value.causationId, child.value.depth]).toStrictEqual(["saga", rootId, 1]);
    const grandchild = d.publish({ source: "host", type: "c", cause: child.ok ? child.value.eventId : "", payload: 3 });
    expect(grandchild.ok ? undefined : grandchild.error.code).toBe("depth_exceeded");
    const orphan = d.publish({ source: "host", type: "d", cause: "evt-99", payload: 4 });
    expect(orphan.ok ? undefined : orphan.error.code).toBe("unknown_cause");
  });

  it("DM10.10 peers still cannot publish: there is no publish method, and a plugin never picks a source", () => {
    const d = driver();
    subscribedPlugin(d);
    for (const conn of ["c1", "p"]) {
      expect(d.request(conn, "_harness/hooks/publish", { source: "daemon", type: "session.created", payload: {} }).error).toMatchObject({ code: -32601 });
    }
    expect(poll(d)).toEqual([]);
  });

  it("DM10.11 published events are in the snapshot and a restored daemon still delivers them", () => {
    const daemon = new Daemon(deps());
    const d = driver(daemon);
    subscribedPlugin(d, ["procedural.*"]);
    daemon.publish({ source: "host", type: "procedural.reverted", payload: { to: 2 } });
    const r = driver(Daemon.restore(JSON.parse(JSON.stringify(daemon.snapshot())), deps()));
    r.connect("p", PLUGIN);
    r.initialize("p");
    expect(poll(r).map((e) => [e["type"], e["source"], e["payload"]])).toEqual([["procedural.reverted", "host", { to: 2 }]]);
  });
});

describe("host-side log reads", () => {
  /** A daemon with two sessions, the first with one ended turn in its log. */
  function twoSessions() {
    const daemon = new Daemon(deps());
    const d = driver(daemon);
    const first = (newSession(d).result as { sessionId: string }).sessionId;
    const second = (newSession(d).result as { sessionId: string }).sessionId;
    endTurn(d, prompt(d, first));
    return { daemon, d, first, second };
  }

  const entriesOf = (daemon: Daemon, sessionId: string) => (daemon.snapshot().sessions.find((s) => s.id === sessionId)!.log as { entries: unknown[] }).entries;

  it("DM10.12 readLog returns a session's entries in [from, to), as its log holds them; to defaults to the head", () => {
    const { daemon, first } = twoSessions();
    const all = entriesOf(daemon, first);
    expect(all.length).toBeGreaterThan(2);
    expect(daemon.readLog(first)).toStrictEqual(all);
    expect(daemon.readLog(first, 1)).toStrictEqual(all.slice(1));
    expect(daemon.readLog(first, 1, 2)).toStrictEqual(all.slice(1, 2));
    expect(daemon.readLog(first, 0, 1_000)).toStrictEqual(all);
    expect(daemon.readLog(first, all.length)).toStrictEqual([]);
    expect(daemon.readLog(first, all.length + 5)).toStrictEqual([]);
    expect(daemon.readLog(first, 2, 1)).toStrictEqual([]);
    expect(daemon.readLog(first, 2, 2)).toStrictEqual([]);
  });

  it("DM10.13 readLog of an unknown session is empty, and a negative or fractional bound is a RangeError", () => {
    const { daemon, first } = twoSessions();
    expect(daemon.readLog("ses_unknown")).toStrictEqual([]);
    for (const [from, to] of [[-1, undefined], [0.5, undefined], [0, -1], [0, 1.5], [Number.NaN, undefined]] as const) {
      expect(() => daemon.readLog(first, from, to)).toThrow(RangeError);
    }
  });

  it("DM10.14 readLog copies no session's log but the one read, and what it returns is the caller's", () => {
    const { daemon, first } = twoSessions();
    const toJSON = vi.spyOn(SessionLog.prototype, "toJSON");
    try {
      const read = daemon.readLog(first) as unknown[];
      expect(toJSON).not.toHaveBeenCalled();
      read.length = 0;
      expect(daemon.readLog(first).length).toBeGreaterThan(2);
    } finally {
      toJSON.mockRestore();
    }
  });

  it("DM10.15 entries compacted below a restored log's base are gone: a read starts at the base", () => {
    const { daemon, first } = twoSessions();
    const snapshot = JSON.parse(JSON.stringify(daemon.snapshot())) as { sessions: { id: string; log: { base: number; entries: unknown[] } }[] };
    const log = snapshot.sessions.find((s) => s.id === first)!.log;
    const kept = log.entries.slice(2);
    snapshot.sessions.find((s) => s.id === first)!.log = { base: 2, entries: kept };
    const restored = Daemon.restore(snapshot, deps());
    expect(restored.readLog(first)).toStrictEqual(kept);
    expect(restored.readLog(first, 0, 3)).toStrictEqual(kept.slice(0, 1));
    expect(restored.readLog(first, 0, 2)).toStrictEqual([]);
  });
});
