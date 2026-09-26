import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import type { ToolSet } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { sessionOf, stateContent, usage } from "@harness/cognitive";
import type { WorkerEvent } from "@harness/core";
import { promptText } from "@harness/testkit";
import { AgentWorker, rememberTurns, sessionAgent, userContent } from "@harness/workers";

const finish = (unified: "stop" | "length" | "tool-calls" | "content-filter" | "other" = "stop"): LanguageModelV4StreamPart => ({ type: "finish", finishReason: { unified, raw: undefined }, usage: usage() });
const text = (t: string, id = "0"): LanguageModelV4StreamPart[] => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: t },
  { type: "text-end", id },
];
const call = (toolName: string, input: unknown, toolCallId = "c1"): LanguageModelV4StreamPart => ({ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) });

/** A model that answers each call with the next scripted stream (the last repeats). */
function scripted(...turns: (LanguageModelV4StreamPart[] | ((o: LanguageModelV4CallOptions) => LanguageModelV4StreamPart[]) | Error)[]) {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async (o) => {
      const turn = turns[Math.min(n++, turns.length - 1)]!;
      if (turn instanceof Error) throw turn;
      return { stream: convertArrayToReadableStream([{ type: "stream-start", warnings: [] }, ...(typeof turn === "function" ? turn(o) : turn)]) };
    },
  });
}

function run(worker: AgentWorker, prompt: unknown[], sessionId = "s1", turnId = "t1") {
  const events: WorkerEvent[] = [];
  const done = worker.run({ type: "prompt", sessionId, turnId, prompt, cwd: "/" }, (e) => events.push(e));
  return { events, done };
}
const updates = (events: WorkerEvent[]) => events.flatMap((e) => (e.type === "update" ? [e.update] : []));
const end = (events: WorkerEvent[]) => events.at(-1);

describe("AgentWorker: any AI SDK agent as a session worker", () => {
  it("AW1.1 streams text as message chunks and reasoning as thought chunks, and ends the turn", async () => {
    const model = scripted([{ type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "plan" }, { type: "reasoning-end", id: "r" }, { type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: "Hel" }, { type: "text-delta", id: "0", delta: "lo" }, { type: "text-end", id: "0" }, finish()]);
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model }) }), [{ type: "text", text: "hi" }]);
    await done;
    expect(events).toEqual([
      { type: "update", sessionId: "s1", turnId: "t1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan" } } },
      { type: "update", sessionId: "s1", turnId: "t1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } } },
      { type: "update", sessionId: "s1", turnId: "t1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } } },
      { type: "end", sessionId: "s1", turnId: "t1", stopReason: "end_turn" },
    ]);
  });

  it("AW1.2 keeps each session's conversation, so follow-up turns carry context; sessions do not share it", async () => {
    const model = scripted([...text("first"), finish()], [...text("second"), finish()], [...text("other"), finish()]);
    const worker = new AgentWorker({ agent: sessionAgent({ model, instructions: "Be brief." }) });
    await run(worker, [{ type: "text", text: "one" }]).done;
    await run(worker, [{ type: "text", text: "two" }], "s1", "t2").done;
    await run(worker, [{ type: "text", text: "three" }], "s2", "t1").done;
    const prompts = model.doStreamCalls.map((c) => c.prompt.map((m) => `${m.role}:${typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : p.type)).join("")}`));
    expect(prompts[1]).toEqual(["system:Be brief.", "user:one", "assistant:first", "user:two"]);
    expect(prompts[2]).toEqual(["system:Be brief.", "user:three"]);
  });

  it("AW1.3 a prompt with an image goes to the vision model, with the image attached", async () => {
    const model = scripted([...text("text"), finish()]);
    const vision = scripted([...text("a cat"), finish()]);
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, vision }) }), [{ type: "text", text: "what is this?" }, { type: "image", data: "AQID", mimeType: "image/png" }]);
    await done;
    expect(updates(events)).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a cat" } }]);
    expect(model.doStreamCalls).toHaveLength(0);
    expect(vision.doStreamCalls[0]!.prompt.at(-1)!.content).toEqual([{ type: "text", text: "what is this?" }, { type: "file", data: { type: "data", data: new Uint8Array([1, 2, 3]) }, mediaType: "image/png" }]);
  });

  it("AW1.4 finish reasons map to ACP stop reasons; a model error is a notice and the turn still ends", async () => {
    for (const [reason, stop] of [["length", "max_tokens"], ["content-filter", "refusal"], ["other", "end_turn"]] as const) {
      const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model: scripted([...text("x"), finish(reason)]) }) }), [{ type: "text", text: "go" }]);
      await done;
      expect(end(events)).toMatchObject({ type: "end", stopReason: stop });
    }
    const failing = run(new AgentWorker({ agent: sessionAgent({ model: scripted(Object.assign(new Error("model offline"), { statusCode: 400 })) }) }), [{ type: "text", text: "go" }]);
    await failing.done;
    expect(updates(failing.events)).toEqual([{ sessionUpdate: "notice", severity: "error", title: "Model call failed", description: expect.stringContaining("model offline") }]);
    expect(end(failing.events)).toMatchObject({ stopReason: "end_turn" });
  });

  it("AW1.5 cancelling stops the stream and ends the turn as cancelled; an unknown turn is ignored", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          async start(controller) {
            controller.enqueue({ type: "text-start", id: "0" });
            controller.enqueue({ type: "text-delta", id: "0", delta: "partial" });
            await gate;
            if (abortSignal?.aborted) controller.error(abortSignal.reason);
          },
        }),
      }),
    });
    const worker = new AgentWorker({ agent: sessionAgent({ model }) });
    const { events, done } = run(worker, [{ type: "text", text: "go" }]);
    await new Promise((r) => setTimeout(r, 10));
    worker.cancel("s1", "nope");
    worker.cancel("s1", "t1");
    release();
    await done;
    expect(end(events)).toMatchObject({ stopReason: "cancelled" });
  });

  it("AW1.6 a steered model's behavior state changes reach the client as notices", async () => {
    const model = scripted([stateContent({ state: "soothing", from: "neutral", cause: "insult" }), ...text("I hear you."), stateContent({ state: "calm" }), finish()]);
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model }) }), [{ type: "text", text: "you are useless" }]);
    await done;
    expect(updates(events)).toEqual([
      { sessionUpdate: "notice", severity: "info", title: "Behavior: soothing", description: "neutral → soothing (insult)", _meta: { harness: { behavior: { state: "soothing", from: "neutral", cause: "insult" } } } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I hear you." } },
      { sessionUpdate: "notice", severity: "info", title: "Behavior: calm", description: "calm", _meta: { harness: { behavior: { state: "calm" } } } },
    ]);
  });

  it("AW1.7 with memory, a turn is given related memories from other sessions, and is remembered afterwards; memory failures never fail a turn", async () => {
    const recalled: unknown[] = [];
    const remembered: unknown[] = [];
    const memory = {
      recall: async (query: string, options: unknown) => (recalled.push([query, options]), [{ text: "the deploy key is in the vault" }]),
      remember: async (items: unknown) => (remembered.push(items), []),
    };
    const model = scripted([...text("Check the vault."), finish()]);
    await run(new AgentWorker({ agent: sessionAgent({ model, memory, instructions: "Help." }), onTurn: rememberTurns(memory) }), [{ type: "text", text: "where is the key?" }]).done;
    expect(recalled).toEqual([["where is the key?", { excludeSession: "s1", limit: 3, kinds: ["user", "assistant"] }]]);
    expect(model.doStreamCalls[0]!.prompt[0]).toEqual({ role: "system", content: "Help.\n\nRelevant memories from earlier sessions:\n- the deploy key is in the vault" });
    expect(remembered).toEqual([
      [
        { text: "where is the key?", sessionId: "s1", kind: "user" },
        { text: "Check the vault.", sessionId: "s1", kind: "assistant" },
      ],
    ]);
    const broken = { recall: async () => Promise.reject(new Error("down")), remember: async () => Promise.reject(new Error("down")) };
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model: scripted([...text("ok"), finish()]), memory: broken }), onTurn: rememberTurns(broken) }), [{ type: "text", text: "hi" }]);
    await done;
    expect(end(events)).toMatchObject({ stopReason: "end_turn" });
    // nothing said means nothing to recall, and nothing to remember but the reply
    const quiet = scripted([...text("hello"), finish()]);
    const silent: unknown[] = [];
    await run(new AgentWorker({ agent: sessionAgent({ model: quiet, memory }), onTurn: rememberTurns({ ...memory, remember: async (items) => silent.push(items) }) }), []).done;
    expect(recalled).toHaveLength(1);
    expect(quiet.doStreamCalls[0]!.prompt[0]!.role).toBe("user");
    expect(silent).toEqual([[{ text: "hello", sessionId: "s1", kind: "assistant" }]]);
  });

  it("AW1.8 with learning, a turn is given the playbook for what was asked; a failing or empty playbook adds nothing", async () => {
    const model = scripted([...text("ok"), finish()]);
    await run(new AgentWorker({ agent: sessionAgent({ model, learning: { recall: async (task) => ({ playbook: `Lessons for ${task}` }) } }) }), [{ type: "text", text: "deploy" }]).done;
    expect(model.doStreamCalls[0]!.prompt[0]).toEqual({ role: "system", content: "Lessons for deploy" });
    for (const learning of [{ recall: async () => Promise.reject(new Error("x")) }, { recall: async () => ({ playbook: "" }) }]) {
      const m = scripted([...text("ok"), finish()]);
      await run(new AgentWorker({ agent: sessionAgent({ model: m, learning }) }), [{ type: "text", text: "deploy" }]).done;
      expect(m.doStreamCalls[0]!.prompt.map((p) => p.role)).toEqual(["user"]);
    }
  });

  it("AW1.14 every model call names its daemon session, so a steered model keeps that session's behavior state", async () => {
    const model = scripted([...text("one"), finish()], [...text("two"), finish()]);
    const worker = new AgentWorker({ agent: sessionAgent({ model }) });
    await run(worker, [{ type: "text", text: "a" }], "s1").done;
    await run(worker, [{ type: "text", text: "b" }], "s2").done;
    expect(model.doStreamCalls.map((c) => sessionOf(c.providerOptions))).toEqual(["s1", "s2"]);
  });

  it("AW1.15 with a model to consult, a turn is given its notes on what was asked as reference; a failing or empty consult adds nothing", async () => {
    const consult = scripted([...text("Lagos is the largest city in Nigeria."), finish()]);
    const model = scripted([...text("ok"), finish()]);
    await run(new AgentWorker({ agent: sessionAgent({ model, consult, instructions: "Help." }) }), [{ type: "text", text: "biggest city in Nigeria?" }]).done;
    expect(consult.doStreamCalls[0]!.prompt.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "biggest city in Nigeria?" }] });
    expect(model.doStreamCalls[0]!.prompt[0]).toEqual({ role: "system", content: "Help.\n\nReference notes from a larger model (check them before relying on them):\nLagos is the largest city in Nigeria." });
    for (const broken of [scripted(new Error("down")), scripted([...text("  "), finish()])]) {
      const m = scripted([...text("ok"), finish()]);
      await run(new AgentWorker({ agent: sessionAgent({ model: m, consult: broken }) }), [{ type: "text", text: "q" }]).done;
      expect(m.doStreamCalls[0]!.prompt.map((p) => p.role)).toEqual(["user"]);
    }
  });

  it("AW1.16 a behavior event for a session goes to the worker's behavior, and the change it caused is reported", () => {
    const raised: [string, string][] = [];
    const worker = new AgentWorker({ agent: sessionAgent({ model: scripted([finish()]) }), onEvent: (sessionId, name) => (raised.push([sessionId, name]), name === "praised" ? { state: "cheerful", from: "neutral", cause: "event praised" } : undefined) });
    const events: WorkerEvent[] = [];
    worker.event({ type: "event", sessionId: "s1", name: "praised" }, (e) => events.push(e));
    worker.event({ type: "event", sessionId: "s1", name: "ignored" }, (e) => events.push(e));
    expect(raised).toEqual([["s1", "praised"], ["s1", "ignored"]]);
    expect(events).toEqual([{ type: "behavior", sessionId: "s1", change: { state: "cheerful", from: "neutral", cause: "event praised" } }]);
    // a worker without behavior ignores events
    new AgentWorker({ agent: sessionAgent({ model: scripted([finish()]) }) }).event({ type: "event", sessionId: "s1", name: "praised" }, (e) => events.push(e));
    expect(events).toHaveLength(1);
  });

  it("AW1.9 tool calls run in the agent's loop and reach the client as tool calls and their results or failures", async () => {
    const model = scripted([call("weather", { city: "Lagos" }), finish("tool-calls")], [call("boom", {}, "c2"), finish("tool-calls")], [...text("Sunny."), finish()]);
    const tools = {
      weather: tool({ inputSchema: z.object({ city: z.string() }), execute: async ({ city }) => `sunny in ${city}` }),
      boom: tool({ inputSchema: z.object({}), execute: async (): Promise<string> => Promise.reject(new Error("broken")) }),
    };
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, tools }) }), [{ type: "text", text: "weather?" }]);
    await done;
    expect(updates(events)).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "weather", kind: "other", status: "pending", rawInput: { city: "Lagos" } },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "sunny in Lagos" },
      { sessionUpdate: "tool_call", toolCallId: "c2", title: "boom", kind: "other", status: "pending", rawInput: {} },
      { sessionUpdate: "tool_call_update", toolCallId: "c2", status: "failed", rawOutput: { error: "broken" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Sunny." } },
    ]);
    expect(end(events)).toMatchObject({ stopReason: "end_turn" });
  });

  it("AW1.10 a tool that needs approval asks the session's approvers through the permission flow; their answer decides whether it runs", async () => {
    for (const [optionId, ran] of [["allow", true], ["deny", false]] as const) {
      const runs: unknown[] = [];
      const model = scripted([call("deploy", { env: "prod" }), finish("tool-calls")], (o) => [...text(promptText(o.prompt) === "" ? "done" : "?"), finish()]);
      const tools = { deploy: tool({ inputSchema: z.object({ env: z.string() }), execute: async (input) => (runs.push(input), "deployed") }) };
      const worker = new AgentWorker({ agent: sessionAgent({ model, tools, toolApproval: { deploy: "user-approval" } }) });
      const { events, done } = run(worker, [{ type: "text", text: "ship it" }]);
      await new Promise((r) => setTimeout(r, 20));
      const request = events.find((e) => e.type === "permission");
      expect(request).toMatchObject({ type: "permission", sessionId: "s1", turnId: "t1", toolCall: { title: "deploy", kind: "other", status: "pending", rawInput: { env: "prod" } }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] });
      worker.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: "other", outcome: { outcome: "selected", optionId: "allow" } });
      worker.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: (request as { requestId: string }).requestId, outcome: { outcome: "selected", optionId } });
      await done;
      expect(runs.length > 0).toBe(ran);
      expect(end(events)).toMatchObject({ stopReason: "end_turn" });
    }
  });

  it("AW1.11 cancelling while a permission is pending ends the turn as cancelled, as does a cancelled permission", async () => {
    const make = () => {
      const model = scripted([call("deploy", {}), finish("tool-calls")], [...text("done"), finish()]);
      return new AgentWorker({ agent: sessionAgent({ model, tools: { deploy: tool({ inputSchema: z.object({}), execute: async () => "ok" }) }, toolApproval: { deploy: "user-approval" } }) });
    };
    const a = make();
    const first = run(a, [{ type: "text", text: "go" }]);
    await new Promise((r) => setTimeout(r, 20));
    a.cancel("s1", "t1");
    await first.done;
    expect(end(first.events)).toMatchObject({ stopReason: "cancelled" });
    const b = make();
    const second = run(b, [{ type: "text", text: "go" }]);
    await new Promise((r) => setTimeout(r, 20));
    const request = second.events.find((e) => e.type === "permission") as { requestId: string };
    b.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: request.requestId, outcome: { outcome: "cancelled" } });
    await second.done;
    expect(end(second.events)).toMatchObject({ stopReason: "cancelled" });
  });

  it("AW1.13 tools can be given anew each turn, so tools added between turns are offered", async () => {
    let tools: ToolSet = {};
    const model = scripted([...text("one"), finish()], [...text("two"), finish()]);
    const worker = new AgentWorker({ agent: sessionAgent({ model, tools: async () => tools }) });
    await run(worker, [{ type: "text", text: "first" }]).done;
    tools = { learned: tool({ description: "A learned tool.", inputSchema: z.object({}), execute: async () => "ok" }) };
    await run(worker, [{ type: "text", text: "second" }], "s1", "t2").done;
    expect(model.doStreamCalls.map((c) => (c.tools ?? []).map((t) => t.name))).toEqual([[], ["learned"]]);
  });

  it("AW1.12 an ACP prompt becomes AI SDK user content: text and image blocks, other blocks left out", () => {
    expect(userContent([{ type: "text", text: "a" }, { type: "image", data: "AQ==", mimeType: "image/png" }, { type: "resource" }, { type: "image", data: 1 }, null, "x"])).toEqual({
      content: [{ type: "text", text: "a" }, { type: "file", data: new Uint8Array([1]), mediaType: "image/png" }],
      said: "a\n",
    });
  });
});
