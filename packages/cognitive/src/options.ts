/**
 * Our settings on AI SDK calls. Anything the AI SDK has a setting for goes there
 * (a JSON Schema is `responseFormat`, set by `Output.object`); the rest travels as
 * provider options under the `harness` key, which our own models read and other
 * providers ignore.
 */
import type { JSONObject, JSONSchema7, JSONValue, LanguageModelV4CallOptions, LanguageModelV4Middleware } from "@ai-sdk/provider";
import { z } from "zod";
import { ConstraintSchema } from "./constraint.ts";
import type { Constraint } from "./constraint.ts";
import { EmbedInputSchema } from "./embedding.ts";
import type { EmbedInput } from "./embedding.ts";
import { DimensionsSchema } from "./units.ts";
import type { Dimensions } from "./units.ts";

export const HARNESS = "harness";

/** The response header naming the ensemble member that served a call. */
export const MODEL_HEADER = "x-harness-model";

/** The custom content kind a steered model emits when its behavior state changes. */
export const STATE_KIND = "harness.state";

type ProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>> | undefined;

const harness = (options: ProviderOptions): Readonly<Record<string, unknown>> => options?.[HARNESS] ?? {};

/** Call settings asking for output that follows a constraint (a template, grammar, regex or JSON Schema). */
export function constrain(constraint: Constraint): { providerOptions: { harness: JSONObject } } {
  // A constraint is JSON (a JSON Schema's type is only looser than JSONValue).
  return { providerOptions: { [HARNESS]: { constraint: constraint as unknown as JSONValue } } };
}

/** The constraint a call asks for: ours, or the AI SDK's JSON response format. */
export function constraintOf(options: { readonly responseFormat?: { readonly type: string; readonly schema?: unknown } | undefined; readonly providerOptions?: ProviderOptions }): Constraint | undefined {
  const ours = harness(options.providerOptions)["constraint"];
  if (ours !== undefined) {
    const parsed = ConstraintSchema.safeParse(ours);
    if (!parsed.success) throw new Error(`invalid constraint in provider options\n${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }
  const format = options.responseFormat;
  if (format?.type === "json") return { type: "json-schema", schema: (format.schema ?? {}) as Record<string, unknown> };
  return undefined;
}

/**
 * Call options with a JSON Schema constraint of ours also set as the AI SDK response
 * format (unless one is set), so a provider that enforces only that still does.
 */
export function withResponseFormat(options: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  if (options.responseFormat !== undefined) return options;
  const constraint = constraintOf(options);
  return constraint?.type === "json-schema" ? { ...options, responseFormat: { type: "json", schema: constraint.schema as JSONSchema7 } } : options;
}

/** `withResponseFormat` as middleware, for wrapping a provider's model. */
export const jsonResponseFormat: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => withResponseFormat(params),
};

/** Call settings naming the daemon session a call belongs to (a steered model keeps behavior state per session). */
export function inSession(sessionId: string): { providerOptions: { harness: JSONObject } } {
  return { providerOptions: { [HARNESS]: { session: sessionId } } };
}

/** The daemon session a call names, if any. */
export function sessionOf(providerOptions: ProviderOptions): string | undefined {
  const session = harness(providerOptions)["session"];
  return typeof session === "string" && session !== "" ? session : undefined;
}

const EmbeddingOptions = z.object({
  kind: z.enum(["query", "document"]).default("document"),
  task: z.string().exactOptional(),
  title: z.string().exactOptional(),
  dimensions: DimensionsSchema.exactOptional(),
});

/** Embedding call settings: what the texts are (queries or documents), and the size wanted. */
export function embedding(settings: { readonly kind: EmbedInput["kind"]; readonly task?: string; readonly title?: string; readonly dimensions?: Dimensions }): { providerOptions: { harness: JSONObject } } {
  return { providerOptions: { [HARNESS]: { ...settings } } };
}

/** Read embedding settings back: each value as the input kind it is, and the size wanted. */
export function embedInputs(values: readonly string[], providerOptions: ProviderOptions): { inputs: EmbedInput[]; dimensions?: Dimensions } {
  const parsed = EmbeddingOptions.safeParse(harness(providerOptions));
  if (!parsed.success) throw new Error(`invalid embedding options\n${z.prettifyError(parsed.error)}`);
  const { kind, task, title, dimensions } = parsed.data;
  const inputs = values.map((text) => EmbedInputSchema.parse(kind === "query" ? { kind, text, ...(task === undefined ? {} : { task }) } : { kind, text, ...(title === undefined ? {} : { title }) }));
  return dimensions === undefined ? { inputs } : { inputs, dimensions };
}

/** A behavior state change, as a steered model's custom content carries it. */
export interface StateChange {
  readonly state: string;
  readonly from?: string;
  readonly cause?: string;
}

const StateSchema = z.object({ state: z.string(), from: z.string().exactOptional(), cause: z.string().exactOptional() });

/** The custom content part for a state change. */
export function stateContent(change: StateChange): { type: "custom"; kind: typeof STATE_KIND; providerMetadata: { harness: JSONObject } } {
  return { type: "custom", kind: STATE_KIND, providerMetadata: { [HARNESS]: { ...change } } };
}

/** The state change a stream part carries, if it is one. */
export function stateOf(part: { readonly type: string; readonly kind?: string; readonly providerMetadata?: ProviderOptions }): StateChange | undefined {
  if (part.type !== "custom" || part.kind !== STATE_KIND) return undefined;
  const parsed = StateSchema.safeParse(harness(part.providerMetadata));
  return parsed.success ? parsed.data : undefined;
}

/** One generated token and the most likely tokens at its position, as natural-log probabilities. */
export interface TokenLogprob {
  readonly token: string;
  readonly logprob: number;
  readonly top: readonly { readonly token: string; readonly logprob: number }[];
}

const TokenLogprobs = z.array(z.object({ token: z.string(), logprob: z.number(), top: z.array(z.object({ token: z.string(), logprob: z.number() })) }));

/** Call settings asking a model that can for the `top` most likely tokens at each generated position. */
export function withLogprobs(top: number): { providerOptions: { harness: JSONObject } } {
  return { providerOptions: { [HARNESS]: { logprobs: top } } };
}

/** How many top tokens a call asks for, if it asks. */
export function logprobsOf(providerOptions: ProviderOptions): number | undefined {
  const top = harness(providerOptions)["logprobs"];
  return typeof top === "number" && Number.isInteger(top) && top > 0 ? top : undefined;
}

/** The token probabilities a model reported (provider metadata `harness.logprobs`), if it did. */
export function logprobsIn(providerMetadata: ProviderOptions): TokenLogprob[] | undefined {
  const parsed = TokenLogprobs.safeParse(harness(providerMetadata)["logprobs"]);
  return parsed.success ? parsed.data : undefined;
}
