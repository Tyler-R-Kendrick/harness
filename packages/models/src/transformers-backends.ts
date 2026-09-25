import type * as TransformersModule from "@huggingface/transformers";
import { Mutex } from "async-mutex";
import type { ChatBackend, ChatBackendRequest, EmbeddingBackend, TokenClassifierBackend } from "./adapters.ts";
import type { Constraint, TokenConstraint } from "@harness/cognitive";
import type { TemplateMessage } from "./local-model.ts";
import type { TokenizerLike } from "./steerable.ts";

/**
 * transformers.js backends. The same ONNX files run in the browser (WebGPU or WASM)
 * and in Node (onnxruntime-node). Models load from the catalog's pinned revision.
 */
export interface TransformersOptions {
  readonly repo: string;
  readonly revision: string;
  readonly device?: "cpu" | "wasm" | "webgpu";
  /** Node only: where transformers.js caches downloads. Browsers use the Cache API. */
  readonly cacheDir?: string;
  /** The transformers.js module to use; defaults to importing @huggingface/transformers. */
  readonly module?: unknown;
}

type Transformers = typeof TransformersModule;

async function runtime(options: TransformersOptions): Promise<Transformers> {
  const t = (options.module as Transformers | undefined) ?? (await import("@huggingface/transformers"));
  if (options.cacheDir !== undefined) t.env.cacheDir = options.cacheDir;
  return t;
}

/**
 * Match Python transformers' image-processor defaults where a model's config leaves a
 * flag out. A preprocessor_config.json may give image_mean/std but no do_normalize:
 * Python defaults it to true, transformers.js reads undefined and skips normalization,
 * so the vision tower sees shifted colours (pure red reads as pink).
 */
export function applyImageProcessorDefaults(imageProcessor: Record<string, unknown> | undefined): void {
  if (imageProcessor && imageProcessor["do_normalize"] === undefined && Array.isArray(imageProcessor["image_mean"]) && Array.isArray(imageProcessor["image_std"])) {
    imageProcessor["do_normalize"] = true;
  }
}

/**
 * Builds constraints for a tokenizer's vocabulary (see @harness/constrained); the host
 * brings it, with how the model's tokens encode text from its catalog entry.
 */
export type Constrainer = (vocabulary: { readonly tokens: readonly string[]; readonly stopTokens: readonly number[] }) => Promise<(constraint: Constraint) => Promise<TokenConstraint>>;

/** A tokenizer's tokens in id order (ids no token has are empty). */
export function vocabularyOf(tokenizer: { get_vocab(): Map<string, number> }): string[] {
  const tokens: string[] = [];
  for (const [token, id] of tokenizer.get_vocab()) tokens[id] = token;
  return Array.from(tokens, (t) => t ?? "");
}

/** Serialize calls: one ONNX session must not run two generations at once. */
const serial = () => {
  const mutex = new Mutex();
  return <T>(task: () => Promise<T>): Promise<T> => mutex.runExclusive(task);
};

/** Weight precision: one for the whole model, or one per ONNX file (e.g. { decoder_model_merged: "q4" }). */
export type Dtype = string | Readonly<Record<string, string>>;

/** An embedding model exported with a pooled, normalized sentence_embedding output. */
export async function loadFeatureExtractionBackend(options: TransformersOptions & { readonly dtype: Dtype }): Promise<EmbeddingBackend> {
  const t = await runtime(options);
  const from = { revision: options.revision };
  const tokenizer = await t.AutoTokenizer.from_pretrained(options.repo, from);
  const model = await t.AutoModel.from_pretrained(options.repo, { ...from, dtype: options.dtype as never, ...(options.device ? { device: options.device } : {}) });
  const queue = serial();
  return {
    embed: (texts) =>
      queue(async () => {
        const inputs = await tokenizer([...texts], { padding: true, truncation: true });
        const { sentence_embedding } = (await model(inputs)) as { sentence_embedding: { tolist(): number[][] } };
        return sentence_embedding.tolist().map((v) => Float32Array.from(v));
      }),
  };
}

/** A token classifier whose label `keepLabel` means "keep this token". */
export async function loadTokenClassificationBackend(options: TransformersOptions & { readonly dtype: Dtype; readonly keepLabel: number }): Promise<TokenClassifierBackend> {
  const t = await runtime(options);
  const from = { revision: options.revision };
  const tokenizer = await t.AutoTokenizer.from_pretrained(options.repo, from);
  const model = await t.AutoModelForTokenClassification.from_pretrained(options.repo, { ...from, dtype: options.dtype as never, ...(options.device ? { device: options.device } : {}) });
  const specials = (tokenizer("", { add_special_tokens: true }).input_ids as { tolist(): bigint[][] }).tolist()[0]!.map(Number);
  const [cls, sep] = [specials[0]!, specials.at(-1)!];
  const queue = serial();
  return {
    tokenize: (text) => tokenizer.tokenize(text),
    keepProbabilities: (tokens) =>
      queue(async () => {
        const ids = [cls, ...(tokenizer.convert_tokens_to_ids([...tokens]) as number[]), sep];
        const shape = [1, ids.length];
        const input_ids = new t.Tensor("int64", BigInt64Array.from(ids.map((id) => BigInt(id))), shape);
        const attention_mask = new t.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape);
        const { logits } = (await model({ input_ids, attention_mask })) as { logits: { tolist(): number[][][] } };
        // P(keep) is the keep label's softmax, per token; drop the CLS/SEP positions.
        return logits
          .tolist()[0]!
          .slice(1, -1)
          .map((row) => 1 / row.reduce((sum, x) => sum + Math.exp(x - row[options.keepLabel]!), 0));
      }),
  };
}

export async function loadVisionChatBackend(
  options: TransformersOptions & {
    /** The transformers.js model class, e.g. an image-text-to-text ...ForConditionalGeneration. */
    readonly modelClass: string;
    readonly dtype: Dtype;
    readonly templateOptions?: Readonly<Record<string, unknown>>;
    /** Some processors (Pixtral-style) take (images, text); most take (text, images). */
    readonly imagesFirst?: boolean;
    /** Constrained decoding: a constrained request's logits are masked at every step. */
    readonly constrainer?: Constrainer;
  },
): Promise<ChatBackend> {
  const t = await runtime(options);
  const from = { revision: options.revision };
  const processor = await t.AutoProcessor.from_pretrained(options.repo, from);
  applyImageProcessorDefaults((processor as unknown as { image_processor?: Record<string, unknown> }).image_processor);
  const ModelClass = (t as unknown as Record<string, unknown>)[options.modelClass] as
    | { from_pretrained(repo: string, o: object): Promise<{ generate(o: object): Promise<{ dims: number[] }>; generation_config?: { eos_token_id?: number | number[] } }> }
    | undefined;
  if (!ModelClass) throw new Error(`transformers.js has no model class ${options.modelClass}`);
  const model = await ModelClass.from_pretrained(options.repo, { ...from, dtype: options.dtype, ...(options.device ? { device: options.device } : {}) });
  const eos = model.generation_config?.eos_token_id ?? [];
  const constrain = options.constrainer && (await options.constrainer({ tokens: vocabularyOf(processor.tokenizer as never), stopTokens: Array.isArray(eos) ? eos : [eos] }));
  /** Masks each step's logits by the constraint, accepting the tokens generated since the last step. */
  const processorFor = (constraint: TokenConstraint) => {
    let seen: number | undefined;
    const p = Object.assign(new t.LogitsProcessor(), {
      _call(inputIds: bigint[][], logits: { data: Float32Array }) {
        const ids = inputIds[0]!;
        for (let i = seen ?? ids.length; i < ids.length; i++) constraint.accept(Number(ids[i]));
        seen = ids.length;
        constraint.mask(logits.data);
        return logits;
      },
    });
    const list = new t.LogitsProcessorList();
    list.push(p as never);
    return list;
  };
  const queue = serial();
  return {
    generate: (request: ChatBackendRequest, onText, shouldStop) =>
      queue(async () => {
        const text = processor.apply_chat_template(request.messages as never, {
          add_generation_prompt: true,
          ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
          ...options.templateOptions,
        } as never) as string;
        const images = await Promise.all(request.images.map((i) => t.RawImage.fromBlob(new Blob([i.data as Uint8Array<ArrayBuffer>], { type: i.mediaType }))));
        const imageArg = images.length === 1 ? images[0] : images;
        const call = processor as unknown as (a: unknown, b?: unknown) => Promise<{ input_ids: { dims: number[] } }>;
        const inputs = await (images.length === 0 ? call(text) : options.imagesFirst ? call(imageArg, text) : call(text, imageArg));
        const stopper = new t.InterruptableStoppingCriteria();
        const streamer = new t.TextStreamer(processor.tokenizer!, {
          skip_prompt: true,
          skip_special_tokens: false,
          callback_function: (delta: string) => {
            onText(delta);
            if (shouldStop()) stopper.interrupt();
          },
        });
        const constraint = request.constraint && constrain ? await constrain(request.constraint) : undefined;
        try {
          const output = await model.generate({ ...inputs, max_new_tokens: request.maxTokens, do_sample: false, streamer, stopping_criteria: stopper, ...(constraint ? { logits_processor: processorFor(constraint) } : {}) });
          return { hitLimit: output.dims.at(-1)! - inputs.input_ids.dims.at(-1)! >= request.maxTokens };
        } finally {
          constraint?.dispose();
        }
      }),
  };
}

/**
 * A chat tokenizer for the steered decode loop: the model's own chat template renders
 * the conversation, then the text is encoded as-is (the template already placed the
 * special tokens). The kernel is text only; images go to the vision models.
 */
export async function loadChatTokenizer(
  options: TransformersOptions & {
    /** A folder inside the repo holding the tokenizer (ONNX exports keep one per variant). */
    readonly subfolder?: string;
    readonly templateOptions?: Readonly<Record<string, unknown>>;
    /** Tokens that end a turn. */
    readonly endTokens: readonly string[];
  },
): Promise<TokenizerLike> {
  const t = await runtime(options);
  const tokenizer = await t.AutoTokenizer.from_pretrained(options.repo, { revision: options.revision, ...(options.subfolder ? { subfolder: options.subfolder } : {}) } as never);
  const endTokens = tokenizer.convert_tokens_to_ids([...options.endTokens]) as number[];
  endTokens.forEach((id, i) => {
    if (!id) throw new Error(`the tokenizer has no token ${options.endTokens[i]}`);
  });
  // The kernel is text only: each message's text parts, joined.
  const toTemplate = (m: TemplateMessage): Record<string, unknown> => {
    if (m.content.some((p) => p.type !== "text")) throw new Error("the steered kernel is text only; send images to a vision model");
    return { ...m, content: m.content.map((p) => (p.type === "text" ? p.text : "")).join("") };
  };
  return {
    endTokens,
    encodeChat: (messages, tools) => {
      const text = tokenizer.apply_chat_template(messages.map(toTemplate) as never, {
        tokenize: false,
        add_generation_prompt: true,
        ...(tools?.length ? { tools: tools.map((tool) => ({ type: "function", function: tool })) } : {}),
        ...options.templateOptions,
      } as never) as unknown as string;
      return tokenizer.encode(text, { add_special_tokens: false } as never);
    },
    decode: (ids) => tokenizer.decode([...ids], { skip_special_tokens: false }),
    encodeText: (text) => tokenizer.encode(text, { add_special_tokens: false } as never),
    vocabulary: () => vocabularyOf(tokenizer as never),
  };
}
