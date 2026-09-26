import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { jsonResponseFormat } from "@harness/cognitive";

/**
 * llama.cpp's llama-server (OpenAI-compatible) as an AI SDK model. Start it with
 * --jinja. It enforces a JSON response format with a grammar, so it declares
 * structured outputs, and our JSON Schema constraint is sent as that format.
 */
export function llamaServer(options: { readonly baseUrl: string; readonly fetch?: typeof fetch; readonly model?: string }): LanguageModelV4 {
  const model = createOpenAICompatible({ name: "llama-server", baseURL: `${options.baseUrl.replace(/\/$/, "")}/v1`, supportsStructuredOutputs: true, ...(options.fetch ? { fetch: options.fetch } : {}) }).chatModel(options.model ?? "default");
  return wrapLanguageModel({ model, middleware: jsonResponseFormat });
}
