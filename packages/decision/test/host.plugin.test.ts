import { describe, expect, it } from "vitest";
import { Daemon } from "@harness/core";
import type { Identity, Output, PermissionOptionSpec, WorkerCommand } from "@harness/core";
import { DaemonDriver, ManualClock, SeededEntropy } from "@harness/testkit";
import { publishOn, startPlugin, tickOf } from "../src/host.ts";
import type { PluginRuntimeLike, StartPluginOptions } from "../src/host.ts";
import { forkId } from "../src/types.ts";
import { rig, saying, shippedAuthority } from "./compose-fixtures.ts";

const OPTIONS: PermissionOptionSpec[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
const CRITICAL = { boolean: 0.95, score: [0, 0, 0.1, 0.9] };

/** A host's runtime over a real daemon: `connect` for peers, `publish` onto the hook bus, the daemon for facts. */
function runtimeOver(daemon: Daemon) {
  const sends = new Map<string, (message: object) => void>();
  const hungUp: string[] = [];
  const methods: string[] = [];
  const identities: Identity[] = [];
  let n = 0;
  const apply = (outputs: Output[]) => {
    for (const o of outputs) if (o.kind === "send") sends.get(o.connectionId)?.(o.message);
  };
  const runtime: PluginRuntimeLike = {
    daemon,
    publish: (event) => daemon.publish(event),
    connect(identity: Identity, send) {
      const id = `peer-${n++}`;
      identities.push(identity);
      sends.set(id, send);
      daemon.connect(id, identity);
      return {
        receive: (message) => (methods.push((message as { method: string }).method), apply(daemon.receive(id, message))),
        disconnect: () => (hungUp.push(id), apply(daemon.disconnect(id))),
      };
    },
  };
  return { runtime, hungUp, methods, identities };
}

/** A timer the test drives: `every` registers the tick, `fire` runs it, and stopping it is observable. */
function manualTimer() {
  const state = { ticks: [] as (() => void)[], periods: [] as number[], stopped: 0 };
  const every: StartPluginOptions["every"] = (tick, ms) => {
    state.ticks.push(tick);
    state.periods.push(ms);
    return () => void (state.stopped += 1);
  };
  return { state, every, fire: () => state.ticks.forEach((t) => t()) };
}

function world(members = [saying("m", CRITICAL)]) {
  const clock = new ManualClock(1_000);
  const daemon = new Daemon({ clock, entropy: new SeededEntropy(5), agentInfo: { name: "h", version: "1" } });
  const d = new DaemonDriver(daemon);
  const { runtime, hungUp, methods, identities } = runtimeOver(daemon);
  const r = rig({ members, authority: shippedAuthority(), clock, publish: publishOn(runtime) });
  d.connect("c1", { principal: "alice", kind: "human" });
  d.initialize("c1");
  const sessionId = (d.request("c1", "session/new", { cwd: "/w", mcpServers: [] }).result as { sessionId: string }).sessionId;
  d.inbox("c1");
  const timer = manualTimer();
  const errors: [string, unknown][] = [];
  const start = (over: Partial<StartPluginOptions> = {}) => startPlugin({ layer: r.layer, runtime, every: timer.every, tickMs: 250, onError: (where, e) => void errors.push([where, e]), ...over });
  const ask = () => {
    d.send("c1", { jsonrpc: "2.0", id: 50, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "clean the build" }] } });
    const command = d.commands().find((c) => c.type === "prompt") as Extract<WorkerCommand, { type: "prompt" }>;
    d.worker({ type: "permission", sessionId, turnId: command.turnId, requestId: "p1", toolCall: { toolCallId: "call-1", title: "Bash", kind: "execute", rawInput: { command: "rm -rf build" } }, options: OPTIONS });
    return command.turnId;
  };
  return { daemon, d, r, runtime, hungUp, methods, identities, timer, errors, start, ask, sessionId };
}

describe("startPlugin: the decision plugin on a running host", () => {
  it("DHN5.1 the plugin is connected as a peer, handles what is on the bus when pumped, and does not answer the request it annotates", async () => {
    const w = world();
    const plugin = await w.start();
    w.ask();
    expect(await plugin.pump()).toBe(2); // turn.started, permission.requested
    expect(w.errors).toEqual([]);
    expect(w.r.layer.inbox.list()).toMatchObject([{ kind: "permission", blocked: true, text: "Bash: rm -rf build (risk: critical)" }]);
    expect(w.daemon.pendingPermissions().map((p) => p.requestId)).toEqual(["p1"]);
    expect(await w.r.layer.records({ fork: forkId("permission.risk") })).toHaveLength(1);
    expect(w.identities).toEqual([{ principal: "decision", kind: "plugin" }]);
  });

  it("DHN5.2 it is pumped at once and on every tick of the host's timer, at the period it was given", async () => {
    const w = world();
    await w.start({ tickMs: 750 });
    expect(w.timer.state.periods).toEqual([750]);
    // a pump has begun without a tick: it polls the bus
    await until(() => w.methods.includes("_harness/hooks/poll"), "the first pump");
    const polls = () => w.methods.filter((m) => m === "_harness/hooks/poll").length;
    const before = polls();
    w.ask();
    expect(w.r.layer.inbox.list()).toEqual([]);
    w.timer.fire();
    await until(() => w.r.layer.inbox.list().length === 1, "the tick to be pumped");
    expect(polls()).toBeGreaterThan(before);
    expect(w.errors).toEqual([]);
  });

  it("DHN5.3 stopping stops the timer once, lets the pump finish, and hangs the connection up; events after that are not handled", async () => {
    const w = world();
    const plugin = await w.start();
    await plugin.stop();
    expect(w.timer.state.stopped).toBe(1);
    expect(w.hungUp).toHaveLength(1);
    w.ask();
    expect(await plugin.pump()).toBe(0);
    expect(w.r.layer.inbox.list()).toEqual([]);
    // the plugin is stopped, so it does not even try the bus its connection no longer reaches
    expect(w.errors).toEqual([]);
  });

  it("DHN5.4 a failure while handling an event is told with the event, and the loop goes on", async () => {
    const w = world();
    const failing = { ...w.runtime, daemon: { pendingPermission: () => { throw new Error("facts down"); }, readLog: () => [], sessions: () => [] } };
    const plugin = await startPlugin({ layer: w.r.layer, runtime: failing, every: w.timer.every, tickMs: 1, onError: (where, e) => void w.errors.push([where, e]) });
    w.ask();
    await plugin.pump();
    expect(w.errors.map(([where, e]) => [where, (e as Error).message])).toEqual([[expect.stringMatching(/^handling permission\.requested \(.+\)$/), "facts down"]]);
    expect(await plugin.pump()).toBe(0);
    await plugin.stop();
  });

  it("DHN5.5 a bus that fails to answer is told as the hook bus, and the next tick tries again", async () => {
    const w = world();
    let fail = false;
    const flaky: PluginRuntimeLike = {
      ...w.runtime,
      connect: (identity, send) => {
        const connection = w.runtime.connect(identity, send);
        return { disconnect: () => connection.disconnect(), receive: (m) => (fail && (m as { method: string }).method === "_harness/hooks/poll" ? (() => { throw new Error("bus down"); })() : connection.receive(m)) };
      },
    };
    const plugin = await startPlugin({ layer: w.r.layer, runtime: flaky, every: w.timer.every, tickMs: 1, onError: (where, e) => void w.errors.push([where, e]) });
    await plugin.pump();
    fail = true;
    await plugin.pump();
    fail = false;
    expect(w.errors.map(([where, e]) => [where, (e as Error).message])).toEqual([["the hook bus", "bus down"]]);
    w.ask();
    expect(await plugin.pump()).toBe(2);
    await plugin.stop();
  });

  it("DHN5.8 a plugin that cannot subscribe hangs its connection up and fails the start", async () => {
    const w = world();
    const odd: PluginRuntimeLike = { ...w.runtime, connect: (identity, send) => w.runtime.connect({ ...identity, kind: "human" }, send) };
    await expect(startPlugin({ layer: w.r.layer, runtime: odd, every: w.timer.every, tickMs: 1, onError: () => {} })).rejects.toThrow("only plugins use the hook bus");
    expect(w.hungUp).toHaveLength(1);
    expect(w.timer.state.ticks).toEqual([]);
  });

  it("DHN5.6 with assess, the attention fork ranks what the plugin puts in the inbox", async () => {
    const w = world([saying("m", { ...CRITICAL, choice: 0.9 })]);
    const plugin = await w.start({ assess: true });
    w.ask();
    await plugin.pump();
    expect(w.r.layer.inbox.list().some((i) => i.urgency !== undefined)).toBe(true);
    const plain = world([saying("m", CRITICAL)]);
    const unranked = await plain.start();
    plain.ask();
    await unranked.pump();
    expect(plain.r.layer.inbox.list().every((i) => i.urgency === undefined)).toBe(true);
  });
});

describe("publishOn", () => {
  it("DHN5.7 decisions become events of the host on the hook bus, with their session when they have one", () => {
    const published: unknown[] = [];
    const publish = publishOn({ publish: (e) => void published.push(e) });
    const payload = { id: "dec-0", fork: "stuck", rung: "rule", action: "continue", confidence: 1, mode: "active" } as const;
    publish({ type: "decision.made", payload: payload as never });
    publish({ type: "decision.made", payload: payload as never, sessionId: "s1" });
    expect(published).toEqual([
      { type: "decision.made", payload },
      { type: "decision.made", payload, sessionId: "s1" },
    ]);
    expect(published[0]).not.toHaveProperty("sessionId");
    expect((published[0] as { payload: unknown }).payload).not.toBe(payload);
  });
});

describe("tickOf", () => {
  it("DHN5.9 a tick pumps; a pump that fails is told to the handler and the tick does not throw", async () => {
    const told: unknown[] = [];
    let pumps = 0;
    const tick = tickOf({ pump: () => (++pumps === 1 ? Promise.reject(new Error("first fails")) : Promise.resolve(0)) }, (e) => void told.push(e));
    expect(tick()).toBeUndefined();
    tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(pumps).toBe(2);
    expect(told.map((e) => (e as Error).message)).toEqual(["first fails"]);
  });
});

async function until(check: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
