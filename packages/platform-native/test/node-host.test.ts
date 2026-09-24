import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { NdjsonDecoder, encodeFrame } from "@harness/protocol";
import type { Worker } from "@harness/workers";
import { FileStorage, NodeHost } from "@harness/platform-native";

function wire(host: NodeHost) {
  const input = new PassThrough();
  const output = new PassThrough();
  const received: Record<string, unknown>[] = [];
  const framer = new NdjsonDecoder();
  output.on("data", (b: Buffer) => {
    for (const r of framer.push(b.toString("utf8"))) if (r.kind === "message") received.push(r.value as Record<string, unknown>);
  });
  host.attach(input, output);
  const send = (m: unknown) => input.write(encodeFrame(m));
  const waitFor = async (pred: (m: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const m = received.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out");
  };
  return { input, send, waitFor, received };
}

describe("NodeHost", () => {
  it("NH1.1 a worker that throws still ends the turn instead of leaving the client waiting", async () => {
    const broken: Worker = { run: async () => { throw new Error("boom"); }, cancel: () => {}, permission: () => {} };
    const host = await NodeHost.start({ worker: broken, identity: { principal: "me", kind: "human" } });
    const c = wire(host);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    c.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/", mcpServers: [] } });
    const created = (await c.waitFor((m) => m["id"] === 2)) as { result: { sessionId: string } };
    c.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: created.result.sessionId, prompt: [] } });
    expect(await c.waitFor((m) => m["id"] === 3)).toEqual({ jsonrpc: "2.0", id: 3, result: { stopReason: "refusal" } });
    await host.close();
  });

  it("NH1.2 a host without storage runs entirely in memory", async () => {
    const host = await NodeHost.start({ worker: { run: async () => {}, cancel: () => {}, permission: () => {} }, identity: { principal: "me", kind: "human" } });
    const c = wire(host);
    c.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    expect(await c.waitFor((m) => m["id"] === 1)).toMatchObject({ result: { protocolVersion: 1 } });
    c.input.end();
    await host.close();
  });

  it("NH1.3 an unreadable snapshot location fails startup loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-host-"));
    mkdirSync(join(dir, "state.json"));
    await expect(new FileStorage(join(dir, "state.json")).load()).rejects.toThrow(/EISDIR/);
    await expect(NodeHost.start({ statePath: join(dir, "state.json"), worker: { run: async () => {}, cancel: () => {}, permission: () => {} }, identity: { principal: "me", kind: "human" } })).rejects.toThrow();
  });
});
