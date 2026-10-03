import { describe, expect, it, vi } from "vitest";
import { DecisionPlugin, PLUGIN_EVENTS } from "../src/plugin.ts";
import type { DecisionPluginOptions, HookEventLike } from "../src/plugin.ts";
import type { PermissionFacts } from "../src/permission.ts";
import { forkId } from "../src/types.ts";
import { FakeBus, FakeFacts, OPTIONS } from "./plugin-fixtures.ts";
import type { PermissionOptionLike } from "../src/plugin.ts";
import { rig, saying, shippedAuthority } from "./compose-fixtures.ts";
import type { RigOptions } from "./compose-fixtures.ts";

const CRITICAL = { boolean: 0.95, score: [0, 0, 0.1, 0.9] };
const ROUTINE = { boolean: 0.02, score: [0.9, 0.1, 0, 0] };
const RM: PermissionFacts = { tool: "Bash", kind: "execute", command: "rm -rf build", cwd: "/w", session: "s1" };
const READ: PermissionFacts = { tool: "Read", kind: "read", path: "/w/a.ts", cwd: "/w", session: "s1" };

function build(over: { layer?: RigOptions; plugin?: Partial<DecisionPluginOptions> } = {}) {
  const bus = new FakeBus();
  const facts = new FakeFacts();
  const errors: [unknown, HookEventLike | undefined][] = [];
  const r = rig({ members: [saying("m", CRITICAL)], authority: shippedAuthority(), ...over.layer });
  const plugin = new DecisionPlugin({ layer: r.layer, source: bus, facts, onError: (e, ev) => void errors.push([e, ev]), ...over.plugin });
  const world = {
    /** A request the daemon has opened and announced. */
    request(session = "s1", requestId = "p1", asks: PermissionFacts = RM, options: readonly PermissionOptionLike[] | null = OPTIONS) {
      facts.openRequest(session, requestId, asks, options ?? undefined);
      facts.append(session, "event", { event: "permission.requested", data: { requestId } });
      return bus.publish("permission.requested", session, { requestId });
    },
    /** The request answered by a person (an option id) or cancelled (null). */
    resolve(session = "s1", requestId = "p1", optionId: string | null = "allow", by = "alice") {
      facts.closeRequest(session, requestId);
      facts.append(session, "event", { event: "permission.resolved", data: { requestId, outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId }, by } });
      return bus.publish("permission.resolved", session, { requestId, by });
    },
    turnStarted: (session = "s1") => bus.publish("turn.started", session, { turnId: "t1" }),
    turnEnded: (session = "s1", stopReason = "end_turn") => bus.publish("turn.ended", session, { turnId: "t1", stopReason }),
  };
  return { ...r, bus, facts, plugin, errors, ...world };
}
type Built = ReturnType<typeof build>;
const started = async (over: Parameters<typeof build>[0] = {}): Promise<Built> => {
  const b = build(over);
  await b.plugin.start();
  return b;
};
const ids = (b: Built) => b.layer.inbox.list().map((i) => i.id);

describe("starting and stopping", () => {
  it("DPL1.1 starting subscribes to the events it reacts to from the bus's stored cursor, and only once", async () => {
    const { plugin, bus } = build();
    expect(plugin.running).toBe(false);
    await plugin.start();
    await plugin.start();
    expect(plugin.running).toBe(true);
    expect(bus.subscribed).toEqual([{ types: ["permission.requested", "permission.resolved", "turn.started", "turn.ended", "session.detached"], from: undefined }]);
    expect([...PLUGIN_EVENTS]).toEqual(bus.subscribed[0]!.types);
  });

  it("DPL1.2 a starting offset is passed to the subscription", async () => {
    const { plugin, bus } = build({ plugin: { from: 7 } });
    await plugin.start();
    expect(bus.subscribed[0]!.from).toBe(7);
  });

  it("DPL1.3 a subscription that fails fails the start, and the plugin is not running", async () => {
    const { plugin, bus } = build();
    bus.failSubscribe = new Error("no bus");
    await expect(plugin.start()).rejects.toThrow("no bus");
    expect(plugin.running).toBe(false);
    bus.failSubscribe = undefined;
    await plugin.start();
    expect(plugin.running).toBe(true);
  });

  it("DPL1.4 before it is started, and after it is stopped, a step does nothing and does not even poll; stopping twice is fine", async () => {
    const b = build();
    b.request();
    expect(await b.plugin.step()).toBe(0);
    await b.plugin.start();
    b.plugin.stop();
    b.plugin.stop();
    expect(b.plugin.running).toBe(false);
    expect(await b.plugin.step()).toBe(0);
    expect(b.bus.calls).toEqual(["subscribe"]);
    await b.plugin.start();
    expect(await b.plugin.step()).toBe(1);
  });

  it("DPL1.5 events it does not react to are not handled: a bus that delivers more than was asked for changes nothing", async () => {
    const b = await started();
    b.bus.subscribed[0]!.types.push("session.created", "capability.added");
    b.bus.publish("session.created", "s1", { cwd: "/w" });
    b.bus.publish("capability.added", undefined, {});
    expect(await b.plugin.step()).toBe(2);
    expect(b.errors).toEqual([]);
    expect(await b.layer.records()).toEqual([]);
    expect(b.layer.inbox.list()).toEqual([]);
    expect(b.bus.acked).toEqual([0, 1]);
  });
});

describe("a permission request", () => {
  it("DPL2.1 is put in the inbox as a blocked permission item and annotated with the risk the layer judged", async () => {
    const b = await started();
    const event = b.request();
    expect(await b.plugin.step()).toBe(1);
    expect(b.layer.inbox.list()).toEqual([{ id: "permission:s1:p1", session: "s1", kind: "permission", since: event.at, blocked: true, text: "Bash: rm -rf build (risk: critical)" }]);
    const [record] = await b.layer.records({ fork: forkId("permission.risk") });
    expect(record).toMatchObject({ action: "critical", session: "s1", correlation: event.correlationId, rung: "model", mode: "active" });
    expect(record!.input).toMatchObject({ tool: "Bash", command: "rm -rf build" });
    expect(b.published.map((p) => [p.type, p.sessionId, p.payload.action])).toEqual([["decision.made", "s1", "critical"]]);
    expect(b.bus.acked).toEqual([event.offset]);
  });

  it("DPL2.2 shows a person what they need and not the secrets: the text and the record have them removed", async () => {
    const b = await started();
    b.request("s1", "p1", { tool: "Bash", kind: "execute", command: "deploy --token sk-live-12345 --env prod", input: { password: "hunter2", note: "ok" } });
    await b.plugin.step();
    expect(b.layer.inbox.list()[0]!.text).not.toContain("sk-live-12345");
    expect(b.layer.inbox.list()[0]!.text).toContain("[redacted]");
    const [record] = await b.layer.records({ fork: forkId("permission.risk") });
    expect(JSON.stringify(record)).not.toContain("sk-live-12345");
    expect(JSON.stringify(record)).not.toContain("hunter2");
  });

  it("DPL2.3 the item names the path or the url when there is no command, and just the tool when there is nothing else", async () => {
    const b = await started();
    b.request("s1", "a", READ);
    b.request("s1", "b", { tool: "WebFetch", url: "https://example.com/x" });
    b.request("s1", "c", { tool: "Think" });
    await b.plugin.step();
    expect(b.layer.inbox.list().map((i) => i.text)).toEqual(["Read: /w/a.ts (risk: critical)", "WebFetch: https://example.com/x (risk: critical)", "Think (risk: critical)"]);
  });

  it("DPL2.4 a request that was answered before the plugin looked has no annotation and no item", async () => {
    const b = await started();
    b.bus.publish("permission.requested", "s1", { requestId: "gone" });
    expect(await b.plugin.step()).toBe(1);
    expect(b.layer.inbox.list()).toEqual([]);
    expect(await b.layer.records()).toEqual([]);
  });

  it("DPL2.5 when the annotation fails the request is still in front of the person, the failure is reported, and the event is acknowledged", async () => {
    const b = await started({ layer: { members: [] } });
    // an input the fork refuses
    b.request("s1", "bad", { tool: "" });
    const good = b.request("s1", "ok", RM);
    expect(await b.plugin.step()).toBe(1);
    expect(ids(b)).toEqual(["permission:s1:bad", "permission:s1:ok"]);
    expect(b.errors).toHaveLength(1);
    expect(String(b.errors[0]![0])).toContain("invalid permission facts");
    expect(b.errors[0]![1]!.type).toBe("permission.requested");
    expect(b.bus.acked).toEqual([0, good.offset]);
    expect(b.layer.inbox.get("permission:s1:ok")!.text).toBe("Bash: rm -rf build (risk: careful)");
    expect(b.layer.inbox.get("permission:s1:bad")!.text).toBe("");
  });

  it("DPL2.6 a fork in shadow mode decides and records but the item says nothing of the risk", async () => {
    const b = await started({ layer: { policyPatch: { forks: { "permission.risk": { mode: "shadow" } } } } });
    b.request();
    await b.plugin.step();
    expect(b.layer.inbox.list()[0]!.text).toBe("Bash: rm -rf build");
    expect((await b.layer.records())[0]).toMatchObject({ mode: "shadow", action: "critical" });
  });

  it("DPL2.7 an event with no request id, or no session, is a failure that is reported", async () => {
    const b = await started();
    b.bus.publish("permission.requested", "s1", {});
    b.bus.publish("permission.requested", "s1", "nonsense");
    b.bus.publish("permission.requested", undefined, { requestId: "p1" });
    expect(await b.plugin.step()).toBe(0);
    expect(b.errors.map(([e]) => (e as Error).message)).toEqual([
      "permission.requested (evt-0) names no request",
      "permission.requested (evt-1) names no request",
      "permission.requested (evt-2) names no session",
    ]);
    expect(b.bus.acked).toEqual([0, 1, 2]);
  });

  it("DPL2.8 with assessment on, each item is also asked of the attention fork, and a model's urgency ranks it; a person-asked fallback does not", async () => {
    const urgent = saying("m", { boolean: 0.95, score: [0, 0, 0.1, 0.9] });
    const b = await started({ layer: { members: [urgent] }, plugin: { assess: true } });
    b.request();
    await b.plugin.step();
    const item = b.layer.inbox.list()[0]!;
    expect(item.urgency).toBe(1);
    expect((await b.layer.records({ fork: forkId("attention") })).length).toBeGreaterThan(0);
    const low = await started({ layer: { members: [saying("m", { score: [0.9, 0.05, 0.03, 0.02] })] }, plugin: { assess: true } });
    // a review item has no floor, so a model that finds it of no urgency gets that into the item
    low.facts.world.sessionIds.add("s1");
    low.turnEnded();
    await low.plugin.step();
    expect(low.layer.inbox.get("review:s1")!.urgency).toBe(0);
    const none = await started({ layer: { members: [] }, plugin: { assess: true } });
    none.request();
    await none.plugin.step();
    expect("urgency" in none.layer.inbox.list()[0]!).toBe(false);
    const off = await started();
    off.request();
    await off.plugin.step();
    expect(await off.layer.records({ fork: forkId("attention") })).toEqual([]);
  });

  it("DPL2.9 the options offered are read from the facts when they can say, and a facts source that cannot say still works (it only loses the outcome)", async () => {
    const b = await started();
    b.request();
    await b.plugin.step();
    expect(b.facts.calls).toContain("permissionOptions");
    const plain = build();
    const without = new DecisionPlugin({ layer: plain.layer, source: plain.bus, facts: { permission: (s, r) => plain.facts.permission(s, r), log: (s, a) => plain.facts.log(s, a), sessions: () => plain.facts.sessions() } });
    await without.start();
    plain.request();
    expect(await without.step()).toBe(1);
    plain.resolve();
    expect(await without.step()).toBe(1);
    expect((await plain.layer.records({ fork: forkId("permission.risk") }))[0]!.outcome).toBeUndefined();
  });
});

describe("a permission resolved", () => {
  const outcomeOf = async (b: Built) => (await b.layer.records({ fork: forkId("permission.risk") }))[0]!.outcome;

  it("DPL3.1 takes the item out of the inbox and records the person's choice as the decision's outcome", async () => {
    const b = await started({ layer: { members: [saying("m", ROUTINE)] } });
    b.request("s1", "p1", READ);
    await b.plugin.step();
    expect(ids(b)).toEqual(["permission:s1:p1"]);
    const event = b.resolve("s1", "p1", "allow", "alice");
    expect(await b.plugin.step()).toBe(1);
    expect(ids(b)).toEqual([]);
    expect(await outcomeOf(b)).toEqual({ at: event.at, source: "human", kind: "approved", correct: true, by: "alice" });
  });

  it("DPL3.2 judges the person's choice against the risk level: approving routine and denying critical are right, the opposite wrong, and careful says nothing", async () => {
    const cases: [string, "allow" | "deny", boolean | undefined][] = [
      ["routine", "allow", true],
      ["routine", "deny", false],
      ["critical", "deny", true],
      ["critical", "allow", false],
      ["careful", "allow", undefined],
      ["careful", "deny", undefined],
    ];
    for (const [risk, choice, correct] of cases) {
      const members = { routine: [saying("m", ROUTINE)], critical: [saying("m", CRITICAL)], careful: [saying("m", ROUTINE)] }[risk]!;
      const b = await started({ layer: { members } });
      b.request("s1", "p1", risk === "careful" ? RM : risk === "routine" ? READ : RM);
      await b.plugin.step();
      b.resolve("s1", "p1", choice);
      await b.plugin.step();
      const outcome = await outcomeOf(b);
      expect(outcome).toMatchObject({ kind: choice === "allow" ? "approved" : "denied", source: "human" });
      expect(outcome!.correct, `${risk} ${choice}`).toBe(correct);
      expect("correct" in outcome!).toBe(correct !== undefined);
    }
  });

  it("DPL3.3 a request cancelled or timed out gives no outcome, but still leaves the inbox", async () => {
    const b = await started();
    b.request();
    await b.plugin.step();
    b.resolve("s1", "p1", null, "system");
    expect(await b.plugin.step()).toBe(1);
    expect(ids(b)).toEqual([]);
    expect(await outcomeOf(b)).toBeUndefined();
  });

  it("DPL3.4 a request it never saw leaves the inbox and nothing else happens", async () => {
    const b = await started();
    b.layer.inbox.add({ id: "permission:s1:old", session: "s1", kind: "permission", since: 1, blocked: true });
    b.resolve("s1", "old", "allow");
    expect(await b.plugin.step()).toBe(1);
    expect(ids(b)).toEqual([]);
    expect(b.errors).toEqual([]);
  });

  it("DPL3.5 a choice it cannot tell as an approval or a denial (the option is unknown, or none were offered) gives no outcome", async () => {
    const unknown = await started();
    unknown.request("s1", "p1", RM, OPTIONS);
    await unknown.plugin.step();
    unknown.resolve("s1", "p1", "mystery");
    await unknown.plugin.step();
    expect(await outcomeOf(unknown)).toBeUndefined();
    expect(unknown.errors).toEqual([]);
    const none = await started();
    none.request("s1", "p1", RM, null);
    await none.plugin.step();
    none.resolve("s1", "p1", "allow");
    await none.plugin.step();
    expect(await outcomeOf(none)).toBeUndefined();
    const odd = await started();
    odd.request("s1", "p1", RM, [{ optionId: "x", kind: "other" }]);
    await odd.plugin.step();
    odd.resolve("s1", "p1", "x");
    await odd.plugin.step();
    expect(await outcomeOf(odd)).toBeUndefined();
  });

  it("DPL3.6 always-options count as approvals and denials too", async () => {
    const b = await started();
    b.request("s1", "a", RM, [{ optionId: "yes", kind: "allow_always" }, { optionId: "no", kind: "reject_always" }]);
    b.request("s1", "b", RM, [{ optionId: "yes", kind: "allow_always" }, { optionId: "no", kind: "reject_always" }]);
    await b.plugin.step();
    b.resolve("s1", "a", "yes");
    b.resolve("s1", "b", "no");
    await b.plugin.step();
    const outcomes = (await b.layer.records({ fork: forkId("permission.risk") })).map((r) => r.outcome!.kind);
    expect(outcomes).toEqual(["approved", "denied"]);
  });

  it("DPL3.7 the outcome is by whoever the log says answered, else whoever the event says, else nobody", async () => {
    const b = await started();
    b.request("s1", "a");
    await b.plugin.step();
    // the log says nothing of who: the event does
    b.facts.closeRequest("s1", "a");
    b.facts.append("s1", "event", { event: "permission.resolved", data: { requestId: "a", outcome: { outcome: "selected", optionId: "allow" } } });
    b.bus.publish("permission.resolved", "s1", { requestId: "a", by: "bob" });
    await b.plugin.step();
    expect((await outcomeOf(b))!.by).toBe("bob");
    const c = await started();
    c.request("s1", "a");
    await c.plugin.step();
    c.facts.closeRequest("s1", "a");
    c.facts.append("s1", "event", { event: "permission.resolved", data: { requestId: "a", outcome: { outcome: "selected", optionId: "allow" } } });
    c.bus.publish("permission.resolved", "s1", { requestId: "a" });
    await c.plugin.step();
    expect("by" in (await outcomeOf(c))!).toBe(false);
  });

  it("DPL3.8 only so many open requests are remembered: the oldest is forgotten and gets no outcome", async () => {
    const b = await started({ plugin: { pendingLimit: 1 } });
    b.request("s1", "old");
    b.request("s1", "new");
    await b.plugin.step();
    b.resolve("s1", "old");
    b.resolve("s1", "new");
    await b.plugin.step();
    const records = await b.layer.records({ fork: forkId("permission.risk") });
    expect(records.map((r) => r.outcome?.kind)).toEqual([undefined, "approved"]);
  });

  it("DPL3.9 a request announced again under another event keeps the later decision to attach the outcome to", async () => {
    const b = await started();
    b.request("s1", "p1");
    b.bus.publish("permission.requested", "s1", { requestId: "p1" });
    await b.plugin.step();
    b.resolve("s1", "p1");
    await b.plugin.step();
    const records = await b.layer.records({ fork: forkId("permission.risk") });
    expect(records.map((r) => r.outcome?.kind)).toEqual([undefined, "approved"]);
  });

  it("DPL3.12 a request whose resolution the log does not show (nothing to read it from) gives no outcome and no error", async () => {
    const b = await started();
    b.request();
    await b.plugin.step();
    b.facts.closeRequest("s1", "p1");
    b.bus.publish("permission.resolved", "s1", { requestId: "p1", by: "alice" });
    expect(await b.plugin.step()).toBe(1);
    expect(b.errors).toEqual([]);
    expect(await outcomeOf(b)).toBeUndefined();
    expect(ids(b)).toEqual([]);
  });

  it("DPL3.13 a resolution seen again under another event changes nothing: the outcome is attached once, at the time of the first", async () => {
    const b = await started();
    b.request();
    await b.plugin.step();
    const first = b.resolve("s1", "p1", "allow");
    await b.plugin.step();
    b.bus.publish("permission.resolved", "s1", { requestId: "p1", by: "mallory" }, { at: first.at! + 99 });
    expect(await b.plugin.step()).toBe(1);
    expect(await outcomeOf(b)).toMatchObject({ at: first.at, by: "alice" });
  });

  it("DPL3.14 who answered is what the log says, before what the event says", async () => {
    const b = await started();
    b.request();
    await b.plugin.step();
    b.facts.closeRequest("s1", "p1");
    b.facts.append("s1", "event", { event: "permission.resolved", data: { requestId: "p1", outcome: { outcome: "selected", optionId: "allow" }, by: "from-log" } });
    b.bus.publish("permission.resolved", "s1", { requestId: "p1", by: "from-event" });
    await b.plugin.step();
    expect((await outcomeOf(b))!.by).toBe("from-log");
  });

  it("DPL3.15 an outcome is read from the resolution of its own request, not another's", async () => {
    const b = await started();
    b.request("s1", "a");
    b.request("s1", "b");
    b.request("s2", "a");
    await b.plugin.step();
    b.resolve("s1", "b", "deny");
    b.resolve("s2", "a", "allow");
    b.resolve("s1", "a", "allow");
    await b.plugin.step();
    const records = await b.layer.records({ fork: forkId("permission.risk") });
    expect(records.map((r) => [r.session, r.outcome?.kind])).toEqual([["s1", "approved"], ["s1", "denied"], ["s2", "approved"]]);
  });

  it("DPL3.8b announcing a request again makes it the newest of those remembered", async () => {
    const b = await started({ plugin: { pendingLimit: 2 } });
    b.request("s1", "p1");
    b.request("s1", "p2");
    b.bus.publish("permission.requested", "s1", { requestId: "p1" });
    b.request("s1", "p3");
    await b.plugin.step();
    b.resolve("s1", "p1");
    b.resolve("s1", "p2");
    b.resolve("s1", "p3");
    await b.plugin.step();
    const kinds = (await b.layer.records({ fork: forkId("permission.risk") })).map((r) => r.outcome?.kind);
    // p2 was the oldest when p3 came: p1 (announced again) and p3 are remembered
    expect(kinds).toEqual([undefined, undefined, "approved", "approved"]);
  });

  it("DPL3.10 a resolution with no request id or no session is reported", async () => {
    const b = await started();
    b.bus.publish("permission.resolved", "s1", {});
    b.bus.publish("permission.resolved", undefined, { requestId: "p" });
    expect(await b.plugin.step()).toBe(0);
    expect(b.errors).toHaveLength(2);
  });

  it("DPL3.11 an outcome the layer refuses is reported, and the item has already left the inbox", async () => {
    const b = await started();
    b.request();
    await b.plugin.step();
    b.facts.closeRequest("s1", "p1");
    b.facts.append("s1", "event", { event: "permission.resolved", data: { requestId: "p1", outcome: { outcome: "selected", optionId: "allow" }, by: "alice" } });
    b.bus.publish("permission.resolved", "s1", { requestId: "p1" }, { at: 1.5 });
    expect(await b.plugin.step()).toBe(0);
    expect(b.errors).toHaveLength(1);
    expect(String(b.errors[0]![0])).toContain("not an outcome");
    expect(ids(b)).toEqual([]);
  });
});

describe("a turn ended", () => {
  const calls = (b: Built, session: string, n: number, title = "ls", input: unknown = { path: "/w" }, output: unknown = "same") => {
    for (let i = 0; i < n; i++) {
      const id = `${title}-${b.facts.world.logs.get(session)?.length ?? 0}`;
      b.facts.toolCall(session, id, title, input);
      b.facts.toolUpdate(session, id, { status: "completed", rawOutput: output });
    }
  };
  const stuckDecisions = (b: Built) => b.layer.records({ fork: forkId("stuck") });

  it("DPL4.1 adds a review item saying how the turn ended, and nothing else when there were no tool calls", async () => {
    const b = await started();
    b.facts.append("s1", "event", { event: "turn.started", data: {} });
    // entries that are not new tool calls
    b.facts.append("s1", "update", { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } } });
    b.facts.append("s1", "update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } });
    b.facts.append("s1", "update", { update: { sessionUpdate: "tool_call", title: "no id" } });
    b.facts.toolUpdate("s1", "ghost", { status: "completed" });
    b.facts.append("s1", "event", { event: "permission.requested", data: { requestId: "p9" } });
    const event = b.turnEnded("s1", "max_tokens");
    expect(await b.plugin.step()).toBe(1);
    expect(b.layer.inbox.list()).toEqual([{ id: "review:s1", session: "s1", kind: "review", since: event.at, blocked: false, text: "the turn ended (max_tokens)" }]);
    expect(await stuckDecisions(b)).toEqual([]);
    b.bus.publish("turn.ended", "s1", { turnId: "t2" });
    await b.plugin.step();
    expect(b.layer.inbox.get("review:s1")!.text).toBe("the turn ended");
  });

  it("DPL4.2 reads the tool calls from the log and runs the stuck fork on them: a call repeated a few times is a warning (an idle item)", async () => {
    const b = await started();
    b.facts.append("s1", "update", { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "fix the build" } } });
    calls(b, "s1", 4);
    b.turnEnded();
    await b.plugin.step();
    const [decision] = await stuckDecisions(b);
    expect(decision).toMatchObject({ action: "warn", rung: "rule", session: "s1" });
    expect(decision!.input).toMatchObject({ goal: "fix the build" });
    expect((decision!.input as { steps: unknown[] }).steps).toHaveLength(4);
    expect(b.layer.inbox.get("stuck:s1")).toMatchObject({ kind: "idle", blocked: false, text: "the agent may be going in circles after 4 tool calls" });
  });

  it("DPL4.3 a call repeated many times is an escalation (a failure item, in the same place as the idle one)", async () => {
    const b = await started();
    calls(b, "s1", 4);
    b.turnEnded();
    await b.plugin.step();
    calls(b, "s1", 3);
    b.turnEnded();
    await b.plugin.step();
    expect(b.layer.inbox.get("stuck:s1")).toMatchObject({ kind: "failure", text: "the agent looks stuck and needs a person after 7 tool calls" });
    expect(ids(b).filter((id) => id.startsWith("stuck"))).toEqual(["stuck:s1"]);
    expect((await stuckDecisions(b)).map((d) => d.action)).toEqual(["warn", "escalate"]);
  });

  it("DPL4.4 an agent that is making progress clears the item: a model says so and the item is resolved", async () => {
    const progressing = saying("m", { boolean: 0.95 });
    const b = await started({ layer: { members: [progressing] } });
    calls(b, "s1", 4);
    b.turnEnded();
    await b.plugin.step();
    expect(b.layer.inbox.get("stuck:s1")).toBeDefined();
    for (const [i, title] of ["a", "b", "c"].entries()) b.facts.toolCall("s1", `x${i}`, title, { n: i });
    b.turnEnded();
    await b.plugin.step();
    expect((await stuckDecisions(b)).at(-1)).toMatchObject({ action: "continue", rung: "model" });
    expect(b.layer.inbox.get("stuck:s1")).toBeUndefined();
  });

  it("DPL4.5 only what is new in the log is read, from where the last read stopped", async () => {
    const b = await started();
    calls(b, "s1", 1, "a", { n: 1 });
    b.turnEnded();
    await b.plugin.step();
    calls(b, "s1", 1, "b", { n: 2 });
    b.turnEnded();
    await b.plugin.step();
    expect(b.facts.logReads).toEqual([["s1", undefined], ["s1", 1]]);
    const second = (await stuckDecisions(b))[1]!;
    expect((second.input as { steps: unknown[] }).steps).toHaveLength(2);
  });

  it("DPL4.6 a turn with no new tool calls does not run the stuck fork again", async () => {
    const b = await started();
    calls(b, "s1", 4);
    b.turnEnded();
    b.turnEnded();
    await b.plugin.step();
    expect(await stuckDecisions(b)).toHaveLength(1);
  });

  it("DPL4.7 what a call left behind is part of the step: the same call with different results is not a repeat, with the same result it is", async () => {
    const differing = await started();
    for (let i = 0; i < 4; i++) {
      differing.facts.toolCall("s1", `c${i}`, "make", { target: "all" });
      differing.facts.toolUpdate("s1", `c${i}`, { status: "completed", rawOutput: `failure ${i}` });
    }
    differing.turnEnded();
    await differing.plugin.step();
    expect((await stuckDecisions(differing))[0]).toMatchObject({ rung: "model", action: "continue" });
    const same = await started();
    calls(same, "s1", 4, "make", { target: "all" }, "failure");
    same.turnEnded();
    await same.plugin.step();
    expect((await stuckDecisions(same))[0]).toMatchObject({ rung: "rule", action: "warn" });
    const failed = await started();
    for (let i = 0; i < 4; i++) {
      failed.facts.toolCall("s1", `f${i}`, "make", { target: "all" });
      failed.facts.toolUpdate("s1", `f${i}`, { status: "failed", rawInput: { target: "all" } });
    }
    failed.turnEnded();
    await failed.plugin.step();
    expect((await stuckDecisions(failed))[0]).toMatchObject({ action: "warn" });
  });

  it("DPL4.8 a call is named by its title, else its kind, else `tool`; an update to a call it never saw, or a call without an id, is ignored", async () => {
    const b = await started();
    b.facts.append("s1", "update", { update: { sessionUpdate: "tool_call", toolCallId: "k", kind: "read" } });
    b.facts.append("s1", "update", { update: { sessionUpdate: "tool_call", toolCallId: "n" } });
    b.facts.append("s1", "update", { update: { sessionUpdate: "tool_call", title: "no id" } });
    b.facts.toolUpdate("s1", "ghost", { status: "completed" });
    b.facts.append("s1", "update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } });
    b.facts.append("s1", "update", "not even an object");
    b.facts.append("s1", "event", "nor this");
    b.turnEnded();
    await b.plugin.step();
    const [decision] = await stuckDecisions(b);
    expect((decision!.input as { steps: { action: string }[] }).steps.map((s) => s.action)).toEqual(["read", "tool"]);
  });

  it("DPL4.9 the goal is what the person asked in the latest turn: chunks join, a new turn starts afresh, non-text chunks are not words", async () => {
    const b = await started();
    const say = (text: string) => b.facts.append("s1", "update", { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } });
    b.facts.append("s1", "event", { event: "turn.started", data: {} });
    say("first part");
    say("second part");
    b.facts.append("s1", "update", { update: { sessionUpdate: "user_message_chunk", content: { type: "image", data: "xx" } } });
    b.facts.append("s1", "update", { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "" } } });
    calls(b, "s1", 1, "a", { n: 1 });
    b.turnEnded();
    await b.plugin.step();
    b.facts.append("s1", "event", { event: "turn.started", data: {} });
    say("x".repeat(1500));
    calls(b, "s1", 1, "b", { n: 2 });
    b.turnEnded();
    await b.plugin.step();
    const [first, second] = await stuckDecisions(b);
    expect((first!.input as { goal: string }).goal).toBe("first part\nsecond part");
    expect((second!.input as { goal: string }).goal).toHaveLength(200);
  });

  it("DPL4.10 only so many tool calls are remembered for a session", async () => {
    const b = await started({ plugin: { maxSteps: 3 } });
    for (let i = 0; i < 5; i++) b.facts.toolCall("s1", `c${i}`, `call ${i}`, { i });
    b.turnEnded();
    await b.plugin.step();
    const [decision] = await stuckDecisions(b);
    expect((decision!.input as { steps: { action: string }[] }).steps.map((s) => s.action)).toEqual(["call 2", "call 3", "call 4"]);
  });

  it("DPL4.11 a session the daemon no longer has gets no item and no decision, and its state is forgotten", async () => {
    const b = await started();
    calls(b, "s1", 4);
    b.turnEnded("s1");
    await b.plugin.step();
    b.facts.world.sessionIds.delete("s1");
    b.facts.world.sessionIds.add("s2");
    b.facts.world.logs.set("s2", []);
    b.turnEnded("s1");
    b.turnEnded("s2");
    await b.plugin.step();
    expect(ids(b).filter((id) => id === "review:s2")).toEqual(["review:s2"]);
    expect(b.facts.logReads.filter(([s]) => s === "s1")).toHaveLength(1);
    // what it knew of s1 is gone: when s1 is back, its log is read from the start
    b.facts.world.sessionIds.add("s1");
    b.turnEnded("s1");
    await b.plugin.step();
    expect(b.facts.logReads.filter(([s]) => s === "s1").at(-1)).toEqual(["s1", undefined]);
  });

  it("DPL4.17 a session still there keeps what was read of it, and others being known does not stop a turn from being looked at", async () => {
    const b = await started();
    b.facts.world.sessionIds.add("s2");
    calls(b, "s1", 1, "a", { n: 1 });
    b.turnEnded("s1");
    await b.plugin.step();
    calls(b, "s1", 1, "b", { n: 2 });
    b.turnEnded("s1");
    b.turnEnded("s2");
    await b.plugin.step();
    expect(b.facts.logReads.filter(([s]) => s === "s1").map(([, after]) => after)).toEqual([undefined, 1]);
    expect(ids(b)).toEqual(["review:s1", "review:s2"]);
  });

  it("DPL4.12 a fork in shadow mode decides and records but puts nothing in the inbox", async () => {
    const b = await started({ layer: { policyPatch: { forks: { stuck: { mode: "shadow" } } } } });
    calls(b, "s1", 4);
    b.turnEnded();
    await b.plugin.step();
    expect((await stuckDecisions(b))[0]).toMatchObject({ mode: "shadow", action: "warn" });
    expect(b.layer.inbox.get("stuck:s1")).toBeUndefined();
    expect(b.layer.inbox.get("review:s1")).toBeDefined();
  });

  it("DPL4.13 a turn event with no session is reported", async () => {
    const b = await started();
    b.bus.publish("turn.ended", undefined, {});
    expect(await b.plugin.step()).toBe(0);
    expect(String(b.errors[0]![0])).toContain("names no session");
  });

  it("DPL4.14 a log that cannot be read is reported, with the review item already in the inbox", async () => {
    const b = await started();
    b.facts.log = () => {
      throw new Error("log gone");
    };
    b.facts.world.sessionIds.add("s1");
    b.turnEnded();
    expect(await b.plugin.step()).toBe(0);
    expect(String(b.errors[0]![0])).toBe("Error: log gone");
    expect(ids(b)).toEqual(["review:s1"]);
  });
});

describe("what makes a tool call a repeat", () => {
  const FIELDS = ["rawInput", "status", "rawOutput"] as const;

  /** Four calls of one tool: alike in everything but (when `differing`) the one field, which is given with the call or by an update. */
  async function play(field: (typeof FIELDS)[number], how: "call" | "update", differing: boolean) {
    const b = await started();
    for (let i = 0; i < 4; i++) {
      const value = differing ? `${field}-${i}` : `${field}-same`;
      const id = `c${i}`;
      const base = { rawInput: { n: 1 }, status: "pending" };
      if (how === "call") {
        const { rawInput, ...rest } = { ...base, [field]: field === "rawInput" ? { v: value } : value };
        b.facts.toolCall("s1", id, "make", rawInput, rest);
      } else {
        b.facts.toolCall("s1", id, "make", base.rawInput);
        b.facts.toolUpdate("s1", id, { [field]: field === "rawInput" ? { v: value } : value });
      }
    }
    b.turnEnded();
    await b.plugin.step();
    expect(b.errors).toEqual([]);
    return (await b.layer.records({ fork: forkId("stuck") }))[0]!;
  }

  for (const field of FIELDS) {
    for (const how of ["call", "update"] as const) {
      it(`DPL13.${FIELDS.indexOf(field) * 2 + (how === "call" ? 1 : 2)} calls that differ in their ${field}, given ${how === "call" ? "with the call" : "in an update"}, are not a repeat; calls that agree are`, async () => {
        expect(await play(field, how, true)).toMatchObject({ rung: "model", action: "continue" });
        expect(await play(field, how, false)).toMatchObject({ rung: "rule", action: "warn" });
      });
    }
  }

  it("DPL13.7 an update names its call by id: one to a call that is not there changes no other, and a later update changes only what it says", async () => {
    const b = await started();
    for (let i = 0; i < 3; i++) b.facts.toolCall("s1", `c${i}`, "make", { n: 1 });
    b.facts.toolUpdate("s1", "ghost", { status: "failed", rawOutput: "boom", rawInput: { n: 2 } });
    b.turnEnded();
    await b.plugin.step();
    expect(await b.layer.records({ fork: forkId("stuck") })).toMatchObject([{ rung: "rule", action: "warn" }]);
    const c = await started();
    for (let i = 0; i < 4; i++) {
      c.facts.toolCall("s1", `c${i}`, "make", { n: 1 });
      c.facts.toolUpdate("s1", `c${i}`, { status: "completed", rawOutput: "ok" });
      c.facts.toolUpdate("s1", `c${i}`, {});
    }
    c.turnEnded();
    await c.plugin.step();
    expect((await c.layer.records({ fork: forkId("stuck") }))[0]).toMatchObject({ rung: "rule" });
  });

  it("DPL13.9 an update that does not mention a field leaves it as it was", async () => {
    const b = await started();
    for (let i = 0; i < 4; i++) {
      if (i % 2 === 0) {
        // the output arrives in an update ...
        b.facts.toolCall("s1", `c${i}`, "make", { n: 1 });
        b.facts.toolUpdate("s1", `c${i}`, { rawOutput: "ok" });
      } else {
        // ... or with the call
        b.facts.toolCall("s1", `c${i}`, "make", { n: 1 }, { rawOutput: "ok" });
      }
    }
    b.turnEnded();
    await b.plugin.step();
    expect((await b.layer.records({ fork: forkId("stuck") }))[0]).toMatchObject({ rung: "rule", action: "warn" });
  });

  it("DPL13.8 the state a decision records for a step is a short fixed digest, the same for the same step", async () => {
    const b = await started();
    for (let i = 0; i < 2; i++) b.facts.toolCall("s1", `c${i}`, "make", { n: 1 });
    b.turnEnded();
    await b.plugin.step();
    const steps = ((await b.layer.records({ fork: forkId("stuck") }))[0]!.input as { steps: { action: string; state: string }[] }).steps;
    expect(steps[0]).toEqual(steps[1]);
    expect(steps[0]!.state).toMatch(/^[0-9a-f]{1,8}$/);
  });
});

describe("a turn started or a session detached", () => {
  it("DPL5.1 clears the session's review, failure and idle items, and leaves its permission items and other sessions' items", async () => {
    const b = await started();
    const item = (id: string, kind: "review" | "failure" | "idle" | "permission" | "question", session = "s1") => b.layer.inbox.add({ id, session, kind, since: 1, blocked: false });
    for (const kind of ["review", "failure", "idle", "permission", "question"] as const) item(`${kind}-1`, kind);
    item("review-2", "review", "s2");
    b.turnStarted("s1");
    await b.plugin.step();
    expect(ids(b)).toEqual(["permission-1", "question-1", "review-2"]);
    item("review-3", "review");
    b.bus.publish("session.detached", "s1", { nodeId: "n" });
    await b.plugin.step();
    expect(ids(b)).toEqual(["permission-1", "question-1", "review-2"]);
  });

  it("DPL5.2 a turn that starts forgets the goal of the one before it", async () => {
    const b = await started();
    b.facts.append("s1", "update", { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old goal" } } });
    b.facts.toolCall("s1", "a", "a", {});
    b.turnEnded();
    await b.plugin.step();
    b.facts.append("s1", "event", { event: "turn.started", data: {} });
    b.facts.toolCall("s1", "b", "b", {});
    b.turnEnded();
    await b.plugin.step();
    const [, second] = await b.layer.records({ fork: forkId("stuck") });
    expect((second!.input as { goal: string }).goal).toBe("");
  });

  it("DPL5.3 an event with no session is reported", async () => {
    const b = await started();
    b.bus.publish("turn.started", undefined, {});
    expect(await b.plugin.step()).toBe(0);
    expect(b.errors).toHaveLength(1);
  });
});

describe("at-least-once delivery", () => {
  it("DPL6.1 an event delivered twice is handled once and acknowledged each time", async () => {
    const b = await started();
    const event = b.request();
    await b.plugin.step();
    b.bus.redeliver = [event.eventId, event.eventId];
    expect(await b.plugin.step()).toBe(0);
    expect(await b.layer.records({ fork: forkId("permission.risk") })).toHaveLength(1);
    expect(b.bus.acked).toEqual([event.offset, event.offset, event.offset]);
    expect(b.published).toHaveLength(1);
  });

  it("DPL6.2 a failing event does not stop the others, and is acknowledged like them", async () => {
    const b = await started();
    b.bus.publish("permission.requested", "s1", {});
    const good = b.request("s1", "p2");
    b.turnEnded("s1");
    expect(await b.plugin.step()).toBe(3 - 1);
    expect(b.errors).toHaveLength(1);
    expect(b.bus.acked).toEqual([0, good.offset, good.offset + 1]);
    expect(ids(b)).toContain("permission:s1:p2");
  });

  it("DPL6.3 a poll that fails is reported and the step handles nothing; the next step carries on", async () => {
    const b = await started();
    b.request();
    b.bus.failPoll = new Error("bus down");
    expect(await b.plugin.step()).toBe(0);
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]![1]).toBeUndefined();
    b.bus.failPoll = undefined;
    expect(await b.plugin.step()).toBe(1);
  });

  it("DPL6.4 an acknowledgement that fails is reported, and the event was handled; the same event is not handled again when it comes back", async () => {
    const b = await started();
    const event = b.request();
    b.bus.failAck = new Error("ack lost");
    expect(await b.plugin.step()).toBe(1);
    expect(b.errors.map(([e]) => (e as Error).message)).toEqual(["ack lost"]);
    b.bus.failAck = undefined;
    b.bus.redeliver = [event.eventId];
    expect(await b.plugin.step()).toBe(0);
    expect(await b.layer.records({ fork: forkId("permission.risk") })).toHaveLength(1);
  });

  it("DPL6.5 an error handler that throws, or none at all, never stops the loop", async () => {
    const b = await started({ plugin: { onError: () => { throw new Error("handler broke"); } } });
    b.bus.publish("permission.requested", "s1", {});
    const good = b.request("s1", "p2");
    expect(await b.plugin.step()).toBe(1);
    expect(b.bus.acked).toEqual([0, good.offset]);
    const quiet = build();
    const silent = new DecisionPlugin({ layer: quiet.layer, source: quiet.bus, facts: quiet.facts });
    await silent.start();
    quiet.bus.publish("permission.requested", "s1", {});
    expect(await silent.step()).toBe(0);
  });

  it("DPL6.6 the batch size is asked of the bus, 100 unless given", async () => {
    const b = await started();
    await b.plugin.step();
    const small = await started({ plugin: { batch: 5 } });
    await small.plugin.step();
    expect([b.bus.polled[0], small.bus.polled[0]]).toEqual([100, 5]);
  });

  it("DPL6.7 only so many event ids are remembered: a very old event delivered again is handled again", async () => {
    const b = await started({ plugin: { seenWindow: 2 } });
    const first = b.request("s1", "p1");
    b.request("s1", "p2");
    b.request("s1", "p3");
    await b.plugin.step();
    b.bus.redeliver = [first.eventId];
    await b.plugin.step();
    expect(await b.layer.records({ fork: forkId("permission.risk") })).toHaveLength(4);
  });
});

describe("the plugin only annotates", () => {
  it("DPL7.1 it uses the bus only to subscribe, poll and acknowledge, and the facts only to read: nothing in either answers a permission", async () => {
    const bus = new FakeBus();
    const facts = new FakeFacts();
    const used: string[] = [];
    const watched = <T extends object>(name: string, target: T, allowed: readonly string[]): T =>
      new Proxy(target, {
        get(t, key, receiver) {
          const value = Reflect.get(t, key, receiver) as unknown;
          if (typeof key === "symbol" || typeof value !== "function") return value;
          if (!allowed.includes(key)) throw new Error(`${name}.${key} is not something an annotating plugin may call`);
          used.push(`${name}.${key}`);
          return (value as (...args: unknown[]) => unknown).bind(t);
        },
      });
    const r = rig({ members: [saying("m", CRITICAL)], authority: shippedAuthority() });
    const errors: unknown[] = [];
    const plugin = new DecisionPlugin({ layer: r.layer, source: watched("bus", bus, ["subscribe", "poll", "ack"]), facts: watched("facts", facts, ["permission", "permissionOptions", "log", "sessions"]), onError: (e) => void errors.push(e) });
    await plugin.start();
    facts.openRequest("s1", "p1", RM, OPTIONS);
    facts.toolCall("s1", "t1", "ls", {});
    bus.publish("permission.requested", "s1", { requestId: "p1" });
    bus.publish("turn.ended", "s1", { stopReason: "end_turn" });
    await plugin.step();
    facts.closeRequest("s1", "p1");
    facts.append("s1", "event", { event: "permission.resolved", data: { requestId: "p1", outcome: { outcome: "selected", optionId: "allow" }, by: "alice" } });
    bus.publish("permission.resolved", "s1", { requestId: "p1", by: "alice" });
    bus.publish("turn.started", "s1", {});
    await plugin.step();
    expect(errors).toEqual([]);
    expect(new Set(used)).toEqual(new Set(["bus.subscribe", "bus.poll", "bus.ack", "facts.permission", "facts.permissionOptions", "facts.sessions", "facts.log"]));
  });
});

describe("an answer that comes while the risk model is thinking", () => {
  const outcomeOf = async (b: Built) => (await b.layer.records({ fork: forkId("permission.risk") }))[0]!.outcome;
  /** A member that, while it thinks, has the person answer the request (as the daemon would: the request closes, the log and the bus say so). */
  const answeringWhileThinking = (answer: () => void) => ({
    id: "m",
    version: "v1",
    ask: async (a: Parameters<ReturnType<typeof saying>["ask"]>[0]) => {
      answer();
      return saying("x", CRITICAL).ask(a);
    },
  });

  it("DPR1.1 the person's choice is still recorded as the outcome: the options were read before the model was asked", async () => {
    const ref: { b?: Built } = {};
    const b = await started({ layer: { members: [answeringWhileThinking(() => ref.b!.resolve("s1", "p1", "deny", "alice"))] } });
    ref.b = b;
    b.request();
    await b.plugin.step();
    expect(b.facts.world.open.size).toBe(0); // the request is closed by the time the plugin has its decision
    const event = b.bus.events.at(-1)!;
    await b.plugin.step();
    expect(await outcomeOf(b)).toEqual({ at: event.at, source: "human", kind: "denied", correct: true, by: "alice" });
    expect(ids(b)).toEqual([]);
    expect(b.errors).toEqual([]);
  });

  it("DPR1.2 the options are read in the same step as the facts, before the decision or the inbox is touched", async () => {
    const ref: { b?: Built } = {};
    const seen: string[][] = [];
    const b = await started({ layer: { members: [answeringWhileThinking(() => seen.push([...ref.b!.facts.calls]))] } });
    ref.b = b;
    b.request();
    await b.plugin.step();
    expect(seen[0]).toEqual(["permissionOptions", "permission"]);
  });

  it("DPR1.3 an approval given while the model thinks is recorded as an approval, judged against the level the model gave", async () => {
    const ref: { b?: Built } = {};
    const b = await started({ layer: { members: [answeringWhileThinking(() => ref.b!.resolve("s1", "p1", "allow", "bob"))] } });
    ref.b = b;
    b.request();
    await b.plugin.step();
    await b.plugin.step();
    expect(await outcomeOf(b)).toMatchObject({ kind: "approved", correct: false, by: "bob" });
  });

  it("DPR1.4 options that are async are read at the same time as the facts, and the outcome is still recorded", async () => {
    const ref: { b?: Built } = {};
    const b = await started({ layer: { members: [answeringWhileThinking(() => ref.b!.resolve("s1", "p1", "deny", "alice"))] } });
    ref.b = b;
    const real = b.facts;
    // the same reads, but returned as promises that settle later
    const slow = { ...real, calls: real.calls, permission: async (s: string, q: string) => real.permission(s, q), permissionOptions: async (s: string, q: string) => real.permissionOptions(s, q), log: real.log.bind(real), sessions: real.sessions.bind(real) };
    const plugin = new DecisionPlugin({ layer: b.layer, source: b.bus, facts: slow, onError: (e) => void b.errors.push([e, undefined]) });
    await plugin.start();
    b.request();
    await plugin.step();
    await plugin.step();
    expect(await outcomeOf(b)).toMatchObject({ kind: "denied", correct: true });
  });
});

describe("secrets in what the plugin shows and passes on", () => {
  const TITLE = "curl -H 'Authorization: Bearer sk-live-12345' https://api.x --password hunter2";

  it("DPS1.1 the inbox text of a permission request has the secrets of its tool title removed", async () => {
    const b = await started();
    b.request("s1", "p1", { tool: TITLE, kind: "execute", command: TITLE, cwd: "/w", session: "s1" });
    await b.plugin.step();
    const text = b.layer.inbox.get("permission:s1:p1")!.text;
    expect(text).not.toMatch(/sk-live-12345|hunter2/);
    expect(text).toContain("[redacted]");
  });

  it("DPS1.2 the decision record of a permission request has no secret in its tool, kind, working directory or session", async () => {
    const b = await started();
    b.request("s1", "p1", { tool: TITLE, kind: "execute token=k1", command: "ls", cwd: "/w/password=c1", session: "s1" });
    await b.plugin.step();
    const [record] = await b.layer.records({ fork: forkId("permission.risk") });
    expect(JSON.stringify(record!.input)).not.toMatch(/sk-live-12345|hunter2|k1|c1/);
  });

  it("DPS1.3 the stuck fork is given the person's words and the tool titles with their secrets removed", async () => {
    const b = await started();
    const spy = vi.spyOn(b.layer, "decideNamed");
    b.facts.append("s1", "update", { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "export OPENAI_API_KEY=sk-live-77 and fix the build" } } });
    b.facts.toolCall("s1", "c1", TITLE, { command: "ls" });
    b.turnEnded();
    await b.plugin.step();
    const call = spy.mock.calls.find(([fork]) => fork === "stuck")!;
    expect(call[1]).toStrictEqual({ goal: "export OPENAI_API_KEY=[redacted] and fix the build", steps: [{ action: expect.stringContaining("--password [redacted]"), state: expect.any(String) }] });
    expect(JSON.stringify(call[1])).not.toMatch(/sk-live-77|sk-live-12345|hunter2/);
  });
});
