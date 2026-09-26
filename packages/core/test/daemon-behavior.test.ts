import { describe, expect, it } from "vitest";
import { Daemon } from "@harness/core";
import type { Identity, WorkerCommand } from "@harness/core";
import { DaemonDriver, ManualClock, SeededEntropy } from "@harness/testkit";

const ALICE: Identity = { principal: "alice", kind: "human" };
const BOB: Identity = { principal: "bob", kind: "human" };
const PLUGIN: Identity = { principal: "mood", kind: "plugin" };

function setup() {
  const daemon = new Daemon({ clock: new ManualClock(1_000), entropy: new SeededEntropy(5), agentInfo: { name: "h", version: "1" } });
  const d = new DaemonDriver(daemon);
  d.connect("c1", ALICE);
  d.initialize("c1");
  const sessionId = (d.request("c1", "session/new", { cwd: "/w", mcpServers: [] }).result as { sessionId: string }).sessionId;
  d.connect("p", PLUGIN);
  d.initialize("p");
  d.request("p", "_harness/hooks/subscribe", { types: ["behavior.*"] });
  return { d, sessionId, daemon };
}

const hooks = (d: DaemonDriver) => (d.request("p", "_harness/hooks/poll", {}).result as { events: { type: string; sessionId?: string; payload: unknown }[] }).events.map((e) => [e.type, e.sessionId, e.payload]);
const logEvents = (d: DaemonDriver, sessionId: string) => {
  d.connect("h", ALICE);
  d.initialize("h", true);
  d.request("h", "_harness/session/attach", { sessionId, from: 0 });
  return d.inbox("h").filter((m) => m.method === "_harness/session/event").map((m) => [m.params?.["event"], m.params?.["data"]]);
};

describe("behavior per daemon session", () => {
  it("DB1.1 a behavior state change in a turn's updates is published as a behavior.changed hook event, with its turn", () => {
    const { d, sessionId } = setup();
    d.send("c1", { jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = d.commands().find((c) => c.type === "prompt") as Extract<WorkerCommand, { type: "prompt" }>;
    const change = { state: "soothing", from: "neutral", cause: "sensor userAngry on" };
    d.worker({ type: "update", sessionId, turnId, update: { sessionUpdate: "notice", severity: "info", title: "Behavior: soothing", _meta: { harness: { behavior: change } } } });
    d.worker({ type: "update", sessionId, turnId, update: { sessionUpdate: "notice", severity: "info", title: "not behavior" } });
    d.worker({ type: "update", sessionId, turnId, update: { sessionUpdate: "notice", severity: "info", title: "bad", _meta: { harness: { behavior: { state: 3 } } } } });
    expect(hooks(d)).toEqual([["behavior.changed", sessionId, { turnId, ...change }]]);
  });

  it("DB1.2 a plugin raises a behavior event for a session: the worker is told, and the raise is published", () => {
    const { d, sessionId } = setup();
    expect(d.request("p", "_harness/behavior/event", { sessionId, event: "praised" }).result).toEqual({});
    expect(d.commands()).toEqual([{ type: "event", sessionId, name: "praised" }]);
    expect(hooks(d)).toEqual([["behavior.raised", sessionId, { event: "praised", by: "mood" }]]);
  });

  it("DB1.3 an attached client with control may raise one too; an observer, a stranger or a bad request may not", () => {
    const { d, sessionId } = setup();
    expect(d.request("c1", "_harness/behavior/event", { sessionId, event: "calm" }).result).toEqual({});
    d.connect("obs", ALICE);
    d.initialize("obs");
    d.request("obs", "_harness/session/attach", { sessionId, grants: ["observe"] });
    expect(d.request("obs", "_harness/behavior/event", { sessionId, event: "calm" }).error).toMatchObject({ code: -32003 });
    d.connect("bob", BOB);
    d.initialize("bob");
    expect(d.request("bob", "_harness/behavior/event", { sessionId, event: "calm" }).error).toMatchObject({ code: -32003 });
    expect(d.request("p", "_harness/behavior/event", { sessionId: "nope", event: "calm" }).error).toMatchObject({ code: -32005 });
    expect(d.request("p", "_harness/behavior/event", { sessionId }).error).toMatchObject({ code: -32602 });
    expect(d.commands()).toEqual([{ type: "event", sessionId, name: "calm" }]);
  });

  it("DB1.4 a behavior change the worker reports between turns is kept in the session log and published", () => {
    const { d, sessionId } = setup();
    d.worker({ type: "behavior", sessionId, change: { state: "cheerful", from: "neutral", cause: "event praised" } });
    d.worker({ type: "behavior", sessionId: "gone", change: { state: "x" } });
    expect(hooks(d)).toEqual([["behavior.changed", sessionId, { state: "cheerful", from: "neutral", cause: "event praised" }]]);
    expect(logEvents(d, sessionId)).toContainEqual(["behavior.changed", { state: "cheerful", from: "neutral", cause: "event praised" }]);
  });

  it("DB1.5 a change's from and cause are kept only when they are text; nothing else is added", () => {
    const { d, sessionId } = setup();
    d.send("c1", { jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = d.commands().find((c) => c.type === "prompt") as Extract<WorkerCommand, { type: "prompt" }>;
    const update = (behavior: unknown) => d.worker({ type: "update", sessionId, turnId, update: { sessionUpdate: "notice", severity: "info", title: "b", _meta: { harness: { behavior } } } });
    update({ state: "wary", from: 3, cause: null });
    update({ state: "calm" });
    const published = hooks(d).map(([, , payload]) => payload);
    expect(published).toStrictEqual([{ turnId, state: "wary" }, { turnId, state: "calm" }]);
  });

  it("DB1.6 a change between turns is logged as an event, a turn's update as an update", () => {
    const { d, sessionId, daemon } = setup();
    d.worker({ type: "behavior", sessionId, change: { state: "cheerful" } });
    d.send("c1", { jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId, prompt: [] } });
    const { turnId } = d.commands().find((c) => c.type === "prompt") as Extract<WorkerCommand, { type: "prompt" }>;
    d.worker({ type: "update", sessionId, turnId, update: { sessionUpdate: "notice", severity: "info", title: "hi" } });
    const log = daemon.snapshot().sessions[0]!.log as { entries: { kind: string; payload: { event?: string; update?: unknown } }[] };
    expect(log.entries.filter((e) => e.payload.event === "behavior.changed").map((e) => e.kind)).toEqual(["event"]);
    expect(log.entries.filter((e) => (e.payload.update as { title?: string } | undefined)?.title === "hi").map((e) => e.kind)).toEqual(["update"]);
  });

  it("DB1.7 a bad raise names the field that is wrong", () => {
    const { d, sessionId } = setup();
    expect(d.request("p", "_harness/behavior/event", { event: "calm" }).error).toMatchObject({ message: expect.stringMatching(/^sessionId must be a string/) });
    expect(d.request("p", "_harness/behavior/event", { sessionId }).error).toMatchObject({ message: expect.stringMatching(/^event must be a string/) });
  });
});
