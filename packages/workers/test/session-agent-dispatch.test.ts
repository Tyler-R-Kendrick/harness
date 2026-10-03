import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { tool } from "ai";
import type { PrepareStepFunction, ToolSet } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { usage } from "@harness/cognitive";
import type { WorkerEvent } from "@harness/core";
import { AgentWorker, sessionAgent } from "@harness/workers";
import type { DispatchRecord, DispatchStepContext } from "@harness/workers";

const finish = (unified: "stop" | "tool-calls" = "stop"): LanguageModelV4StreamPart => ({ type: "finish", finishReason: { unified, raw: undefined }, usage: usage() });
const text = (t: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: t },
  { type: "text-end", id: "0" },
];
const call = (toolName: string, input: unknown, toolCallId = "c1"): LanguageModelV4StreamPart[] => [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }, finish("tool-calls")];

/** A model that answers each call with the next scripted stream (the last repeats). */
function scripted(...turns: (LanguageModelV4StreamPart[] | ((o: LanguageModelV4CallOptions) => LanguageModelV4StreamPart[]))[]) {
  let n = 0;
  return new MockLanguageModelV4({
    doStream: async (o) => {
      const turn = turns[Math.min(n++, turns.length - 1)]!;
      return { stream: convertArrayToReadableStream([{ type: "stream-start", warnings: [] }, ...(typeof turn === "function" ? turn(o) : turn)]) };
    },
  });
}
const answers = (t: string) => scripted([...text(t), finish()]);

function run(worker: AgentWorker, prompt: unknown[], sessionId = "s1", turnId = "t1") {
  const events: WorkerEvent[] = [];
  const done = worker.run({ type: "prompt", sessionId, turnId, prompt, cwd: "/" }, (e) => events.push(e));
  return { events, done };
}
const said = (events: WorkerEvent[]) => events.flatMap((e) => (e.type === "update" && e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text" ? [e.update.content.text] : [])).join("");
/** Streams a prompt with a prepareStep passed in the call (the agent's prepareCall hands it on; the SDK's call type just does not list it). */
function streamWithStep(agent: ReturnType<typeof sessionAgent>, prepareStep: PrepareStepFunction<ToolSet>) {
  const params = { options: { sessionId: "s1" }, prompt: "hi", prepareStep };
  return agent.stream(params);
}
const hi = [{ type: "text", text: "hi" }];
const echo = tool({ inputSchema: z.object({ q: z.string() }), execute: async ({ q }) => `echo ${q}` });
const other = tool({ inputSchema: z.object({}), execute: async () => "other" });

describe("sessionAgent dispatch: per-step model choice", () => {
  it("DWK1.1 without a dispatch option every step uses the agent's model", async () => {
    const model = answers("plain");
    const small = answers("small");
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model }) }), hi);
    await done;
    expect(said(events)).toBe("plain");
    expect(small.doStreamCalls).toHaveLength(0);
  });

  it("DWK1.2 'stay' keeps the step on the agent's model", async () => {
    const model = answers("main");
    const small = answers("small");
    const large = answers("large");
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, dispatch: { tiers: { small, large }, plan: async () => "stay" } }) }), hi);
    await done;
    expect(said(events)).toBe("main");
    expect(small.doStreamCalls).toHaveLength(0);
    expect(large.doStreamCalls).toHaveLength(0);
  });

  it("DWK1.3 'small' routes the step to the small tier", async () => {
    const model = answers("main");
    const small = answers("small");
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, dispatch: { tiers: { small, large: answers("large") }, plan: async () => "small" } }) }), hi);
    await done;
    expect(said(events)).toBe("small");
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("DWK1.4 'large' routes the step to the large tier", async () => {
    const model = answers("main");
    const large = answers("large");
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, dispatch: { tiers: { small: answers("small"), large }, plan: async () => "large" } }) }), hi);
    await done;
    expect(said(events)).toBe("large");
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("DWK1.5 a choice whose tier is not given means stay", async () => {
    const records: DispatchRecord[] = [];
    for (const choice of ["small", "large"] as const) {
      const model = answers("main");
      const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, dispatch: { tiers: {}, plan: async () => choice, onDispatch: (r) => void records.push(r) } }) }), hi);
      await done;
      expect(said(events)).toBe("main");
    }
    expect(records.map((r) => r.choice)).toEqual(["stay", "stay"]);
  });

  it("DWK1.6 an agent with a dispatch still works without any tier or hook", async () => {
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("main"), dispatch: { tiers: {}, plan: () => Promise.resolve("stay") } }) }), hi);
    await done;
    expect(said(events)).toBe("main");
  });
});

describe("sessionAgent dispatch: every step of a multi-step turn is dispatched", () => {
  it("DWK2.1 each step of one tool turn can go to a different model", async () => {
    const main = scripted([...call("echo", { q: "b" }, "c2")]);
    const small = scripted([...call("echo", { q: "a" }, "c1")]);
    const large = answers("done");
    const plans: ("small" | "stay" | "large")[] = ["small", "stay", "large"];
    const seen: DispatchStepContext[] = [];
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model: main, tools: { echo }, dispatch: { tiers: { small, large }, plan: async (s) => (seen.push(s), plans[s.stepNumber]!) } }) }), hi);
    await done;
    expect(main.doStreamCalls).toHaveLength(1);
    expect(small.doStreamCalls).toHaveLength(1);
    expect(large.doStreamCalls).toHaveLength(1);
    expect(said(events)).toBe("done");
    expect(seen.map((s) => s.stepNumber)).toEqual([0, 1, 2]);
  });

  it("DWK2.2 plan is asked once per step with the session, step number and the tools offered", async () => {
    const seen: DispatchStepContext[] = [];
    const model = scripted([...call("echo", { q: "a" })], [...text("ok"), finish()]);
    const { done } = run(new AgentWorker({ agent: sessionAgent({ model, tools: { echo, other }, dispatch: { tiers: {}, plan: async (s) => (seen.push(s), "stay") } }) }), hi, "sess-9");
    await done;
    expect(seen).toHaveLength(2);
    expect(seen.map((s) => [s.sessionId, s.stepNumber])).toEqual([["sess-9", 0], ["sess-9", 1]]);
    expect(seen[0]!.toolNames).toEqual(["echo", "other"]);
  });

  it("DWK2.3 the step's messages are the ones the model is about to receive, including the earlier steps' tool results", async () => {
    const seen: DispatchStepContext[] = [];
    const model = scripted([...call("echo", { q: "a" })], [...text("ok"), finish()]);
    const { done } = run(new AgentWorker({ agent: sessionAgent({ model, tools: { echo }, dispatch: { tiers: {}, plan: async (s) => (seen.push(s), "stay") } }) }), hi);
    await done;
    expect(seen[0]!.messages.map((m) => m.role)).toEqual(["user"]);
    expect(seen[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  });

  it("DWK2.4 the first step has no lastToolInputs; later steps carry the previous step's tool inputs", async () => {
    const seen: DispatchStepContext[] = [];
    const model = scripted([...call("echo", { q: "a" })], [...text("ok"), finish()]);
    const { done } = run(new AgentWorker({ agent: sessionAgent({ model, tools: { echo }, dispatch: { tiers: {}, plan: async (s) => (seen.push(s), "stay") } }) }), hi);
    await done;
    expect(seen[0]!.lastToolInputs).toBeUndefined();
    expect(seen[1]!.lastToolInputs).toEqual([{ toolName: "echo", input: { q: "a" } }]);
  });

  it("DWK2.5 tools given anew each turn are the ones named in the step", async () => {
    const seen: DispatchStepContext[] = [];
    const { done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("ok"), tools: async () => ({ other }), dispatch: { tiers: {}, plan: async (s) => (seen.push(s), "stay") } }) }), hi);
    await done;
    expect(seen[0]!.toolNames).toEqual(["other"]);
  });

  it("DWK2.6 an agent with no tools names none", async () => {
    const seen: DispatchStepContext[] = [];
    const { done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("ok"), dispatch: { tiers: {}, plan: async (s) => (seen.push(s), "stay") } }) }), hi);
    await done;
    expect(seen[0]!.toolNames).toEqual([]);
  });

  it("DWK2.7 concurrent sessions are dispatched with their own session ids", async () => {
    const seen: string[] = [];
    const worker = new AgentWorker({ agent: sessionAgent({ model: answers("ok"), dispatch: { tiers: {}, plan: async (s) => (seen.push(s.sessionId), "stay") } }) });
    await Promise.all([run(worker, hi, "a").done, run(worker, hi, "b").done]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });
});

describe("sessionAgent dispatch: the context estimate", () => {
  it("DWK3.1 contextTokens is the serialized messages' length over four, rounded up", async () => {
    const seen: DispatchStepContext[] = [];
    const { done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("ok"), dispatch: { tiers: {}, plan: async (s) => (seen.push(s), "stay") } }) }), hi);
    await done;
    expect(seen[0]!.contextTokens).toBe(Math.ceil(JSON.stringify(seen[0]!.messages).length / 4));
    expect(seen[0]!.contextTokens).toBeGreaterThan(0);
  });

  it("DWK3.2 a longer conversation has a larger estimate", async () => {
    const seen: DispatchStepContext[] = [];
    const worker = new AgentWorker({ agent: sessionAgent({ model: answers("an answer of some length"), dispatch: { tiers: {}, plan: async (s) => (seen.push(s), "stay") } }) });
    await run(worker, hi).done;
    await run(worker, [{ type: "text", text: "and a much longer follow up question than before" }], "s1", "t2").done;
    expect(seen[1]!.contextTokens).toBeGreaterThan(seen[0]!.contextTokens);
  });

  it("DWK3.3 an unserializable message counts as zero rather than failing the dispatch", async () => {
    const seen: DispatchStepContext[] = [];
    const records: DispatchRecord[] = [];
    const agent = sessionAgent({ model: answers("ok"), dispatch: { tiers: {}, plan: async (s) => (seen.push(s), "stay"), onDispatch: (r) => void records.push(r) } });
    // The model call may itself refuse such a message; the dispatch before it must not throw.
    await (await streamWithStep(agent, () => ({ messages: [{ role: "user", content: [{ type: "text", text: "x", providerOptions: { x: { n: 1n as never } } }] }] }))).consumeStream({ onError: () => undefined });
    expect(seen[0]!.contextTokens).toBe(0);
    expect(records.map((r) => r.choice)).toEqual(["stay"]);
  });

  it("DWK3.4 binary data counts as its base64 length, not as its bytes serialized one by one", async () => {
    const records: DispatchRecord[] = [];
    const agent = sessionAgent({ model: answers("ok"), dispatch: { tiers: {}, plan: async () => "stay", onDispatch: (r) => void records.push(r) } });
    await (await streamWithStep(agent, () => ({ messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "file", data: { type: "data", data: new Uint8Array(300) }, mediaType: "application/pdf" }] }] }))).consumeStream({ onError: () => undefined });
    expect(records[0]!.contextTokens).toBeGreaterThanOrEqual(100);
    expect(records[0]!.contextTokens).toBeLessThan(200);
  });
});

describe("sessionAgent dispatch: images", () => {
  const image = [{ type: "text", text: "what is this?" }, { type: "image", data: "AQID", mimeType: "image/png" }];

  it("DWK4.1 a turn with an image stays on the vision model whatever the plan says, and the plan is not asked", async () => {
    const vision = answers("a cat");
    const small = answers("small");
    const large = answers("large");
    let asked = 0;
    const records: DispatchRecord[] = [];
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("main"), vision, dispatch: { tiers: { small, large }, plan: async () => (asked++, "small"), onDispatch: (r) => void records.push(r) } }) }), image);
    await done;
    expect(said(events)).toBe("a cat");
    expect(small.doStreamCalls).toHaveLength(0);
    expect(large.doStreamCalls).toHaveLength(0);
    expect(asked).toBe(0);
    expect(records.map((r) => r.choice)).toEqual(["stay"]);
  });

  it("DWK4.2 every step of an image turn stays on the vision model", async () => {
    const vision = scripted([...call("echo", { q: "a" })], [...text("a cat"), finish()]);
    const small = answers("small");
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("main"), vision, tools: { echo }, dispatch: { tiers: { small }, plan: async () => "small" } }) }), image);
    await done;
    expect(vision.doStreamCalls).toHaveLength(2);
    expect(small.doStreamCalls).toHaveLength(0);
    expect(said(events)).toBe("a cat");
  });

  it("DWK4.3 an image still in the conversation keeps later text turns off a text-only tier", async () => {
    const vision = answers("a cat");
    const small = answers("small");
    const main = answers("main");
    const worker = new AgentWorker({ agent: sessionAgent({ model: main, vision, dispatch: { tiers: { small }, plan: async () => "small" } }) });
    await run(worker, image).done;
    const { events, done } = run(worker, [{ type: "text", text: "and its colour?" }], "s1", "t2");
    await done;
    expect(small.doStreamCalls).toHaveLength(0);
    expect(said(events)).toBe("main");
  });

  it("DWK4.4 a tool result carrying an image keeps the next step off the tiers", async () => {
    const shot = tool({ inputSchema: z.object({}), execute: async () => "png", toModelOutput: () => ({ type: "content", value: [{ type: "file-data", data: "AQID", mediaType: "image/png" }] }) });
    const small = answers("small");
    const model = scripted([...call("shot", {})], [...text("seen"), finish()]);
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, tools: { shot }, dispatch: { tiers: { small }, plan: async (s) => (s.stepNumber === 0 ? "stay" : "small") } }) }), hi);
    await done;
    expect(small.doStreamCalls).toHaveLength(0);
    expect(said(events)).toBe("seen");
  });

  it("DWK4.5 a tool result of plain content does not block the tiers", async () => {
    const note = tool({ inputSchema: z.object({}), execute: async () => "n", toModelOutput: () => ({ type: "content", value: [{ type: "text", text: "n" }] }) });
    const small = answers("small");
    const model = scripted([...call("note", {})]);
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model, tools: { note }, dispatch: { tiers: { small }, plan: async (s) => (s.stepNumber === 0 ? "stay" : "small") } }) }), hi);
    await done;
    expect(small.doStreamCalls).toHaveLength(1);
    expect(said(events)).toBe("small");
  });
});

describe("sessionAgent dispatch: best effort", () => {
  it("DWK5.1 a plan that rejects means stay, and the failure goes to onError with the step", async () => {
    const errors: { error: unknown; step: DispatchStepContext }[] = [];
    const small = answers("small");
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("main"), dispatch: { tiers: { small }, plan: () => Promise.reject(new Error("no planner")), onError: (error, step) => void errors.push({ error, step }) } }) }), hi);
    await done;
    expect(said(events)).toBe("main");
    expect(small.doStreamCalls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect((errors[0]!.error as Error).message).toBe("no planner");
    expect(errors[0]!.step.stepNumber).toBe(0);
  });

  it("DWK5.2 a plan that throws synchronously means stay", async () => {
    const { events, done } = run(
      new AgentWorker({
        agent: sessionAgent({
          model: answers("main"),
          dispatch: {
            tiers: { small: answers("small") },
            plan: () => {
              throw new Error("boom");
            },
          },
        }),
      }),
      hi,
    );
    await done;
    expect(said(events)).toBe("main");
  });

  it("DWK5.3 a plan that answers something else means stay", async () => {
    const small = answers("small");
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("main"), dispatch: { tiers: { small }, plan: async () => "medium" as "small" } }) }), hi);
    await done;
    expect(said(events)).toBe("main");
    expect(small.doStreamCalls).toHaveLength(0);
  });

  it("DWK5.4 a failing onError does not fail the turn", async () => {
    const { events, done } = run(
      new AgentWorker({
        agent: sessionAgent({
          model: answers("main"),
          dispatch: {
            tiers: {},
            plan: () => Promise.reject(new Error("x")),
            onError: () => {
              throw new Error("logger down");
            },
          },
        }),
      }),
      hi,
    );
    await done;
    expect(said(events)).toBe("main");
  });

  it("DWK5.5 a failing onDispatch does not fail the turn and is reported to onError", async () => {
    const errors: unknown[] = [];
    const small = answers("small");
    const { events, done } = run(
      new AgentWorker({
        agent: sessionAgent({
          model: answers("main"),
          dispatch: {
            tiers: { small },
            plan: async () => "small",
            onDispatch: () => {
              throw new Error("sink down");
            },
            onError: (error) => void errors.push(error),
          },
        }),
      }),
      hi,
    );
    await done;
    expect(said(events)).toBe("small");
    expect((errors[0] as Error).message).toBe("sink down");
  });

  it("DWK5.6 a plan that fails with no onError is silent", async () => {
    const { events, done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("main"), dispatch: { tiers: {}, plan: () => Promise.reject(new Error("x")) } }) }), hi);
    await done;
    expect(said(events)).toBe("main");
  });
});

describe("sessionAgent dispatch: the record", () => {
  it("DWK6.1 onDispatch is called once per step with the session, step, the effective choice and the context estimate", async () => {
    const records: DispatchRecord[] = [];
    const seen: DispatchStepContext[] = [];
    const small = scripted([...call("echo", { q: "a" })]);
    const model = answers("done");
    const plans = ["small", "stay"] as const;
    const { done } = run(new AgentWorker({ agent: sessionAgent({ model, tools: { echo }, dispatch: { tiers: { small }, plan: async (s) => (seen.push(s), plans[s.stepNumber]!), onDispatch: (r) => void records.push(r) } }) }), hi, "sess-3");
    await done;
    expect(records).toEqual([
      { sessionId: "sess-3", stepNumber: 0, choice: "small", contextTokens: seen[0]!.contextTokens },
      { sessionId: "sess-3", stepNumber: 1, choice: "stay", contextTokens: seen[1]!.contextTokens },
    ]);
  });

  it("DWK6.2 a plan failure is recorded as stay", async () => {
    const records: DispatchRecord[] = [];
    const { done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("main"), dispatch: { tiers: {}, plan: () => Promise.reject(new Error("x")), onDispatch: (r) => void records.push(r) } }) }), hi);
    await done;
    expect(records.map((r) => r.choice)).toEqual(["stay"]);
  });

  it("DWK6.3 the plan is asked before the record is made", async () => {
    const order: string[] = [];
    const { done } = run(new AgentWorker({ agent: sessionAgent({ model: answers("main"), dispatch: { tiers: {}, plan: async () => (order.push("plan"), "stay"), onDispatch: () => void order.push("record") } }) }), hi);
    await done;
    expect(order).toEqual(["plan", "record"]);
  });
});

describe("sessionAgent dispatch: composes with a caller's prepareStep", () => {
  it("DWK7.1 a prepareStep given on the call runs first; its model is the step's current model and its other settings are kept", async () => {
    const chosen = answers("chosen");
    const small = answers("small");
    const agent = sessionAgent({ model: answers("main"), dispatch: { tiers: { small }, plan: async () => "stay" } });
    const result = await streamWithStep(agent, () => ({ model: chosen, activeTools: [] }));
    expect(await result.text).toBe("chosen");
    expect(small.doStreamCalls).toHaveLength(0);
  });

  it("DWK7.2 the dispatch can override a prepareStep's model with a tier", async () => {
    const chosen = answers("chosen");
    const small = answers("small");
    const agent = sessionAgent({ model: answers("main"), dispatch: { tiers: { small }, plan: async () => "small" } });
    const result = await streamWithStep(agent, () => ({ model: chosen }));
    expect(await result.text).toBe("small");
  });

  it("DWK7.3 messages overridden by the caller's prepareStep are the ones dispatched on", async () => {
    const seen: DispatchStepContext[] = [];
    const agent = sessionAgent({ model: answers("main"), dispatch: { tiers: {}, plan: async (s) => (seen.push(s), "stay") } });
    await (await streamWithStep(agent, () => ({ messages: [{ role: "user", content: "rewritten" }] }))).consumeStream();
    expect(seen[0]!.messages).toEqual([{ role: "user", content: "rewritten" }]);
  });

  it("DWK7.4 tools the caller's prepareStep deactivates are not named", async () => {
    const seen: DispatchStepContext[] = [];
    const agent = sessionAgent({ model: answers("main"), tools: { echo, other }, dispatch: { tiers: {}, plan: async (s) => (seen.push(s), "stay") } });
    await (await streamWithStep(agent, () => ({ activeTools: ["other"] }))).consumeStream();
    expect(seen[0]!.toolNames).toEqual(["other"]);
  });

  it("DWK7.5 a caller's prepareStep that returns nothing leaves the dispatch in charge", async () => {
    const small = answers("small");
    const agent = sessionAgent({ model: answers("main"), dispatch: { tiers: { small }, plan: async () => "small" } });
    const result = await streamWithStep(agent, () => undefined);
    expect(await result.text).toBe("small");
  });
});
