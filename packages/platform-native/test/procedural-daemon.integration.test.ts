import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { GraphIdSchema, revisionId, RevisionRecordSchema, seedGraph } from "@harness/procedural";
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

  it("PX2.71 the daemon dreams on the preset's schedule from its ticks, gating on the --procedural-eval task suite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-procedural-"));
    // A graph whose head was set long ago: the harness preset's weekly dream is due at the first tick.
    const store = proceduralStore(join(dir, "procedural"));
    const seed = seedGraph();
    await store.revisions.put(RevisionRecordSchema.parse({ id: revisionId(seed), graph: "team/search", parents: [], document: seed, edits: null, origin: "import", evidence: {}, decision: { kind: "head" }, at: 0 }));
    await store.heads.set(GraphIdSchema.parse("team/search"), undefined, revisionId(seed));
    const tasks = join(dir, "tasks.json");
    writeFileSync(tasks, JSON.stringify({ scorer: "exact", tasks: [{ id: "v0", prompt: "Capital of France?", expected: "Paris", split: "validation" }] }));
    // No gateway credential: the suite's solver (the gateway model) fails, and the scheduled dream says so.
    const { AI_GATEWAY_API_KEY: _key, VERCEL_OIDC_TOKEN: _oidc, ...env } = process.env;
    const child = spawn(process.execPath, [MAIN, "--stdio", "--worker", "echo", "--procedural", join(dir, "procedural"), "--procedural-eval", tasks], { env: { ...env, NODE_OPTIONS: "" } });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    for (let i = 0; i < 600 && !stderr.includes("procedural: scheduled dream"); i++) await new Promise((r) => setTimeout(r, 25));
    expect(stderr).toMatch(/procedural: scheduled dream of team\/search \(every\) failed: task v0 failed: /);
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));
    // The attempt is in the store: the dream started, so a restart waits a week.
    const entries = await proceduralStore(join(dir, "procedural")).dreams(GraphIdSchema.parse("team/search")).read(0);
    expect(entries[0]?.event).toMatchObject({ kind: "started", head: revisionId(seed), train: [] });
  });

  it("PX2.72 --procedural-eval is refused at startup when it cannot work: no --procedural, a malformed file, a judge or tools the host lacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-procedural-"));
    const file = (name: string, content: unknown) => {
      const path = join(dir, name);
      writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
      return path;
    };
    const valid = { scorer: "exact", tasks: [{ id: "v0", prompt: "p", expected: "e", split: "validation" }] };
    const run = async (...args: string[]) => {
      const child = spawn(process.execPath, [MAIN, "--stdio", "--worker", "echo", ...args], { env: { ...process.env, NODE_OPTIONS: "" } });
      children.push(child);
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
      return { code, stderr };
    };
    const procedural = ["--procedural", join(dir, "procedural")];
    expect(await run("--procedural-eval", file("a.json", valid))).toEqual({ code: 2, stderr: "--procedural-eval needs --procedural: the task suite scores that directory's graphs when they dream\n" });
    expect(await run(...procedural, "--procedural-eval", file("b.json", { ...valid, scorer: "bleu" }))).toMatchObject({ code: 2, stderr: expect.stringMatching(/^--procedural-eval .*b\.json: invalid task suite[\s\S]*at scorer/) });
    expect(await run(...procedural, "--procedural-eval", file("c.json", { ...valid, scorer: "judge" }))).toEqual({ code: 2, stderr: "the task suite's judge scorer needs --cognitive: the catalog's judge scores the answers\n" });
    expect(await run(...procedural, "--procedural-eval", file("d.json", { ...valid, tools: [{ name: "lookup" }] }))).toEqual({ code: 2, stderr: "the task suite names tools, and this host offers only its workflow library's (--cognitive --workflows <dir>)\n" });
    expect(await run(...procedural, "--workflows", join(dir, "wf"), "--procedural-eval", file("e.json", { ...valid, tools: [{ name: "lookup" }] }))).toMatchObject({ code: 2 });
  });
});
