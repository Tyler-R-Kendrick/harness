import { describe, expect, it } from "vitest";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { jsonSchema, tool } from "ai";
import type { WorkerEvent } from "@harness/core";
import { nullSandbox, scriptedHarness } from "@harness/testkit";
import type { ScriptedTurn } from "@harness/testkit";
import { AgentWorker, harnessSessions } from "@harness/workers";

function run(worker: AgentWorker, text: string, sessionId = "s1", turnId = "t1") {
  const events: WorkerEvent[] = [];
  const done = worker.run({ type: "prompt", sessionId, turnId, prompt: [{ type: "text", text }], cwd: "/" }, (e) => events.push(e));
  return { events, done };
}
const reply = (events: WorkerEvent[]) =>
  events
    .flatMap((e) => (e.type === "update" && e.update["sessionUpdate"] === "agent_message_chunk" ? [(e.update["content"] as { text: string }).text] : []))
    .join("");

const weather = tool({ description: "Weather for a city.", inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }), execute: async ({ city }) => ({ city, sky: "clear" }) });

function setup(script: (prompt: string) => ScriptedTurn | string, settings: { toolApproval?: Record<string, "user-approval"> } = {}) {
  const harness = scriptedHarness(script);
  const agent = new HarnessAgent({ harness, instructions: "Be brief.", tools: { weather }, ...settings });
  const sessions = harnessSessions(agent, { sandboxSession: nullSandbox });
  return { harness, sessions, worker: new AgentWorker({ agent: sessions }) };
}

describe("harnessSessions: an AI SDK harness (Claude Code, Codex, any ACP agent) as a session worker", () => {
  it("HS1.1 a turn runs on the harness and its reply streams as message chunks", async () => {
    const { harness, worker } = setup((p) => `you said ${p}`);
    const { events, done } = run(worker, "hi");
    await done;
    expect(reply(events)).toBe("you said hi");
    expect(events.at(-1)).toEqual({ type: "end", sessionId: "s1", turnId: "t1", stopReason: "end_turn" });
    expect(harness.log.turns[0]).toMatchObject({ sessionId: "s1", instructions: "Be brief." });
  });

  it("HS1.2 each daemon session has one harness session for all its turns, which gets only the new prompt", async () => {
    const { harness, worker } = setup((p) => p.toUpperCase());
    await run(worker, "one").done;
    await run(worker, "two", "s1", "t2").done;
    await run(worker, "three", "s2").done;
    expect(harness.log.started).toEqual(["s1", "s2"]);
    // the harness keeps its own conversation: the worker's history is not replayed to it
    expect(harness.log.turns.map((t) => [t.sessionId, t.prompt])).toEqual([
      ["s1", { role: "user", content: [{ type: "text", text: "one" }] }],
      ["s1", { role: "user", content: [{ type: "text", text: "two" }] }],
      ["s2", { role: "user", content: [{ type: "text", text: "three" }] }],
    ]);
  });

  it("HS1.3 turns that start together share one harness session", async () => {
    const { harness, worker } = setup((p) => p);
    await Promise.all([run(worker, "a").done, run(worker, "b", "s1", "t2").done]);
    expect(harness.log.started).toEqual(["s1"]);
  });

  it("HS1.4 the harness's call of a host tool runs on the host and shows as a tool call", async () => {
    const { worker } = setup(() => ({ text: "Lagos:", tool: { name: "weather", input: { city: "Lagos" } } }));
    const { events, done } = run(worker, "weather?");
    await done;
    const updates = events.flatMap((e) => (e.type === "update" ? [e.update] : []));
    expect(updates).toContainEqual({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "weather", kind: "other", status: "pending", rawInput: { city: "Lagos" } });
    expect(updates).toContainEqual({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", rawOutput: { city: "Lagos", sky: "clear" } });
    expect(reply(events)).toBe('Lagos: {"city":"Lagos","sky":"clear"}');
  });

  it("HS1.5 a tool that needs approval asks the session's approvers, and their answer continues the turn", async () => {
    const { worker } = setup(() => ({ text: "Lagos:", tool: { name: "weather", input: { city: "Lagos" } } }), { toolApproval: { weather: "user-approval" } });
    const events: WorkerEvent[] = [];
    const done = worker.run({ type: "prompt", sessionId: "s1", turnId: "t1", prompt: [{ type: "text", text: "weather?" }], cwd: "/" }, (e) => {
      events.push(e);
      if (e.type === "permission") worker.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: e.requestId, outcome: { outcome: "selected", optionId: "allow" } });
    });
    await done;
    expect(events.find((e) => e.type === "permission")).toMatchObject({ toolCall: { title: "weather", rawInput: { city: "Lagos" } } });
    expect(reply(events)).toBe('Lagos: {"city":"Lagos","sky":"clear"}');
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
  });

  it("HS1.9 a denied tool does not run: the harness is told so and the turn goes on", async () => {
    const { worker } = setup(() => ({ text: "Lagos:", tool: { name: "weather", input: { city: "Lagos" } } }), { toolApproval: { weather: "user-approval" } });
    const events: WorkerEvent[] = [];
    await worker.run({ type: "prompt", sessionId: "s1", turnId: "t1", prompt: [{ type: "text", text: "weather?" }], cwd: "/" }, (e) => {
      events.push(e);
      if (e.type === "permission") worker.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: e.requestId, outcome: { outcome: "selected", optionId: "deny" } });
    });
    expect(reply(events)).toMatch(/^Lagos: \{"type":"execution-denied"/);
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
  });

  it("HS1.6 cancelling a turn aborts it on the harness", async () => {
    const { worker } = setup(() => ({ text: "never", tool: { name: "weather", input: { city: "Lagos" } } }), { toolApproval: { weather: "user-approval" } });
    const events: WorkerEvent[] = [];
    const done = worker.run({ type: "prompt", sessionId: "s1", turnId: "t1", prompt: [{ type: "text", text: "x" }], cwd: "/" }, (e) => {
      events.push(e);
      if (e.type === "permission") worker.cancel("s1", "t1");
    });
    await done;
    expect(events.at(-1)).toEqual({ type: "end", sessionId: "s1", turnId: "t1", stopReason: "cancelled" });
  });

  it("HS1.7 closing ends every harness session, and a later turn starts a fresh one", async () => {
    const { harness, sessions, worker } = setup((p) => p);
    await run(worker, "a").done;
    await run(worker, "b", "s2").done;
    await sessions.close();
    expect(harness.log.ended.sort()).toEqual(["s1", "s2"]);
    await run(worker, "c", "s1", "t2").done;
    expect(harness.log.started).toEqual(["s1", "s2", "s1"]);
  });

  it("HS1.8 a harness that fails to start fails the turn with a notice", async () => {
    const harness = { ...scriptedHarness((p) => p), doStart: async () => Promise.reject(new Error("no sandbox port")) };
    const worker = new AgentWorker({ agent: harnessSessions(new HarnessAgent({ harness }), { sandboxSession: nullSandbox }) });
    const { events, done } = run(worker, "hi");
    await done;
    expect(events).toContainEqual(expect.objectContaining({ type: "update", update: expect.objectContaining({ sessionUpdate: "notice", severity: "error", description: expect.stringMatching(/no sandbox port/) }) }));
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
  });

  it("HS1.10 generate runs a whole turn on the session's harness session too", async () => {
    const { harness, sessions } = setup((p) => `re: ${p}`);
    const { text } = await sessions.generate({ prompt: "ping", options: { sessionId: "s9" } });
    expect(text).toBe("re: ping");
    expect(harness.log.started).toEqual(["s9"]);
    expect(sessions.version).toBe("agent-v1");
  });

  it("HS1.11 with neither a sandbox provider nor sandbox sessions, a turn fails with a notice rather than hanging", async () => {
    const worker = new AgentWorker({ agent: harnessSessions(new HarnessAgent({ harness: scriptedHarness((p) => p) })) });
    const { events, done } = run(worker, "hi");
    await done;
    expect(events).toContainEqual(expect.objectContaining({ type: "update", update: expect.objectContaining({ sessionUpdate: "notice", severity: "error" }) }));
  });

  it("HS2.1 with a store, closing parks every harness session and a later turn resumes it, as across a daemon restart", async () => {
    const saved = new Map<string, unknown>();
    const store = { get: async (id: string) => saved.get(id), set: async (id: string, state: unknown) => void saved.set(id, state), delete: async (id: string) => void saved.delete(id) };
    const harness = scriptedHarness((p) => p);
    const make = () => new AgentWorker({ agent: harnessSessions(new HarnessAgent({ harness }), { sandboxSession: nullSandbox, store }) });
    const agent = harnessSessions(new HarnessAgent({ harness }), { sandboxSession: nullSandbox, store });
    await run(new AgentWorker({ agent }), "before").done;
    await agent.close();
    expect(harness.log.ended).toEqual(["s1"]);
    // stopped, not detached: a detached harness leaves its runtime (and sandbox) running for another process
    expect(harness.log.stopped).toEqual(["s1"]);
    expect(harness.log.detached).toEqual([]);
    expect([...saved.keys()]).toEqual(["s1"]);
    // a new daemon process: the same session resumes from its parked state, which is then spent
    const { events, done } = run(make(), "after", "s1", "t2");
    await done;
    expect(reply(events)).toBe("after");
    expect(harness.log.resumed).toEqual(["s1"]);
    expect(saved.has("s1")).toBe(false);
  });

  it.each([
    ["another harness", { type: "resume-session", specificationVersion: "harness-v1", harnessId: "other", data: {} }],
    ["a state the harness refuses", { type: "resume-session", specificationVersion: "harness-v1", harnessId: "scripted", data: { sessionId: "elsewhere" } }],
  ])("HS2.2 a parked state from %s is dropped and the session starts fresh", async (_, parked) => {
    const saved = new Map<string, unknown>([["s1", parked]]);
    const store = { get: async (id: string) => saved.get(id), set: async (id: string, state: unknown) => void saved.set(id, state), delete: async (id: string) => void saved.delete(id) };
    const harness = scriptedHarness((p) => p);
    const worker = new AgentWorker({ agent: harnessSessions(new HarnessAgent({ harness }), { sandboxSession: nullSandbox, store }) });
    const { events, done } = run(worker, "fresh");
    await done;
    expect(reply(events)).toBe("fresh");
    expect(harness.log.resumed).toEqual([]);
    expect(saved.has("s1")).toBe(false);
  });
});
