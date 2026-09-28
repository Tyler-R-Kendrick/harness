import { describe, expect, it } from "vitest";
import { generateText, jsonSchema, streamText, tool } from "ai";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { parseReply, REPLY_SCHEMA, sampleLanguageModel, sampleTurns } from "../src/sample-model.ts";
import type { Sample, SampleCallOptions, SampleInput } from "../src/sample-model.ts";

/** A `sample` that answers each call with the next scripted reply, streamed in a few pieces, and records what it was asked. */
function scripted(...replies: (string | { code: string; message: string; text?: string })[]) {
  const calls: { input: SampleInput; options: SampleCallOptions | undefined }[] = [];
  const sample: Sample = async (input, options) => {
    calls.push({ input, options });
    const reply = replies.shift() ?? "{}";
    if (typeof reply !== "string") throw reply;
    let text = "";
    for (let i = 0; i < reply.length; i += 7) {
      const delta = reply.slice(i, i + 7);
      text += delta;
      options?.onText?.({ text, delta });
    }
    return { text: reply, truncated: false };
  };
  return { sample, calls };
}

const call = (prompt: LanguageModelV4CallOptions["prompt"], extra: Partial<LanguageModelV4CallOptions> = {}): LanguageModelV4CallOptions => ({ prompt, ...extra });

describe("the model behind the playground: Claude through the artifact's sample capability", () => {
  it("SM1.1 a reply's text becomes the answer, and nothing is called", async () => {
    const { sample } = scripted('{"text": "Hello there.", "toolCalls": []}');
    const result = await generateText({ model: sampleLanguageModel(sample), prompt: "hi" });
    expect(result.text).toBe("Hello there.");
    expect(result.finishReason).toBe("stop");
  });

  it("SM1.2 a reply's tool calls become AI SDK tool calls, and their results go back on the next call", async () => {
    const { sample, calls } = scripted('{"text": "Looking.", "toolCalls": [{"toolName": "bash", "input": {"command": "ls"}}]}', '{"text": "Two files.", "toolCalls": []}');
    const bash = tool({ description: "Run a command", inputSchema: jsonSchema<{ command: string }>({ type: "object", properties: { command: { type: "string" } }, required: ["command"] }), execute: async ({ command }) => `ran ${command}` });
    const result = await generateText({ model: sampleLanguageModel(sample), prompt: "what is here?", tools: { bash }, stopWhen: () => false });
    expect(result.steps[0]?.toolCalls.map((c) => [c.toolName, c.input])).toEqual([["bash", { command: "ls" }]]);
    expect(result.text).toBe("Two files.");
    const second = calls[1]!.input as { role: string; content: string }[];
    expect(second.at(-1)).toEqual({ role: "user", content: expect.stringContaining("ran ls") });
  });

  it("SM1.3 text streams as it is written: the text field of the partial JSON reply grows delta by delta", async () => {
    const { sample } = scripted('{"text": "one two three four five six", "toolCalls": []}');
    const result = streamText({ model: sampleLanguageModel(sample), prompt: "count" });
    const deltas: string[] = [];
    for await (const d of result.textStream) deltas.push(d);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("one two three four five six");
  });

  it("SM1.4 a failed sample (a plain {code, message} object) fails the call with an Error naming the code", async () => {
    const { sample } = scripted({ code: "not_granted", message: "the viewer said no" });
    await expect(generateText({ model: sampleLanguageModel(sample), prompt: "hi", maxRetries: 0 })).rejects.toThrow(/not_granted: the viewer said no/);
  });

  it("SM1.5 every call asks fresh (no cache), with the tier asked for now and the call's abort signal", async () => {
    let tier: "quick" | "default" = "quick";
    const { sample, calls } = scripted('{"text": "a"}', '{"text": "b"}');
    const model = sampleLanguageModel(sample, { tier: () => tier });
    const abort = new AbortController();
    await generateText({ model, prompt: "one", abortSignal: abort.signal });
    tier = "default";
    await generateText({ model, prompt: "two" });
    expect(calls.map((c) => [c.options?.modelTier, c.options?.cache])).toEqual([
      ["quick", false],
      ["default", false],
    ]);
    expect(calls[0]!.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("SM1.4b a thrown Error passes through as it is; anything else becomes an Error", async () => {
    const thrown = (e: unknown): Sample => async () => {
      throw e;
    };
    await expect(generateText({ model: sampleLanguageModel(thrown(new Error("plain")), {}), prompt: "hi", maxRetries: 0 })).rejects.toThrow("plain");
    await expect(generateText({ model: sampleLanguageModel(thrown("odd"), {}), prompt: "hi", maxRetries: 0 })).rejects.toThrow("odd");
  });

  it("SM1.7 a reply that is not JSON streams whole, as plain text, when it ends", async () => {
    const { sample } = scripted("Just words, no JSON.");
    const deltas: string[] = [];
    for await (const d of streamText({ model: sampleLanguageModel(sample), prompt: "hi" }).textStream) deltas.push(d);
    expect(deltas).toEqual(["Just words, no JSON."]);
  });

  it("SM1.8 a reply of tool calls alone has no text block", async () => {
    const { sample } = scripted('{"text": "", "toolCalls": [{"toolName": "t", "input": {}}]}');
    const result = await generateText({ model: sampleLanguageModel(sample), prompt: "go", tools: { t: tool({ inputSchema: jsonSchema<object>({ type: "object" }) }) } });
    expect(result.content.map((c) => c.type)).toEqual(["tool-call"]);
  });

  it("SM1.9 a failure in a streamed call arrives as the stream's error", async () => {
    const { sample } = scripted({ code: "rate_limited", message: "slow down" });
    const errors: unknown[] = [];
    await streamText({ model: sampleLanguageModel(sample), prompt: "hi", maxRetries: 0, onError: ({ error }) => void errors.push(error) }).consumeStream();
    expect(String(errors[0])).toMatch(/rate_limited: slow down/);
  });

  it("SM1.6 a reply cut short by the length limit finishes as length", async () => {
    const sample: Sample = async (_input, options) => {
      options?.onText?.({ text: '{"text": "partial', delta: '{"text": "partial' });
      return { text: '{"text": "partial', truncated: true };
    };
    const result = await generateText({ model: sampleLanguageModel(sample), prompt: "long" });
    expect(result.finishReason).toBe("length");
    expect(result.text).toBe("partial");
  });
});

describe("what a reply becomes", () => {
  it("SM1.10 tool-call ids never repeat, across models too (a page reloaded onto a kept conversation starts a new model)", async () => {
    const reply = '{"text": "", "toolCalls": [{"toolName": "t", "input": {}}, {"toolName": "t", "input": {}}]}';
    const ids: string[] = [];
    for (const model of [sampleLanguageModel(scripted(reply).sample), sampleLanguageModel(scripted(reply).sample)]) {
      ids.push(...(await generateText({ model, prompt: "go", tools: { t: tool({ inputSchema: jsonSchema<object>({ type: "object" }) }) } })).toolCalls.map((c) => c.toolCallId));
    }
    expect(new Set(ids).size).toBe(4);
  });

  it("SM1.11 the final text is the answer even when it does not continue what streamed", async () => {
    const sample: Sample = async (_input, options) => {
      options?.onText?.({ text: '{"text": "draft', delta: '{"text": "draft' });
      return { text: '{"text": "final"}', truncated: false };
    };
    const texts: string[] = [];
    const result = streamText({ model: sampleLanguageModel(sample), prompt: "hi" });
    for await (const part of result.fullStream) if (part.type === "text-end") texts.push(part.id);
    expect(await result.text).toMatch(/final$/);
    expect(texts).toHaveLength(2);
  });

  it("SM1.12 a reply cut short reads as the text written so far, streamed or not", async () => {
    const sample: Sample = async () => ({ text: '{"text": "partial ans', truncated: true });
    const result = await generateText({ model: sampleLanguageModel(sample), prompt: "long" });
    expect(result.text).toBe("partial ans");
    expect(result.finishReason).toBe("length");
  });

  it("SM1.13 the model is named by its runtime, not a model", () => {
    expect(sampleLanguageModel(scripted().sample)).toMatchObject({ provider: "claude.sample", modelId: "sample" });
  });
});

describe("the sample input a call becomes", () => {
  it("SM2.1 instructions, tools and the reply format lead as a user turn; the conversation follows and ends on a user turn", () => {
    const turns = sampleTurns(
      call(
        [
          { role: "system", content: "You work in a shell." },
          { role: "user", content: [{ type: "text", text: "list files" }] },
        ],
        { tools: [{ type: "function", name: "bash", description: "Run a command", inputSchema: { type: "object", properties: { command: { type: "string" } } } }] },
      ),
    );
    expect(turns[0]!.role).toBe("user");
    expect(turns[0]!.content).toContain("You work in a shell.");
    expect(turns[0]!.content).toContain("bash: Run a command");
    expect(turns[0]!.content).toContain('"command"');
    expect(turns[0]!.content).toContain('"toolCalls"');
    expect(turns.at(-1)).toEqual({ role: "user", content: "list files" });
  });

  it("SM2.2 an earlier assistant turn is shown in the reply format, and tool results (denials too) as a user turn", () => {
    const turns = sampleTurns(
      call([
        { role: "user", content: [{ type: "text", text: "go" }] },
        { role: "assistant", content: [{ type: "text", text: "Running." }, { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "rm x" } }] },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "execution-denied", reason: "no" } },
            { type: "tool-result", toolCallId: "c2", toolName: "readFile", output: { type: "json", value: { content: "hi" } } },
            { type: "tool-result", toolCallId: "c3", toolName: "bash", output: { type: "error-text", value: "boom" } },
            { type: "tool-result", toolCallId: "c4", toolName: "bash", output: { type: "text", value: "plain" } },
            { type: "tool-result", toolCallId: "c5", toolName: "bash", output: { type: "error-json", value: { e: 1 } } },
            { type: "tool-result", toolCallId: "c6", toolName: "bash", output: { type: "content", value: [{ type: "text", text: "parts" }, { type: "file", mediaType: "image/png", data: { type: "data", data: new Uint8Array([1]) } }] } },
            { type: "tool-result", toolCallId: "c7", toolName: "bash", output: { type: "execution-denied" } },
            { type: "tool-approval-response", approvalId: "a1", approved: false },
          ],
        },
      ]),
    );
    expect(JSON.parse(turns[2]!.content)).toEqual({ text: "Running.", toolCalls: [{ toolName: "bash", input: { command: "rm x" } }] });
    const results = turns[3]!;
    expect(results.role).toBe("user");
    for (const s of ["denied by the person: no", '{"content":"hi"}', "error: boom", "plain", 'error: {"e":1}', "parts[file]", "(c7): denied by the person"]) expect(results.content).toContain(s);
    expect(results.content.endsWith("(c7): denied by the person")).toBe(true);
    expect(results.content.split("\n")).toHaveLength(8);
  });

  it("SM2.3 a conversation ending on the assistant gets a closing user turn; files are named, not sent", () => {
    const turns = sampleTurns(
      call([
        { role: "user", content: [{ type: "file", mediaType: "image/png", data: { type: "data", data: new Uint8Array([1]) } }] },
        { role: "assistant", content: [{ type: "text", text: "An image." }] },
      ]),
    );
    expect(turns[1]).toEqual({ role: "user", content: "[a image/png file]" });
    expect(turns.at(-1)).toEqual({ role: "user", content: "Continue." });
  });

  it("SM2.4 a call that wants JSON says so, with its schema, in the leading turn", () => {
    const turns = sampleTurns(call([{ role: "user", content: [{ type: "text", text: "x" }] }], { responseFormat: { type: "json", schema: { type: "object", properties: { n: { type: "integer" } } } } }));
    expect(turns[0]!.content).toMatch(/"text" must itself be JSON/);
    expect(turns[0]!.content).toContain('"integer"');
  });

  it("SM2.4b JSON without a schema is asked for plainly; provider tools are left out; a tool without a description is listed bare", () => {
    const turns = sampleTurns(
      call([{ role: "user", content: [{ type: "text", text: "x" }] }], {
        responseFormat: { type: "json" },
        tools: [
          { type: "function", name: "plain", inputSchema: { type: "object" } },
          { type: "provider", id: "p.search", name: "search", args: {} },
        ],
      }),
    );
    expect(turns[0]!.content).toContain('The value of "text" must itself be JSON.');
    expect(turns[0]!.content).toContain("- plain: \n");
    expect(turns[0]!.content).not.toContain("search");
  });

  it("SM2.6 the reply's shape is sent as its JSON Schema", () => {
    const turns = sampleTurns(call([{ role: "user", content: [{ type: "text", text: "x" }] }]));
    expect(turns[0]!.content).toContain(JSON.stringify(REPLY_SCHEMA));
    expect(REPLY_SCHEMA).toMatchObject({ type: "object", required: ["text", "toolCalls"] });
  });

  it("SM2.5 a call with no tools says there are none", () => {
    const turns = sampleTurns(call([{ role: "user", content: [{ type: "text", text: "x" }] }]));
    expect(turns[0]!.content).toContain("You have no tools");
  });
});

describe("reading a reply", () => {
  it("SM3.1 a reply is read tolerantly: bare JSON, a fenced block, or the object inside a sentence", () => {
    expect(parseReply('{"text": "a"}')).toEqual({ text: "a", toolCalls: [] });
    expect(parseReply('```json\n{"text": "b", "toolCalls": []}\n```')).toEqual({ text: "b", toolCalls: [] });
    expect(parseReply('Sure: {"text": "c"} done')).toEqual({ text: "c", toolCalls: [] });
  });

  it("SM3.2 a reply that is not the format is taken as plain text", () => {
    expect(parseReply("just words")).toEqual({ text: "just words", toolCalls: [] });
    expect(parseReply('{"text": 3}')).toEqual({ text: '{"text": 3}', toolCalls: [] });
  });

  it("SM3.3 malformed tool calls are dropped; a missing input is an empty object", () => {
    expect(parseReply('{"text": "", "toolCalls": [{"toolName": "a"}, {"input": {}}, 3, {"toolName": "b", "input": {"x": 1}}]}')).toEqual({
      text: "",
      toolCalls: [
        { toolName: "a", input: {} },
        { toolName: "b", input: { x: 1 } },
      ],
    });
  });
});
