import { describe, expect, it } from "vitest";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { jsonSchema, tool } from "ai";
import type { ModelMessage } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { usage } from "@harness/cognitive";
import type { WorkerEvent } from "@harness/core";
import { nullSandbox, scriptedHarness } from "@harness/testkit";
import type { ScriptedTurn } from "@harness/testkit";
import { AgentWorker, harnessSessions, sessionAgent } from "@harness/workers";
import type { StepContext, StepHook, TurnContext } from "@harness/workers";

const finish = (unified: "stop" | "tool-calls" = "stop"): LanguageModelV4StreamPart => ({ type: "finish", finishReason: { unified, raw: undefined }, usage: usage() });
const text = (t: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: t },
  { type: "text-end", id: "0" },
];
const call = (toolName: string, input: unknown, toolCallId = "c1"): LanguageModelV4StreamPart => ({ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) });

function scripted(...turns: (LanguageModelV4StreamPart[] | ((o: LanguageModelV4CallOptions) => LanguageModelV4StreamPart[]))[]) {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async (o) => {
      const turn = turns[Math.min(n++, turns.length - 1)]!;
      return { stream: convertArrayToReadableStream([{ type: "stream-start", warnings: [] }, ...(typeof turn === "function" ? turn(o) : turn)]) };
    },
  });
}

/** A hook that records what it is given, and answers with `answer`. */
function recording(answer: (c: StepContext) => ReturnType<StepHook["prepare"]> = async () => undefined) {
  const seen: StepContext[] = [];
  const hook: StepHook = {
    prepare: async (c) => {
      seen.push({ ...c, messages: structuredClone(c.messages) });
      return answer(c);
    },
  };
  return { hook, seen };
}

function run(worker: AgentWorker, prompt: string, options: { sessionId?: string; turnId?: string; sessionMeta?: Record<string, unknown>; cwd?: string; onEvent?: (e: WorkerEvent) => void } = {}) {
  const events: WorkerEvent[] = [];
  const { sessionId = "s1", turnId = "t1", cwd = "/work" } = options;
  const done = worker.run({ type: "prompt", sessionId, turnId, prompt: [{ type: "text", text: prompt }], cwd, ...(options.sessionMeta ? { sessionMeta: options.sessionMeta } : {}) }, (e) => {
    events.push(e);
    options.onEvent?.(e);
  });
  return { events, done };
}
const updates = (events: WorkerEvent[]) => events.flatMap((e) => (e.type === "update" ? [e.update] : []));
const roles = (o: LanguageModelV4CallOptions) => o.prompt.map((m) => m.role);
const textOf = (m: LanguageModelV4CallOptions["prompt"][number]) => (typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : p.type)).join(""));

describe("sessionAgent's step hook: a per-step AI SDK prepareStep for procedural guidance", () => {
  it("PW1.1 the hook is asked on every step with the turn's session, turn, cwd and session meta, the step's messages and the initial instructions", async () => {
    const { hook, seen } = recording();
    const model = scripted([call("weather", { city: "Lagos" }), finish("tool-calls")], [...text("Sunny."), finish()]);
    const tools = { weather: tool({ inputSchema: z.object({ city: z.string() }), execute: async ({ city }) => `sunny in ${city}` }) };
    const worker = new AgentWorker({ agent: sessionAgent({ model, tools, instructions: "Be brief.", step: hook }) });
    await run(worker, "weather?", { sessionMeta: { repo: "harness" } }).done;
    expect(seen.map((c) => [c.sessionId, c.turnId, c.cwd, c.sessionMeta, c.stepNumber, c.initialInstructions])).toEqual([
      ["s1", "t1", "/work", { repo: "harness" }, 0, "Be brief."],
      ["s1", "t1", "/work", { repo: "harness" }, 1, "Be brief."],
    ]);
    expect(seen[0]!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "weather?" }] }]);
    expect(seen[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(seen[1]!.messages[1]!.content).toEqual([expect.objectContaining({ type: "tool-call", toolName: "weather", input: { city: "Lagos" } })]);
  });

  it("PW1.2 a session without meta gives the hook none", async () => {
    const { hook, seen } = recording();
    await run(new AgentWorker({ agent: sessionAgent({ model: scripted([...text("hi"), finish()]), step: hook }) }), "hi").done;
    expect(Object.keys(seen[0]!)).not.toContain("sessionMeta");
    expect(seen[0]!.initialInstructions).toBeUndefined();
  });

  it("PW1.3 the instructions and messages the hook returns are what that step's model call gets", async () => {
    const advisory: ModelMessage = { role: "user", content: "Guidance: look outside." };
    const { hook } = recording(async (c) => ({ instructions: `${String(c.initialInstructions)}\n\nstep ${c.stepNumber}`, messages: [...c.messages, advisory] }));
    const model = scripted([...text("ok"), finish()]);
    await run(new AgentWorker({ agent: sessionAgent({ model, instructions: "Be brief.", step: hook }) }), "weather?").done;
    const prompt = model.doStreamCalls[0]!.prompt;
    expect(roles(model.doStreamCalls[0]!)).toEqual(["system", "user", "user"]);
    expect(textOf(prompt[0]!)).toBe("Be brief.\n\nstep 0");
    expect(textOf(prompt[2]!)).toBe("Guidance: look outside.");
  });

  it("PW1.4 a hook that returns nothing leaves the step as it was", async () => {
    const { hook } = recording();
    const model = scripted([...text("ok"), finish()]);
    await run(new AgentWorker({ agent: sessionAgent({ model, instructions: "Be brief.", step: hook }) }), "weather?").done;
    expect(roles(model.doStreamCalls[0]!)).toEqual(["system", "user"]);
    expect(textOf(model.doStreamCalls[0]!.prompt[0]!)).toBe("Be brief.");
  });

  it("PW1.5 what the hook reports reaches the client as an update of the turn, before that step's tool call", async () => {
    const { hook } = recording(async (c) => {
      c.report({ sessionUpdate: "notice", severity: "info", title: `step ${c.stepNumber}` });
      return undefined;
    });
    const model = scripted([call("weather", { city: "Lagos" }), finish("tool-calls")], [...text("Sunny."), finish()]);
    const tools = { weather: tool({ inputSchema: z.object({ city: z.string() }), execute: async () => "sunny" }) };
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, tools, step: hook }) }), "weather?");
    await done;
    expect(updates(events).map((u) => (u.sessionUpdate === "notice" ? u.title : u.sessionUpdate))).toEqual(["step 0", "tool_call", "tool_call_update", "step 1", "agent_message_chunk"]);
    expect(events.filter((e) => e.type === "update").every((e) => e.sessionId === "s1" && e.turnId === "t1")).toBe(true);
  });

  it("PW1.6 a failing hook never fails the turn: the step runs unguided and a warning says why", async () => {
    const hook: StepHook = { prepare: async () => Promise.reject(new Error("graph store offline")) };
    const model = scripted([...text("ok"), finish()]);
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, instructions: "Be brief.", step: hook }) }), "hi");
    await done;
    expect(updates(events)).toEqual([
      { sessionUpdate: "notice", severity: "warning", title: "Step guidance failed", description: "graph store offline" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
    expect(roles(model.doStreamCalls[0]!)).toEqual(["system", "user"]);
    const odd: StepHook = { prepare: async () => Promise.reject("just a string") };
    const second = run(new AgentWorker({ agent: sessionAgent({ model: scripted([...text("ok"), finish()]), step: odd }) }), "hi");
    await second.done;
    expect(updates(second.events)[0]).toMatchObject({ description: "just a string" });
  });

  it("PW1.7 after an approval round the hook still sees the approved call as the last assistant tool call, in the same turn", async () => {
    const { hook, seen } = recording();
    const model = scripted([call("deploy", { env: "prod" }), finish("tool-calls")], [...text("done"), finish()]);
    const tools = { deploy: tool({ inputSchema: z.object({ env: z.string() }), execute: async () => "deployed" }) };
    const worker = new AgentWorker({ agent: sessionAgent({ model, tools, toolApproval: { deploy: "user-approval" }, step: hook }) });
    await run(worker, "ship it", {
      onEvent: (e) => {
        if (e.type === "permission") queueMicrotask(() => worker.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: e.requestId, outcome: { outcome: "selected", optionId: "allow" } }));
      },
    }).done;
    // The worker restarts the agent's stream after the approval round, so AI SDK step numbers restart; the turn and messages do not.
    expect(seen.map((c) => [c.turnId, c.stepNumber])).toEqual([
      ["t1", 0],
      ["t1", 0],
    ]);
    const lastAssistant = seen[1]!.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(lastAssistant.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool-call", toolName: "deploy" })]));
  });

  it("PW1.81 the active tools the hook returns are the only tools that step's model call is offered; without them every tool is", async () => {
    const tools = { weather: tool({ inputSchema: z.object({}), execute: async () => "ok" }), deploy: tool({ inputSchema: z.object({}), execute: async () => "ok" }) };
    const offered = (o: LanguageModelV4CallOptions) => (o.tools ?? []).map((t) => t.name);
    let step = 0;
    const narrowing: StepHook = { prepare: async () => (step++ === 0 ? { activeTools: ["weather"] } : undefined) };
    const model = scripted([call("weather", {}), finish("tool-calls")], [...text("ok"), finish()]);
    await run(new AgentWorker({ agent: sessionAgent({ model, tools, step: narrowing }) }), "hi").done;
    expect(model.doStreamCalls.map(offered)).toEqual([["weather"], ["weather", "deploy"]]);
  });

  it("PW1.22 the hook is told the names of the tools the turn offers, whether given once or anew each turn", async () => {
    const tools = { weather: tool({ inputSchema: z.object({}), execute: async () => "ok" }), deploy: tool({ inputSchema: z.object({}), execute: async () => "ok" }) };
    const fixed = recording();
    await run(new AgentWorker({ agent: sessionAgent({ model: scripted([...text("ok"), finish()]), tools, step: fixed.hook }) }), "hi").done;
    expect(fixed.seen[0]!.tools).toEqual(["weather", "deploy"]);
    const fresh = recording();
    await run(new AgentWorker({ agent: sessionAgent({ model: scripted([...text("ok"), finish()]), tools: async () => ({ deploy: tools.deploy }), step: fresh.hook }) }), "hi").done;
    expect(fresh.seen[0]!.tools).toEqual(["deploy"]);
    const none = recording();
    await run(new AgentWorker({ agent: sessionAgent({ model: scripted([...text("ok"), finish()]), step: none.hook }) }), "hi").done;
    expect(none.seen[0]!.tools).toEqual([]);
  });

  it("PW1.8 without a hook, no step preparation is added", async () => {
    const model = scripted([...text("ok"), finish()]);
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, instructions: "Be brief." }) }), "hi");
    await done;
    expect(updates(events)).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }]);
  });
});

const weather = tool({ description: "Weather for a city.", inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }), execute: async ({ city }) => ({ city, sky: "clear" }) });

function harnessSetup(script: (prompt: string) => ScriptedTurn | string, turn: StepHook["turn"], settings: { toolApproval?: Record<string, "user-approval"> } = {}) {
  const harness = scriptedHarness(script);
  const agent = new HarnessAgent({ harness, instructions: "Be brief.", tools: { weather }, ...settings });
  const hook: StepHook = { prepare: async () => undefined, ...(turn ? { turn } : {}) };
  return { harness, worker: new AgentWorker({ agent: harnessSessions(agent, { sandboxSession: nullSandbox, step: hook }) }) };
}

describe("harnessSessions' turn hook: turn-level guidance for opaque harness workers", () => {
  it("PW1.9 the turn hook's text is prepended to the prompt the harness gets, and the hook is told the session, turn, cwd, meta and prompt", async () => {
    const seen: TurnContext[] = [];
    const { harness, worker } = harnessSetup(
      (p) => `saw ${p}`,
      async (c) => {
        seen.push(c);
        return "Guidance: check the sky.";
      },
    );
    await run(worker, "weather?", { sessionMeta: { repo: "harness" } }).done;
    expect(harness.log.turns[0]!.prompt).toMatchObject({ role: "user", content: [{ type: "text", text: "Guidance: check the sky.\n\n" }, { type: "text", text: "weather?" }] });
    expect(seen.map((c) => [c.sessionId, c.turnId, c.cwd, c.sessionMeta, c.lastAction, c.tools])).toEqual([["s1", "t1", "/work", { repo: "harness" }, undefined, ["weather"]]]);
    expect(seen[0]!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "weather?" }] }]);
  });

  it("PW1.10 the next turn's hook is told the previous turn's last tool call; a turn without calls keeps it", async () => {
    const seen: (string | undefined)[] = [];
    const { worker } = harnessSetup(
      (p) => (p.includes("weather") ? { text: "Lagos:", tool: { name: "weather", input: { city: "Lagos" } } } : "plain"),
      async (c) => {
        seen.push(c.lastAction);
        return undefined;
      },
    );
    await run(worker, "weather?").done;
    await run(worker, "thanks", { turnId: "t2" }).done;
    await run(worker, "again", { turnId: "t3" }).done;
    expect(seen).toEqual([undefined, "weather", "weather"]);
  });

  it("PW1.77 the next turn's hook is told the previous turn's last call with its input and its result's output, for a state tracker", async () => {
    const seen: TurnContext["lastCall"][] = [];
    const { worker } = harnessSetup(
      (p) => (p.includes("weather") ? { text: "Lagos:", tool: { name: "weather", input: { city: "Lagos" } } } : "plain"),
      async (c) => {
        seen.push(c.lastCall);
        return undefined;
      },
    );
    await run(worker, "weather?").done;
    await run(worker, "thanks", { turnId: "t2" }).done;
    await run(worker, "again", { turnId: "t3" }).done;
    const lagos = { name: "weather", input: { city: "Lagos" }, output: { city: "Lagos", sky: "clear" } };
    expect(seen).toEqual([undefined, lagos, lagos]);
  });

  it("PW1.78 a call whose result the harness never reported is told without an output", async () => {
    const seen: TurnContext["lastCall"][] = [];
    const { worker } = harnessSetup(
      (p) => (p.includes("weather") ? { text: "Lagos:", tool: { name: "weather", input: { city: "Lagos" } } } : "plain"),
      async (c) => {
        seen.push(c.lastCall);
        return undefined;
      },
      { toolApproval: { weather: "user-approval" } },
    );
    await run(worker, "weather?", {
      onEvent: (e) => {
        if (e.type === "permission") worker.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: e.requestId, outcome: { outcome: "cancelled" } });
      },
    }).done;
    await run(worker, "thanks", { turnId: "t2" }).done;
    expect(seen).toEqual([undefined, { name: "weather", input: { city: "Lagos" } }]);
  });

  it("PW1.11 no text leaves the prompt as it was, and what the hook reports reaches the client", async () => {
    const { harness, worker } = harnessSetup(
      (p) => p,
      async (c) => {
        c.report({ sessionUpdate: "notice", severity: "info", title: "turn guided" });
        return undefined;
      },
    );
    const { events, done } = run(worker, "hi");
    await done;
    expect(harness.log.turns[0]!.prompt).toMatchObject({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(updates(events)[0]).toEqual({ sessionUpdate: "notice", severity: "info", title: "turn guided" });
  });

  it("PW1.12 a continuation after an approval round is not guided again", async () => {
    let asked = 0;
    const { harness, worker } = harnessSetup(
      () => ({ text: "Lagos:", tool: { name: "weather", input: { city: "Lagos" } } }),
      async () => {
        asked++;
        return "Guidance: go.";
      },
      { toolApproval: { weather: "user-approval" } },
    );
    await run(worker, "weather?", {
      onEvent: (e) => {
        if (e.type === "permission") worker.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: e.requestId, outcome: { outcome: "selected", optionId: "allow" } });
      },
    }).done;
    expect(asked).toBe(1);
    expect(harness.log.turns).toHaveLength(1);
  });

  it("PW1.13 a failing turn hook never fails the turn: the prompt goes unguided and a warning says why", async () => {
    const { harness, worker } = harnessSetup(
      (p) => p,
      async () => Promise.reject(new Error("no graph")),
    );
    const { events, done } = run(worker, "hi");
    await done;
    expect(harness.log.turns[0]!.prompt).toMatchObject({ content: [{ type: "text", text: "hi" }] });
    expect(updates(events)[0]).toEqual({ sessionUpdate: "notice", severity: "warning", title: "Turn guidance failed", description: "no graph" });
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
  });

  it("PW1.14 a hook without a turn variant, or a string prompt, is passed through untouched", async () => {
    const { harness, worker } = harnessSetup((p) => `saw ${p}`, undefined);
    await run(worker, "hi").done;
    expect(harness.log.turns[0]!.prompt).toMatchObject({ content: [{ type: "text", text: "hi" }] });
    const guided = scriptedHarness((p) => `saw ${p}`);
    const sessions = harnessSessions(new HarnessAgent({ harness: guided }), { sandboxSession: nullSandbox, step: { prepare: async () => undefined, turn: async () => "Guidance." } });
    const { text: reply } = await sessions.generate({ prompt: "ping", options: { sessionId: "s9" } });
    expect(reply).toBe("saw ping");
  });
});
