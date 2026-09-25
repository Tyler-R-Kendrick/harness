import { describe, expect, it } from "vitest";
import { generateText, jsonSchema, Output, streamText, wrapLanguageModel } from "ai";
import type { TextStreamPart, ToolSet } from "ai";
import { llamaServer, pageInstruction } from "@harness/models";
import { constrain, toolSet } from "@harness/cognitive";
import { generatorContract } from "@harness/testkit";

type Chunk = Record<string, unknown>;
const delta = (d: Record<string, unknown>, finish: string | null = null): Chunk => ({ id: "chatcmpl-1", choices: [{ index: 0, delta: d, finish_reason: finish }] });

/** A llama-server stand-in: records requests and streams OpenAI-style SSE chunks. */
function server(chunks: (body: Record<string, unknown>) => Chunk[] | Record<string, unknown>, status = 200) {
  const requests: { url: string; body: Record<string, unknown>; signal: AbortSignal | undefined }[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(url), body, signal: init?.signal ?? undefined });
    if (status !== 200) return Response.json({ error: { code: status, message: "Loading model", type: "unavailable_error" } }, { status });
    const out = chunks(body);
    if (!Array.isArray(out)) return Response.json(out);
    const text = out.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(text);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  return { f: f as typeof fetch, requests };
}

/** The parts of a stream a consumer reads, without the lifecycle parts. */
async function parts(stream: AsyncIterable<TextStreamPart<ToolSet>>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const p of stream) {
    if (p.type === "text-delta" || p.type === "reasoning-delta") out.push({ type: p.type, text: p.text });
    else if (p.type === "tool-call") out.push({ type: p.type, toolName: p.toolName, input: p.input });
    else if (p.type === "finish") out.push({ type: p.type, finishReason: p.finishReason });
  }
  return out;
}

const weather = { name: "get_weather", description: "Weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const timer = { name: "set_timer", description: "Start a timer.", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } };

describe("llama-server as an AI SDK language model", () => {
  it("LS1.1 posts an OpenAI chat request with tools and streams text, reasoning and the finish reason", async () => {
    const { f, requests } = server(() => [delta({ reasoning_content: "think" }), delta({ content: "Hel" }), delta({ content: "lo" }), delta({}, "stop")]);
    const result = streamText({ model: llamaServer({ baseUrl: "http://127.0.0.1:8080/", fetch: f, model: "local-model" }), prompt: "hi", tools: toolSet([{ name: "t", description: "d", parameters: { type: "object" } }]), maxOutputTokens: 50, maxRetries: 0 });
    expect(await parts(result.fullStream)).toEqual([
      { type: "reasoning-delta", text: "think" },
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      { type: "finish", finishReason: "stop" },
    ]);
    expect(requests[0]!.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    // the model id is the server's default unless one is named
    expect(llamaServer({ baseUrl: "http://127.0.0.1:8080" }).modelId).toBe("default");
    expect(requests[0]!.body).toMatchObject({
      model: "local-model",
      stream: true,
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }],
    });
  });

  it("LS1.5 a JSON Schema constraint is sent as the server's structured output", async () => {
    const { f, requests } = server(() => [delta({ content: '{"n": 4}' }), delta({}, "stop")]);
    const model = llamaServer({ baseUrl: "http://127.0.0.1:8080", fetch: f });
    const result = streamText({ model, prompt: "a number", output: Output.object({ schema: jsonSchema<{ n: number }>({ type: "object", properties: { n: { type: "integer" } } }) }), maxRetries: 0 });
    expect(await result.output).toEqual({ n: 4 });
    expect(requests[0]!.body["response_format"]).toMatchObject({ type: "json_schema", json_schema: { schema: { type: "object", properties: { n: { type: "integer" } } } } });
    // our other kinds of constraint travel as harness provider options, which this provider does not send
    await streamText({ model, prompt: "x", ...constrain({ type: "regex", pattern: "a" }), maxRetries: 0 }).consumeStream();
    expect(requests[1]!.body["response_format"]).toBeUndefined();
    expect(JSON.stringify(requests[1]!.body)).not.toContain("regex");
  });

  it("LS1.2 tool calls streamed in pieces are assembled and emitted before the finish", async () => {
    const { f } = server(() => [
      delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"Lagos"}' } }] }),
      delta({ tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "set_timer", arguments: '{"minutes":5}' } }] }),
      delta({}, "tool_calls"),
    ]);
    const result = streamText({ model: llamaServer({ baseUrl: "http://x", fetch: f }), prompt: "both", tools: toolSet([weather, timer]), maxRetries: 0 });
    expect(await parts(result.fullStream)).toEqual([
      { type: "tool-call", toolName: "get_weather", input: { city: "Lagos" } },
      { type: "tool-call", toolName: "set_timer", input: { minutes: 5 } },
      { type: "finish", finishReason: "tool-calls" },
    ]);
  });

  it("LS1.4 images become data URLs and assistant tool calls and tool results use the OpenAI shape", async () => {
    const { f, requests } = server(() => [delta({ content: "ok" }), delta({}, "length")]);
    const result = streamText({
      model: llamaServer({ baseUrl: "http://x", fetch: f }),
      maxRetries: 0,
      messages: [
        { role: "user", content: [{ type: "text", text: "see" }, { type: "image", image: new Uint8Array([104, 105]), mediaType: "image/png" }] },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_0", toolName: "t", input: { a: 1 } }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "call_0", toolName: "t", output: { type: "text", value: "done" } }] },
      ],
    });
    expect(await result.finishReason).toBe("length");
    expect(requests[0]!.body["messages"]).toMatchObject([
      { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }] },
      { role: "assistant", tool_calls: [{ id: "call_0", type: "function", function: { name: "t", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "call_0", content: "done" },
    ]);
  });

  it("LS1.3 an HTTP error carries the server's message", async () => {
    const { f } = server(() => [], 503);
    await expect(generateText({ model: llamaServer({ baseUrl: "http://x", fetch: f }), prompt: "x", maxRetries: 0 })).rejects.toThrow(/Loading model/);
  });

  it("LS1.6 aborting the call aborts the request", async () => {
    const { f, requests } = server(() => [delta({ content: "a" }), delta({ content: "b" }), delta({}, "stop")]);
    const abort = new AbortController();
    const result = streamText({ model: llamaServer({ baseUrl: "http://x", fetch: f }), prompt: "x", abortSignal: abort.signal, maxRetries: 0 });
    for await (const _ of result.textStream) break;
    abort.abort();
    expect(requests[0]!.signal?.aborted).toBe(true);
  });
});

generatorContract("llama-server over a fake server", () => {
  const { f } = server((body) =>
    body["tools"] ? [delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Lagos"}' } }] }), delta({}, "tool_calls")] : [delta({ content: "Paris" }), delta({}, "stop")],
  );
  return llamaServer({ baseUrl: "http://x", fetch: f });
});

describe("llama-server as a document parser", () => {
  it("LD1.1 sends a page image with the catalog's instruction and returns the Markdown", async () => {
    const { f, requests } = server(() => ({ id: "chatcmpl-1", choices: [{ index: 0, message: { role: "assistant", content: "| a | b |\n|---|---|" }, finish_reason: "stop" }] }));
    const model = wrapLanguageModel({ model: llamaServer({ baseUrl: "http://x", fetch: f }), middleware: pageInstruction("Convert the page to Markdown.") });
    const { text } = await generateText({ model, maxRetries: 0, messages: [{ role: "user", content: [{ type: "file", data: new Uint8Array([1]), mediaType: "image/jpeg" }] }] });
    expect(text).toBe("| a | b |\n|---|---|");
    expect(requests[0]!.body).toMatchObject({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AQ==" } }, { type: "text", text: "Convert the page to Markdown." }] }],
    });
  });
});
