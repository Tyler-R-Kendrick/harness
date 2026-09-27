import { describe, expect, it } from "vitest";
import { generateText, jsonSchema, Output, streamText, wrapLanguageModel } from "ai";
import type { TextStreamPart, ToolSet } from "ai";
import { llamaServer, pageInstruction } from "@harness/models";
import { constrain, logprobsIn, toolSet, withLogprobs } from "@harness/cognitive";
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

  it("LS1.7 a JSON Schema sent as our constraint becomes the server's structured output", async () => {
    const { f, requests } = server(() => [delta({ content: '{"n": 4}' }), delta({}, "stop")]);
    const schema = { type: "object", properties: { n: { type: "integer" } } };
    const result = streamText({ model: llamaServer({ baseUrl: "http://x", fetch: f }), prompt: "a number", ...constrain({ type: "json-schema", schema }), maxRetries: 0 });
    expect(await result.text).toBe('{"n": 4}');
    expect(requests[0]!.body["response_format"]).toMatchObject({ type: "json_schema", json_schema: { schema } });
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

  it("LS1.8 asked for token probabilities, the server is asked for its top log-probabilities, and they come back as harness provider metadata", async () => {
    const lp = (token: string, logprob: number, top: [string, number][]) => ({ token, logprob, bytes: [], top_logprobs: top.map(([t, l]) => ({ token: t, logprob: l, bytes: [] })) });
    const { f, requests } = server(() => ({
      id: "c1",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: '"A"' }, finish_reason: "stop", logprobs: { content: [lp('"', 0, [['"', 0]]), lp("A", -0.1, [["A", -0.1], ["B", -2.4]])] } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }));
    const model = llamaServer({ baseUrl: "http://x", fetch: f });
    const result = await generateText({ model, prompt: "?", ...withLogprobs(5), maxRetries: 0 });
    expect(requests[0]!.body).toMatchObject({ logprobs: true, top_logprobs: 5 });
    // under the provider's current options key, so the AI SDK warns of nothing
    expect(result.warnings).toEqual([]);
    expect(logprobsIn(result.providerMetadata)).toEqual([
      { token: '"', logprob: 0, top: [{ token: '"', logprob: 0 }] },
      { token: "A", logprob: -0.1, top: [{ token: "A", logprob: -0.1 }, { token: "B", logprob: -2.4 }] },
    ]);
    // not asked, not requested, and nothing reported
    const plain = await generateText({ model, prompt: "?", maxRetries: 0 });
    expect(requests[1]!.body["logprobs"]).toBeUndefined();
    expect(requests[1]!.body["top_logprobs"]).toBeUndefined();
    expect(logprobsIn(plain.providerMetadata)).toEqual([
      { token: '"', logprob: 0, top: [{ token: '"', logprob: 0 }] },
      { token: "A", logprob: -0.1, top: [{ token: "A", logprob: -0.1 }, { token: "B", logprob: -2.4 }] },
    ]);
  });

  it("LS1.9 streamed, each chunk's token probabilities are gathered and reported when the stream finishes", async () => {
    const withLp = (content: string, token: string, logprob: number, finish: string | null = null): Chunk => ({ id: "c1", choices: [{ index: 0, delta: { content }, finish_reason: finish, logprobs: { content: [{ token, logprob, top_logprobs: [{ token, logprob }] }] } }] });
    const { f } = server(() => [withLp("Ye", "Ye", -0.5), withLp("s", "s", -0.01), delta({}, "stop")]);
    const result = streamText({ model: llamaServer({ baseUrl: "http://x", fetch: f }), prompt: "?", ...withLogprobs(1), maxRetries: 0 });
    expect(await result.text).toBe("Yes");
    expect(logprobsIn(await result.providerMetadata)).toEqual([
      { token: "Ye", logprob: -0.5, top: [{ token: "Ye", logprob: -0.5 }] },
      { token: "s", logprob: -0.01, top: [{ token: "s", logprob: -0.01 }] },
    ]);
    const { f: bare } = server(() => [delta({ content: "x" }), delta({}, "stop")]);
    const none = streamText({ model: llamaServer({ baseUrl: "http://x", fetch: bare }), prompt: "?", maxRetries: 0 });
    await none.consumeStream();
    expect(logprobsIn(await none.providerMetadata)).toBeUndefined();
  });

  it("LS1.10 a model's chat template options go with every request", async () => {
    const { f, requests } = server(() => [delta({ content: "Paris" }), delta({}, "stop")]);
    const model = llamaServer({ baseUrl: "http://x", fetch: f, template: { enable_thinking: false } });
    expect(await streamText({ model, prompt: "?", maxRetries: 0 }).text).toBe("Paris");
    await generateText({ model, prompt: "?", ...withLogprobs(3), maxRetries: 0 }).catch(() => undefined);
    expect(requests.map((r) => r.body["chat_template_kwargs"])).toEqual([{ enable_thinking: false }, { enable_thinking: false }]);
    expect(requests[1]!.body).toMatchObject({ logprobs: true, top_logprobs: 3 });
    // without options, none is sent
    await streamText({ model: llamaServer({ baseUrl: "http://x", fetch: f }), prompt: "?", maxRetries: 0 }).consumeStream();
    expect(requests[2]!.body["chat_template_kwargs"]).toBeUndefined();
  });
});
