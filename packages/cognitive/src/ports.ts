/**
 * What the cognitive core's models are. Every model is an AI SDK model: generators,
 * tool routers and document parsers are `LanguageModelV4`s, embedding models are
 * `EmbeddingModelV4`s and judges are `EvaluationModelV4`s, so any AI SDK provider's
 * model is a member as is, and our local models implement the same specs. Prompt
 * compression, which the AI SDK has no model kind for, is the one port of our own.
 *
 * Requests that arrive as JSON (see service.ts) are parsed by the schemas here.
 */
import type { EmbeddingModelV4, Experimental_EvaluationModelV4 as EvaluationModelV4, LanguageModelV4 } from "@ai-sdk/provider";
import { base64 } from "@scure/base";
import { z } from "zod";
import { ProbabilitySchema } from "./units.ts";

export type { EmbeddingModelV4, EvaluationModelV4, LanguageModelV4 };

// ---- judgment (typed questions, the AI SDK's evaluation questions) ---------------------

export const JudgeQuestionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), instructions: z.string(), criteria: z.object({ true: z.string().nullable().exactOptional(), false: z.string().nullable().exactOptional() }).exactOptional() }),
  z.object({ type: z.literal("choice"), instructions: z.string(), criteria: z.record(z.string(), z.string().nullable()) }),
  z.object({ type: z.literal("score"), instructions: z.string(), criteria: z.array(z.string().nullable()) }),
]);
export type JudgeQuestion = z.output<typeof JudgeQuestionSchema>;

/** A judge's answers, parsed where they enter, so probabilities are Probabilities. */
export const JudgeAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("boolean"), probability: ProbabilitySchema }).readonly(),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), ProbabilitySchema).readonly().exactOptional() }).readonly(),
  z.object({ type: z.literal("score"), score: z.number(), probabilities: z.record(z.string(), ProbabilitySchema).readonly().exactOptional() }).readonly(),
]);
export type JudgeAnswer = z.output<typeof JudgeAnswerSchema>;

// ---- tools as JSON (e.g. offered by an ACP client) -------------------------------------

export const ToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  /** JSON Schema for the arguments object. */
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type ToolSpec = z.output<typeof ToolSpecSchema>;

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

// ---- images as JSON ---------------------------------------------------------------

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

export const ParseRequestSchema = z.object({ pages: z.array(ImageInputSchema), instruction: z.string().exactOptional() });

// ---- the set of models one adapter provides ------------------------------------------

export interface PortMap {
  readonly judge: EvaluationModelV4;
  readonly router: LanguageModelV4;
  readonly embedder: EmbeddingModelV4;
  readonly compressor: Compressor;
  readonly generator: LanguageModelV4;
  readonly "document-parser": LanguageModelV4;
}

export type Ports = Partial<PortMap>;
