import { ChatStreamParser, parseChatOutput } from "@harness/cognitive";
import type { ChatMessage, DocumentParser, GenerateRequest, GenerationEvent, Generator, ImageInput, ParsedPage, ParseRequest, ToolCall } from "@harness/cognitive";

/**
 * Clients for llama.cpp's llama-server (OpenAI-compatible /v1/chat/completions), which
 * serves the native-only models: Ornith (agentic coding and tools) and OvisOCR2
 * (documents). Start the server with --jinja so tool calls and reasoning come back
 * structured; raw <think>/<tool_call> text is parsed too, in case they do not.
 */
export interface LlamaServerOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** Model name to send; llama-server serves one model and may ignore it. */
  readonly model?: string;
}

function dataUrl(image: ImageInput): string {
  let binary = "";
  for (const b of image.data) binary += String.fromCharCode(b);
  return `data:${image.mediaType};base64,${btoa(binary)}`;
}

function toOpenAI(messages: readonly ChatMessage[]): Record<string, unknown>[] {
  let next = 0;
  const open: { id: string; name: string }[] = [];
  return messages.map((m) => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return {
          role: "user",
          content:
            typeof m.content === "string"
              ? m.content
              : m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: dataUrl(p.image) } })),
        };
      case "assistant": {
        const calls = (m.toolCalls ?? []).map((c) => {
          const id = `call_${next++}`;
          open.push({ id, name: c.name });
          return { id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } };
        });
        return { role: "assistant", content: m.content, ...(calls.length ? { tool_calls: calls } : {}) };
      }
      case "tool": {
        const i = open.findIndex((c) => c.name === m.name);
        const id = i >= 0 ? open.splice(i, 1)[0]!.id : `call_${next++}`;
        return { role: "tool", tool_call_id: id, content: m.content };
      }
    }
  });
}

async function post(options: LlamaServerOptions, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const url = `${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(options.model === undefined ? {} : { model: options.model }), ...body }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`llama-server ${response.status}: ${await response.text()}`);
  return response;
}

async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        yield JSON.parse(data) as Record<string, unknown>;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

interface Delta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: { index: number; function?: { name?: string; arguments?: string } }[];
}

export class LlamaServerGenerator implements Generator {
  readonly #options: LlamaServerOptions;

  constructor(options: LlamaServerOptions) {
    this.#options = options;
  }

  async *generate(request: GenerateRequest): AsyncIterable<GenerationEvent> {
    const controller = new AbortController();
    try {
      const response = await post(
        this.#options,
        {
          stream: true,
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
          messages: toOpenAI(request.messages),
          ...(request.tools?.length ? { tools: request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
        },
        controller.signal,
      );
      const parser = new ChatStreamParser();
      const streamed = new Map<number, { name: string; args: string }>();
      let finish: string | null = null;
      let calls = 0;
      for await (const chunk of sseEvents(response.body!)) {
        const choice = (chunk["choices"] as { delta?: Delta; finish_reason?: string | null }[] | undefined)?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (delta.reasoning_content) yield { type: "reasoning", text: delta.reasoning_content };
        if (delta.content) {
          for (const e of parser.push(delta.content)) {
            if (e.type === "tool-call") calls++;
            yield e;
          }
        }
        for (const t of delta.tool_calls ?? []) {
          const call = streamed.get(t.index) ?? { name: "", args: "" };
          call.name += t.function?.name ?? "";
          call.args += t.function?.arguments ?? "";
          streamed.set(t.index, call);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      for (const e of parser.end()) {
        if (e.type === "tool-call") calls++;
        yield e;
      }
      for (const [, c] of [...streamed].sort(([a], [b]) => a - b)) {
        const args = c.args.trim() === "" ? {} : (JSON.parse(c.args) as ToolCall["arguments"]);
        calls++;
        yield { type: "tool-call", call: { name: c.name, arguments: args } };
      }
      yield { type: "finish", reason: calls > 0 ? "tool-calls" : finish === "length" ? "length" : "stop" };
    } finally {
      controller.abort();
    }
  }
}

export class LlamaServerDocumentParser implements DocumentParser {
  readonly #options: LlamaServerOptions & { readonly instruction?: string; readonly maxTokens?: number };

  constructor(options: LlamaServerOptions & { readonly instruction?: string; readonly maxTokens?: number }) {
    this.#options = options;
  }

  async parse(request: ParseRequest): Promise<{ readonly pages: readonly ParsedPage[] }> {
    const instruction = request.instruction ?? this.#options.instruction ?? "Convert this page to Markdown.";
    const pages: ParsedPage[] = [];
    for (const page of request.pages) {
      const response = await post(this.#options, {
        stream: false,
        ...(this.#options.maxTokens === undefined ? {} : { max_tokens: this.#options.maxTokens }),
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl(page) } }, { type: "text", text: instruction }] }],
      });
      const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const raw = json.choices?.[0]?.message?.content ?? "";
      pages.push({ markdown: parseChatOutput(raw).text, raw });
    }
    return { pages };
  }
}
