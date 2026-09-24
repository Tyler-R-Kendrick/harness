/**
 * Ports the cognitive core drives. Each model adapter implements one or more of
 * them; the ensemble picks an adapter per task. Types are structural so adapters
 * for AI SDK models, WASM engines and ONNX runtimes can implement them without the
 * core depending on any of those libraries.
 */
import type { ChatEvent, ToolCall } from "./chat-format.ts";
import type { EmbedInput } from "./embedding.ts";

// ---- judgment (Jev's typed questions) -------------------------------------------

export type JudgeQuestion =
  | { readonly type: "boolean"; readonly instructions: string; readonly criteria?: { readonly true?: string | null; readonly false?: string | null } }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string | null>> }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: readonly (string | null)[] };

export type JudgeAnswer =
  | { readonly type: "boolean"; readonly probability: number }
  | { readonly type: "choice"; readonly choice: string; readonly probabilities?: Readonly<Record<string, number>> }
  | { readonly type: "score"; readonly score: number; readonly probabilities?: Readonly<Record<string, number>> };

export type JudgeState = string | Readonly<Record<string, unknown>> | readonly unknown[];

export interface JudgeRequest {
  readonly state: JudgeState;
  readonly questions: Readonly<Record<string, JudgeQuestion>>;
}

export interface Judge {
  evaluate(request: JudgeRequest): Promise<Record<string, JudgeAnswer>>;
}

// ---- tool routing and extraction --------------------------------------------------

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments object. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface RouteRequest {
  readonly input: string;
  readonly tools: readonly ToolSpec[];
}

export interface Routing {
  readonly calls: readonly ToolCall[];
  /** Calibrated probability that `calls` is right, in [0, 1]. */
  readonly confidence: number;
  readonly reasoning: string;
}

export interface ToolRouter {
  route(request: RouteRequest): Promise<Routing>;
}

// ---- embeddings ------------------------------------------------------------------

export interface Embedder {
  readonly dimensions: number;
  /** One unit-length vector per input. */
  embed(inputs: readonly EmbedInput[], options?: { readonly dimensions?: number }): Promise<Float32Array[]>;
}

// ---- prompt compression ------------------------------------------------------------

export interface CompressRequest {
  readonly text: string;
  /** Target fraction of tokens to keep, in (0, 1]. */
  readonly rate: number;
  /** Tokens that must survive compression. */
  readonly forceTokens?: readonly string[];
}

export interface Compression {
  readonly text: string;
  readonly originalTokens: number;
  readonly compressedTokens: number;
}

export interface Compressor {
  compress(request: CompressRequest): Promise<Compression>;
}

// ---- generation (text and vision) --------------------------------------------------

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

export type GenerationEvent = ChatEvent | { readonly type: "finish"; readonly reason: FinishReason };

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
