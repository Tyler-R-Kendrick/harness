import { describe, expect, it } from "vitest";
import { Daemon } from "@harness/core";
import type { PermissionOptionSpec, WorkerCommand } from "@harness/core";
import { DaemonDriver, ManualClock, SeededEntropy } from "@harness/testkit";
import { daemonFacts, DecisionPlugin, hookSourceOver } from "../src/plugin.ts";
import { forkId } from "../src/types.ts";
import { rig, saying, shippedAuthority } from "./compose-fixtures.ts";

const OPTIONS: PermissionOptionSpec[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
const CRITICAL = { boolean: 0.95, score: [0, 0, 0.1, 0.9] };

/** A real daemon, the plugin on a real plugin connection, and the layer publishing back to the daemon's bus. */
function world(members = [saying("m", CRITICAL)]) {
  const clock = new ManualClock(1_000);
  const daemon = new Daemon({ clock, entropy: new SeededEntropy(5), agentInfo: { name: "h", version: "1" } });
  const d = new DaemonDriver(daemon);
  d.connect("plg", { principal: "decision", kind: "plugin" });
  d.initialize("plg");
  const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const response = d.request("plg", method, params);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const r = rig({
    members,
    authority: shippedAuthority(),
    clock,
    publish: (event) => daemon.publish({ type: event.type, payload: { ...event.payload }, ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }) }),
  });
  const errors: unknown[] = [];
  const plugin = new DecisionPlugin({ layer: r.layer, source: hookSourceOver(call), facts: daemonFacts(daemon), onError: (e) => void errors.push(e) });
  d.connect("audit", { principal: "audit", kind: "plugin" });
  d.initialize("audit");
  d.request("audit", "_harness/hooks/subscribe", { types: ["decision.*"] });
  d.connect("c1", { principal: "alice", kind: "human" });
  d.initialize("c1");
  const sessionId = (d.request("c1", "session/new", { cwd: "/w", mcpServers: [] }).result as { sessionId: string }).sessionId;
  d.inbox("c1");
  return { daemon, d, r, plugin, errors, sessionId, clock };
}
type World = ReturnType<typeof world>;

function prompt(w: World): string {
  w.d.send("c1", { jsonrpc: "2.0", id: 50, method: "session/prompt", params: { sessionId: w.sessionId, prompt: [{ type: "text", text: "clean the build" }] } });
  const command = w.d.commands().find((c) => c.type === "prompt") as Extract<WorkerCommand, { type: "prompt" }>;
  return command.turnId;
}

const ask = (w: World, turnId: string, requestId: string) =>
  w.d.worker({ type: "permission", sessionId: w.sessionId, turnId, requestId, toolCall: { toolCallId: `call-${requestId}`, title: "Bash", kind: "execute", rawInput: { command: "rm -rf build", path: "/w/build" } }, options: OPTIONS });

describe("the plugin on a real daemon", () => {
  it("DPL11.1 a permission request is annotated and shown to the person without being answered; the person's choice then becomes the decision's outcome", async () => {
    const w = world();
    await w.plugin.start();
    const turnId = prompt(w);
    ask(w, turnId, "p1");
    expect(await w.plugin.step()).toBe(2); // turn.started, permission.requested
    expect(w.errors).toEqual([]);

    expect(w.r.layer.inbox.list()).toMatchObject([{ id: `permission:${w.sessionId}:p1`, kind: "permission", blocked: true, text: "Bash: rm -rf build (risk: critical)" }]);
    // still open: the plugin has not answered, and nothing was told to the worker
    expect(w.daemon.pendingPermissions().map((p) => p.requestId)).toEqual(["p1"]);
    expect(w.d.commands().filter((c) => c.type === "permission")).toEqual([]);
    const [record] = await w.r.layer.records({ fork: forkId("permission.risk") });
    expect(record).toMatchObject({ action: "critical", session: w.sessionId, input: { tool: "Bash", kind: "execute", command: "rm -rf build", path: "/w/build", cwd: "/w" } });

    const asked = w.d.inbox("c1").find((m) => m.method === "session/request_permission")!;
    w.d.send("c1", { jsonrpc: "2.0", id: asked.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    const commands = w.d.commands().filter((c) => c.type === "permission");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });

    expect(await w.plugin.step()).toBe(1);
    expect(w.r.layer.inbox.list()).toEqual([]);
    expect((await w.r.layer.record(record!.id))!.outcome).toMatchObject({ source: "human", kind: "approved", correct: false, by: expect.any(String) });
  });

  it("DPL11.2 the decisions are published back on the daemon's hook bus for other plugins", async () => {
    const w = world();
    await w.plugin.start();
    const turnId = prompt(w);
    ask(w, turnId, "p1");
    await w.plugin.step();
    const events = (w.d.request("audit", "_harness/hooks/poll", {}).result as { events: { type: string; source: string; sessionId: string; payload: { fork: string; action: string } }[] }).events;
    expect(events.map((e) => [e.type, e.source, e.sessionId, e.payload.fork, e.payload.action])).toEqual([["decision.made", "host", w.sessionId, "permission.risk", "critical"]]);
  });

  it("DPL11.3 a request cancelled when the turn ends leaves the inbox and gets no outcome", async () => {
    const w = world();
    await w.plugin.start();
    const turnId = prompt(w);
    ask(w, turnId, "p1");
    await w.plugin.step();
    w.d.worker({ type: "end", sessionId: w.sessionId, turnId, stopReason: "cancelled" });
    await w.plugin.step();
    expect(w.errors).toEqual([]);
    expect(w.r.layer.inbox.list().map((i) => i.id)).toEqual([`review:${w.sessionId}`]);
    expect((await w.r.layer.records({ fork: forkId("permission.risk") }))[0]!.outcome).toBeUndefined();
  });

  it("DPL11.4 the tool calls of a turn are read from the session's log: a call repeated is an idle item, and a new turn clears it", async () => {
    const w = world();
    await w.plugin.start();
    const turnId = prompt(w);
    for (let i = 0; i < 4; i++) {
      const toolCallId = `t${i}`;
      w.d.worker({ type: "update", sessionId: w.sessionId, turnId, update: { sessionUpdate: "tool_call", toolCallId, title: "npm test", kind: "execute", status: "pending", rawInput: { command: "npm test" } } });
      w.d.worker({ type: "update", sessionId: w.sessionId, turnId, update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed", rawOutput: "1 failing" } });
    }
    w.d.worker({ type: "end", sessionId: w.sessionId, turnId, stopReason: "end_turn" });
    await w.plugin.step();
    expect(w.errors).toEqual([]);
    const [decision] = await w.r.layer.records({ fork: forkId("stuck") });
    expect(decision).toMatchObject({ action: "warn", rung: "rule", session: w.sessionId });
    expect((decision!.input as { goal: string; steps: unknown[] }).goal).toBe("clean the build");
    expect((decision!.input as { steps: unknown[] }).steps).toHaveLength(4);
    expect(w.r.layer.inbox.list().map((i) => [i.id.split(":")[0], i.kind]).sort()).toEqual([["review", "review"], ["stuck", "idle"]]);
    prompt(w);
    await w.plugin.step();
    expect(w.r.layer.inbox.list()).toEqual([]);
  });

  it("DPL11.5 the plugin sees only what the bus carries to it: it never sees its own decision events, and a restart resumes from the bus's cursor", async () => {
    const w = world();
    await w.plugin.start();
    const turnId = prompt(w);
    ask(w, turnId, "p1");
    expect(await w.plugin.step()).toBe(2);
    expect(await w.plugin.step()).toBe(0);
    w.plugin.stop();
    const again = new DecisionPlugin({ layer: w.r.layer, source: hookSourceOver(async (m, p) => (w.d.request("plg", m, p).result as unknown) ?? {}), facts: daemonFacts(w.daemon) });
    await again.start();
    expect(await again.step()).toBe(0);
  });
});
