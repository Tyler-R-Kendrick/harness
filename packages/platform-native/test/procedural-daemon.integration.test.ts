import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { CandidateDocumentSchema, FORMAT, GraphIdSchema, revisionId, RevisionRecordSchema, seedGraph } from "@harness/procedural";
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
    expect(await invoke(first.client, "procedural.feedback", { session: "s", turn: "t", score: 1 })).toEqual({ status: "no-pin", reason: "session s is not pinned to a graph" });
    first.child.stdin.end();
    expect(await first.exited).toBe(0);

    const second = launch(dir);
    await second.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(await invoke(second.client, "procedural.history", { graph: "team/search" })).toMatchObject({ head: revisionId(seedGraph()), revisions: [{ origin: "import" }] });
    second.child.stdin.end();
    expect(await second.exited).toBe(0);
    expect(await proceduralStore(join(dir, "procedural")).heads.get(GraphIdSchema.parse("team/search"))).toEqual({ revision: revisionId(seedGraph()), history: [] });
  });

  it("PX2.129 the daemon serves procedural.plan and procedural.run, and at startup resumes the plan runs a stopped daemon left in plan-runs.json, logging each end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-procedural-"));
    const store = join(dir, "procedural");
    mkdirSync(store, { recursive: true });
    const done = { plan: { nodes: [], edges: [] }, outcomes: {} };
    writeFileSync(
      join(store, "plan-runs.json"),
      JSON.stringify({
        runs: [
          { id: "00000000000000a1", graph: "team/search", state: done },
          { id: "00000000000000a2", graph: "team/search", state: { ...done, outcomes: { ghost: { ok: true, output: 1 } } } },
        ],
      }),
    );
    const d = launch(dir);
    await d.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    for (let i = 0; i < 400 && !d.stderr().includes("00000000000000a2"); i++) await new Promise((r) => setTimeout(r, 10));
    expect(d.stderr()).toContain("procedural: plan run 00000000000000a1 on team/search succeeded: no tasks\n");
    expect(d.stderr()).toContain("procedural: plan run 00000000000000a2 on team/search could not be resumed and was dropped: task ghost is not in the plan\n");
    expect(await invoke(d.client, "procedural.import", { graph: "team/search" })).toMatchObject({ status: "head" });
    expect(await invoke(d.client, "procedural.plan", { graph: "team/search", from: "Start", to: "End" })).toMatchObject({ status: "ok", plan: { nodes: [], edges: [] } });
    expect(await invoke(d.client, "procedural.run", { graph: "team/search", from: "Start", to: "End" })).toMatchObject({ graph: "team/search", status: "succeeded", tasks: [] });
    expect(await invoke(d.client, "procedural.run", { graph: "team/search", from: "End", to: "Start" })).toMatchObject({ status: "invalid", diagnostics: [{ code: "unreachable" }] });
    d.child.stdin.end();
    expect(await d.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(store, "plan-runs.json"), "utf8"))).toEqual({ runs: [] });
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

  it("PX2.96 an agent worker's daemon gives dream a composer: procedural.dream runs with it; a --workflows directory that is procedural's staging library, or an invalid --procedural-composition file, keeps the daemon from starting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-procedural-"));
    const daemon = launch(dir, "--worker", "model");
    await daemon.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(await invoke(daemon.client, "procedural.dream", { graph: "none" })).toEqual({ status: "done", result: { status: "no-head", graph: "none" } });
    daemon.child.stdin.end();
    expect(await daemon.exited).toBe(0);

    const shared = launch(dir, "--worker", "model", "--workflows", join(dir, "procedural", "staging"));
    expect(await shared.exited).not.toBe(0);
    expect(shared.stderr()).toContain("cannot be procedural's staging library");
    const file = join(dir, "composition.json");
    writeFileSync(file, JSON.stringify({ support: 0, minScore: 0.5, maxLength: 3 }));
    const invalid = launch(dir, "--worker", "model", "--procedural-composition", file);
    expect(await invalid.exited).not.toBe(0);
    expect(invalid.stderr()).toContain("invalid composition settings");
  });

  it("PX2.125 a harness worker's daemon gives dream a composer too: procedural.dream runs with it; a --workflows directory that is procedural's staging library keeps it from starting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-procedural-"));
    const harness = ["--worker", "harness", "--harness", "codex", "--harness-state", join(dir, "harness.json"), "--sandboxes", join(dir, "sandboxes")];
    const daemon = launch(dir, ...harness);
    await daemon.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(await invoke(daemon.client, "procedural.dream", { graph: "none" })).toEqual({ status: "done", result: { status: "no-head", graph: "none" } });
    daemon.child.stdin.end();
    expect(await daemon.exited).toBe(0);
    const shared = launch(dir, ...harness, "--workflows", join(dir, "procedural", "staging"));
    expect(await shared.exited).not.toBe(0);
    expect(shared.stderr()).toContain("cannot be procedural's staging library");
  });

  it("PX2.123 --procedural-tools gives the daemon's dream the tools a deployment declares free of side effects: a valid file starts it and procedural.dream runs; an invalid one, or one without --procedural, keeps it from starting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-procedural-"));
    const file = (name: string, content: unknown) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(content));
      return path;
    };
    const daemon = launch(dir, "--procedural-tools", file("tools.json", { sideEffectFree: ["search"] }));
    await daemon.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    expect(await invoke(daemon.client, "procedural.dream", { graph: "none" })).toEqual({ status: "done", result: { status: "no-head", graph: "none" } });
    daemon.child.stdin.end();
    expect(await daemon.exited).toBe(0);

    const invalid = launch(dir, "--procedural-tools", file("bad.json", { sideEffectFree: [""] }));
    expect(await invalid.exited).toBe(2);
    expect(invalid.stderr()).toMatch(/^--procedural-tools .*bad\.json: invalid tool declarations/);
    const alone = spawn(process.execPath, [MAIN, "--stdio", "--worker", "echo", "--procedural-tools", join(dir, "tools.json")], { env: { ...process.env, NODE_OPTIONS: "" } });
    children.push(alone);
    let stderr = "";
    alone.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    expect(await new Promise((resolve) => alone.on("exit", resolve))).toBe(2);
    expect(stderr).toBe("--procedural-tools needs --procedural: it declares the tools that directory's graphs dream over\n");
  });

  it("PX2.89 the daemon dreams on the preset's schedule from its ticks, gating on the --procedural-eval task suite", async () => {
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

  it("PX2.90 --procedural-eval is refused at startup when it cannot work: no --procedural, a malformed file, a judge or tools the host lacks", async () => {
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

  it("PX2.112 the approvals inbox over ACP: an import proposal waits and is announced on the hook bus, procedural.approve commits it, procedural.decline rejects another, each decision announced; the policy's approve action guards them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-procedural-"));
    const state = join(dir, "state.json");
    const expert = {
      format: FORMAT,
      nodeTypes: ["ACTION", "REASONING", "STATUS"],
      relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
      nodes: [
        { id: "Start", type: "STATUS", description: "The task begins." },
        { id: "search", type: "ACTION", description: "Search the index." },
        { id: "End", type: "STATUS", description: "Answered." },
      ],
      edges: [
        { from: "Start", relation: "LEADS_TO", to: "search", condition: null, guidance: "Search first.", pitfalls: "" },
        { from: "search", relation: "LEADS_TO", to: "End", condition: null, guidance: "Answer.", pitfalls: "" },
      ],
    };
    const proposal = revisionId(CandidateDocumentSchema.parse(expert));
    const other = { ...expert, edges: [expert.edges[0]!, { ...expert.edges[1]!, guidance: "Answer briefly." }] };
    const declined = revisionId(CandidateDocumentSchema.parse(other));
    const seed = revisionId(seedGraph());

    const daemon = launch(dir, "--state", state);
    await daemon.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await invoke(daemon.client, "procedural.import", { graph: "team/search" });
    expect(await invoke(daemon.client, "procedural.import", { graph: "team/search", document: expert })).toEqual({ status: "proposed", revision: proposal, head: seed });
    expect(await invoke(daemon.client, "procedural.approvals", { graph: "team/search" })).toMatchObject({ head: seed, approvals: [{ candidate: proposal, origin: "import", onHead: true }] });
    expect(await invoke(daemon.client, "procedural.approve", { graph: "team/search", candidate: proposal })).toEqual({ status: "committed", graph: "team/search", candidate: proposal, revision: proposal, previous: seed });
    await invoke(daemon.client, "procedural.import", { graph: "team/search", document: other });
    expect(await invoke(daemon.client, "procedural.decline", { graph: "team/search", candidate: declined })).toEqual({ status: "declined", graph: "team/search", candidate: declined });
    expect(await invoke(daemon.client, "procedural.approvals", { graph: "team/search" })).toMatchObject({ head: proposal, approvals: [] });
    daemon.child.stdin.end();
    expect(await daemon.exited).toBe(0);
    // The daemon's saved state holds the notices, published by the host under source `procedural`.
    const hooks = (JSON.parse(readFileSync(state, "utf8")) as { hooks: { events: { type: string; source: string; payload: Record<string, unknown> }[] } }).hooks.events.filter((e) => e.type.startsWith("procedural.approval."));
    expect(hooks.map((e) => [e.type, e.source, e.payload["candidate"], e.payload["decision"]])).toEqual([
      ["procedural.approval.requested", "procedural", proposal, undefined],
      ["procedural.approval.decided", "procedural", proposal, "approved"],
      ["procedural.approval.requested", "procedural", declined, undefined],
      ["procedural.approval.decided", "procedural", declined, "declined"],
    ]);
    expect(await proceduralStore(join(dir, "procedural")).heads.get(GraphIdSchema.parse("team/search"))).toEqual({ revision: proposal, history: [seed] });

    // A policy that keeps approve from this host's principal refuses the inbox, and nothing is decided.
    const policy = join(dir, "policy.json");
    writeFileSync(policy, JSON.stringify({ rules: [{ when: { actions: ["approve"] }, allow: false }] }));
    const guarded = launch(dir, "--procedural-policy", policy);
    await guarded.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await invoke(guarded.client, "procedural.import", { graph: "team/search", document: other });
    await expect(invoke(guarded.client, "procedural.approvals", { graph: "team/search" })).rejects.toMatchObject({ message: expect.stringContaining("approve on graph team/search is not allowed") });
    await expect(invoke(guarded.client, "procedural.approve", { graph: "team/search", candidate: declined })).rejects.toMatchObject({ message: expect.stringContaining("approve on graph team/search is not allowed") });
    guarded.child.stdin.end();
    expect(await guarded.exited).toBe(0);
  });
});
