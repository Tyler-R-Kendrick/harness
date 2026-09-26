import { describe, expect, it } from "vitest";
import type { Identity, SnapshotStorage } from "@harness/core";
import { bytes, Ensemble } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { DaemonRuntime } from "@harness/runtime";
import type { RuntimeOptions } from "@harness/runtime";
import { hashEmbeddingModel, ManualClock, MemoryStorage, SeededEntropy } from "@harness/testkit";
import type { Worker } from "@harness/workers";

const ME: Identity = { principal: "me", kind: "human" };
const idle: Worker = { run: async () => {}, cancel: () => {}, permission: () => {} };

type Message = Record<string, unknown>;

async function runtime(options: Partial<RuntimeOptions> = {}) {
  const clock = new ManualClock(1_000);
  const logged: string[] = [];
  const rt = await DaemonRuntime.start({ worker: idle, clock, entropy: new SeededEntropy(1), log: (m) => logged.push(m), ...options });
  return { rt, clock, logged };
}

/** A peer on the runtime: what it was sent, and requests by id. */
function peer(rt: DaemonRuntime) {
  const received: Message[] = [];
  const connection = rt.connect(ME, (m) => received.push(m as Message));
  let next = 1;
  const request = (method: string, params: unknown = {}) => {
    const id = next++;
    connection.receive({ jsonrpc: "2.0", id, method, params });
    return id;
  };
  const waitFor = async (pred: (m: Message) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const m = received.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error("timed out");
  };
  const reply = (id: number) => waitFor((m) => m["id"] === id);
  const open = async () => {
    request("initialize", { protocolVersion: 1 });
    const created = (await reply(request("session/new", { cwd: "/", mcpServers: [] }))) as { result: { sessionId: string } };
    return created.result.sessionId;
  };
  return { connection, received, request, reply, waitFor, open };
}

describe("DaemonRuntime", () => {
  it("RT1.1 a connection's requests reach the daemon and its replies come back to that connection only", async () => {
    const { rt } = await runtime();
    const a = peer(rt);
    const b = peer(rt);
    expect(a.connection.id).not.toBe(b.connection.id);
    expect(a.connection.id).toMatch(/^con_/);
    expect(await a.reply(a.request("initialize", { protocolVersion: 1 }))).toMatchObject({ result: { protocolVersion: 1 } });
    expect(b.received).toEqual([]);
    await rt.close();
  });

  it("RT1.2 a prompt runs on the worker and its updates and end reach the client", async () => {
    const worker: Worker = {
      ...idle,
      run: async (c, emit) => {
        emit({ type: "update", sessionId: c.sessionId, turnId: c.turnId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } });
        emit({ type: "end", sessionId: c.sessionId, turnId: c.turnId, stopReason: "end_turn" });
      },
    };
    const { rt } = await runtime({ worker });
    const p = peer(rt);
    const sessionId = await p.open();
    const id = p.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    expect(await p.reply(id)).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(p.received).toContainEqual(expect.objectContaining({ method: "session/update", params: expect.objectContaining({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } }) }));
    await rt.close();
  });

  it("RT1.3 a worker that throws ends the turn as a refusal, and the failure is logged", async () => {
    const { rt, logged } = await runtime({ worker: { ...idle, run: async () => { throw new Error("boom"); } } });
    const p = peer(rt);
    const sessionId = await p.open();
    expect(await p.reply(p.request("session/prompt", { sessionId, prompt: [] }))).toMatchObject({ result: { stopReason: "refusal" } });
    expect(logged).toEqual([expect.stringMatching(/^worker failed: Error: boom/)]);
    await rt.close();
  });

  it("RT1.4 a worker that rejects with a non-error is logged as text", async () => {
    const { rt, logged } = await runtime({ worker: { ...idle, run: () => Promise.reject("nope") } });
    const p = peer(rt);
    const sessionId = await p.open();
    await p.reply(p.request("session/prompt", { sessionId, prompt: [] }));
    expect(logged).toEqual(["worker failed: nope"]);
    await rt.close();
  });

  it("RT1.5 cancels and permission answers go to the worker", async () => {
    const seen: string[] = [];
    let release = () => {};
    const worker: Worker = {
      run: (c, emit) =>
        new Promise<void>((done) => {
          emit({ type: "permission", sessionId: c.sessionId, turnId: c.turnId, requestId: "perm-1", toolCall: { toolCallId: "t1" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] });
          release = () => (emit({ type: "end", sessionId: c.sessionId, turnId: c.turnId, stopReason: "cancelled" }), done());
        }),
      permission: (c) => seen.push(`permission ${c.requestId} ${c.outcome.outcome}`),
      cancel: (_, turnId) => (seen.push(`cancel ${typeof turnId}`), release()),
    };
    const { rt } = await runtime({ worker });
    const p = peer(rt);
    const sessionId = await p.open();
    const prompt = p.request("session/prompt", { sessionId, prompt: [] });
    const ask = (await p.waitFor((m) => m["method"] === "session/request_permission")) as { id: number };
    p.connection.receive({ jsonrpc: "2.0", id: ask.id, result: { outcome: { outcome: "selected", optionId: "ok" } } });
    p.connection.receive({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    expect(await p.reply(prompt)).toMatchObject({ result: { stopReason: "cancelled" } });
    expect(seen).toEqual(["permission perm-1 selected", "cancel string"]);
    await rt.close();
  });

  it("RT1.6 tick expires deadlines: an unanswered permission request is cancelled once its time passes", async () => {
    const answers: string[] = [];
    const worker: Worker = {
      ...idle,
      run: async (c, emit) => emit({ type: "permission", sessionId: c.sessionId, turnId: c.turnId, requestId: "perm-1", toolCall: { toolCallId: "t1" }, options: [] }),
      permission: (c) => answers.push(c.outcome.outcome),
    };
    const { rt, clock } = await runtime({ worker, permissionTimeoutMs: 500 });
    const p = peer(rt);
    const sessionId = await p.open();
    p.request("session/prompt", { sessionId, prompt: [] });
    await p.waitFor((m) => m["method"] === "session/request_permission");
    clock.advance(499);
    rt.tick();
    expect(answers).toEqual([]);
    clock.advance(1);
    rt.tick();
    expect(answers).toEqual(["cancelled"]);
    await rt.close();
  });

  it("RT1.7 a behavior event goes to the worker, and the change it reports lands in the session log", async () => {
    const worker: Worker = { ...idle, event: (c, emit) => emit({ type: "behavior", sessionId: c.sessionId, change: { state: "cheerful", cause: `event ${c.name}` } }) };
    const { rt } = await runtime({ worker });
    const p = peer(rt);
    const sessionId = await p.open();
    expect(await p.reply(p.request("_harness/behavior/event", { sessionId, event: "praised" }))).toMatchObject({ result: {} });
    const log = rt.daemon.snapshot().sessions[0]!.log as { entries: { payload: { event?: string; data?: unknown } }[] };
    expect(log.entries.map((e) => e.payload)).toContainEqual({ event: "behavior.changed", data: { state: "cheerful", cause: "event praised" } });
    await rt.close();
  });

  it("RT1.8 a behavior event for a worker without behavior is accepted and does nothing", async () => {
    const { rt } = await runtime();
    const p = peer(rt);
    const sessionId = await p.open();
    expect(await p.reply(p.request("_harness/behavior/event", { sessionId, event: "praised" }))).toMatchObject({ result: {} });
    await rt.close();
  });

  it("RT1.9 after disconnecting, a connection's messages are ignored and nothing more is sent to it", async () => {
    const { rt } = await runtime();
    const p = peer(rt);
    await p.open();
    p.connection.disconnect();
    p.connection.disconnect();
    const before = p.received.length;
    p.request("session/list");
    await new Promise((r) => setTimeout(r, 5));
    expect(p.received).toHaveLength(before);
    expect(rt.daemon.snapshot().sessions).toHaveLength(1);
    await rt.close();
  });

  it("RT2.1 state is saved after changes and a runtime started later restores it, marking interrupted turns", async () => {
    const storage = new MemoryStorage();
    const { rt } = await runtime({ storage, worker: { ...idle, run: () => new Promise(() => {}) } });
    const p = peer(rt);
    const sessionId = await p.open();
    p.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] });
    await new Promise((r) => setTimeout(r, 5));
    const saved = storage.reopen();
    const later = (await runtime({ storage: saved })).rt;
    const q = peer(later);
    q.request("initialize", { protocolVersion: 1 });
    expect(await q.reply(q.request("session/list"))).toMatchObject({ result: { sessions: [{ sessionId }] } });
    q.request("session/load", { sessionId, cwd: "/", mcpServers: [] });
    expect(await q.waitFor((m) => (m["params"] as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "notice")).toMatchObject({ params: { update: { title: "Turn interrupted by daemon restart" } } });
    await later.close();
    const reloaded = (await saved.reopen().load()) as { sessions: unknown[] };
    expect(reloaded.sessions).toHaveLength(1);
  });

  it("RT2.2 saves are coalesced: a burst of changes writes far fewer snapshots than changes, the last one current", async () => {
    const saves: unknown[] = [];
    const storage: SnapshotStorage = { load: async () => undefined, save: async (s) => void saves.push(s) };
    const { rt } = await runtime({ storage });
    const p = peer(rt);
    p.request("initialize", { protocolVersion: 1 });
    for (let i = 0; i < 5; i++) p.request("session/new", { cwd: "/", mcpServers: [] });
    await rt.close();
    expect(saves.length).toBeLessThan(6);
    expect((saves.at(-1) as { sessions: unknown[] }).sessions).toHaveLength(5);
  });

  it("RT2.3 a failed save is logged and later saves still run", async () => {
    let fail = true;
    const saves: unknown[] = [];
    const storage: SnapshotStorage = { load: async () => undefined, save: async (s) => { if (fail) { fail = false; throw new Error("disk full"); } saves.push(s); } };
    const { rt, logged } = await runtime({ storage });
    const p = peer(rt);
    await p.open();
    await new Promise((r) => setTimeout(r, 5));
    p.request("session/new", { cwd: "/", mcpServers: [] });
    await rt.close();
    expect(logged).toEqual(["snapshot save failed: Error: disk full"]);
    expect(saves.length).toBeGreaterThan(0);
  });

  it("RT2.4 close waits for running turns before the final save", async () => {
    const saves: { sessions: { log: unknown }[] }[] = [];
    const storage: SnapshotStorage = { load: async () => undefined, save: async (s) => void saves.push(JSON.parse(JSON.stringify(s))) };
    let finish = () => {};
    const worker: Worker = { ...idle, run: (c, emit) => new Promise<void>((done) => (finish = () => (emit({ type: "end", sessionId: c.sessionId, turnId: c.turnId, stopReason: "end_turn" }), done()))) };
    const { rt } = await runtime({ storage, worker });
    const p = peer(rt);
    const sessionId = await p.open();
    const id = p.request("session/prompt", { sessionId, prompt: [] });
    await new Promise((r) => setTimeout(r, 5));
    let closed = false;
    const closing = rt.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(await p.reply(id)).toMatchObject({ result: { stopReason: "end_turn" } });
    expect(JSON.stringify(saves.at(-1))).toContain("end_turn");
  });

  it("RT2.5 without storage the runtime runs in memory", async () => {
    const { rt } = await runtime();
    const p = peer(rt);
    await p.open();
    await rt.close();
    expect(rt.daemon.snapshot().sessions).toHaveLength(1);
  });

  it("RT3.1 with an ensemble, cognitive capabilities are mirrored and invokes are answered by the ensemble", async () => {
    const embedder: ModelDescriptor = { id: "embedder-a", name: "Embedder A", publisher: "t", tasks: ["text-embedding"], ports: ["embedder"], locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["browser"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] };
    const ensemble = new Ensemble({ platform: "browser" });
    ensemble.register(embedder, async () => ({ embedder: hashEmbeddingModel(4) }));
    const { rt } = await runtime({ cognitive: ensemble });
    expect(rt.daemon.capabilities()).toContainEqual(expect.objectContaining({ name: "cognitive.text-embedding", trust: "trusted", provenance: "platform" }));
    const p = peer(rt);
    p.request("initialize", { protocolVersion: 1 });
    const ok = (await p.reply(p.request("_harness/cognitive/invoke", { op: "embed", input: { inputs: [{ kind: "query", text: "hello" }] } }))) as { result: { model: string; vectors: number[][] } };
    expect(ok.result.model).toBe("embedder-a");
    expect(ok.result.vectors[0]).toHaveLength(4);
    expect(await p.reply(p.request("_harness/cognitive/invoke", { op: "embed", input: { inputs: "bad" } }))).toMatchObject({ error: { code: -32603, message: expect.stringMatching(/inputs/) } });
    ensemble.revoke("embedder-a", "platform withdrew it");
    expect(rt.daemon.capabilities().map((c) => c.name)).not.toContain("cognitive.text-embedding");
    await rt.close();
    ensemble.register({ ...embedder, id: "embedder-c" }, async () => ({ embedder: hashEmbeddingModel(4) }));
    expect(rt.daemon.capabilities().map((c) => c.name)).not.toContain("cognitive.text-embedding");
  });

  it("RT3.2 without an ensemble, cognitive work fails with the host's reason", async () => {
    const { rt } = await runtime({ cognitiveOff: "start with --cognitive" });
    const p = peer(rt);
    p.request("initialize", { protocolVersion: 1 });
    expect(await p.reply(p.request("_harness/cognitive/status"))).toMatchObject({ error: { message: "the cognitive core is not enabled on this host (start with --cognitive)" } });
    await rt.close();
  });

  it("RT3.3 without an ensemble or a reason, cognitive work fails plainly", async () => {
    const { rt } = await runtime();
    const p = peer(rt);
    p.request("initialize", { protocolVersion: 1 });
    expect(await p.reply(p.request("_harness/cognitive/status"))).toMatchObject({ error: { message: "the cognitive core is not enabled on this host" } });
    await rt.close();
  });

  it("RT3.4 an ensemble failure that is not an error is reported as text", async () => {
    const ensemble = new Ensemble({ platform: "browser" });
    const embedder: ModelDescriptor = { id: "embedder-b", name: "Embedder B", publisher: "t", tasks: ["text-embedding"], ports: ["embedder"], locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["browser"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] };
    ensemble.register(embedder, async () => ({ embedder: { ...hashEmbeddingModel(4), doEmbed: () => Promise.reject("weights missing") } }));
    const { rt } = await runtime({ cognitive: ensemble });
    const p = peer(rt);
    p.request("initialize", { protocolVersion: 1 });
    expect(await p.reply(p.request("_harness/cognitive/invoke", { op: "embed", input: { inputs: [{ kind: "query", text: "x" }] } }))).toMatchObject({ error: { message: expect.stringMatching(/weights missing/) } });
    await rt.close();
  });

  it("RT3.5 without a log, failures are dropped quietly rather than thrown", async () => {
    const rt = await DaemonRuntime.start({ worker: { ...idle, run: async () => { throw new Error("boom"); } }, clock: new ManualClock(), entropy: new SeededEntropy(3) });
    const p = peer(rt);
    const sessionId = await p.open();
    expect(await p.reply(p.request("session/prompt", { sessionId, prompt: [] }))).toMatchObject({ result: { stopReason: "refusal" } });
    await rt.close();
  });

  it("RT3.6 the agent info and flow capacity given reach the daemon", async () => {
    const { rt } = await runtime({ agentInfo: { name: "browser-harness", version: "1.2.3" }, flowCapacity: 7 });
    const p = peer(rt);
    expect(await p.reply(p.request("initialize", { protocolVersion: 1 }))).toMatchObject({ result: { agentInfo: { name: "browser-harness", version: "1.2.3" } } });
    await rt.close();
  });

  it("RT3.7 without agent info the daemon introduces itself as harness", async () => {
    const { rt } = await runtime();
    const p = peer(rt);
    expect(await p.reply(p.request("initialize", { protocolVersion: 1 }))).toMatchObject({ result: { agentInfo: { name: "harness", version: "0.0.0" } } });
    await rt.close();
  });

  it("RT3.8 capability changes from the ensemble are saved as they happen", async () => {
    const saves: string[] = [];
    const storage: SnapshotStorage = { load: async () => undefined, save: async (s) => void saves.push(JSON.stringify(s)) };
    const embedder: ModelDescriptor = { id: "embedder-d", name: "Embedder D", publisher: "t", tasks: ["text-embedding"], ports: ["embedder"], locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["browser"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] };
    const ensemble = new Ensemble({ platform: "browser" });
    ensemble.register(embedder, async () => ({ embedder: hashEmbeddingModel(4) }));
    const { rt } = await runtime({ storage, cognitive: ensemble });
    await new Promise((r) => setTimeout(r, 5));
    const offered = saves.length;
    expect(offered).toBeGreaterThan(0);
    ensemble.revoke("embedder-d", "gone");
    await new Promise((r) => setTimeout(r, 5));
    expect(saves.length).toBeGreaterThan(offered);
    expect(saves.at(-1)).not.toBe(saves[offered - 1]);
    await rt.close();
  });

  it("RT2.6 a fresh runtime saves nothing until something changes, and a tick with nothing due changes nothing", async () => {
    const saves: unknown[] = [];
    const storage: SnapshotStorage = { load: async () => undefined, save: async (s) => void saves.push(s) };
    const { rt } = await runtime({ storage });
    rt.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(saves).toEqual([]);
    await rt.close();
    expect(saves).toEqual([]);
  });

  it("RT2.7 a restored runtime saves at once, so the turns it marked interrupted stay marked", async () => {
    const storage = new MemoryStorage();
    const { rt } = await runtime({ storage, worker: { ...idle, run: () => new Promise(() => {}) } });
    const p = peer(rt);
    const sessionId = await p.open();
    p.request("session/prompt", { sessionId, prompt: [] });
    await new Promise((r) => setTimeout(r, 5));
    const saves: unknown[] = [];
    const reopened = storage.reopen();
    const watched: SnapshotStorage = { load: () => reopened.load(), save: (s) => (saves.push(s), reopened.save(s)) };
    await runtime({ storage: watched });
    await new Promise((r) => setTimeout(r, 5));
    expect(saves).toHaveLength(1);
    expect(JSON.stringify(saves[0])).toContain("turn.interrupted");
  });

  it("RT2.8 busy counts the turns and cognitive work in flight", async () => {
    let finish = () => {};
    const worker: Worker = { ...idle, run: (c, emit) => new Promise<void>((done) => (finish = () => (emit({ type: "end", sessionId: c.sessionId, turnId: c.turnId, stopReason: "end_turn" }), done()))) };
    let answer = () => {};
    const slow = { ...hashEmbeddingModel(4) };
    const embed = slow.doEmbed.bind(slow);
    slow.doEmbed = (o) => new Promise((resolve) => (answer = () => resolve(embed(o))));
    const embedder: ModelDescriptor = { id: "embedder-e", name: "Embedder E", publisher: "t", tasks: ["text-embedding"], ports: ["embedder"], locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["browser"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] };
    const ensemble = new Ensemble({ platform: "browser" });
    ensemble.register(embedder, async () => ({ embedder: slow }));
    const { rt } = await runtime({ worker, cognitive: ensemble });
    expect(rt.busy).toBe(0);
    const p = peer(rt);
    const sessionId = await p.open();
    const prompt = p.request("session/prompt", { sessionId, prompt: [] });
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.busy).toBe(1);
    const invoke = p.request("_harness/cognitive/invoke", { op: "embed", input: { inputs: [{ kind: "query", text: "x" }] } });
    await new Promise((r) => setTimeout(r, 5));
    expect(rt.busy).toBe(2);
    answer();
    await p.reply(invoke);
    await new Promise((r) => setTimeout(r, 1));
    expect(rt.busy).toBe(1);
    finish();
    await p.reply(prompt);
    await new Promise((r) => setTimeout(r, 1));
    expect(rt.busy).toBe(0);
    await rt.close();
  });

  it("RT1.10 disconnecting releases what the connection held: another client can take over its session", async () => {
    const { rt } = await runtime({ worker: { ...idle, run: async (c, emit) => emit({ type: "end", sessionId: c.sessionId, turnId: c.turnId, stopReason: "end_turn" }) } });
    const a = peer(rt);
    const sessionId = await a.open();
    await a.reply(a.request("session/prompt", { sessionId, prompt: [] }));
    const b = peer(rt);
    b.request("initialize", { protocolVersion: 1 });
    await b.reply(b.request("session/load", { sessionId, cwd: "/", mcpServers: [] }));
    expect(await b.reply(b.request("session/prompt", { sessionId, prompt: [] }))).toMatchObject({ error: { message: expect.stringMatching(/input lease is held/) } });
    a.connection.disconnect();
    expect(await b.reply(b.request("session/prompt", { sessionId, prompt: [] }))).toMatchObject({ result: { stopReason: "end_turn" } });
    await rt.close();
  });

  it("RT3.9 once closed, the runtime stops following the ensemble", async () => {
    const embedder: ModelDescriptor = { id: "embedder-f", name: "Embedder F", publisher: "t", tasks: ["text-embedding"], ports: ["embedder"], locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["browser"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] };
    const ensemble = new Ensemble({ platform: "browser" });
    ensemble.register(embedder, async () => ({ embedder: hashEmbeddingModel(4) }));
    const { rt } = await runtime({ cognitive: ensemble });
    await rt.close();
    ensemble.revoke("embedder-f", "gone");
    expect(rt.daemon.capabilities().map((c) => c.name)).toContain("cognitive.text-embedding");
  });
});
