import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import type { HookEvent } from "@harness/core";
import { EchoWorker } from "@harness/workers";
import { invokeCognitive } from "@harness/cognitive";
import type { WorkerEvent } from "@harness/core";
import { GraphIdSchema, importGraph, logTrajectories, MemoryProceduralStore, parsePolicy, parseResolver, resolveGraph, revisionId, RevisionIdSchema, ScoreSchema, seedGraph } from "@harness/procedural";
import type { RevisionId } from "@harness/procedural";
import { scriptedHarness, scriptedModel } from "@harness/testkit";
import {
  buildNativeEnsemble,
  daemonSessions,
  harnessWorker,
  hostAuthorizer,
  hostPorts,
  nativeDream,
  nativeLiveLearner,
  loadProceduralPolicy,
  loadProceduralResolver,
  loadProceduralSettings,
  nativeProceduralStep,
  nativeStepEvictions,
  NodeHost,
  pumpHookEvents,
  sessionLogReader,
  snapshotSessions,
} from "@harness/platform-native";

const require = createRequire(import.meta.url);

/** A client on the runtime's own connection: requests answered synchronously for the methods used here, and a turn awaited. */
function client(host: NodeHost) {
  const replies = new Map<unknown, Record<string, unknown>>();
  const connection = host.runtime.connect({ principal: "me", kind: "human" }, (m) => void replies.set((m as { id?: unknown }).id, m as Record<string, unknown>));
  let id = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const mine = (id += 1);
    connection.receive({ jsonrpc: "2.0", id: mine, method, params });
    for (let i = 0; i < 400 && !replies.has(mine); i++) await new Promise((r) => setTimeout(r, 5));
    return replies.get(mine)!["result"] as Record<string, unknown>;
  };
  return { request, disconnect: () => connection.disconnect() };
}

async function withSession() {
  const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" }, tickMs: 60_000 });
  const c = client(host);
  await c.request("initialize", { protocolVersion: 1 });
  const { sessionId } = (await c.request("session/new", { cwd: "/", mcpServers: [] })) as { sessionId: string };
  const prompt = (text: string) => c.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  return { host, sessionId, prompt, leave: c.disconnect };
}

describe("procedural host plumbing", () => {
  it("PX2.40 the hook pump hands each subscribed event to the handler in order and acknowledges it; a new pump for the plugin resumes after the last acknowledged", async () => {
    const { host, sessionId, prompt } = await withSession();
    const seen: HookEvent[] = [];
    const pump = pumpHookEvents(host.runtime, { plugin: "procedural-learner", types: ["turn.ended"], onEvent: async (e) => void seen.push(e), intervalMs: 60_000 });
    await prompt("one");
    await prompt("two");
    await pump.drain();
    expect(seen.map((e) => [e.type, e.sessionId])).toEqual([
      ["turn.ended", sessionId],
      ["turn.ended", sessionId],
    ]);
    pump.close();
    const again: HookEvent[] = [];
    const resumed = pumpHookEvents(host.runtime, { plugin: "procedural-learner", types: ["turn.ended"], onEvent: async (e) => void again.push(e), intervalMs: 60_000 });
    await prompt("three");
    await resumed.drain();
    expect(again).toHaveLength(1);
    resumed.close();
    await host.close();
  });

  it("PX2.41 a handler that fails leaves its event unacknowledged, reported, for the next drain", async () => {
    const { host, prompt } = await withSession();
    const logged: string[] = [];
    let fail = true;
    const handled: number[] = [];
    const pump = pumpHookEvents(host.runtime, {
      plugin: "flaky",
      types: ["turn.ended"],
      onEvent: async (e) => {
        if (fail) throw new Error("not yet");
        handled.push(e.offset);
      },
      intervalMs: 60_000,
      log: (m) => logged.push(m),
    });
    await prompt("one");
    await pump.drain();
    expect(logged).toEqual(["flaky: not yet"]);
    fail = false;
    await pump.drain();
    expect(handled).toHaveLength(1);
    pump.close();
    await host.close();
  });

  it("PX2.42 the pump drains on its own every interval, and a daemon refusal is an error", async () => {
    const { host, prompt } = await withSession();
    const seen: HookEvent[] = [];
    const pump = pumpHookEvents(host.runtime, { plugin: "timed", types: ["turn.ended"], onEvent: async (e) => void seen.push(e), intervalMs: 10 });
    await prompt("one");
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    pump.close();
    const refusing = { connect: (_: unknown, send: (m: object) => void) => ({ id: "c", receive: (m: unknown) => send({ id: (m as { id: number }).id, error: { message: "no" } }), disconnect: () => {} }) };
    expect(() => pumpHookEvents(refusing as never, { plugin: "p", types: [], onEvent: async () => {} })).toThrow("initialize: no");
    await host.close();
  });

  it("PX2.52 without a log a failure is dropped quietly and retried; anything thrown is reported by its text", async () => {
    const { host, prompt } = await withSession();
    let throws: unknown = "a string";
    const handled: number[] = [];
    const quiet = pumpHookEvents(host.runtime, {
      plugin: "quiet",
      types: ["turn.ended"],
      onEvent: async (e) => {
        if (throws !== undefined) throw throws;
        handled.push(e.offset);
      },
    });
    await prompt("one");
    await quiet.drain();
    expect(handled).toEqual([]);
    const logged: string[] = [];
    const loud = pumpHookEvents(host.runtime, { plugin: "loud", types: ["turn.ended"], onEvent: async () => Promise.reject("plain"), log: (m) => logged.push(m), intervalMs: 60_000 });
    await prompt("two");
    await loud.drain();
    expect(logged).toEqual(["loud: plain"]);
    throws = undefined;
    await quiet.drain();
    expect(handled).toHaveLength(2);
    quiet.close();
    loud.close();
    await host.close();
  });

  it("PX2.43 the log reader returns a session's entries in [from, to), and none for a session it does not have", async () => {
    const { host, sessionId, prompt } = await withSession();
    await prompt("hello");
    const read = sessionLogReader(host.daemon);
    const all = await read(sessionId, 0, Number.MAX_SAFE_INTEGER);
    expect(all.length).toBeGreaterThan(2);
    expect(all.map((e) => e.offset)).toEqual(all.map((_, i) => i));
    expect((await read(sessionId, 1, 3)).map((e) => e.offset)).toEqual([1, 2]);
    expect(await read(sessionId, 2)).toEqual(all.slice(2));
    expect(await read("absent", 0, 10)).toEqual([]);
    await host.close();
  });

  it("PX2.69 the log reader reads one session through Daemon.readLog and never copies the daemon's snapshot", async () => {
    const { host, sessionId, prompt } = await withSession();
    await prompt("hello");
    const snapshot = vi.spyOn(host.daemon, "snapshot");
    const readLog = vi.spyOn(host.daemon, "readLog");
    const read = sessionLogReader(host.daemon);
    expect((await read(sessionId, 1, 3)).map((e) => e.offset)).toEqual([1, 2]);
    expect(await read(sessionId, 2)).toEqual(host.daemon.readLog(sessionId, 2));
    expect(readLog).toHaveBeenCalledWith(sessionId, 1, 3);
    expect(readLog).toHaveBeenCalledWith(sessionId, 2, undefined);
    expect(snapshot).not.toHaveBeenCalled();
    await host.close();
  });

  it("PX2.44 procedural settings load from the package's own data file by default, or from a tweaked copy", () => {
    const own = require.resolve("@harness/procedural/data/settings.json");
    expect(loadProceduralSettings().presets.harness.overlay).toBe(true);
    const copy = JSON.parse(readFileSync(own, "utf8"));
    copy.presets.harness.guidanceCache = false;
    const file = join(mkdtempSync(join(tmpdir(), "procedural-")), "settings.json");
    writeFileSync(file, JSON.stringify(copy));
    expect(loadProceduralSettings(file).presets.harness.guidanceCache).toBe(false);
    writeFileSync(file, JSON.stringify({ ...copy, presets: {} }));
    expect(() => loadProceduralSettings(file)).toThrow(/invalid procedural settings/);
  });
});

describe("procedural guidance and access on the native host", () => {
  const graph = GraphIdSchema.parse("default");
  const seeded = async () => {
    const store = new MemoryProceduralStore();
    await importGraph({ store, graph, clock: hostPorts.clock });
    return store;
  };
  const mine = parseResolver({ rules: [{ when: { principal: "me" }, graph: "default" }] });

  it("PX2.53 the step hook resolves a session with the host's principal, pins it and delivers guidance from the session's model", async () => {
    const store = await seeded();
    const notices: unknown[] = [];
    const step = nativeProceduralStep({ store, settings: loadProceduralSettings(), resolver: mine, principal: "me" });
    const input = { sessionId: "s1", turnId: "t1", messages: [{ role: "user" as const, content: "Find it." }], initialInstructions: undefined, stepNumber: 0, model: scriptedModel(() => "Start by searching."), report: (n: unknown) => void notices.push(n) };
    const prepared = await step.prepare(input);
    expect(JSON.stringify(prepared?.messages?.at(-1))).toContain("Start by searching.");
    expect(await store.pins.get("s1")).toMatchObject({ graph, core: revisionId(seedGraph()) });
    expect(notices).toHaveLength(1);
    const other = nativeProceduralStep({ store, settings: loadProceduralSettings(), resolver: mine, principal: "someone-else", preset: "paper" });
    expect(await other.prepare({ ...input, sessionId: "s2" })).toBeUndefined();
    expect(await nativeProceduralStep({ store, settings: loadProceduralSettings(), resolver: mine }).prepare({ ...input, sessionId: "s3" })).toBeUndefined();
    expect(await store.pins.get("s2")).toBeUndefined();
  });

  it("PX2.118 the host's step hook applies the access policy it is given: a session the policy denies is left unguided", async () => {
    const store = await seeded();
    const resolver = parseResolver({ rules: [{ when: {}, graph: "default" }] });
    const policy = parsePolicy({ rules: [{ when: { meta: { team: "search" } }, allow: true }], default: "deny" });
    const step = nativeProceduralStep({ store, settings: loadProceduralSettings(), resolver, policy, model: scriptedModel(() => "Search first.") });
    const input = { sessionId: "s1", turnId: "t1", messages: [{ role: "user" as const, content: "Find it." }], initialInstructions: undefined, stepNumber: 0, model: scriptedModel(() => "Search first."), report: () => {} };
    expect(await step.prepare(input)).toBeUndefined();
    expect(await store.pins.get("s1")).toBeUndefined();
    expect(await step.prepare({ ...input, sessionId: "s2", sessionMeta: { team: "search" } })).toBeDefined();
  });

  it("PX2.54 a harness worker with the step hook prepends each turn's guidance, from the hook's guidance model, to its prompt", async () => {
    const store = await seeded();
    const step = nativeProceduralStep({ store, settings: loadProceduralSettings(), resolver: parseResolver({ rules: [{ when: {}, graph: "default" }] }), model: scriptedModel(() => "Search first.") });
    const harness = harnessWorker({ harness: scriptedHarness((p) => `got ${p}`), sandboxRoot: mkdtempSync(join(tmpdir(), "procedural-")), step });
    const events: WorkerEvent[] = [];
    await harness.worker.run({ type: "prompt", sessionId: "s1", turnId: "t1", prompt: [{ type: "text", text: "one" }], cwd: "/" }, (e) => events.push(e));
    const text = events.flatMap((e) => (e.type === "update" && e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text" ? [e.update.content.text] : [])).join("");
    expect(text).toMatch(/^got .*Search first\.[\s\S]*one$/);
    await harness.close();
  });

  it("PX2.68 the step hook forgets a session the daemon detaches: its next step is guided afresh", async () => {
    const { host, sessionId, leave } = await withSession();
    const store = await seeded();
    const notices: { _meta: { harness: { procedural: { step: { cached: boolean } } } } }[] = [];
    const step = nativeProceduralStep({ store, settings: loadProceduralSettings(), resolver: mine, principal: "me" });
    const evictions = nativeStepEvictions({ runtime: host.runtime, step, intervalMs: 60_000 });
    const input = (stepNumber: number) => ({ sessionId, turnId: "t1", messages: [{ role: "user" as const, content: "Find it." }], initialInstructions: undefined, stepNumber, model: scriptedModel(() => "Start by searching."), report: (n: unknown) => void notices.push(n as (typeof notices)[number]) });
    await step.prepare(input(0));
    await step.prepare(input(1));
    await evictions.drain();
    await step.prepare(input(2));
    leave();
    await evictions.drain();
    await step.prepare(input(3));
    expect(notices.map((n) => n._meta.harness.procedural.step.cached)).toEqual([false, true, true, false]);
    evictions.close();
    // With the pump's own interval, and a log.
    nativeStepEvictions({ runtime: host.runtime, step, log: () => undefined }).close();
    await host.close();
  });

  it("PX2.55 the policy file binds to the host's principal; the resolver loads from procedural's data file by default", () => {
    const file = join(mkdtempSync(join(tmpdir(), "procedural-")), "policy.json");
    writeFileSync(file, JSON.stringify({ rules: [{ when: { principal: "me", actions: ["revert"] }, allow: false }] }));
    const policy = loadProceduralPolicy(file);
    expect(hostAuthorizer(policy, "me")("revert", graph)).toBe(false);
    expect(hostAuthorizer(policy, "me")("read", graph)).toBe(true);
    expect(hostAuthorizer(policy, "you")("revert", graph)).toBe(true);
    expect(hostAuthorizer(undefined, "me")("revert", graph)).toBe(true);
    expect(resolveGraph(loadProceduralResolver(), {})).toBe("default");
    writeFileSync(file, JSON.stringify({ rules: "none" }));
    expect(() => loadProceduralResolver(file)).toThrow(/invalid procedural resolver/);
    expect(hostPorts.entropy.bytes(16)).toHaveLength(16);
  });
});

describe("the live learner on the native host", () => {
  it("PX2.56 the learner observes each ended turn of a pinned session from the daemon's log, once, into the graph's overlay", async () => {
    const { host, sessionId, prompt } = await withSession();
    const store = new MemoryProceduralStore();
    const graph = GraphIdSchema.parse("default");
    const { revision } = (await importGraph({ store, graph, clock: hostPorts.clock })) as { revision: RevisionId };
    await store.pins.set(sessionId, { graph, core: revision, overlay: 0, salt: "s", at: 0 });
    const live = nativeLiveLearner({ runtime: host.runtime, store, settings: loadProceduralSettings(), intervalMs: 60_000 });
    await prompt("one");
    await live.drain();
    await live.drain();
    const events = (await store.overlay(graph).read(0)).map((e) => e.event);
    expect(events.filter((e) => e.kind === "observed").map((e) => (e as { turnKey: string }).turnKey)).toEqual([expect.stringMatching(new RegExp(`^${sessionId}/`))]);
    expect(await live.learner.feedback(sessionId, "absent-turn", 2)).toMatchObject({ kind: "skipped" });
    live.close();
    await host.close();
  });

  it("PX2.61 with reflection on in the preset, the learner reflects on a scored turn with the host's reflector", async () => {
    const { host, sessionId, prompt } = await withSession();
    const store = new MemoryProceduralStore();
    const graph = GraphIdSchema.parse("default");
    const { revision } = (await importGraph({ store, graph, clock: hostPorts.clock })) as { revision: RevisionId };
    await store.pins.set(sessionId, { graph, core: revision, overlay: 0, salt: "s", at: 0 });
    const base = loadProceduralSettings();
    const settings = { ...base, presets: { ...base.presets, harness: { ...base.presets.harness, live: { ...base.presets.harness.live!, reflection: "turn" as const } } } };
    const asked: string[] = [];
    const live = nativeLiveLearner({ runtime: host.runtime, store, settings, intervalMs: 60_000, reflect: async ({ trajectory }) => (asked.push(trajectory), []) });
    await prompt("reflect on this");
    const ended = JSON.stringify(host.daemon.snapshot()).match(/"event":"turn\.ended","data":\{"turnId":"([^"]+)"/)!;
    expect(await live.learner.feedback(sessionId, ended[1]!, 0.9)).toMatchObject({ kind: "observed" });
    expect(asked).toEqual([expect.stringMatching(/^Score: 0\.90\nQuery: reflect on this/)]);
    live.close();
    await host.close();
  });

  it("PX2.57 a learner failure is logged and the turn is observed on a later drain", async () => {
    const { host, sessionId, prompt } = await withSession();
    const store = new MemoryProceduralStore();
    const graph = GraphIdSchema.parse("default");
    const { revision } = (await importGraph({ store, graph, clock: hostPorts.clock })) as { revision: RevisionId };
    await store.pins.set(sessionId, { graph, core: revision, overlay: 0, salt: "s", at: 0 });
    const read = store.overlay.bind(store);
    let broken = true;
    store.overlay = (g) => (broken ? { ...read(g), append: async () => Promise.reject(new Error("disk full")) } : read(g));
    const logged: string[] = [];
    const live = nativeLiveLearner({ runtime: host.runtime, store, settings: loadProceduralSettings(), preset: "harness", log: (m) => logged.push(m) });
    await prompt("one");
    await live.drain();
    expect(logged).toEqual(["procedural-learner: disk full"]);
    broken = false;
    await live.drain();
    expect((await store.overlay(graph).read(0)).some((e) => e.event.kind === "observed")).toBe(true);
    live.close();
    await host.close();
  });
});

describe("dream's trajectories and lease on the native host", () => {
  it("PX2.63 trajectories for dream from the live daemon's logs are the ended turns of sessions pinned to the graph, under the revision, scored from the overlay (scored first)", async () => {
    const { host, sessionId, prompt } = await withSession();
    const store = new MemoryProceduralStore();
    const graph = GraphIdSchema.parse("default");
    const { revision } = (await importGraph({ store, graph, clock: hostPorts.clock })) as { revision: RevisionId };
    await store.pins.set(sessionId, { graph, core: revision, overlay: 0, salt: "s", at: 0 });
    await prompt("one");
    await prompt("two");
    const source = logTrajectories({ store, sessions: async () => snapshotSessions(host.daemon.snapshot()) });
    const all = await source.select({ graph, revision, limit: 10 });
    expect(all.map((t) => [t.session, t.core, t.score])).toEqual([
      [sessionId, revision, null],
      [sessionId, revision, null],
    ]);
    await store.overlay(graph).append([{ kind: "observed", turnKey: `${sessionId}/${all[1]!.turn}`, path: [], unmatched: [], score: ScoreSchema.parse(0.75), exposure: [] }]);
    expect(await source.select({ graph, revision, limit: 1 })).toMatchObject([{ turn: all[1]!.turn, score: 0.75, scoreSource: null }]);
    expect(await source.select({ graph: GraphIdSchema.parse("other"), revision, limit: 10 })).toEqual([]);
    expect(await source.select({ graph, revision: RevisionIdSchema.parse("a".repeat(64)), limit: 10 })).toEqual([]);
    const empty = { version: 1, sessions: [{ id: sessionId, cwd: "/", owner: "me", log: {}, tree: {} }], hooks: {} };
    expect(await logTrajectories({ store, sessions: async () => snapshotSessions(empty) }).select({ graph, revision, limit: 5 })).toEqual([]);
    await host.close();
  });

  it("PX2.70 dream's session logs from the live daemon are every session's log, read through readLog without a snapshot", async () => {
    const { host, sessionId, prompt } = await withSession();
    await prompt("one");
    const snapshot = vi.spyOn(host.daemon, "snapshot");
    const logs = daemonSessions(host.daemon);
    snapshot.mockClear();
    expect(logs).toEqual([{ id: sessionId, entries: host.daemon.readLog(sessionId) }]);
    expect(logs[0]!.entries.length).toBeGreaterThan(2);
    expect(snapshot).not.toHaveBeenCalled();
    snapshot.mockRestore();
    expect(logs).toEqual(snapshotSessions(host.daemon.snapshot()));
    await host.close();
  });

  it("PX2.64 a dream runs on the store with the refiner on the given model, under the preset's dream settings, and holds the lease as the host", async () => {
    const store = new MemoryProceduralStore();
    const graph = GraphIdSchema.parse("default");
    await importGraph({ store, graph, clock: hostPorts.clock });
    const model = scriptedModel(() => JSON.stringify({ add_nodes: [], delete_nodes: [], add_edges: [], delete_edges: [] }));
    const dream = nativeDream({ store, settings: loadProceduralSettings(), model, sessions: async () => [], preset: "harness" });
    const result = await dream(graph);
    expect(result).toMatchObject({ status: "done", graph });
    expect(model.doGenerateCalls.length).toBeGreaterThan(0);
    expect(await store.dreams(graph).head()).toBeGreaterThan(0);
    expect(await nativeDream({ store, settings: loadProceduralSettings(), model, sessions: async () => [] })(GraphIdSchema.parse("none"))).toMatchObject({ status: "no-head" });
    expect(await store.lease.acquire(graph, "someone-else")).toBeDefined();
    expect(await nativeDream({ store, settings: loadProceduralSettings(), model, sessions: async () => [], holder: "mine" })(graph)).toEqual({ status: "busy", graph });
  });
});

describe("procedural on the native cognitive host", () => {
  it("PX2.48 the ensemble serves procedural.* over the store in the directory, which a later host reads back; the policy it is given applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "procedural-"));
    const none = { models: [], preferences: {} };
    const first = buildNativeEnsemble({ cacheDir: join(dir, "cache"), allowHosted: false, catalog: none, procedural: { dir: join(dir, "store") } });
    expect(first.ensemble.extensions()).toEqual(["procedural"]);
    const imported = (await invokeCognitive(first.ensemble, "procedural.import", { graph: "team/search" })) as { status: string; revision: string };
    expect(imported.status).toBe("head");
    expect(await first.procedural!.store.heads.get(GraphIdSchema.parse("team/search"))).toEqual({ revision: imported.revision, history: [] });
    expect(first.procedural!.settings).toEqual(loadProceduralSettings());
    const second = buildNativeEnsemble({ cacheDir: join(dir, "cache"), allowHosted: false, catalog: none, procedural: { dir: join(dir, "store"), authorize: (action) => action === "read" } });
    expect(await invokeCognitive(second.ensemble, "procedural.history", { graph: "team/search" })).toMatchObject({ head: imported.revision });
    await expect(invokeCognitive(second.ensemble, "procedural.revert", { graph: "team/search" })).rejects.toThrow("revert on graph team/search is not allowed");
    await Promise.all([first.close(), second.close()]);
  });
});
