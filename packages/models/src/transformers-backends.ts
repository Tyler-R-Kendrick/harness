import type * as TransformersModule from "@huggingface/transformers";
import type { ChatBackend, ChatBackendRequest, EmbeddingBackend, TokenClassifierBackend } from "./adapters.ts";

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
}

type Transformers = typeof TransformersModule;

async function runtime(options: TransformersOptions): Promise<Transformers> {
  const t = await import("@huggingface/transformers");
  if (options.cacheDir !== undefined) t.env.cacheDir = options.cacheDir;
  return t;
}

/**
 * Match Python transformers' image-processor defaults where a model's config leaves a
 * flag out. Qwen3.5's preprocessor_config.json gives image_mean/std but no
 * do_normalize: Python defaults it to true, transformers.js reads undefined and skips
 * normalization, so the vision tower sees shifted colours (pure red reads as pink).
 */
export function applyImageProcessorDefaults(imageProcessor: Record<string, unknown> | undefined): void {
  if (imageProcessor && imageProcessor["do_normalize"] === undefined && Array.isArray(imageProcessor["image_mean"]) && Array.isArray(imageProcessor["image_std"])) {
    imageProcessor["do_normalize"] = true;
  }
}

/** Serialize calls: one ONNX session must not run two generations at once. */
function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export async function loadEmbeddingGemmaBackend(options: TransformersOptions & { readonly dtype?: "q4" | "q8" | "fp32" }): Promise<EmbeddingBackend> {
  const t = await runtime(options);
  const from = { revision: options.revision };
  const tokenizer = await t.AutoTokenizer.from_pretrained(options.repo, from);
  const model = await t.AutoModel.from_pretrained(options.repo, { ...from, dtype: options.dtype ?? "q4", ...(options.device ? { device: options.device } : {}) });
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

export async function loadLinguaBackend(options: TransformersOptions & { readonly dtype?: "uint8" | "int8" | "q4" | "fp32" }): Promise<TokenClassifierBackend> {
  const t = await runtime(options);
  const from = { revision: options.revision };
  const tokenizer = await t.AutoTokenizer.from_pretrained(options.repo, from);
  const model = await t.AutoModelForTokenClassification.from_pretrained(options.repo, { ...from, dtype: options.dtype ?? "uint8", ...(options.device ? { device: options.device } : {}) });
  const specials = (tokenizer("", { add_special_tokens: true }).input_ids as { tolist(): bigint[][] }).tolist()[0]!.map(Number);
  const [cls, sep] = [specials[0]!, specials.at(-1)!];
  const queue = serial();
  return {
    style: "wordpiece",
    tokenize: (text) => tokenizer.tokenize(text),
    keepProbabilities: (tokens) =>
      queue(async () => {
        const ids = [cls, ...(tokenizer.convert_tokens_to_ids([...tokens]) as number[]), sep];
        const shape = [1, ids.length];
        const input_ids = new t.Tensor("int64", BigInt64Array.from(ids.map((id) => BigInt(id))), shape);
        const attention_mask = new t.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape);
        const { logits } = (await model({ input_ids, attention_mask })) as { logits: { tolist(): number[][][] } };
        // LLMLingua-2: P(keep) is softmax index 1, per token; drop the CLS/SEP positions.
        return logits
          .tolist()[0]!
          .slice(1, -1)
          .map(([drop, keep]) => 1 / (1 + Math.exp(drop! - keep!)));
      }),
  };
}

export async function loadVisionChatBackend(
  options: TransformersOptions & {
    readonly modelClass: "Qwen3_5ForConditionalGeneration" | "LightOnOcrForConditionalGeneration";
    readonly dtype: Readonly<Record<string, string>>;
    readonly templateOptions?: Readonly<Record<string, unknown>>;
    /** Pixtral-style processors (LightOnOCR) take (images, text); Qwen's take (text, images). */
    readonly imagesFirst?: boolean;
  },
): Promise<ChatBackend> {
  const t = await runtime(options);
  const from = { revision: options.revision };
  const processor = await t.AutoProcessor.from_pretrained(options.repo, from);
  applyImageProcessorDefaults((processor as unknown as { image_processor?: Record<string, unknown> }).image_processor);
  const ModelClass = t[options.modelClass] as unknown as { from_pretrained(repo: string, o: object): Promise<{ generate(o: object): Promise<{ dims: number[] }> }> };
  const model = await ModelClass.from_pretrained(options.repo, { ...from, dtype: options.dtype, ...(options.device ? { device: options.device } : {}) });
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
        const output = await model.generate({ ...inputs, max_new_tokens: request.maxTokens, do_sample: false, streamer, stopping_criteria: stopper });
        return { hitLimit: output.dims.at(-1)! - inputs.input_ids.dims.at(-1)! >= request.maxTokens };
      }),
  };
}
