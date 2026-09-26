import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AnyMessage } from "@agentclientprotocol/sdk";
import { HarnessCapabilityUnsupportedError } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { daemonHarness, noSandbox } from "@harness/client";
import type { DaemonLink } from "@harness/client";
import type { WorkerEvent } from "@harness/core";
import { NodeHost } from "@harness/platform-native";
import { AgentWorker, EchoWorker, harnessSessions } from "@harness/workers";
import type { Worker } from "@harness/workers";

const hosts: NodeHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});

/** A daemon in this process, and a way to open ACP connections to it (as a socket would). */
async function daemon(worker: Worker = new EchoWorker()) {
  const host = await NodeHost.start({ worker, identity: { principal: "me", kind: "human" } });
  hosts.push(host);
  let opened = 0;
  const connect = (): DaemonLink => {
    opened++;
    const toHost = new PassThrough();
    const fromHost = new PassThrough();
    host.attach(toHost, fromHost);
    return { stream: ndJsonStream(Writable.toWeb(toHost), Readable.toWeb(fromHost) as ReadableStream<Uint8Array>), close: () => void toHost.end() };
  };
  return { host, connect, opened: () => opened };
}

const sessions = (host: NodeHost) => host.daemon.snapshot().sessions.map((s) => s.id);

function run(worker: AgentWorker, text: string, sessionId = "s1", turnId = "t1", answer?: "allow" | "deny") {
  const events: WorkerEvent[] = [];
  const done = worker.run({ type: "prompt", sessionId, turnId, prompt: [{ type: "text", text }], cwd: "/" }, (e) => {
    events.push(e);
    if (e.type === "permission" && answer) worker.permission({ type: "permission", sessionId, turnId, requestId: e.requestId, outcome: { outcome: "selected", optionId: answer } });
  });
  return { events, done };
}
const reply = (events: WorkerEvent[]) =>
  events
    .flatMap((e) => (e.type === "update" && e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text" ? [e.update.content.text] : []))
    .join("");

describe("daemonHarness: the harness daemon as an AI SDK harness (HarnessV1)", () => {
  it("DH1.1 a HarnessAgent turn runs as a prompt on a daemon session and streams its reply", async () => {
    const d = await daemon();
    const agent = new HarnessAgent({ harness: daemonHarness({ connect: d.connect }) });
    const session = await agent.createSession({ sandboxSession: noSandbox() });
    const result = await agent.stream({ session, prompt: "hello there" });
    expect(await result.text).toBe("echo: hello there");
    expect(await result.finishReason).toBe("stop");
    expect(sessions(d.host)).toHaveLength(1);
    await session.destroy();
  });

  it("DH1.2 one daemon session serves every turn of a harness session; instructions go before the first prompt only", async () => {
    const d = await daemon();
    const agent = new HarnessAgent({ harness: daemonHarness({ connect: d.connect }), instructions: "Be brief." });
    const session = await agent.createSession({ sandboxSession: noSandbox() });
    expect(await (await agent.stream({ session, prompt: "one" })).text).toBe("echo: Be brief.\none");
    expect(await (await agent.stream({ session, prompt: "two" })).text).toBe("echo: two");
    expect(sessions(d.host)).toHaveLength(1);
    expect(d.opened()).toBe(1);
    await session.destroy();
  });

  it("DH1.3 a permission request from the daemon's worker is a tool approval; the answer reaches the daemon", async () => {
    const d = await daemon();
    const outer = new AgentWorker({ agent: harnessSessions(new HarnessAgent({ harness: daemonHarness({ connect: d.connect }) }), { sandboxSession: noSandbox }) });
    const allowed = run(outer, "!permission hi", "s1", "t1", "allow");
    await allowed.done;
    expect(allowed.events.find((e) => e.type === "permission")).toMatchObject({ toolCall: { title: "Echo the prompt back" } });
    expect(reply(allowed.events)).toBe("echo: !permission hi");
    const denied = run(outer, "!permission no", "s2", "t1", "deny");
    await denied.done;
    expect(reply(denied.events)).toBe("permission denied");
  });

  it("DH1.4 a detached harness session resumes on the same daemon session, which outlived the connection", async () => {
    const d = await daemon();
    const agent = new HarnessAgent({ harness: daemonHarness({ connect: d.connect }) });
    const first = await agent.createSession({ sandboxSession: noSandbox() });
    await (await agent.stream({ session: first, prompt: "first" })).text;
    const parked = await first.detach();
    expect(sessions(d.host)).toHaveLength(1);
    const again = await agent.createSession({ sessionId: first.sessionId, resumeFrom: parked, sandboxSession: noSandbox() });
    expect(again.isResume).toBe(true);
    expect(await (await agent.stream({ session: again, prompt: "second" })).text).toBe("echo: second");
    expect(sessions(d.host)).toHaveLength(1);
    expect(d.opened()).toBe(2);
    await again.destroy();
  });

  it("DH1.5 aborting a turn cancels it on the daemon", async () => {
    // the worker holds its words until the daemon's cancel reaches it
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const worker = new EchoWorker({ pause: () => gate });
    const cancel = worker.cancel.bind(worker);
    worker.cancel = (sessionId, turnId) => (cancel(sessionId, turnId), release());
    const d = await daemon(worker);
    const agent = new HarnessAgent({ harness: daemonHarness({ connect: d.connect }) });
    const session = await agent.createSession({ sandboxSession: noSandbox() });
    const abort = new AbortController();
    const result = await agent.stream({ session, prompt: "slow words here", abortSignal: abort.signal });
    abort.abort();
    await result.consumeStream();
    const log = d.host.daemon.snapshot().sessions[0]!.log as { entries: { payload: { event?: string; data?: { stopReason?: string } } }[] };
    const events = log.entries.map((e) => e.payload);
    expect(events.find((e) => e.event === "turn.ended")?.data?.stopReason).toBe("cancelled");
    await session.destroy();
  });

  it("DH1.6 compaction and suspending a turn are not offered: the daemon keeps its own sessions", async () => {
    const d = await daemon();
    const harness = daemonHarness({ connect: d.connect });
    const session = await harness.doStart({ sessionId: "x", sandboxSession: noSandbox(), sessionWorkDir: "/w" });
    await expect(session.doCompact()).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
    await expect(session.doSuspendTurn()).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
    await expect(session.doContinueTurn({ skills: [], tools: [], emit: () => {} })).rejects.toThrow(/no turn/);
    await session.doDestroy();
  });

  it("DH1.7 the null sandbox answers what the AI SDK asks of every harness and runs nothing", async () => {
    const box = noSandbox();
    expect(await box.run({ command: "pwd" })).toEqual({ exitCode: 0, stdout: "/\n", stderr: "" });
    expect(await box.run({ command: 'mkdir -p "$WORK_DIR"' })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    await box.writeTextFile({ path: "a", content: "x" });
    await box.writeBinaryFile({ path: "a", content: new Uint8Array() });
    await box.writeFile({ path: "a", content: new ReadableStream() });
    expect([await box.readFile({ path: "a" }), await box.readBinaryFile({ path: "a" }), await box.readTextFile({ path: "a" })]).toEqual([null, null, null]);
    await expect(box.spawn({ command: "ls" })).rejects.toThrow(/runs no processes/);
  });

  it("DH1.8 the daemon worker's reasoning, tool calls and results, and other updates reach the AI SDK stream", async () => {
    const scripted: Worker = {
      async run(c, emit) {
        const base = { sessionId: c.sessionId, turnId: c.turnId };
        const update = (u: Parameters<typeof emit>[0] extends infer E ? (E extends { type: "update"; update: infer U } ? U : never) : never) => emit({ type: "update", ...base, update: u });
        update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan" } });
        update({ sessionUpdate: "tool_call", toolCallId: "a", title: "read", kind: "read", status: "pending", rawInput: { path: "x" } });
        update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed", rawOutput: { text: "hi" } });
        update({ sessionUpdate: "tool_call_update", toolCallId: "b", title: "write", status: "failed", rawOutput: { error: "denied" } });
        update({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed" });
        update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress" });
        update({ sessionUpdate: "notice", severity: "info", title: "Behavior: calm" });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "AQ==" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
        emit({ type: "end", ...base, stopReason: "max_tokens" });
      },
      cancel: () => {},
      permission: () => {},
    };
    const d = await daemon(scripted);
    const agent = new HarnessAgent({ harness: daemonHarness({ connect: d.connect }) });
    const session = await agent.createSession({ sandboxSession: noSandbox() });
    const result = await agent.stream({ session, prompt: "go" });
    const parts: unknown[] = [];
    for await (const p of result.fullStream) {
      if (p.type === "reasoning-delta" || p.type === "text-delta") parts.push({ type: p.type, text: p.text });
      else if (p.type === "tool-call") parts.push({ type: p.type, toolCallId: p.toolCallId, toolName: p.toolName, input: p.input });
      else if (p.type === "tool-result") parts.push({ type: p.type, toolCallId: p.toolCallId, output: p.output });
      else if (p.type === "tool-error") parts.push({ type: p.type, toolCallId: p.toolCallId });
      else if (p.type === "raw") parts.push({ type: p.type });
      else if (p.type === "finish") parts.push({ type: p.type, finishReason: p.finishReason });
    }
    // the AI SDK reports provider-executed results at the end of the step
    expect(parts).toEqual([
      { type: "reasoning-delta", text: "plan" },
      { type: "tool-call", toolCallId: "a", toolName: "read", input: { path: "x" } },
      { type: "tool-call", toolCallId: "b", toolName: "write", input: {} },
      { type: "tool-call", toolCallId: "c", toolName: "c", input: {} },
      { type: "raw" },
      { type: "text-delta", text: "done" },
      { type: "tool-result", toolCallId: "a", output: { text: "hi" } },
      { type: "tool-error", toolCallId: "b" },
      { type: "tool-result", toolCallId: "c", output: null },
      { type: "finish", finishReason: "length" },
    ]);
    await session.destroy();
  });

  it("DH1.9 an image in the prompt reaches the daemon as an ACP image; a stopped session can be resumed", async () => {
    const seen: unknown[] = [];
    const recorder: Worker = { run: async (c, emit) => (seen.push(c.prompt), emit({ type: "end", sessionId: c.sessionId, turnId: c.turnId, stopReason: "end_turn" })), cancel: () => {}, permission: () => {} };
    const d = await daemon(recorder);
    const agent = new HarnessAgent({ harness: daemonHarness({ connect: d.connect }) });
    const session = await agent.createSession({ sandboxSession: noSandbox() });
    await (await agent.stream({ session, messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "file", data: new Uint8Array([1]), mediaType: "image/png" }, { type: "file", data: new Uint8Array([2]), mediaType: "application/pdf" }] }] })).consumeStream();
    await (await agent.stream({ session, messages: [{ role: "user", content: "plain" }] })).consumeStream();
    expect(seen).toEqual([[{ type: "text", text: "see" }, { type: "image", mimeType: "image/png", data: "AQ==" }], [{ type: "text", text: "plain" }]]);
    const stopped = await session.stop();
    expect(stopped).toMatchObject({ type: "resume-session", harnessId: "harness-daemon" });
  });

  it("DH1.10 a permission request while this client runs no turn, or with no option for its answer, is cancelled", async () => {
    // another client prompts the same daemon session: the daemon asks every approver, and this one has no turn to show it in
    const d = await daemon();
    const harness = daemonHarness({ connect: d.connect });
    const idle = await harness.doStart({ sessionId: "x", sandboxSession: noSandbox(), sessionWorkDir: "/w" });
    const daemonSessionId = d.host.daemon.snapshot().sessions[0]!.id;
    const other = d.connect();
    const acp = new ClientSideConnection(() => ({ sessionUpdate: async () => {}, requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }) }), other.stream);
    await acp.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await acp.loadSession({ sessionId: daemonSessionId, cwd: "/w", mcpServers: [] });
    expect(await acp.prompt({ sessionId: daemonSessionId, prompt: [{ type: "text", text: "!permission x" }] })).toEqual({ stopReason: "end_turn" });
    await idle.doDestroy();

    // a worker that offers only "allow": denying it has no matching option, so the request is cancelled
    const allowOnly: Worker = {
      async run(c, emit) {
        const base = { sessionId: c.sessionId, turnId: c.turnId };
        emit({ type: "permission", ...base, requestId: "r", toolCall: { toolCallId: "t", title: "go" }, options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }] });
        await new Promise<void>((r) => (this.permission = (p) => (answers.push(p.outcome), r())));
        emit({ type: "end", ...base, stopReason: "end_turn" });
      },
      cancel: () => {},
      permission: () => {},
    };
    const answers: unknown[] = [];
    const d2 = await daemon(allowOnly);
    const outer = new AgentWorker({ agent: harnessSessions(new HarnessAgent({ harness: daemonHarness({ connect: d2.connect }) }), { sandboxSession: noSandbox }) });
    await run(outer, "go", "s1", "t1", "deny").done;
    expect(answers).toEqual([{ outcome: "cancelled" }]);
  });

  it("DH1.11 updates that arrive in the same read as the prompt's answer still come before the finish", async () => {
    // A daemon that writes a turn's last update and its answer together, as one chunk: the
    // ACP SDK answers a request at once but hands notifications through async handlers.
    const connect = (): DaemonLink => {
      const toDaemon = new TransformStream<AnyMessage, AnyMessage>();
      let answer = (_: AnyMessage[]) => {};
      const fromDaemon = new ReadableStream<AnyMessage>({ start: (c) => void (answer = (ms) => ms.forEach((m) => c.enqueue(m))) });
      void (async () => {
        for await (const m of toDaemon.readable as unknown as AsyncIterable<{ id?: number; method?: string; params?: { sessionId?: string } }>) {
          if (m.method === "initialize") answer([{ jsonrpc: "2.0", id: m.id!, result: { protocolVersion: PROTOCOL_VERSION } }]);
          else if (m.method === "session/new") answer([{ jsonrpc: "2.0", id: m.id!, result: { sessionId: "d1" } }]);
          else if (m.method === "session/prompt")
            answer([
              { jsonrpc: "2.0", method: "session/update", params: { sessionId: "d1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all of it" } } } },
              { jsonrpc: "2.0", id: m.id!, result: { stopReason: "end_turn" } },
            ]);
          else if (m.id !== undefined) answer([{ jsonrpc: "2.0", id: m.id, result: {} }]);
        }
      })();
      return { stream: { readable: fromDaemon, writable: toDaemon.writable }, close: () => {} };
    };
    const agent = new HarnessAgent({ harness: daemonHarness({ connect }) });
    const session = await agent.createSession({ sandboxSession: noSandbox() });
    const result = await agent.stream({ session, prompt: "go" });
    expect(await result.text).toBe("all of it");
    await session.destroy();
  });
});
