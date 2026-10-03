import { describe, expect, it } from "vitest";
import { Daemon } from "@harness/core";
import type { Identity, Output } from "@harness/core";
import { ManualClock, SeededEntropy } from "@harness/testkit";
import { bytes, commitSha, Ensemble, sha256 } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { connectPeer, ensembleVerifier, errorText, layerDispatch, parseLayerSettings, PluginPump } from "../src/host.ts";
import type { DispatchStepLike, PeerRuntimeLike } from "../src/host.ts";
import { forkId } from "../src/types.ts";
import { readFileSync } from "node:fs";
import { rig, saying } from "./compose-fixtures.ts";

// ---- a runtime over a real daemon: what a host's `DaemonRuntime.connect` gives a peer ------------------------

function runtimeOf(daemon: Daemon): PeerRuntimeLike {
  const sends = new Map<string, (message: object) => void>();
  let n = 0;
  const apply = (outputs: Output[]) => {
    for (const o of outputs) if (o.kind === "send") sends.get(o.connectionId)?.(o.message);
  };
  return {
    connect(identity: Identity, send) {
      const id = `c${n++}`;
      sends.set(id, send);
      daemon.connect(id, identity);
      return {
        receive: (message) => apply(daemon.receive(id, message)),
        disconnect: () => apply(daemon.disconnect(id)),
      };
    },
  };
}

const newDaemon = () => new Daemon({ clock: new ManualClock(1_000), entropy: new SeededEntropy(3), agentInfo: { name: "h", version: "1" } });
const PLUGIN: Identity = { principal: "decision", kind: "plugin" };

describe("connectPeer: a plugin's connection to the daemon inside the host's process", () => {
  it("DHN1.1 the connection is initialized and its calls reach the daemon's hook bus", async () => {
    const daemon = newDaemon();
    const peer = await connectPeer(runtimeOf(daemon), PLUGIN);
    await peer.call("_harness/hooks/subscribe", { types: ["thing.happened"] });
    daemon.publish({ type: "thing.happened", payload: { n: 1 } });
    const polled = (await peer.call("_harness/hooks/poll", {})) as { events: { type: string; payload: { n: number } }[] };
    expect(polled.events.map((e) => e.payload.n)).toEqual([1]);
  });

  it("DHN1.2 a call the daemon refuses fails with the daemon's message", async () => {
    const peer = await connectPeer(runtimeOf(newDaemon()), { principal: "alice", kind: "human" });
    await expect(peer.call("_harness/hooks/poll", {})).rejects.toThrow("only plugins use the hook bus");
    await expect(peer.call("nope/nothing", {})).rejects.toThrow("unknown method nope/nothing");
  });

  it("DHN1.3 each call is told apart by its id: two in flight at once get their own answers", async () => {
    const daemon = newDaemon();
    const peer = await connectPeer(runtimeOf(daemon), PLUGIN);
    const [list, subscribed] = await Promise.all([peer.call("_harness/capabilities/list", {}), peer.call("_harness/hooks/subscribe", { types: ["a.b"] })]);
    expect(list).toHaveProperty("capabilities");
    expect(subscribed).toEqual({});
  });

  it("DHN1.4 closing hangs up the connection once, fails calls in flight and refuses new ones", async () => {
    const hungUp: number[] = [];
    // A daemon that answers the initialization and nothing else: every other call stays in flight.
    const runtime: PeerRuntimeLike = {
      connect(_identity, send) {
        return {
          receive: (m) => {
            const { id, method } = m as { id: number; method: string };
            if (method === "initialize") send({ jsonrpc: "2.0", id, result: {} });
          },
          disconnect: () => void hungUp.push(1),
        };
      },
    };
    const peer = await connectPeer(runtime, PLUGIN);
    const pending = peer.call("_harness/hooks/poll", {});
    peer.close();
    peer.close();
    expect(hungUp).toHaveLength(1);
    await expect(pending).rejects.toThrow("the connection is closed");
    await expect(peer.call("_harness/hooks/poll", {})).rejects.toThrow("the connection is closed");
  });

  it("DHN1.5 messages that answer no call of its own (notifications, requests to it, answers to calls it did not make) are ignored", async () => {
    const daemon = newDaemon();
    let deliver!: (message: object) => void;
    const runtime: PeerRuntimeLike = {
      connect(identity, send) {
        deliver = send;
        daemon.connect("x", identity);
        // The daemon's own replies are dropped here, so only what the test delivers by hand arrives.
        return { receive: (m) => void daemon.receive("x", m), disconnect: () => void daemon.disconnect("x") };
      },
    };
    let settled = false;
    const peer = connectPeer(runtime, PLUGIN).then((p) => ((settled = true), p));
    deliver({ jsonrpc: "2.0", method: "session/update", params: {} });
    // a request to the peer that happens to carry the id of its pending call is not the call's answer
    deliver({ jsonrpc: "2.0", id: 1, method: "session/request_permission", params: {} });
    deliver({ jsonrpc: "2.0", id: 12345, result: {} });
    deliver({ jsonrpc: "2.0", id: "1", result: {} });
    deliver({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    deliver({ jsonrpc: "2.0", id: 1, result: { agentCapabilities: {} } });
    await expect(peer).resolves.toBeDefined();
  });

  it("DHN1.6 an error answer fails the call with its message, or with the error as it came when it has none; a failed initialization hangs the connection up", async () => {
    const answers: unknown[] = [{ code: -32000, message: "no thanks" }, { code: -32000 }, "refused", { code: 1, message: 7 }, null];
    const hungUp: number[] = [];
    const runtimeAnswering = (error: unknown): PeerRuntimeLike => ({
      connect(_identity, send) {
        return {
          receive: (m) => send({ jsonrpc: "2.0", id: (m as { id: number }).id, error }),
          disconnect: () => void hungUp.push(1),
        };
      },
    });
    const failures: string[] = [];
    for (const error of answers) await connectPeer(runtimeAnswering(error), PLUGIN).catch((e: Error) => failures.push(e.message));
    expect(failures).toEqual([
      "initialize failed (no thanks)",
      'initialize failed (request failed ({"code":-32000}))',
      'initialize failed (request failed ("refused"))',
      'initialize failed (request failed ({"code":1,"message":7}))',
      "initialize failed (request failed (null))",
    ]);
    expect(hungUp).toHaveLength(5);
  });
});

// ---- the pump ----------------------------------------------------------------------------------------------------

/** A plugin whose steps handle the numbers it is given, one per step. */
function stepper(handled: number[]) {
  const calls: number[] = [];
  return {
    calls,
    async step() {
      calls.push(calls.length);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return handled[calls.length - 1] ?? 0;
    },
  };
}

describe("PluginPump: steps the plugin until nothing is left", () => {
  it("DHN2.1 steps again while events are being handled, and stops at the first step that handles none", async () => {
    const plugin = stepper([3, 2, 0, 7]);
    const pump = new PluginPump(plugin);
    expect(await pump.pump()).toBe(5);
    expect(plugin.calls).toHaveLength(3);
  });

  it("DHN2.2 a pump asked for while one runs does not overlap it: one more round runs after it, and both calls get the same result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let steps = 0;
    let inFlight = 0;
    let overlapped = false;
    const plugin = {
      async step() {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        steps += 1;
        if (steps === 1) await gate;
        inFlight -= 1;
        return 0;
      },
    };
    const pump = new PluginPump(plugin);
    const first = pump.pump();
    const second = pump.pump();
    release();
    expect(await first).toBe(await second);
    expect(steps).toBe(2);
    expect(overlapped).toBe(false);
  });

  it("DHN2.3 a pump asked for after one finished runs afresh", async () => {
    const plugin = stepper([]);
    const pump = new PluginPump(plugin);
    await pump.pump();
    await pump.pump();
    expect(plugin.calls).toHaveLength(2);
  });

  it("DHN2.4 a plugin that always has more is stepped at most maxRounds times (default 32) in one pump", async () => {
    const endless = { calls: 0, async step() { this.calls += 1; return 1; } };
    expect(await new PluginPump(endless, { maxRounds: 4 }).pump()).toBe(4);
    expect(endless.calls).toBe(4);
    const more = { calls: 0, async step() { this.calls += 1; return 1; } };
    await new PluginPump(more).pump();
    expect(more.calls).toBe(32);
  });

  it("DHN2.5 a plugin whose step fails fails the pump, and the next pump runs afresh", async () => {
    let fail = true;
    const plugin = {
      async step() {
        if (fail) throw new Error("bus down");
        return 0;
      },
    };
    const pump = new PluginPump(plugin);
    await expect(pump.pump()).rejects.toThrow("bus down");
    fail = false;
    expect(await pump.pump()).toBe(0);
  });

  it("DHN2.6 idle resolves once the pump in flight has finished, and at once when none is", async () => {
    const plugin = stepper([1]);
    const pump = new PluginPump(plugin);
    await pump.idle();
    expect(plugin.calls).toHaveLength(0);
    void pump.pump();
    await pump.idle();
    expect(plugin.calls).toHaveLength(2);
  });

  it("DHN2.7 idle does not throw when the pump in flight failed", async () => {
    const pump = new PluginPump({ step: () => Promise.reject(new Error("x")) });
    const failed = pump.pump().catch(() => "failed");
    await expect(pump.idle()).resolves.toBeUndefined();
    expect(await failed).toBe("failed");
  });
});

// ---- settings from files -----------------------------------------------------------------------------------------------

const shipped = (name: string): unknown => JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url), "utf8"));
const RAW = () => ({
  attention: shipped("attention"),
  stuck: shipped("stuck"),
  dispatch: shipped("dispatch"),
  lifecycle: shipped("lifecycle"),
  evolve: shipped("evolve"),
  permission: shipped("permission-questions"),
});

describe("parseLayerSettings", () => {
  it("DHN3.1 the shipped files parse into the layer's settings", () => {
    const settings = parseLayerSettings(RAW());
    expect(settings.dispatch.version).toBe("dispatch-1");
    expect(settings.permission).toBeDefined();
    expect(Object.keys(settings).sort()).toEqual(["attention", "dispatch", "evolve", "lifecycle", "permission", "stuck"]);
  });

  it("DHN3.2 the permission questions are optional", () => {
    const { permission: _, ...rest } = RAW();
    expect(parseLayerSettings(rest)).not.toHaveProperty("permission");
  });

  it("DHN3.3 a file that does not parse is an error that names the settings it is", () => {
    expect(() => parseLayerSettings({ ...RAW(), dispatch: { version: "" } })).toThrow("invalid dispatch settings");
    expect(() => parseLayerSettings({ ...RAW(), stuck: 3 })).toThrow("stuck settings");
  });
});

// ---- dispatch: the layer's dispatch fork as a step planner ----------------------------------------------------------------

const ROUTINE = { score: [0, 0, 0, 1] };
const JUDGMENT = { score: [1, 0, 0, 0] };

const step = (over: Partial<DispatchStepLike> = {}): DispatchStepLike => ({
  sessionId: "s1",
  stepNumber: 1,
  messages: [{ role: "user", content: [{ type: "text", text: "rename the variable everywhere" }] }],
  toolNames: ["edit", "grep"],
  contextTokens: 50_000,
  ...over,
});

describe("layerDispatch: the dispatch fork decides which tier a step runs on", () => {
  const tiers = { small: "S", large: "L" } as const;

  it("DHN4.1 a run of routine work on the large tier moves the step to the small one, and is recorded as a decision of the session", async () => {
    const r = rig({ members: [saying("m", ROUTINE)] });
    const dispatch = layerDispatch({ layer: r.layer, tiers });
    expect(await dispatch.plan(step())).toBe("small");
    const [record] = await r.layer.records({ fork: forkId("dispatch") });
    expect(record).toMatchObject({ session: "s1", action: "small", input: { current: "large", context: 50_000 } });
  });

  it("DHN4.2 work that needs judgment stays on the large tier", async () => {
    const r = rig({ members: [saying("m", JUDGMENT)] });
    expect(await layerDispatch({ layer: r.layer, tiers }).plan(step())).toBe("stay");
  });

  it("DHN4.3 the session is on the small tier after a step moved there, and the next step stays there (stay would mean the session's own model)", async () => {
    const r = rig({ members: [saying("m", ROUTINE)] });
    const dispatch = layerDispatch({ layer: r.layer, tiers });
    expect(await dispatch.plan(step())).toBe("small");
    dispatch.onDispatch({ sessionId: "s1", stepNumber: 1, choice: "small" });
    expect(await dispatch.plan(step({ stepNumber: 2 }))).toBe("small");
    const records = await r.layer.records({ fork: forkId("dispatch") });
    expect(records.map((x) => (x.input as { current: string }).current)).toEqual(["large", "small"]);
  });

  it("DHN4.4 a new turn starts on the large tier whatever the last one ended on", async () => {
    const r = rig({ members: [saying("m", ROUTINE)] });
    const dispatch = layerDispatch({ layer: r.layer, tiers });
    dispatch.onDispatch({ sessionId: "s1", stepNumber: 3, choice: "small" });
    await dispatch.plan(step({ stepNumber: 0 }));
    const [record] = await r.layer.records({ fork: forkId("dispatch") });
    expect(record!.input).toMatchObject({ current: "large" });
  });

  it("DHN4.5 a step that stayed (the tier was not available) leaves the session on the large tier", async () => {
    const r = rig({ members: [saying("m", ROUTINE)] });
    const dispatch = layerDispatch({ layer: r.layer, tiers });
    dispatch.onDispatch({ sessionId: "s1", stepNumber: 1, choice: "small" });
    dispatch.onDispatch({ sessionId: "s1", stepNumber: 2, choice: "stay" });
    await dispatch.plan(step({ stepNumber: 3 }));
    const [record] = await r.layer.records({ fork: forkId("dispatch") });
    expect(record!.input).toMatchObject({ current: "large" });
  });

  it("DHN4.6 sessions are told apart", async () => {
    const r = rig({ members: [saying("m", ROUTINE)] });
    const dispatch = layerDispatch({ layer: r.layer, tiers });
    dispatch.onDispatch({ sessionId: "s1", stepNumber: 1, choice: "small" });
    await dispatch.plan(step({ sessionId: "s2", stepNumber: 2 }));
    const [record] = await r.layer.records({ fork: forkId("dispatch") });
    expect(record).toMatchObject({ session: "s2", input: { current: "large" } });
  });

  it("DHN4.7 a decision in shadow mode is recorded and not acted on", async () => {
    const r = rig({ members: [saying("m", ROUTINE)], policyPatch: { forks: { dispatch: { mode: "shadow" } } } });
    expect(await layerDispatch({ layer: r.layer, tiers }).plan(step())).toBe("stay");
    expect((await r.layer.records({ fork: forkId("dispatch") }))[0]).toMatchObject({ action: "small", mode: "shadow" });
  });

  it("DHN4.8 with no member to ask the ladder ends at the person, and the step stays", async () => {
    const r = rig({ members: [] });
    expect(await layerDispatch({ layer: r.layer, tiers }).plan(step())).toBe("stay");
    expect((await r.layer.records({ fork: forkId("dispatch") }))[0]).toMatchObject({ rung: "human", action: "stay" });
  });

  it("DHN4.9 the task the fork is shown is the last thing the person said and the tools just used", async () => {
    const asked: unknown[] = [];
    const r = rig({
      members: [
        {
          id: "m",
          version: "v1",
          ask: async (a) => {
            asked.push(a.state);
            return saying("x", ROUTINE).ask(a);
          },
        },
      ],
    });
    const dispatch = layerDispatch({ layer: r.layer, tiers });
    await dispatch.plan(
      step({
        messages: [
          { role: "user", content: "first thing" },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: [{ type: "text", text: "second " }, { type: "image", image: "x" }, { type: "text", text: "thing" }] },
          { role: "tool", content: [] },
        ],
        lastToolInputs: [{ toolName: "grep" }, { toolName: "edit" }],
      }),
    );
    expect((asked[0] as { task: string }).task).toBe("second thing\nlast tool calls: grep, edit");
  });

  it("DHN4.10 a string message is the task as it is, cut at 400 characters; no user message is no task", async () => {
    const asked: string[] = [];
    const r = rig({
      members: [
        {
          id: "m",
          version: "v1",
          ask: async (a) => {
            asked.push((a.state as { task: string }).task);
            return saying("x", ROUTINE).ask(a);
          },
        },
      ],
    });
    const dispatch = layerDispatch({ layer: r.layer, tiers });
    await dispatch.plan(step({ messages: [{ role: "user", content: "x".repeat(500) }] }));
    await dispatch.plan(step({ messages: [{ role: "assistant", content: "hi" }], lastToolInputs: [] }));
    await dispatch.plan(step({ messages: [{ role: "user", content: 7 }] }));
    // parts that are not text, are not objects, or say their text wrongly are not words
    await dispatch.plan(step({ messages: [{ role: "user", content: [null, "text", 5, { type: "image", text: "no" }, { type: "text", text: 7 }, { type: "text" }, { text: "no type" }, { type: "text", text: "yes" }] }] }));
    expect(asked).toEqual(["x".repeat(400), "", "", "yes"]);
  });

  it("DHN4.11 the tiers it was given are the ones it reports, and a failing decision is the caller's to handle", async () => {
    const dispatch = layerDispatch({ layer: { decideNamed: () => Promise.reject(new Error("log down")) }, tiers });
    expect(dispatch.tiers).toEqual(tiers);
    await expect(dispatch.plan(step())).rejects.toThrow("log down");
  });

  it("DHN4.12 a failure is reported to the handler it was given, with the step", () => {
    const seen: [unknown, string][] = [];
    const dispatch = layerDispatch({ layer: rig().layer, tiers, onError: (e, s) => void seen.push([e, s.sessionId]) });
    dispatch.onError!("boom", step());
    expect(seen).toEqual([["boom", "s1"]]);
    expect(layerDispatch({ layer: rig().layer, tiers })).not.toHaveProperty("onError");
  });

  it("DHN4.13 the sessions it remembers are bounded: the one least recently told about is forgotten first", async () => {
    const r = rig({ members: [saying("m", ROUTINE)] });
    const dispatch = layerDispatch({ layer: r.layer, tiers, remember: 2 });
    for (const s of ["a", "b"]) dispatch.onDispatch({ sessionId: s, stepNumber: 1, choice: "small" });
    // a is told about again, so b is the one least recently told about when c comes
    dispatch.onDispatch({ sessionId: "a", stepNumber: 2, choice: "small" });
    dispatch.onDispatch({ sessionId: "c", stepNumber: 1, choice: "small" });
    for (const s of ["a", "b", "c"]) await dispatch.plan(step({ sessionId: s, stepNumber: 2 }));
    const records = await r.layer.records({ fork: forkId("dispatch") });
    expect(records.map((x) => [x.session, (x.input as { current: string }).current])).toEqual([["a", "small"], ["b", "large"], ["c", "small"]]);
  });
});

describe("layerDispatch: what the fork is shown, and the facts it is given", () => {
  const tiers = { small: "S", large: "L" } as const;

  it("DHF1.1 the person's words and the tools just used are shown with their secrets removed", async () => {
    const asked: string[] = [];
    const r = rig({
      members: [
        {
          id: "m",
          version: "v1",
          ask: async (a) => {
            asked.push((a.state as { task: string }).task);
            return saying("x", ROUTINE).ask(a);
          },
        },
      ],
    });
    const dispatch = layerDispatch({ layer: r.layer, tiers });
    await dispatch.plan(step({ messages: [{ role: "user", content: "export OPENAI_API_KEY=sk-live-1 and rename" }], lastToolInputs: [{ toolName: "curl --password hunter2" }] }));
    expect(asked).toEqual(["export OPENAI_API_KEY=[redacted] and rename\nlast tool calls: curl --password [redacted]"]);
    const [record] = await r.layer.records({ fork: forkId("dispatch") });
    expect(JSON.stringify(record!.input)).not.toMatch(/sk-live-1|hunter2/);
  });

  it("DHF1.2 a secret near the end of the words that are cut is cut with them or removed, never kept", async () => {
    const seen: unknown[] = [];
    const layer = { decideNamed: (_: string, input: unknown) => (seen.push(input), Promise.reject(new Error("stop"))) } as unknown as Parameters<typeof layerDispatch>[0]["layer"];
    const dispatch = layerDispatch({ layer, tiers });
    await dispatch.plan(step({ messages: [{ role: "user", content: `${"x".repeat(392)} token=abcdefghijk` }] })).catch(() => undefined);
    expect((seen[0] as { task: string }).task).toBe(`${"x".repeat(392)} token=[redacted]`);
  });

  it("DHF1.3 a step whose tool calls delete or deploy is given the facts that hold it on the large tier, whatever the model says", async () => {
    for (const lastToolInputs of [[{ toolName: "delete_file" }], [{ toolName: "bash", input: { command: "git push --force origin main" } }], [{ toolName: "grep" }, { toolName: "deploy" }]]) {
      const r = rig({ members: [saying("m", ROUTINE)] });
      expect(await layerDispatch({ layer: r.layer, tiers }).plan(step({ lastToolInputs })), JSON.stringify(lastToolInputs)).toBe("stay");
      const [record] = await r.layer.records({ fork: forkId("dispatch") });
      expect(record!.input).toMatchObject({ facts: expect.objectContaining({}) });
      expect(JSON.stringify((record!.input as { facts: unknown }).facts)).toMatch(/irreversible|production/);
      expect(record).toMatchObject({ action: "stay" });
    }
  });

  it("DHF1.4 a step of harmless tool calls has no facts and still moves to the small tier", async () => {
    const r = rig({ members: [saying("m", ROUTINE)] });
    expect(await layerDispatch({ layer: r.layer, tiers }).plan(step({ lastToolInputs: [{ toolName: "grep" }, { toolName: "edit", input: { command: "ls" } }] }))).toBe("small");
    const [record] = await r.layer.records({ fork: forkId("dispatch") });
    expect(record!.input).not.toHaveProperty("facts");
  });

  it("DHF1.5 a layer that does not say its settings is given no facts", async () => {
    const seen: unknown[] = [];
    const layer = { decideNamed: (_: string, input: unknown) => (seen.push(input), Promise.reject(new Error("stop"))) } as unknown as Parameters<typeof layerDispatch>[0]["layer"];
    await layerDispatch({ layer, tiers }).plan(step({ lastToolInputs: [{ toolName: "delete_file" }] })).catch(() => undefined);
    expect(seen[0]).not.toHaveProperty("facts");
  });

  it("DHF1.6 the facts come from the settings the layer holds: other words, other facts", async () => {
    const seen: unknown[] = [];
    const settings = { dispatch: { derive: { fragile: ["grep"] } } } as unknown as NonNullable<Parameters<typeof layerDispatch>[0]["layer"]["settings"]>;
    const layer = { settings, decideNamed: (_: string, input: unknown) => (seen.push(input), Promise.reject(new Error("stop"))) } as unknown as Parameters<typeof layerDispatch>[0]["layer"];
    await layerDispatch({ layer, tiers }).plan(step({ lastToolInputs: [{ toolName: "grep" }] })).catch(() => undefined);
    expect(seen[0]).toMatchObject({ facts: { fragile: true } });
  });
});

// ---- the verifier -----------------------------------------------------------------------------------------------------

const model = (id: string, extra: Partial<ModelDescriptor> = {}): ModelDescriptor =>
  ({
    id,
    name: id,
    publisher: "t",
    tasks: ["judgment"],
    ports: ["judge"],
    locality: "local",
    runtime: "transformers.js",
    run: { dtype: "q4" },
    platforms: ["native", "browser"],
    license: "MIT",
    downloadBytes: bytes(1),
    artifact: { repo: `t/${id}`, revision: commitSha("a".repeat(40)), files: [{ path: "m.onnx", bytes: bytes(1), sha256: sha256("b".repeat(64)) }] },
    benchmarks: [{ benchmark: "b", task: "judgment", metric: "m", score: 50, higherIsBetter: true }],
    ...extra,
  }) as ModelDescriptor;

const ensembleOf = (...models: ModelDescriptor[]): Ensemble => {
  const ensemble = new Ensemble({ platform: "native" });
  for (const m of models) ensemble.register(m, async () => ({}));
  return ensemble;
};

describe("ensembleVerifier", () => {
  it("DHN9.1 with more than one judgment model the verifier is the ensemble under an identity of its own", () => {
    const verifier = ensembleVerifier(ensembleOf(model("a"), model("b")));
    expect(verifier).toMatchObject({ id: "ensemble-verifier", version: "ensemble" });
  });

  it("DHN9.2 with one judgment model, or none, there is nothing distinct to verify with", () => {
    expect(ensembleVerifier(ensembleOf(model("a")))).toBeUndefined();
    expect(ensembleVerifier(ensembleOf())).toBeUndefined();
  });

  it("DHN9.3 a model that does not serve the judge port is not a second judge", () => {
    expect(ensembleVerifier(ensembleOf(model("a"), model("b", { ports: ["generator"] })))).toBeUndefined();
  });
});

describe("errorText", () => {
  it("DHN9.4 an error is its message, and anything else is as it reads", () => {
    expect(errorText(new Error("bus down"))).toBe("bus down");
    expect(errorText("the bus is down")).toBe("the bus is down");
    expect(errorText(404)).toBe("404");
    expect(errorText(undefined)).toBe("undefined");
  });
});
