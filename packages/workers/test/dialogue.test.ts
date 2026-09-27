import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateText, stepCountIs, streamText, tool, wrapLanguageModel } from "ai";
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4ToolResultOutput } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { collectParts, constrain, HARNESS, inSession, MODEL_HEADER, usage } from "@harness/cognitive";
import { Dialogue, parseSettings } from "@harness/dialogue";
import type { Step } from "@harness/dialogue";
import { dialogueMiddleware, stepOf } from "@harness/workers";

const settingsFile = JSON.parse(readFileSync(new URL("../../dialogue/data/settings.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
const settings = parseSettings({ ...settingsFile, induce: { ...settingsFile["induce"], cluster: 0.7 } });

const book = {
  scripts: [
    {
      id: "order-status",
      intent: "The customer asks where their order is",
      patterns: ["where(?: is|'s) (?:my )?order (?<order_id>\\d+)"],
      slots: { order_id: { pattern: "\\d+" } },
      reply: ["Let me look up order ", { slot: "order_id" }, "."],
    },
    { id: "tracking", intent: "Read back a tracking result", result: { tool: "track_order" }, reply: ["Order ", { input: ["id"] }, " is ", { output: ["status"] }, " and arrives ", { output: ["eta", "day"] }, "."] },
    { id: "confirm-cancel", intent: "The customer confirms a cancellation", context: "order-status", patterns: ["yes(?:,? please)?"], reply: ["Done: ", { generate: "summary" }, "."] },
    { id: "book-table", intent: "Book a table", patterns: ["book a table"], slots: { time: { prompts: ["For what time?"] } }, reply: ["Booked for ", { slot: "time" }, "."] },
  ],
};

type Say = string | { readonly tool: string; readonly input: Record<string, unknown> } | { readonly error: string };

/** A model that says `say(call)`: text, a tool call or a failure, generated or streamed. It records its calls. */
function replyModel(say: (call: LanguageModelV4CallOptions) => Say): MockLanguageModelV4 & { readonly calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = [];
  const parts = (s: Say): LanguageModelV4StreamPart[] => {
    const start: LanguageModelV4StreamPart = { type: "stream-start", warnings: [] };
    if (typeof s === "string")
      return [start, { type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: s }, { type: "text-end", id: "0" }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() }];
    if ("error" in s) return [start, { type: "error", error: new Error(s.error) }, { type: "finish", finishReason: { unified: "error", raw: undefined }, usage: usage() }];
    return [start, { type: "tool-call", toolCallId: "call_0", toolName: s.tool, input: JSON.stringify(s.input) }, { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() }];
  };
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      calls.push(call);
      return collectParts(parts(say(call)));
    },
    doStream: async (call) => {
      calls.push(call);
      return { stream: convertArrayToReadableStream(parts(say(call))) };
    },
  });
  return Object.assign(model, { calls });
}

const lastText = (prompt: LanguageModelV4Prompt) => {
  const last = [...prompt].reverse().find((m) => m.role === "user");
  return last?.role === "user" ? last.content.map((p) => (p.type === "text" ? p.text : "")).join("") : "";
};

function setup(say: (call: LanguageModelV4CallOptions) => Say = () => "the model's reply", dialogue = new Dialogue({ settings, book })) {
  const inner = replyModel(say);
  return { inner, dialogue, model: wrapLanguageModel({ model: inner, middleware: dialogueMiddleware(dialogue) }) };
}

const session = inSession("session-1");

describe("dialogueMiddleware", () => {
  it("DW1.1 a scripted reply is the model's response with no model call, named in the model header and provider metadata", async () => {
    const { inner, model } = setup();
    const result = await generateText({ model, prompt: "where is order 1234" });
    expect(result.text).toBe("Let me look up order 1234.");
    expect(inner.calls).toHaveLength(0);
    expect(result.response.headers?.[MODEL_HEADER]).toBe("dialogue/order-status");
    expect(result.providerMetadata?.[HARNESS]?.["dialogue"]).toEqual({ script: "order-status", kind: "reply", match: { by: "pattern" } });
    expect(result.usage.outputTokens).toBe(0);
  });

  it("DW1.2 streamed, a scripted reply is one text block", async () => {
    const { inner, model } = setup();
    const result = streamText({ model, prompt: "where is order 1234" });
    expect(await result.text).toBe("Let me look up order 1234.");
    expect((await result.response).headers?.[MODEL_HEADER]).toBe("dialogue/order-status");
    expect(inner.calls).toHaveLength(0);
  });

  it("DW1.3 a step no script answers goes to the model, and its reply, generated or streamed, is observed", async () => {
    const { inner, dialogue, model } = setup((call) => `Checking order ${/\d+/.exec(lastText(call.prompt))![0]}.`);
    expect((await generateText({ model, prompt: "where are order 12" })).text).toBe("Checking order 12.");
    expect(await streamText({ model, prompt: "where are order 34" }).text).toBe("Checking order 34.");
    await dialogue.idle();
    expect(inner.calls).toHaveLength(2);
    expect(dialogue.script("s1")).toMatchObject({ status: "candidate", reply: ["Checking order ", { slot: "slot_1" }, "."] });
  });

  it("DW1.4 a script with generated holes has the model write them under its template, in the step's session", async () => {
    const { inner, model } = setup(() => "Done: order 5 is cancelled.");
    await generateText({ model, prompt: "where is order 5", ...session });
    const result = await generateText({ model, prompt: "yes please", ...session });
    expect(result.text).toBe("Done: order 5 is cancelled.");
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]!.providerOptions?.[HARNESS]).toEqual({ session: "session-1", constraint: { type: "template", parts: ["Done: ", { hole: "summary" }, "."] } });
    expect(result.providerMetadata?.[HARNESS]?.["dialogue"]).toMatchObject({ script: "confirm-cancel", kind: "generate" });
    await generateText({ model, prompt: "where is order 5", ...session });
    const streamed = streamText({ model, prompt: "yes please", ...session });
    expect(await streamed.text).toBe("Done: order 5 is cancelled.");
    expect((await streamed.providerMetadata)?.[HARNESS]?.["dialogue"]).toMatchObject({ script: "confirm-cancel", kind: "generate" });
  });

  it("DW1.5 a form asks for a slot in one turn and completes the reply with the next, in the session", async () => {
    const { inner, model } = setup();
    expect((await generateText({ model, prompt: "book a table", ...session })).text).toBe("For what time?");
    const messages = [
      { role: "user" as const, content: "book a table" },
      { role: "assistant" as const, content: "For what time?" },
      { role: "user" as const, content: "7pm" },
    ];
    expect((await generateText({ model, messages, ...session })).text).toBe("Booked for 7pm.");
    expect(inner.calls).toHaveLength(0);
  });

  it("DW1.6 in a tool loop, the model decides the call and a result script reads the result back with no second model call", async () => {
    const { inner, dialogue, model } = setup((call) => (call.prompt.at(-1)?.role === "tool" ? "the model's read-back" : { tool: "track_order", input: { id: 1234 } }));
    const result = await generateText({
      model,
      prompt: "where is my order 1234 now?",
      tools: { track_order: tool({ inputSchema: z.object({ id: z.number() }), execute: async () => ({ status: "shipped", eta: { day: "Tuesday" } }) }) },
      stopWhen: stepCountIs(3),
    });
    expect(result.text).toBe("Order 1234 is shipped and arrives Tuesday.");
    expect(inner.calls).toHaveLength(1);
    await dialogue.idle();
    expect(dialogue.save()).toMatchObject({ clusters: [] });
  });

  it("DW1.7 calls that are not chat turns, and a dialogue that fails, go to the model", async () => {
    const { inner, model } = setup((call) => (call.toolChoice?.type === "required" ? { tool: "t", input: {} } : "the model's reply"));
    await generateText({ model, prompt: "where is order 1234", ...constrain({ type: "regex", pattern: "[a-z ]+" }) });
    await generateText({ model, prompt: "where is order 1234", tools: { t: tool({ inputSchema: z.object({}) }) }, toolChoice: "required" });
    expect(inner.calls).toHaveLength(2);
    class Failing extends Dialogue {
      override async respond(_step: Step): Promise<never> {
        throw new Error("dialogue broke");
      }
    }
    const failing = setup(undefined, new Failing({ settings, book }));
    expect((await generateText({ model: failing.model, prompt: "where is order 1234" })).text).toBe("the model's reply");
    expect((await streamText({ model: failing.model, prompt: "where is order 1234" }).text)).toBe("the model's reply");
  });

  it("DW1.8 streams where the model called tools, or failed, teach nothing", async () => {
    for (const say of [{ tool: "track_order", input: { id: 1 } }, { error: "overloaded" }] as const) {
      const { dialogue, model } = setup(() => say);
      for (const n of [1, 2]) {
        const { stream } = await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: `say something ${n}` }] }] });
        for await (const _ of stream as unknown as AsyncIterable<unknown>) void _;
      }
      await dialogue.idle();
      expect(dialogue.save()).toMatchObject({ clusters: [] });
    }
  });
});

describe("stepOf", () => {
  const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] });
  const call = { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "track_order", input: { id: 7 } }] };
  const result = (output: LanguageModelV4ToolResultOutput) => ({ role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "c1", toolName: "track_order", output }] });
  const options = (prompt: LanguageModelV4Prompt, more: Partial<LanguageModelV4CallOptions> = {}): LanguageModelV4CallOptions => ({ prompt, ...more });

  it("DW2.1 a prompt ending with the user's words is an utterance step, in the session its call names", () => {
    expect(stepOf(options([{ role: "system", content: "Be brief." }, user("hi there")], session))).toEqual({ sessionId: "session-1", utterance: "hi there" });
    expect(stepOf(options([user("hi"), { role: "assistant", content: [{ type: "text", text: "Hello." }] }, user("again")]))).toEqual({ utterance: "again" });
  });

  it("DW2.2 a prompt ending with one tool's result is a result step, with the call's input and the result's output", () => {
    expect(stepOf(options([user("track 7"), call, result({ type: "json", value: { status: "late" } })]))).toEqual({ utterance: "track 7", result: { tool: "track_order", input: { id: 7 }, output: { status: "late" } } });
    expect(stepOf(options([user("track 7"), call, result({ type: "text", value: "late" })]))).toMatchObject({ result: { output: "late" } });
  });

  it("DW2.3 anything else is not a step: constrained or forced calls, files, several or failed results, results without their call, or no words", () => {
    const image = { role: "user" as const, content: [{ type: "text" as const, text: "what is this" }, { type: "file" as const, data: { type: "data" as const, data: "AAAA" }, mediaType: "image/png" }] };
    const two = { role: "tool" as const, content: [result({ type: "json", value: 1 }).content[0]!, { ...result({ type: "json", value: 2 }).content[0]!, toolCallId: "c2" }] };
    for (const o of [
      options([user("hi")], constrain({ type: "regex", pattern: "x" })),
      options([user("hi")], { responseFormat: { type: "json" } }),
      options([user("hi")], { toolChoice: { type: "required" } }),
      options([user("hi")], { toolChoice: { type: "tool", toolName: "t" } }),
      options([image]),
      options([user("track 7"), call, two]),
      options([user("track 7"), call, result({ type: "error-text", value: "down" })]),
      options([user("track 7"), result({ type: "json", value: 1 })]),
      options([user("hi"), { role: "assistant", content: [{ type: "text", text: "Hello." }] }]),
      options([user("   ")]),
      options([call, result({ type: "json", value: 1 })]),
    ])
      expect(stepOf(o)).toBeUndefined();
  });
});
