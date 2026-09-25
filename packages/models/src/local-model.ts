/**
 * What every local model shares as an AI SDK `LanguageModelV4`: the call's prompt as
 * chat-template messages (images in placeholder order), its function tools, and the
 * decoder's parts as a stream (or collected into a generate result).
 */
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Middleware, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4ToolResultOutput } from "@ai-sdk/provider";
import { base64 } from "@scure/base";
import { collectParts } from "@harness/cognitive";
import type { ImageInput } from "@harness/cognitive";

export type TemplatePart = { readonly type: "text"; readonly text: string } | { readonly type: "image" };

export interface TemplateMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: readonly TemplatePart[];
  readonly name?: string;
  readonly tool_calls?: readonly { readonly type: "function"; readonly function: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> } }[];
}

/** A function tool as chat templates take it. */
export interface TemplateTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

function output(o: LanguageModelV4ToolResultOutput): string {
  switch (o.type) {
    case "text":
    case "error-text":
      return o.value;
    case "json":
    case "error-json":
      return JSON.stringify(o.value);
    case "execution-denied":
      return `denied${o.reason ? `: ${o.reason}` : ""}`;
    case "content":
      return o.value.map((p) => (p.type === "text" ? p.text : "")).join("");
  }
}

function image(part: { readonly mediaType: string; readonly data: { readonly type: string; readonly data?: Uint8Array | string } }): ImageInput {
  if (!part.mediaType.startsWith("image/")) throw new Error(`this model reads images, not ${part.mediaType}`);
  if (part.data.type !== "data" || part.data.data === undefined) throw new Error("this model needs image bytes, not a reference");
  return { mediaType: part.mediaType, data: typeof part.data.data === "string" ? base64.decode(part.data.data) : part.data.data };
}

/** A call's prompt as chat-template messages, with its images in placeholder order, and its function tools. */
export function templateOf(options: Pick<LanguageModelV4CallOptions, "prompt" | "tools">): { messages: TemplateMessage[]; images: ImageInput[]; tools: TemplateTool[] } {
  const images: ImageInput[] = [];
  const text = (t: string): TemplatePart[] => [{ type: "text", text: t }];
  const messages = options.prompt.flatMap((m): TemplateMessage[] => {
    switch (m.role) {
      case "system":
        return [{ role: "system", content: text(m.content) }];
      case "user":
        return [
          {
            role: "user",
            content: m.content.map((p): TemplatePart => {
              if (p.type === "text") return { type: "text", text: p.text };
              images.push(image(p));
              return { type: "image" };
            }),
          },
        ];
      case "assistant": {
        const calls = m.content.flatMap((p) => (p.type === "tool-call" ? [{ type: "function" as const, function: { name: p.toolName, arguments: (typeof p.input === "string" ? JSON.parse(p.input) : (p.input ?? {})) as Record<string, unknown> } }] : []));
        const said = m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
        return [{ role: "assistant", content: text(said), ...(calls.length ? { tool_calls: calls } : {}) }];
      }
      case "tool":
        return m.content.flatMap((p) => (p.type === "tool-result" ? [{ role: "tool" as const, name: p.toolName, content: text(output(p.output)) }] : []));
    }
  });
  const tools = (options.tools ?? []).flatMap((t) => (t.type === "function" ? [{ name: t.name, description: t.description ?? "", parameters: t.inputSchema as Record<string, unknown> }] : []));
  return { messages, images, tools };
}

/** A model whose decoder yields stream parts, as an AI SDK language model: streamed, or collected for generate. */
export function localLanguageModel(spec: {
  readonly provider: string;
  readonly modelId: string;
  /** The decoder's parts for one call; stopping the iteration (the consumer left, or the call was aborted) must stop decoding. */
  run(options: LanguageModelV4CallOptions): AsyncIterable<LanguageModelV4StreamPart>;
}): LanguageModelV4 {
  const drain = async (options: LanguageModelV4CallOptions) => {
    const parts: LanguageModelV4StreamPart[] = [];
    for await (const part of spec.run(options)) {
      // Leaving the loop stops the decoder.
      options.abortSignal?.throwIfAborted();
      parts.push(part);
    }
    return parts;
  };
  return {
    specificationVersion: "v4",
    provider: spec.provider,
    modelId: spec.modelId,
    // Image URLs are downloaded by the AI SDK: these models take bytes.
    supportedUrls: {},
    doGenerate: async (options) => collectParts(await drain(options)),
    doStream: async (options) => {
      // The decoder feeds the stream as it decodes rather than when the consumer reads:
      // the AI SDK neither cancels a stream its consumer stopped reading nor an aborted
      // call's, and a paused decoder would hold its model (a KV cache, a queue). It stops
      // early only when the stream is cancelled or the call aborted.
      let stopped = false;
      let finished: Promise<void> = Promise.resolve();
      const stop = () => {
        stopped = true;
        return finished;
      };
      options.abortSignal?.addEventListener("abort", () => void stop(), { once: true });
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            finished = (async () => {
              try {
                for await (const part of spec.run(options)) {
                  if (stopped) return;
                  controller.enqueue(part);
                }
                controller.close();
              } catch (error) {
                if (stopped) return;
                controller.enqueue({ type: "error", error });
                controller.close();
              }
            })();
          },
          cancel: stop,
        }),
      };
    },
  };
}

/**
 * The instruction a document-parsing model was trained with (catalog data), added to a
 * user message that sends a page image with no words of its own.
 */
export function pageInstruction(instruction: string): LanguageModelV4Middleware {
  const add = (prompt: LanguageModelV4Prompt): LanguageModelV4Prompt =>
    prompt.map((m) => (m.role === "user" && m.content.some((p) => p.type === "file") && !m.content.some((p) => p.type === "text" && p.text.trim() !== "") ? { ...m, content: [...m.content, { type: "text" as const, text: instruction }] } : m));
  return { specificationVersion: "v4", transformParams: async ({ params }) => ({ ...params, prompt: add(params.prompt) }) };
}
