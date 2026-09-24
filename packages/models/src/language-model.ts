import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, streamText, tool } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { parseChatOutput } from "@harness/cognitive";
import type { ChatMessage, DocumentParser, GenerateRequest, GenerationEvent, Generator, ParsedPage, ParseRequest, ToolSpec } from "@harness/cognitive";

/**
 * Any AI SDK language model as a cognitive-core port. The AI SDK does the wire work
 * (HTTP, SSE, tool-call assembly, reasoning); this only maps our chat types onto it.
 */
function toModelMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  // Our tool results name their tool; the AI SDK pairs them with calls by id.
  let next = 0;
  const open: { id: string; name: string }[] = [];
  return messages.map((m): ModelMessage => {
    switch (m.role) {
      case "system":
        return m;
      case "user":
        return {
          role: "user",
          content: typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p : { type: "file", data: p.image.data, mediaType: p.image.mediaType })),
        };
      case "assistant": {
        const calls = (m.toolCalls ?? []).map((c) => {
          const toolCallId = `call_${next++}`;
          open.push({ id: toolCallId, name: c.name });
          return { type: "tool-call" as const, toolCallId, toolName: c.name, input: c.arguments };
        });
        return { role: "assistant", content: calls.length ? [...(m.content ? [{ type: "text" as const, text: m.content }] : []), ...calls] : m.content };
      }
      case "tool": {
        const i = open.findIndex((c) => c.name === m.name);
        const toolCallId = i >= 0 ? open.splice(i, 1)[0]!.id : `call_${next++}`;
        return { role: "tool", content: [{ type: "tool-result", toolCallId, toolName: m.name, output: { type: "text", value: m.content } }] };
      }
    }
  });
}

/** Tools the model may call; without `execute` the calls come back to us. */
const toolSet = (tools: readonly ToolSpec[]): ToolSet => Object.fromEntries(tools.map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema(t.parameters) })]));

export class LanguageModelGenerator implements Generator {
  readonly #model: LanguageModel;

  constructor(model: LanguageModel) {
    this.#model = model;
  }

  async *generate(request: GenerateRequest): AsyncIterable<GenerationEvent> {
    const abort = new AbortController();
    try {
      const result = streamText({
        model: this.#model,
        messages: toModelMessages(request.messages),
        abortSignal: abort.signal,
        maxRetries: 0,
        ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
        ...(request.tools?.length ? { tools: toolSet(request.tools) } : {}),
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") yield { type: "text", text: part.text };
        else if (part.type === "reasoning-delta") yield { type: "reasoning", text: part.text };
        else if (part.type === "tool-call") yield { type: "tool-call", call: { name: part.toolName, arguments: part.input as Record<string, unknown> } };
        else if (part.type === "error") throw part.error;
        else if (part.type === "finish") yield { type: "finish", reason: part.finishReason === "length" ? "length" : part.finishReason === "tool-calls" ? "tool-calls" : "stop" };
      }
    } finally {
      abort.abort();
    }
  }
}

export class LanguageModelDocumentParser implements DocumentParser {
  readonly #model: LanguageModel;
  readonly #options: { readonly instruction?: string; readonly maxTokens?: number };

  constructor(model: LanguageModel, options: { readonly instruction?: string; readonly maxTokens?: number } = {}) {
    this.#model = model;
    this.#options = options;
  }

  async parse(request: ParseRequest): Promise<{ readonly pages: readonly ParsedPage[] }> {
    const instruction = request.instruction ?? this.#options.instruction ?? "Convert this page to Markdown.";
    const pages: ParsedPage[] = [];
    for (const page of request.pages) {
      const { text } = await generateText({
        model: this.#model,
        maxRetries: 0,
        ...(this.#options.maxTokens === undefined ? {} : { maxOutputTokens: this.#options.maxTokens }),
        messages: [{ role: "user", content: [{ type: "file", data: page.data, mediaType: page.mediaType }, { type: "text", text: instruction }] }],
      });
      pages.push({ markdown: parseChatOutput(text).text, raw: text });
    }
    return { pages };
  }
}

/** llama.cpp's llama-server (OpenAI-compatible) as an AI SDK model. Start it with --jinja. */
export function llamaServer(options: { readonly baseUrl: string; readonly fetch?: typeof fetch; readonly model?: string }): LanguageModel {
  return createOpenAICompatible({ name: "llama-server", baseURL: `${options.baseUrl.replace(/\/$/, "")}/v1`, ...(options.fetch ? { fetch: options.fetch } : {}) }).chatModel(options.model ?? "default");
}
