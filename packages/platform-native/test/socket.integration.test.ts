import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EchoWorker } from "@harness/workers";
import { NodeHost } from "@harness/platform-native";
import { RawClient, sleep } from "./helpers.ts";
import type { Msg } from "./helpers.ts";

const hosts: NodeHost[] = [];
const clients: RawClient[] = [];
const identity = { principal: "tester", kind: "human" as const };

async function startHost(dir: string, pauseMs = 15) {
  const host = await NodeHost.start({ statePath: join(dir, "state.json"), worker: new EchoWorker({ pause: () => sleep(pauseMs) }), identity, tickMs: 50 });
  await host.listen(join(dir, "harness.sock"));
  hosts.push(host);
  return host;
}

async function client(dir: string): Promise<RawClient> {
  const c = await RawClient.connect(join(dir, "harness.sock"));
  clients.push(c);
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: {}, _meta: { harness: { profileVersion: 1 } } });
  return c;
}

const offsetOf = (m: Msg) => (m.params?.["_meta"] as { harness: { offset: number } } | undefined)?.harness.offset;
const isTurnEnded = (m: Msg) => m.method === "_harness/session/event" && m.params?.["event"] === "turn.ended";

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of hosts.splice(0)) await h.close();
});

describe("native daemon over a Unix socket", () => {
  it("NS2.1 MX1 a turn outlives its client and a second client replays it once, in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-sock-"));
    await startHost(dir);
    const a = await client(dir);
    const { result } = await a.request("session/new", { cwd: dir, mcpServers: [] });
    const sessionId = (result as { sessionId: string }).sessionId;
    a.send({ jsonrpc: "2.0", id: 99, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "a b c d e f" }] } });
    await a.waitFor((m) => m.method === "session/update");
    a.close();

    const b = await client(dir);
    await b.request("_harness/session/attach", { sessionId, from: 0 });
    await b.waitFor(isTurnEnded);
    const offsets = b.received.map(offsetOf).filter((o): o is number => o !== undefined);
    expect(offsets).toEqual([...offsets.keys()]);
    const text = b.received
      .filter((m) => m.method === "session/update" && (m.params?.["update"] as { sessionUpdate: string }).sessionUpdate === "agent_message_chunk")
      .map((m) => ((m.params?.["update"] as { content: { text: string } }).content.text))
      .join("");
    expect(text).toBe("echo: a b c d e f");
  });

  it("NS2.2 two attached clients both receive the live stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-sock-"));
    await startHost(dir);
    const a = await client(dir);
    const { result } = await a.request("session/new", { cwd: dir, mcpServers: [] });
    const sessionId = (result as { sessionId: string }).sessionId;
    const b = await client(dir);
    await b.request("_harness/session/attach", { sessionId });
    await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "fan out" }] });
    await b.waitFor(isTurnEnded);
    const chunks = (c: RawClient) => c.received.filter((m) => m.method === "session/update").length;
    expect(chunks(a)).toBeGreaterThan(0);
    expect(chunks(b)).toBe(chunks(a));
  });

  it("NS2.3 the socket is private to its owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-sock-"));
    await startHost(dir);
    expect(statSync(join(dir, "harness.sock")).mode & 0o077).toBe(0);
  });

  it("NS2.4 MX5 sessions persist across a host restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-sock-"));
    const host = await startHost(dir, 0);
    const a = await client(dir);
    const { result } = await a.request("session/new", { cwd: dir, mcpServers: [] });
    const sessionId = (result as { sessionId: string }).sessionId;
    await a.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "persist" }] });
    a.close();
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);

    await startHost(dir, 0);
    const b = await client(dir);
    const list = await b.request("session/list", {});
    expect(list.result).toEqual({ sessions: [{ sessionId, cwd: dir }] });
  });

  it("NS2.5 malformed input gets a JSON-RPC error and the connection keeps working", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-sock-"));
    await startHost(dir);
    const a = await client(dir);
    a.send("not json at all" as unknown);
    const err = await a.waitFor((m) => m.error?.code === -32600 || m.error?.code === -32700);
    expect(err.id).toBeNull();
    const list = await a.request("session/list", {});
    expect(list.result).toEqual({ sessions: [] });
  });
});
