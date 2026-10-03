import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { connectPeer, forkId } from "@harness/decision";
import { buildNativeDecision, DECISION_LOCK, NodeHost } from "@harness/platform-native";
import { answering, cleanDirs, clientOf, ensembleOf, PermissionWorker, tempDir, until } from "./decision-fixtures.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const CLI = new URL("../src/decision-cli.ts", import.meta.url).pathname;
const run = promisify(execFile);
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  await cleanDirs();
});

interface Daemon {
  readonly child: ChildProcessWithoutNullStreams;
  readonly client: ClientSideConnection;
  readonly exited: Promise<number | null>;
  stderr(): string;
  // The result of an operation is read loosely: each test states what it expects of its parts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(op: string, input?: unknown): Promise<any>;
  /** Hangs up the way an editor does when it is done: the daemon shuts down by itself. */
  hangUp(): Promise<number | null>;
}

/** The daemon over stdio as an editor launches it, with the cognitive core offline (no hosted models, no weights fetched) and the decision layer on `dir`. */
async function launch(dir: string, extra: readonly string[] = [], approve: () => Promise<string> = async () => "cancelled"): Promise<Daemon> {
  const args = ["--stdio", "--cognitive", "--no-hosted", "--model-cache", join(dir, "models"), "--decision", join(dir, "decision"), "--worker", "echo", "--state", join(dir, "state.json"), ...extra];
  const child = spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, NODE_OPTIONS: "" } });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async () => {
        const optionId = await approve();
        return optionId === "cancelled" ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId } };
      },
    }),
    stream,
  );
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
  return {
    child,
    client,
    exited,
    stderr: () => stderr,
    invoke: (op, input = {}) => client.extMethod("_harness/cognitive/invoke", { op, input }),
    hangUp: () => (child.stdin.end(), exited),
  };
}

/** A fresh scratch directory whose decision directory the daemon makes. */
const scratch = (): string => mkdtempSync(join(tmpdir(), "harness-din-"));

const RISKY = { tool: "Bash", kind: "execute", command: "rm -rf build", session: "s1" };

describe("harness --decision over stdio with the official ACP SDK client", () => {
  it("DIN1.1 the decision operations are served through _harness/cognitive/invoke, and a decision with no model to ask ends at a person with the fork's fallback and a record", async () => {
    const dir = scratch();
    const d = await launch(dir);
    const status = await d.invoke("decision.status");
    expect(status).toMatchObject({ policy: "policy-1", decisions: 0, members: [{ id: "ensemble", version: "ensemble" }], calibration: { entries: 0 }, inbox: 0 });
    expect(status.forks.map((f: { id: string }) => f.id)).toEqual(expect.arrayContaining(["permission.risk", "attention", "stuck", "dispatch"]));

    const forks = await d.invoke("decision.forks");
    expect(forks.forks.find((f: { id: string }) => f.id === "permission.risk")).toMatchObject({ policy: { act: 0.9, mode: "active" } });
    expect((await d.invoke("decision.policy")).policy.version).toBe("policy-1");

    const decided = await d.invoke("decision.decide", { fork: "permission.risk", input: RISKY, session: "s1", correlation: "cor-1" });
    expect(decided).toMatchObject({ id: "dec-0", action: "careful", rung: "human", needsHuman: true, mode: "active" });
    // the model rung said why it could not answer
    expect(decided.record.trace.map((t: { rung: string }) => t.rung)).toEqual(["rule", "model", "human"]);
    expect(decided.record.trace[1].outcome).toMatch(/^failed: /);

    const record = await d.invoke("decision.record", { id: "dec-0" });
    expect(record.record).toMatchObject({ id: "dec-0", fork: "permission.risk", session: "s1", correlation: "cor-1", input: RISKY, rung: "human", action: "careful" });
    expect((await d.invoke("decision.record", {})).records.map((r: { id: string }) => r.id)).toEqual(["dec-0"]);
    // it is on disk the moment the call returned
    expect(readFileSync(join(dir, "decision", "decisions.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(await d.hangUp()).toBe(0);
  });

  it("DIN1.2 outcomes, reports, spans, calibration and the inbox work over ACP", async () => {
    const dir = scratch();
    const d = await launch(dir);
    await d.invoke("decision.decide", { fork: "permission.risk", input: RISKY, session: "s1" });
    expect(await d.invoke("decision.outcome", { id: "dec-0", outcome: { source: "human", kind: "denied", correct: true, by: "alice" } })).toEqual({ id: "dec-0", attached: true });
    expect((await d.invoke("decision.record", { id: "dec-0" })).record.outcome).toMatchObject({ source: "human", kind: "denied", correct: true, by: "alice", at: expect.any(Number) });

    const { reports } = await d.invoke("decision.report");
    expect(reports).toMatchObject([{ fork: "permission.risk", decisions: 1, withOutcome: 1, byRung: { human: 1 }, accuracy: 1 }]);
    const { spans } = await d.invoke("decision.spans");
    expect(spans).toHaveLength(1);
    expect(JSON.stringify(spans[0])).toContain("permission.risk");

    // a handful of records is too few to fit anything: no entries, and no error
    expect(await d.invoke("decision.calibrate")).toEqual({ fitted: [], entries: 0 });
    expect(existsSync(join(dir, "decision", "calibration.json"))).toBe(true);

    const added = await d.invoke("decision.inbox", { items: [{ id: "permission:s1:r1", session: "s1", kind: "permission", since: Date.now(), blocked: true, text: "Bash: rm -rf build" }] });
    expect(added).toMatchObject({ added: 1, resolved: 0, ranked: [{ item: { id: "permission:s1:r1" } }] });
    expect((await d.invoke("decision.inbox", {})).ranked).toHaveLength(1);
    expect(await d.invoke("decision.inbox", { resolve: ["permission:s1:r1"] })).toMatchObject({ resolved: 1, ranked: [] });
    expect(await d.hangUp()).toBe(0);
  });

  it("DIN1.3 a call the layer refuses is an error that says which operation failed and why", async () => {
    const d = await launch(scratch());
    await expect(d.invoke("decision.decide", { fork: "nope", input: {} })).rejects.toThrow(/decision\.decide failed \(unknown-fork\)/);
    await expect(d.invoke("decision.outcome", { id: "dec-9", outcome: { source: "human", kind: "denied" } })).rejects.toThrow(/decision\.outcome failed \(invalid\): no decision dec-9/);
    await expect(d.invoke("decision.status", { extra: 1 })).rejects.toThrow(/invalid decision\.status input/);
    await d.hangUp();
  });

  it("DIN1.4 records, outcomes and calibration persist across a restart of the daemon on the same directory, and the ids go on", async () => {
    const dir = scratch();
    const first = await launch(dir);
    await first.invoke("decision.decide", { fork: "permission.risk", input: RISKY, session: "s1" });
    await first.invoke("decision.decide", { fork: "stuck", input: { goal: "g", steps: [] } });
    await first.invoke("decision.outcome", { id: "dec-0", outcome: { source: "human", kind: "approved", correct: false } });
    await first.invoke("decision.calibrate");
    expect(await first.hangUp()).toBe(0);

    const second = await launch(dir);
    expect(await second.invoke("decision.status")).toMatchObject({ decisions: 2, calibration: { entries: 0 } });
    expect((await second.invoke("decision.record", { id: "dec-0" })).record.outcome).toMatchObject({ kind: "approved", correct: false });
    expect((await second.invoke("decision.record", {})).records.map((r: { id: string }) => r.id)).toEqual(["dec-0", "dec-1"]);
    expect((await second.invoke("decision.decide", { fork: "permission.risk", input: RISKY })).id).toBe("dec-2");
    // the inbox is a view of what is open now: it does not outlive the daemon
    expect(await second.invoke("decision.inbox")).toMatchObject({ ranked: [] });
    expect(await second.hangUp()).toBe(0);
  });

  it("DIN1.5 an editor that hangs up while a decision is being written loses nothing: the daemon waits for the log before it exits", async () => {
    const dir = scratch();
    const d = await launch(dir);
    const pending = Array.from({ length: 5 }, (_, i) => d.invoke("decision.decide", { fork: "stuck", input: { goal: `g${i}`, steps: [] } }));
    await Promise.all(pending);
    expect(await d.hangUp()).toBe(0);
    expect(readFileSync(join(dir, "decision", "decisions.jsonl"), "utf8").trim().split("\n")).toHaveLength(5);
  });

  it("DIN1.6 --decision needs the cognitive core: its models are the ensemble's", async () => {
    const child = spawn(process.execPath, [MAIN, "--stdio", "--decision", join(scratch(), "decision")], { env: { ...process.env, NODE_OPTIONS: "" } });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    expect(await new Promise<number | null>((resolve) => child.on("exit", resolve))).toBe(2);
    expect(stderr).toContain("--decision needs --cognitive (or --worker ensemble)");
  });

  it("DIN1.9 the layer starts with the model and ensemble workers too (no local chat model offline, so there is no small tier to dispatch to)", async () => {
    for (const worker of ["model", "ensemble"]) {
      const d = await launch(scratch(), ["--worker", worker]);
      expect(await d.invoke("decision.status")).toMatchObject({ decisions: 0, members: [{ id: "ensemble" }] });
      expect(await d.hangUp()).toBe(0);
    }
  });

  it("DIN1.7 a decision directory with a file that is not valid stops the daemon with the file named", async () => {
    const dir = scratch();
    const decisionDir = join(dir, "decision");
    mkdirSync(decisionDir);
    writeFileSync(join(decisionDir, "policy.json"), '{"version":""}');
    const child = spawn(process.execPath, [MAIN, "--stdio", "--cognitive", "--no-hosted", "--model-cache", join(dir, "models"), "--decision", decisionDir], { env: { ...process.env, NODE_OPTIONS: "" } });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    expect(await new Promise<number | null>((resolve) => child.on("exit", resolve))).toBe(1);
    expect(stderr).toContain(`--decision ${decisionDir}:`);
    expect(stderr).toContain(join(decisionDir, "policy.json"));
  });

  it("DIN1.8 the daemon with the layer still runs sessions, and the plugin sees them: a finished turn becomes a review item in the inbox until the next turn starts (a spawned daemon's turns are answered by the built-in dialogue, so permission requests are exercised in a Node host below, DIN2)", async () => {
    const d = await launch(scratch());
    const { sessionId } = await d.client.newSession({ cwd: "/tmp", mcpServers: [] });
    expect((await d.client.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })).stopReason).toBe("end_turn");
    const review = async () => (await d.invoke("decision.inbox")).ranked.map((r: { item: { kind: string; session: string } }) => [r.item.kind, r.item.session]);
    await until(async () => (await review()).some(([kind]: [string]) => kind === "review"), "the finished turn to become a review item");
    expect(await review()).toContainEqual(["review", sessionId]);
    // Node's own notice about type stripping is not the daemon's to answer for.
    expect(d.stderr().split("\n").filter((line) => line !== "" && !/ExperimentalWarning|--trace-warnings/.test(line))).toEqual([]);
    expect(await d.hangUp()).toBe(0);
  });
});

// ---- the permission flow, end to end, in a Node host ------------------------------------------------------------------------

describe("the permission flow with the decision plugin on a Node host", () => {
  async function flow() {
    const dir = await tempDir();
    const ensemble = ensembleOf({ judge: answering({ boolean: 0.95, level: "last" }) });
    const logs: string[] = [];
    const decision = await buildNativeDecision({ dir, ensemble, log: (m) => void logs.push(m), tickMs: 10 });
    const worker = new PermissionWorker();
    const answered: unknown[] = [];
    const permission = worker.permission.bind(worker);
    worker.permission = (command) => (answered.push(command.outcome), permission(command));
    const host = await NodeHost.start({ worker, identity: { principal: "alice", kind: "human" }, cognitive: ensemble, tickMs: 50 });
    await decision.attach(host.runtime);
    const approver = clientOf(host);
    await approver.initialize();
    const { sessionId } = await approver.connection.newSession({ cwd: "/work", mcpServers: [] });
    const audit = await connectPeer(host.runtime, { principal: "audit", kind: "plugin" });
    await audit.call("_harness/hooks/subscribe", { types: ["decision.*", "permission.*"] });
    const close = async () => {
      audit.close();
      await decision.stop();
      await host.close();
      await decision.settled();
    };
    return { decision, host, approver, sessionId, audit, answered, logs, close };
  }

  /** The approver is asked, and answers when `choose` is called. */
  function ask(f: Awaited<ReturnType<typeof flow>>, text: string) {
    let choose!: (optionId: string) => void;
    const chosen = new Promise<string>((resolve) => (choose = resolve));
    f.approver.answer = async () => ({ outcome: { outcome: "selected", optionId: await chosen } });
    return { choose, done: f.approver.connection.prompt({ sessionId: f.sessionId, prompt: [{ type: "text", text }] }) };
  }

  it("DIN2.1 the plugin annotates the request and puts it in the inbox; only the approver answers it, and the answer becomes the decision's outcome", async () => {
    const f = await flow();
    const { choose, done } = ask(f, "rm -rf build");
    await until(() => f.approver.permissions.length === 1, "the request to reach the approver");
    await until(() => f.decision.layer.inbox.list().some((i) => i.text?.includes("(risk:")), "the annotation");

    // in the inbox, blocked, and annotated with the risk
    expect(f.decision.layer.inbox.list()).toMatchObject([{ id: `permission:${f.sessionId}:${f.approver.permissions[0]!.toolCall.toolCallId.split(":")[0]}:permission`, kind: "permission", blocked: true, text: expect.stringMatching(/^Bash: rm -rf build \(risk: critical\)$/) }]);
    // it announced the decision for plugins...
    const polled = (await f.audit.call("_harness/hooks/poll", {})) as { events: { type: string; payload: { fork?: string; action?: string } }[] };
    const types = polled.events.map((e) => e.type);
    expect(types).toContain("permission.requested");
    expect(polled.events.find((e) => e.type === "decision.made")!.payload).toMatchObject({ fork: "permission.risk", action: "critical" });
    // ...and did not answer: the request is still open, and the worker has heard nothing
    expect(f.host.daemon.pendingPermissions()).toHaveLength(1);
    expect(f.answered).toEqual([]);

    choose("allow");
    expect((await done).stopReason).toBe("end_turn");
    // the worker heard the approver, and only the approver
    expect(f.answered).toEqual([{ outcome: "selected", optionId: "allow" }]);
    const [decided] = await f.decision.layer.records({ fork: forkId("permission.risk") });
    await until(async () => (await f.decision.layer.record(decided!.id))?.outcome !== undefined, "the outcome");
    // approving what the layer called critical is the person overriding the layer: recorded as a wrong call
    expect((await f.decision.layer.record(decided!.id))!.outcome).toMatchObject({ source: "human", kind: "approved", correct: false });
    await until(() => f.decision.layer.inbox.list().filter((i) => i.kind === "permission").length === 0, "the item to leave the inbox");
    expect(f.logs).toEqual([]);
    await f.close();
  });

  it("DIN2.2 a denial of the same request is the outcome that agrees with the layer", async () => {
    const f = await flow();
    const { choose, done } = ask(f, "rm -rf build");
    await until(() => f.decision.layer.inbox.list().some((i) => i.text?.includes("(risk:")), "the annotation");
    choose("deny");
    await done;
    expect(f.answered).toEqual([{ outcome: "selected", optionId: "deny" }]);
    const [decided] = await f.decision.layer.records({ fork: forkId("permission.risk") });
    await until(async () => (await f.decision.layer.record(decided!.id))?.outcome !== undefined, "the outcome");
    expect((await f.decision.layer.record(decided!.id))!.outcome).toMatchObject({ source: "human", kind: "denied", correct: true });
    await f.close();
  });

  it("DIN2.3 a request that is cancelled gets no outcome, and is not left in the inbox", async () => {
    const f = await flow();
    const { done } = ask(f, "rm -rf build");
    await until(() => f.decision.layer.inbox.list().some((i) => i.text?.includes("(risk:")), "the annotation");
    await f.approver.connection.cancel({ sessionId: f.sessionId });
    expect((await done).stopReason).toBe("cancelled");
    await until(() => f.decision.layer.inbox.list().every((i) => i.kind !== "permission"), "the item to leave the inbox");
    const [decided] = await f.decision.layer.records({ fork: forkId("permission.risk") });
    expect(decided!.outcome).toBeUndefined();
    await f.close();
  });

  it("DIN2.4 the layer never lowers what the authority requires: its verdict on a request is advice, and the approver is asked either way", async () => {
    const f = await flow();
    const first = ask(f, "ls");
    await until(() => f.approver.permissions.length === 1, "the request");
    // whatever the layer thought of it, the request waited for the approver
    expect(f.host.daemon.pendingPermissions()).toHaveLength(1);
    first.choose("allow");
    await first.done;
    await f.close();
  });
});

// ---- the command line, on what the daemon wrote ----------------------------------------------------------------------------

describe("harness-decision on a directory a daemon wrote", () => {
  const cli = (...args: string[]) => run(process.execPath, [CLI, ...args], { env: { PATH: process.env["PATH"] ?? "", NODE_OPTIONS: "" } });

  /** A daemon that has made some decisions with outcomes, and has been shut down. */
  async function written(): Promise<string> {
    const dir = scratch();
    const d = await launch(dir);
    for (let i = 0; i < 6; i++) {
      await d.invoke("decision.decide", { fork: "permission.risk", input: { ...RISKY, command: `rm -rf build-${i}` }, session: `s${i % 2}` });
      await d.invoke("decision.outcome", { id: `dec-${i}`, outcome: { source: "human", kind: i % 2 === 0 ? "approved" : "denied", correct: i % 2 !== 0 } });
    }
    expect(await d.hangUp()).toBe(0);
    return join(dir, "decision");
  }

  it("DIN3.1 status, report and thresholds read what the daemon kept", async () => {
    const dir = await written();
    expect(JSON.parse((await cli("status", dir)).stdout)).toMatchObject({ policy: "policy-1", decisions: 6, members: [] });
    expect(JSON.parse((await cli("report", dir)).stdout).reports).toMatchObject([{ fork: "permission.risk", decisions: 6, withOutcome: 6, accuracy: 0.5 }]);
    const text = (await cli("report", dir, "--text")).stdout;
    expect(text).toMatch(/^fork\s+decisions/);
    expect(text).toMatch(/permission\.risk\s+6\s/);
    expect(JSON.parse((await cli("thresholds", dir, "--fork", "permission.risk", "--risk", "0.2", "--delta", "0.1")).stdout)).toMatchObject({ fork: "permission.risk", samples: 0, currentAct: 0.9 });
  });

  it("DIN3.2 calibrate writes calibration.json, and the next daemon starts from it", async () => {
    const dir = await written();
    const out = JSON.parse((await cli("calibrate", dir, "--min-samples", "3")).stdout);
    expect(out.entries).toBe(JSON.parse(readFileSync(join(dir, "calibration.json"), "utf8")).entries.length);
    // decisions that ended at a person have no answers to calibrate: the book is written, empty
    expect(out).toEqual({ fitted: [], entries: 0 });
  });

  it("DIN3.3 export and induce work on the records, and say so when there is nothing to learn from", async () => {
    const dir = await written();
    expect((await cli("export", dir, "--holdout", "0.2")).stdout).toBe("");
    expect(JSON.parse((await cli("induce", dir)).stdout)).toMatchObject({ rules: [] });
    // the three requests a person judged the layer right about (it asked for care) share a tool: a shadow candidate rule
    const induced = await cli("induce", dir, "--run", "--fork", "permission.risk", "--min-support", "3", "--min-purity", "0.9", "--max-rules", "5", "--max-conditions", "1", "--fields", "tool");
    expect(JSON.parse(induced.stdout)).toMatchObject({ rules: [{ fork: "permission.risk", state: "candidate", rule: { when: { eq: ["tool", "Bash"] }, action: "careful", support: 3 } }], counts: { candidate: 1 } });
    expect((await cli("induce", dir, "--text")).stdout).toMatch(/^fork\s+rule\s+action\s+state[\s\S]*permission\.risk\s+\{"eq":\["tool","Bash"\]\}\s+"careful"\s+candidate/);
  });

  it("DIN3.4 exit codes: 1 for a directory that is not there, 2 for wrong usage", async () => {
    const dir = await written();
    await expect(cli("status", join(dir, "missing"))).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("is not a decision directory") });
    await expect(cli("status")).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("usage: harness-decision") });
    await expect(cli("frobnicate", dir)).rejects.toMatchObject({ code: 2 });
    await expect(cli("thresholds", dir)).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("--fork is required") });
  });

  it("DIN3.5 the daemon and the command line can share a directory in turn: what the command line writes, the daemon reads", async () => {
    const dir = await written();
    await cli("induce", dir, "--run", "--fork", "permission.risk", "--min-support", "3", "--min-purity", "0.9", "--max-rules", "5", "--max-conditions", "1", "--fields", "tool");
    const d = await launch(join(dir, ".."));
    expect((await d.invoke("decision.status")).decisions).toBe(6);
    const { rules } = await d.invoke("decision.rules", {});
    expect(rules).toMatchObject([{ fork: "permission.risk", state: "candidate", rule: { action: "careful" } }]);
    // and what the daemon learns, the command line reads
    await d.invoke("decision.calibrate");
    await d.hangUp();
    expect(JSON.parse((await cli("status", dir)).stdout).lifecycle.candidate).toBe(1);
  });
});

// ---- one process per directory -----------------------------------------------------------------------------------------------

describe("one process owns a decision directory", () => {
  const cli = (...args: string[]) => run(process.execPath, [CLI, ...args], { env: { PATH: process.env["PATH"] ?? "", NODE_OPTIONS: "" } });
  const lockOf = (dir: string): unknown => JSON.parse(readFileSync(join(dir, "decision", DECISION_LOCK), "utf8"));

  it("DIN4.1 while a daemon runs on the directory, harness-decision of another process refuses, naming the daemon's pid, and the daemon's records are untouched; once the daemon has exited it works", async () => {
    const dir = scratch();
    const decisionDir = join(dir, "decision");
    const d = await launch(dir);
    await d.invoke("decision.decide", { fork: "stuck", input: { goal: "g", steps: [] } });
    expect(lockOf(dir)).toEqual({ pid: d.child.pid, holder: "harness" });
    const log = readFileSync(join(decisionDir, "decisions.jsonl"), "utf8");
    for (const args of [["status"], ["report"], ["export", "--holdout", "0.2"], ["calibrate"]]) {
      await expect(cli(args[0]!, decisionDir, ...args.slice(1))).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: `harness-decision: the decision directory ${decisionDir} is in use by harness (pid ${d.child.pid}); stop it first\n`,
      });
    }
    expect(readFileSync(join(decisionDir, "decisions.jsonl"), "utf8")).toBe(log);
    expect(lockOf(dir)).toEqual({ pid: d.child.pid, holder: "harness" });
    // the daemon is unharmed and still answers
    expect((await d.invoke("decision.status")).decisions).toBe(1);
    expect(await d.hangUp()).toBe(0);
    expect(existsSync(join(decisionDir, DECISION_LOCK))).toBe(false);
    expect(JSON.parse((await cli("status", decisionDir)).stdout).decisions).toBe(1);
    expect(existsSync(join(decisionDir, DECISION_LOCK))).toBe(false);
  });

  it("DIN4.2 a second daemon on a directory the first holds refuses to start and names the holder; the first keeps its lock", async () => {
    const dir = scratch();
    const first = await launch(dir);
    const args = ["--stdio", "--cognitive", "--no-hosted", "--model-cache", join(dir, "models"), "--decision", join(dir, "decision"), "--worker", "echo"];
    const second = spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, NODE_OPTIONS: "" } });
    children.push(second);
    let stderr = "";
    second.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    expect(await new Promise<number | null>((resolve) => second.on("exit", resolve))).toBe(1);
    expect(stderr).toContain(`the decision directory ${join(dir, "decision")} is in use by harness (pid ${first.child.pid}); stop it first`);
    expect(lockOf(dir)).toEqual({ pid: first.child.pid, holder: "harness" });
    expect((await first.invoke("decision.status")).decisions).toBe(0);
    expect(await first.hangUp()).toBe(0);
  });

  it("DIN4.3 a daemon that was killed leaves a lock that is stale: harness-decision and the next daemon take the directory over", async () => {
    const dir = scratch();
    const d = await launch(dir);
    await d.invoke("decision.decide", { fork: "stuck", input: { goal: "g", steps: [] } });
    d.child.kill("SIGKILL");
    await d.exited;
    expect(existsSync(join(dir, "decision", DECISION_LOCK))).toBe(true);
    expect(JSON.parse((await cli("status", join(dir, "decision"))).stdout).decisions).toBe(1);
    expect(existsSync(join(dir, "decision", DECISION_LOCK))).toBe(false);
    const next = await launch(dir);
    expect((await next.invoke("decision.status")).decisions).toBe(1);
    expect(lockOf(dir)).toEqual({ pid: next.child.pid, holder: "harness" });
    expect(await next.hangUp()).toBe(0);
  });

  it("DIN4.4 a daemon stopped by SIGTERM releases the directory", async () => {
    const dir = scratch();
    const d = await launch(dir);
    expect(existsSync(join(dir, "decision", DECISION_LOCK))).toBe(true);
    d.child.kill("SIGTERM");
    expect(await d.exited).toBe(0);
    expect(existsSync(join(dir, "decision", DECISION_LOCK))).toBe(false);
  });

  it("DIN4.5 a daemon that cannot read the directory releases it before it stops", async () => {
    const dir = scratch();
    const decisionDir = join(dir, "decision");
    mkdirSync(decisionDir);
    writeFileSync(join(decisionDir, "policy.json"), '{"version":""}');
    const child = spawn(process.execPath, [MAIN, "--stdio", "--cognitive", "--no-hosted", "--model-cache", join(dir, "models"), "--decision", decisionDir], { env: { ...process.env, NODE_OPTIONS: "" } });
    children.push(child);
    expect(await new Promise<number | null>((resolve) => child.on("exit", resolve))).toBe(1);
    expect(existsSync(join(decisionDir, DECISION_LOCK))).toBe(false);
  });
});
