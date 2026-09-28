import { afterEach, describe, expect, it } from "vitest";
import { Bash, defineCommand, InMemoryFs } from "just-bash";
import type { ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { usage as usageOf } from "@harness/cognitive";
import type { RequestPermissionRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import type { Worker } from "@harness/workers";
import { Playground, switchWorker } from "../src/playground.ts";
import type { PlaygroundOptions } from "../src/playground.ts";
import { shellModel } from "../src/shell-model.ts";
import { Tracer } from "../src/trace.ts";
import { HOME } from "../src/vfs.ts";

const open: Playground[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
});

async function start(options: Partial<PlaygroundOptions> = {}) {
  const tracer = new Tracer(() => Date.now());
  const bash = new Bash({ cwd: HOME, files: { [`${HOME}/README.md`]: "hi\n" } });
  const playground = await Playground.start({ bash, tracer, models: { shell: shellModel() }, worker: () => "shell", approval: () => "ask", ...options });
  open.push(playground);
  return { playground, tracer, bash };
}

function turn(answer: (request: RequestPermissionRequest) => string | undefined = () => "allow") {
  const updates: SessionUpdate[] = [];
  const asked: RequestPermissionRequest[] = [];
  return {
    updates,
    asked,
    said: () => updates.flatMap((u) => (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" ? [u.content.text] : [])).join(""),
    handlers: {
      update: (u: SessionUpdate) => void updates.push(u),
      permission: async (r: RequestPermissionRequest) => (asked.push(r), answer(r)),
    },
  };
}

describe("the playground: the browser host driven over ACP from the page", () => {
  it("PG1.1 the echo worker answers a prompt in a new session; the ACP messages and worker commands are traced", async () => {
    const { playground, tracer } = await start({ worker: () => "echo" });
    const t = turn();
    const report = await playground.prompt("hello harness", t.handlers);
    expect(report.stopReason).toBe("end_turn");
    expect(t.said()).toBe("echo: hello harness");
    const names = tracer.events().map((e) => `${e.kind}:${e.name}`);
    for (const n of ["acp:initialize #0", "acp:session/new #1", "acp:session/prompt #2", "worker:prompt", "worker:end · end_turn"]) expect(names).toContain(n);
  });

  it("PG1.2 a command the person allows runs in the shared filesystem, and the turn reports what changed and the files after it", async () => {
    const { playground, tracer, bash } = await start();
    const t = turn();
    const report = await playground.prompt("$ echo made > new.txt && echo more >> README.md", t.handlers);
    expect(t.asked[0]!.toolCall).toMatchObject({ title: "bash", rawInput: { command: "echo made > new.txt && echo more >> README.md" } });
    expect(await bash.readFile(`${HOME}/new.txt`)).toBe("made\n");
    expect(report).toMatchObject({ stopReason: "end_turn", diff: { added: [`${HOME}/new.txt`], modified: [`${HOME}/README.md`], removed: [] }, toolCalls: 1, modelCalls: 2 });
    expect(t.said()).toBe("exit 0\n");
    expect(report.files.get(`${HOME}/new.txt`)).toEqual({ size: 5, mtime: expect.any(Number), text: "made\n" });
    expect(tracer.events().find((e) => e.kind === "vfs")).toMatchObject({ name: "changes · 1 added, 1 modified, 0 removed" });
  });

  it("PG1.3 a denied command does not run, and nothing changes", async () => {
    const { playground, bash } = await start();
    const t = turn(() => "deny");
    const report = await playground.prompt("$ rm README.md", t.handlers);
    expect(await bash.fs.exists(`${HOME}/README.md`)).toBe(true);
    expect(report.diff).toEqual({ added: [], modified: [], removed: [] });
    expect(t.said()).toBe("The command did not run: denied by the person.");
  });

  it("PG1.4 on auto approval nothing is asked; a dismissed question cancels the turn", async () => {
    const auto = await start({ approval: () => "auto" });
    const t = turn();
    await auto.playground.prompt("$ touch x", t.handlers);
    expect(t.asked).toEqual([]);
    const asking = await start();
    expect((await asking.playground.prompt("$ touch y", turn(() => undefined).handlers)).stopReason).toBe("cancelled");
  });

  it("PG1.5 cancel ends the running turn as cancelled (and is a no-op before any session)", async () => {
    const { playground } = await start();
    await playground.cancel();
    expect(playground.sessionId).toBeUndefined();
    let release: () => void = () => {};
    const waiting = new Promise<void>((r) => (release = r));
    const running = playground.prompt("$ sleep", { update: () => {}, permission: async () => (release(), new Promise<string | undefined>(() => {})) });
    await waiting;
    await playground.cancel();
    expect((await running).stopReason).toBe("cancelled");
  });

  it("PG1.6 sessions are listed; using another replays its log to the handler", async () => {
    const { playground } = await start({ worker: () => "echo" });
    await playground.prompt("first", turn().handlers);
    const first = playground.sessionId!;
    const second = await playground.newSession();
    expect(await playground.sessions()).toEqual([first, second]);
    const replay = turn();
    await playground.use(first, replay.handlers.update);
    expect(playground.sessionId).toBe(first);
    expect(replay.said()).toBe("echo: first");
  });

  it("PG1.7 every snapshot the daemon saves is seen, and its new hook events are traced", async () => {
    const snapshots: unknown[] = [];
    const { playground, tracer } = await start({ worker: () => "echo", onSnapshot: (s) => void snapshots.push(s) });
    await playground.prompt("hi", turn().handlers);
    await playground.close();
    expect(snapshots.length).toBeGreaterThan(0);
    expect(playground.snapshot().sessions).toHaveLength(1);
    const hooks = tracer.events().filter((e) => e.kind === "hook").map((e) => e.name);
    expect(hooks).toContain("turn.started");
    expect(new Set(hooks).size).toBe(hooks.length);
  });

  it("PG1.8 a model call that fails ends the turn with a notice, not a crash", async () => {
    const broken = { ...shellModel(), doStream: () => Promise.reject(new Error("model down")), doGenerate: () => Promise.reject(new Error("model down")) };
    const { playground } = await start({ models: { shell: broken } });
    const t = turn();
    const report = await playground.prompt("$ ls", t.handlers);
    expect(report.stopReason).toBe("refusal");
    expect(t.updates.some((u) => u.sessionUpdate === "notice" && u.description === "model down")).toBe(true);
  });
  it("PG1.10 the agent's shell shares the terminal's files but not its commands: the harness cannot be driven from a tool call", async () => {
    const { playground, bash } = await start({ approval: () => "auto" });
    bash.registerCommand(defineCommand("harness", async () => ({ stdout: "drove the harness\n", stderr: "", exitCode: 0 })));
    expect((await bash.exec("harness", { cwd: HOME })).stdout).toBe("drove the harness\n");
    const t = turn();
    await playground.prompt("$ harness reset", t.handlers);
    expect(t.said()).toMatch(/^exit 127\n.*command not found/s);
    await playground.prompt("$ echo mine > agent.txt", turn().handlers);
    expect(await bash.readFile(`${HOME}/agent.txt`)).toBe("mine\n");
  });

  it("PG1.11 a file no turn changes is read once, not twice a turn: each walk starts from the last", async () => {
    const reads: string[] = [];
    const inner = new InMemoryFs({ [`${HOME}/README.md`]: "hi\n" });
    const fs = new Proxy(inner, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (key === "readFile") return (path: string, options?: never) => (reads.push(path), target.readFile(path, options));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { playground } = await start({ bash: new Bash({ fs, cwd: HOME }), worker: () => "echo" });
    await playground.prompt("one", turn().handlers);
    await playground.prompt("two", turn().handlers);
    expect(reads.filter((p) => p === `${HOME}/README.md`)).toEqual([`${HOME}/README.md`]);
  });

  it("PG1.12 extra tools reach the agent workers (traced), and their own approval rule decides before the policy's", async () => {
    const { tool, jsonSchema } = await import("ai");
    const ran: string[] = [];
    const extra = { note: tool({ description: "Keep a note", inputSchema: jsonSchema<{ text: string }>({ type: "object", properties: { text: { type: "string" } } }), execute: async ({ text }) => (ran.push(text), { kept: text }) }) };
    const calls = new MockLanguageModelV4({
      doStream: async ({ prompt }) => ({
        stream: convertArrayToReadableStream<LanguageModelV4StreamPart>(
          prompt.at(-1)!.role === "tool"
            ? [{ type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: "noted" }, { type: "text-end", id: "0" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usageOf() }]
            : [{ type: "tool-call", toolCallId: "n1", toolName: "note", input: '{"text":"hi"}' }, { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usageOf() }],
        ),
      }),
    });
    const { playground, tracer } = await start({ models: { calls }, worker: () => "calls", approval: () => "ask", tools: extra, toolApproval: (name) => (name === "note" ? "not-applicable" : undefined) });
    const t = turn();
    await playground.prompt("take a note", t.handlers);
    expect(ran).toEqual(["hi"]);
    expect(t.asked).toEqual([]);
    expect(tracer.events().some((e) => e.kind === "tool" && e.name === "note")).toBe(true);
  });

  it("PG1.13 instructions are read each turn, and what the harness writes after a turn (its own files) is in that turn's diff", async () => {
    let said = "first";
    const seen: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        seen.push(String(prompt[0]!.content));
        return { stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([{ type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: "ok" }, { type: "text-end", id: "0" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usageOf() }]) };
      },
    });
    const { playground, bash } = await start({ models: { m: model }, worker: () => "m", instructions: async () => said, afterTurn: () => bash.fs.writeFile(`${HOME}/AGENTS.md`, `after ${said}`) });
    const first = await playground.prompt("one", turn().handlers);
    expect(first.diff.added).toEqual([`${HOME}/AGENTS.md`]);
    said = "second";
    const second = await playground.prompt("two", turn().handlers);
    expect(second.diff.modified).toEqual([`${HOME}/AGENTS.md`]);
    expect(seen).toEqual(["first", "second"]);
  });

  it("PG1.9 what the host cannot hand to anyone (a snapshot that fails to save) shows up in the trace", async () => {
    const { playground, tracer } = await start({ worker: () => "echo", storage: { load: async () => undefined, save: async () => Promise.reject(new Error("disk full")) } });
    await playground.prompt("hi", turn().handlers);
    await playground.close();
    expect(tracer.events().find((e) => e.kind === "host")).toMatchObject({ name: "log", detail: expect.stringContaining("disk full") });
  });
});

describe("the playground across a reload", () => {
  it("PG3.1 with the same stores, a restarted playground has the sessions, and the agent continues the conversation; old hook events are not traced again", async () => {
    const daemon = new Map<string, unknown>();
    const storage = { load: async () => structuredClone(daemon.get("d")), save: async (v: unknown) => void daemon.set("d", structuredClone(v)) };
    const kept = new Map<string, readonly ModelMessage[]>();
    const conversations = { load: async (id: string) => kept.get(id), save: async (id: string, m: readonly ModelMessage[]) => void kept.set(id, m) };
    const model = () =>
      new MockLanguageModelV4({
        doStream: async ({ prompt }) => ({
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: `heard ${prompt.filter((m) => m.role === "user").length}` },
            { type: "text-end", id: "0" },
            { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } } },
          ]),
        }),
      });
    const first = await start({ models: { m: model() }, worker: () => "m", storage, conversations });
    const t1 = turn();
    await first.playground.prompt("one", t1.handlers);
    const sessionId = first.playground.sessionId!;
    await first.playground.close();
    expect(t1.said()).toBe("heard 1");

    const again = await start({ models: { m: model() }, worker: () => "m", storage, conversations });
    expect(await again.playground.sessions()).toEqual([sessionId]);
    await again.playground.use(sessionId, () => {});
    const t2 = turn();
    await again.playground.prompt("two", t2.handlers);
    expect(t2.said()).toBe("heard 2");
    await again.playground.close();
    const hooks = again.tracer.events().filter((e) => e.kind === "hook").map((e) => e.name);
    expect(hooks).not.toContain("session.created");
    expect(hooks).toContain("turn.started");
  });
});

describe("switching workers", () => {
  function recording(name: string, log: string[]): Worker {
    return {
      run: async (c, emit) => (log.push(`${name} run`), emit({ type: "end", sessionId: c.sessionId, turnId: c.turnId, stopReason: "end_turn" })),
      cancel: () => void log.push(`${name} cancel`),
      permission: () => void log.push(`${name} permission`),
      event: () => void log.push(`${name} event`),
    };
  }

  it("PG2.1 a turn runs on the worker chosen when it starts; its cancel and permission answers go to that worker", async () => {
    const log: string[] = [];
    let current = "a";
    const worker = switchWorker({ a: recording("a", log), b: recording("b", log) }, () => current);
    const command = { type: "prompt" as const, sessionId: "s", turnId: "t", cwd: "/", prompt: [] };
    let hold: () => void = () => {};
    const slow: Worker = { ...recording("a", log), run: (c, emit) => new Promise<void>((r) => (hold = () => (emit({ type: "end", sessionId: c.sessionId, turnId: c.turnId, stopReason: "end_turn" }), r()))) };
    const w = switchWorker({ a: slow, b: recording("b", log) }, () => current);
    const running = w.run(command, () => {});
    current = "b";
    w.cancel("s", "t");
    w.permission({ type: "permission", sessionId: "s", turnId: "t", requestId: "r", outcome: { outcome: "cancelled" } });
    hold();
    await running;
    w.cancel("s", "t");
    await worker.run(command, () => {});
    worker.event!({ type: "event", sessionId: "s", name: "e" }, () => {});
    expect(log).toEqual(["a cancel", "a permission", "b run", "b event"]);
  });

  it("PG2.2 a worker name nobody knows fails the turn", async () => {
    await expect(switchWorker({}, () => "nope").run({ type: "prompt", sessionId: "s", turnId: "t", cwd: "/", prompt: [] }, () => {})).rejects.toThrow("no worker named nope");
  });
});
