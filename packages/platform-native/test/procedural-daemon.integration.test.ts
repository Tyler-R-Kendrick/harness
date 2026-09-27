import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { GraphIdSchema, revisionId, seedGraph } from "@harness/procedural";
import { proceduralStore } from "@harness/platform-native";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
});

/** The daemon with the cognitive core (no hosted models, none loaded) and procedural graphs in `dir`. */
function launch(dir: string, ...extra: string[]) {
  const child = spawn(process.execPath, [MAIN, "--stdio", "--worker", "echo", "--cognitive", "--no-hosted", "--model-cache", join(dir, "models"), "--procedural", join(dir, "procedural"), ...extra], {
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
  const client = new ClientSideConnection(() => ({ sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), stream);
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { child, client, exited, stderr: () => stderr };
}

const invoke = (client: ClientSideConnection, op: string, input: unknown) => client.extMethod("_harness/cognitive/invoke", { op, input });

describe("procedural graphs on the native daemon", () => {
  it("PX2.50 --procedural serves procedural.* over ACP (dream and feedback included), kept in the directory across a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-procedural-"));
    const first = launch(dir);
    await first.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(await invoke(first.client, "procedural.import", { graph: "team/search" })).toEqual({ status: "head", revision: revisionId(seedGraph()) });
    expect(await invoke(first.client, "procedural.export", { graph: "team/search", format: "mermaid" })).toMatchObject({ status: "ok", text: expect.stringMatching(/^flowchart TD\n/) });
    // Dream and feedback reach the host's dream runner and live learner.
    expect(await invoke(first.client, "procedural.dream", { graph: "none" })).toEqual({ status: "done", result: { status: "no-head", graph: "none" } });
    expect(await invoke(first.client, "procedural.feedback", { session: "s", turn: "t", score: 1 })).toEqual({ status: "missing", reason: "session s is not pinned to a graph" });
    first.child.stdin.end();
    expect(await first.exited).toBe(0);

    const second = launch(dir);
    await second.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(await invoke(second.client, "procedural.history", { graph: "team/search" })).toMatchObject({ head: revisionId(seedGraph()), revisions: [{ origin: "import" }] });
    second.child.stdin.end();
    expect(await second.exited).toBe(0);
    expect(await proceduralStore(join(dir, "procedural")).heads.get(GraphIdSchema.parse("team/search"))).toEqual({ revision: revisionId(seedGraph()), history: [] });
  });

  it("PX2.51 without the cognitive core --procedural still starts (sessions are guided), and procedural.* is not served", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-procedural-"));
    const child = spawn(process.execPath, [MAIN, "--stdio", "--worker", "echo", "--procedural", join(dir, "procedural")], { env: { ...process.env, NODE_OPTIONS: "" } });
    children.push(child);
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const client = new ClientSideConnection(() => ({ sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) }), stream);
    await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await expect(invoke(client, "procedural.history", { graph: "g" })).rejects.toMatchObject({ message: expect.stringMatching(/procedural|cognitive/) });
    const { sessionId } = await client.newSession({ cwd: "/tmp", mcpServers: [] });
    expect(await client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })).toMatchObject({ stopReason: "end_turn" });
  });
});
