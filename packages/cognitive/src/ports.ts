/**
 * Ports the cognitive core drives. Each model adapter implements one or more of
 * them; the ensemble picks an adapter per task. Types are structural so adapters
 * for AI SDK models, WASM engines and ONNX runtimes can implement them without the
 * core depending on any of those libraries.
 */
import { base64 } from "@scure/base";
import { z } from "zod";
import type { ChatEvent, ToolCall } from "./chat-format.ts";
import type { EmbedInput } from "./embedding.ts";
import { ProbabilitySchema } from "./units.ts";
import type { Dimensions, Probability } from "./units.ts";

// Requests that can arrive as JSON (see service.ts) are defined as schemas; their
// types are the schemas' outputs, so a parsed request is a port request as is.

// ---- judgment (typed questions) ------------------------------------------------

export const JudgeQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), instructions: z.string(), criteria: z.object({ true: z.string().nullable().exactOptional(), false: z.string().nullable().exactOptional() }).exactOptional() }),
  z.object({ type: z.literal("choice"), instructions: z.string(), criteria: z.record(z.string(), z.string().nullable()) }),
  z.object({ type: z.literal("score"), instructions: z.string(), criteria: z.array(z.string().nullable()) }),
]);
export type JudgeQuestion = z.output<typeof JudgeQuestionSchema>;

/** A judge's answers, parsed where they enter (an adapter's model output), so probabilities are Probabilities. */
export const JudgeAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), probability: ProbabilitySchema }).readonly(),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), ProbabilitySchema).readonly().exactOptional() }).readonly(),
  z.object({ type: z.literal("score"), score: z.number(), probabilities: z.record(z.string(), ProbabilitySchema).readonly().exactOptional() }).readonly(),
]);
export type JudgeAnswer = z.output<typeof JudgeAnswerSchema>;

export type JudgeState = string | Readonly<Record<string, unknown>> | readonly unknown[];

export interface JudgeRequest {
  readonly state: JudgeState;
  readonly questions: Readonly<Record<string, JudgeQuestion>>;
}

export interface Judge {
  evaluate(request: JudgeRequest): Promise<Record<string, JudgeAnswer>>;
}

// ---- tool routing and extraction --------------------------------------------------

export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  /** JSON Schema for the arguments object. */
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type ToolSpec = z.output<typeof ToolSpecSchema>;

export interface RouteRequest {
  readonly input: string;
  readonly tools: readonly ToolSpec[];
}

export interface Routing {
  readonly calls: readonly ToolCall[];
  /** Calibrated probability that `calls` is right. */
  readonly confidence: Probability;
  readonly reasoning: string;
}

export interface ToolRouter {
  route(request: RouteRequest): Promise<Routing>;
}

// ---- embeddings ------------------------------------------------------------------

export interface Embedder {
  readonly dimensions: Dimensions;
  /** One unit-length vector per input. */
  embed(inputs: readonly EmbedInput[], options?: { readonly dimensions?: Dimensions }): Promise<Float32Array[]>;
}

// ---- prompt compression ------------------------------------------------------------

export const CompressRequestSchema = z.object({
  text: z.string(),
  /** Target fraction of tokens to keep, in (0, 1]. */
  rate: z.number().gt(0).lte(1),
  /** Tokens that must survive compression. */
  forceTokens: z.array(z.string()).exactOptional(),
});
export type CompressRequest = z.output<typeof CompressRequestSchema>;

export interface Compression {
  readonly text: string;
  readonly originalTokens: number;
  readonly compressedTokens: number;
}

export interface Compressor {
  compress(request: CompressRequest): Promise<Compression>;
}

// ---- generation (text and vision) --------------------------------------------------

/** An image as JSON carries its bytes as base64. */
export const ImageInputSchema = z.object({
  mediaType: z.string().min(1),
  data: z.string().transform((data, ctx) => {
    try {
      return base64.decode(data);
    } catch {
      ctx.addIssue({ code: "custom", message: "not valid base64" });
      return z.NEVER;
    }
  }),
});
export interface ImageInput {
  readonly mediaType: string;
  readonly data: Uint8Array;
}

export type ContentPart = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly image: ImageInput };

export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string | readonly ContentPart[] }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: "tool"; readonly name: string; readonly content: string };

export type FinishReason = "stop" | "length" | "tool-calls" | "error";

/** A steered model's behavior state changed (see @harness/behavior). */
export interface StateEvent {
  readonly type: "state";
  readonly state: string;
  readonly from?: string;
  readonly cause?: string;
}

export type GenerationEvent = ChatEvent | StateEvent | { readonly type: "finish"; readonly reason: FinishReason };

export interface GenerateRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  readonly maxTokens?: number;
}

export interface Generator {
  /** Streams events and ends with exactly one finish event. Stop early by breaking out of the loop. */
  generate(request: GenerateRequest): AsyncIterable<GenerationEvent>;
}

// ---- documents ---------------------------------------------------------------------

export interface ParsedPage {
  readonly markdown: string;
  /** The model's native output (e.g. DocTags), kept for lossless downstream use. */
  readonly raw: string;
}

export const ParseRequestSchema = z.object({ pages: z.array(ImageInputSchema), instruction: z.string().exactOptional() });
export interface ParseRequest {
  readonly pages: readonly ImageInput[];
  readonly instruction?: string;
}

export interface DocumentParser {
  parse(request: ParseRequest): Promise<{ readonly pages: readonly ParsedPage[] }>;
}

// ---- the set of ports one adapter provides -------------------------------------------

export interface PortMap {
  readonly judge: Judge;
  readonly router: ToolRouter;
  readonly embedder: Embedder;
  readonly compressor: Compressor;
  readonly generator: Generator;
  readonly "document-parser": DocumentParser;
}

export type Ports = Partial<PortMap>;
