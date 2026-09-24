import { describe, expect, it } from "vitest";
import { LlamaServerDocumentParser, LlamaServerGenerator } from "@harness/models";
import type { GenerationEvent } from "@harness/cognitive";
import { generatorContract } from "@harness/testkit";

async function collect(stream: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

type Chunk = Record<string, unknown>;
const delta = (d: Record<string, unknown>, finish: string | null = null): Chunk => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

/** A llama-server stand-in: records requests and streams OpenAI-style SSE chunks. */
function server(chunks: (body: Record<string, unknown>) => Chunk[] | Record<string, unknown>, status = 200) {
  const requests: { url: string; body: Record<string, unknown>; signal: AbortSignal | undefined }[] = [];
  const f = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(url), body, signal: init?.signal ?? undefined });
    if (status !== 200) return new Response("model not loaded", { status });
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

describe("llama-server generator (Ornith)", () => {
  it("LS1.1 posts an OpenAI chat request with tools and streams text, reasoning and the finish reason", async () => {
    const { f, requests } = server(() => [delta({ reasoning_content: "think" }), delta({ content: "Hel" }), delta({ content: "lo" }), delta({}, "stop")]);
    const g = new LlamaServerGenerator({ baseUrl: "http://127.0.0.1:8080", fetch: f, model: "ornith" });
    const events = await collect(g.generate({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "t", description: "d", parameters: { type: "object" } }], maxTokens: 50 }));
    expect(requests[0]!.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    expect(requests[0]!.body).toEqual({
      model: "ornith",
      stream: true,
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }],
    });
    expect(events).toEqual([
      { type: "reasoning", text: "think" },
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("LS1.2 tool calls streamed in pieces are assembled and emitted before the finish", async () => {
    const { f } = server(() => [
      delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"Lagos"}' } }] }),
      delta({ tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "set_timer", arguments: '{"minutes":5}' } }] }),
      delta({}, "tool_calls"),
    ]);
    const events = await collect(new LlamaServerGenerator({ baseUrl: "http://x", fetch: f }).generate({ messages: [{ role: "user", content: "both" }] }));
    expect(events).toEqual([
      { type: "tool-call", call: { name: "get_weather", arguments: { city: "Lagos" } } },
      { type: "tool-call", call: { name: "set_timer", arguments: { minutes: 5 } } },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  it("LS1.3 unparsed <think> and <tool_call> text from the server is still parsed", async () => {
    const { f } = server(() => [delta({ content: "<think>x</think>ok<tool_call>{\"name\":\"t\",\"arguments\":{}}</tool_call>" }), delta({}, "stop")]);
    const events = await collect(new LlamaServerGenerator({ baseUrl: "http://x", fetch: f }).generate({ messages: [{ role: "user", content: "go" }] }));
    expect(events).toEqual([
      { type: "reasoning", text: "x" },
      { type: "text", text: "ok" },
      { type: "tool-call", call: { name: "t", arguments: {} } },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  it("LS1.4 images become data URLs and assistant tool calls and tool results use the OpenAI shape", async () => {
    const { f, requests } = server(() => [delta({ content: "ok" }), delta({}, "length")]);
    const events = await collect(
      new LlamaServerGenerator({ baseUrl: "http://x", fetch: f }).generate({
        messages: [
          { role: "user", content: [{ type: "text", text: "see" }, { type: "image", image: { mediaType: "image/png", data: new Uint8Array([104, 105]) } }] },
          { role: "assistant", content: "", toolCalls: [{ name: "t", arguments: { a: 1 } }] },
          { role: "tool", name: "t", content: "done" },
        ],
      }),
    );
    expect(requests[0]!.body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }] },
      { role: "assistant", content: "", tool_calls: [{ id: "call_0", type: "function", function: { name: "t", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "call_0", content: "done" },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "length" });
  });

  it("LS1.5 an HTTP error is an error naming the status and body", async () => {
    const { f } = server(() => [], 503);
    await expect(collect(new LlamaServerGenerator({ baseUrl: "http://x", fetch: f }).generate({ messages: [{ role: "user", content: "x" }] }))).rejects.toThrow(/503.*model not loaded/);
  });

  it("LS1.6 breaking out of the stream aborts the request", async () => {
    const { f, requests } = server(() => [delta({ content: "a" }), delta({ content: "b" }), delta({}, "stop")]);
    for await (const _ of new LlamaServerGenerator({ baseUrl: "http://x", fetch: f }).generate({ messages: [{ role: "user", content: "x" }] })) break;
    expect(requests[0]!.signal?.aborted).toBe(true);
  });
});

generatorContract("llama-server generator over a fake server", () => {
  const { f } = server((body) =>
    body["tools"] ? [delta({ tool_calls: [{ index: 0, function: { name: "get_weather", arguments: '{"city":"Lagos"}' } }] }), delta({}, "tool_calls")] : [delta({ content: "Paris" }), delta({}, "stop")],
  );
  return new LlamaServerGenerator({ baseUrl: "http://x", fetch: f });
});

describe("llama-server document parser (OvisOCR2)", () => {
  it("LD1.1 sends each page image with the instruction and returns the Markdown", async () => {
    const { f, requests } = server(() => ({ choices: [{ message: { content: "| a | b |\n|---|---|" } }] }));
    const parser = new LlamaServerDocumentParser({ baseUrl: "http://x", fetch: f, instruction: "Convert the page to Markdown." });
    const result = await parser.parse({ pages: [{ mediaType: "image/jpeg", data: new Uint8Array([1]) }] });
    expect(result.pages).toEqual([{ markdown: "| a | b |\n|---|---|", raw: "| a | b |\n|---|---|" }]);
    expect(requests[0]!.body).toMatchObject({
      stream: false,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AQ==" } }, { type: "text", text: "Convert the page to Markdown." }] }],
    });
  });
});
