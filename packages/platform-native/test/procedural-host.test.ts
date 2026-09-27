import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { HookEvent } from "@harness/core";
import { EchoWorker } from "@harness/workers";
import { loadProceduralSettings, NodeHost, pumpHookEvents, sessionLogReader } from "@harness/platform-native";

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
  return { request };
}

async function withSession() {
  const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" }, tickMs: 60_000 });
  const c = client(host);
  await c.request("initialize", { protocolVersion: 1 });
  const { sessionId } = (await c.request("session/new", { cwd: "/", mcpServers: [] })) as { sessionId: string };
  const prompt = (text: string) => c.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  return { host, sessionId, prompt };
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

  it("PX2.43 the log reader returns a session's entries in [from, to), and none for a session it does not have", async () => {
    const { host, sessionId, prompt } = await withSession();
    await prompt("hello");
    const read = sessionLogReader(host.daemon);
    const all = await read(sessionId, 0, Number.MAX_SAFE_INTEGER);
    expect(all.length).toBeGreaterThan(2);
    expect(all.map((e) => e.offset)).toEqual(all.map((_, i) => i));
    expect((await read(sessionId, 1, 3)).map((e) => e.offset)).toEqual([1, 2]);
    expect(await read("absent", 0, 10)).toEqual([]);
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
