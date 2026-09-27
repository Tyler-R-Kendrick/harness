import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible";
import type { MetadataExtractor } from "@ai-sdk/openai-compatible";
import type { JSONValue, LanguageModelV4, LanguageModelV4Middleware, SharedV4ProviderMetadata } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { HARNESS, jsonResponseFormat, logprobsOf } from "@harness/cognitive";
import type { TokenLogprob } from "@harness/cognitive";

const PROVIDER = "llama-server";
/** Where the provider reads its own options: its name in camelCase (the AI SDK deprecates the raw name). */
const OPTIONS = "llamaServer";

/** OpenAI's shape for a choice's token log-probabilities, which llama-server returns. */
type OpenAiLogprobs = { readonly content?: readonly { readonly token: string; readonly logprob: number; readonly top_logprobs?: readonly { readonly token: string; readonly logprob: number }[] }[] } | null | undefined;

const tokens = (choice: unknown): TokenLogprob[] =>
  ((choice as { logprobs?: OpenAiLogprobs } | undefined)?.logprobs?.content ?? []).map((c) => ({ token: c.token, logprob: c.logprob, top: (c.top_logprobs ?? []).map((t) => ({ token: t.token, logprob: t.logprob })) }));
const firstChoice = (body: unknown): unknown => (body as { choices?: readonly unknown[] } | undefined)?.choices?.[0];
// Token log-probabilities are JSON (a JSONValue's type is only looser than the interface).
const reported = (all: TokenLogprob[]): SharedV4ProviderMetadata | undefined => (all.length === 0 ? undefined : { [HARNESS]: { logprobs: all as unknown as JSONValue } });

/** The token log-probabilities the server returns, as our provider metadata (`harness.logprobs`). */
const logprobsMetadata: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => reported(tokens(firstChoice(parsedBody))),
  createStreamExtractor: () => {
    const all: TokenLogprob[] = [];
    return {
      processChunk: (chunk) => void all.push(...tokens(firstChoice(chunk))),
      buildMetadata: () => reported(all),
    };
  },
};

/** A call asking for token probabilities (our `harness.logprobs`) asks the server for its top log-probabilities. */
const logprobsRequest: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => {
    const top = logprobsOf(params.providerOptions);
    if (top === undefined) return params;
    return { ...params, providerOptions: { ...params.providerOptions, [OPTIONS]: { ...params.providerOptions?.[OPTIONS], logprobs: true, top_logprobs: top } } };
  },
};

/** Chat template options (a model's, from its catalog entry) go with every request. */
const templateOptions = (template: Readonly<Record<string, unknown>>): LanguageModelV4Middleware => ({
  specificationVersion: "v4",
  transformParams: async ({ params }) => ({ ...params, providerOptions: { ...params.providerOptions, [OPTIONS]: { ...params.providerOptions?.[OPTIONS], chat_template_kwargs: template as JSONValue } } }),
});

/**
 * llama.cpp's llama-server (OpenAI-compatible) as an AI SDK model. Start it with
 * --jinja. It enforces a JSON response format with a grammar, so it declares
 * structured outputs, and our JSON Schema constraint is sent as that format. Asked for
 * token probabilities, it reports them as provider metadata. A model's chat template
 * options (its catalog entry's `template`) go with every request.
 */
export function llamaServer(options: { readonly baseUrl: string; readonly fetch?: typeof fetch; readonly model?: string; readonly template?: Readonly<Record<string, unknown>> }): LanguageModelV4 {
  const baseURL = `${options.baseUrl.replace(/\/$/, "")}/v1`;
  const model = new OpenAICompatibleChatLanguageModel(options.model ?? "default", {
    provider: `${PROVIDER}.chat`,
    url: ({ path }) => `${baseURL}${path}`,
    headers: () => ({}),
    supportsStructuredOutputs: true,
    metadataExtractor: logprobsMetadata,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return wrapLanguageModel({ model, middleware: [jsonResponseFormat, logprobsRequest, ...(options.template ? [templateOptions(options.template)] : [])] });
}
