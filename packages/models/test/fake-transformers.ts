/** A stand-in for the @huggingface/transformers module, recording what the backends ask of it. */
interface FakeTensor {
  type: string;
  data: BigInt64Array;
  dims: number[];
}

export function fakeTransformers(opts: { generated?: string[]; promptLength?: number; embeddingWidth?: number } = {}) {
  const log: { name: string; args: unknown[] }[] = [];
  // transformers.js tokenizers are synchronous callables.
  const tokenizer = Object.assign(
    (texts: unknown, o: unknown) => {
      log.push({ name: "tokenizer", args: [texts, o] });
      return Array.isArray(texts) ? { ids: texts.length } : { input_ids: { tolist: () => [[101, 102]] } };
    },
    {
      tokenize: (text: string) => text.split(" "),
      convert_tokens_to_ids: (tokens: string[]) => tokens.map((t) => t.length),
      apply_chat_template: (messages: unknown, o: unknown) => (log.push({ name: "chat-template", args: [messages, o] }), "PROMPT"),
      encode: () => [5, 6],
      decode: (ids: number[]) => ids.map((i) => String.fromCharCode(96 + i)).join(""),
    },
  );
  const processor = Object.assign(
    async (...args: unknown[]) => {
      log.push({ name: "processor", args });
      return { input_ids: { dims: [1, opts.promptLength ?? 5] } };
    },
    {
      tokenizer: {},
      image_processor: { image_mean: [0.5, 0.5, 0.5], image_std: [0.5, 0.5, 0.5] } as Record<string, unknown>,
      apply_chat_template: (messages: unknown, o: unknown) => {
        log.push({ name: "template", args: [messages, o] });
        return "PROMPT";
      },
    },
  );
  let running = 0;
  const visionModel = {
    generate: async (o: { max_new_tokens: number; streamer: { opts: { callback_function: (t: string) => void } }; stopping_criteria: { interrupted: boolean } }) => {
      running++;
      if (running > 1) throw new Error("two generations ran at once");
      let n = 0;
      for (const t of opts.generated ?? ["Hel", "lo"]) {
        await Promise.resolve();
        if (o.stopping_criteria.interrupted) break;
        o.streamer.opts.callback_function(t);
        n++;
      }
      running--;
      return { dims: [1, (opts.promptLength ?? 5) + n] };
    },
  };
  const module = {
    env: {} as Record<string, unknown>,
    AutoTokenizer: { from_pretrained: async (repo: string, o: unknown) => (log.push({ name: "tokenizer.load", args: [repo, o] }), tokenizer) },
    AutoModel: {
      from_pretrained: async (repo: string, o: unknown) => (
        log.push({ name: "model.load", args: [repo, o] }),
        async (inputs: { ids: number }) => ({ sentence_embedding: { tolist: () => Array.from({ length: inputs.ids }, (_, i) => [i, 1, ...new Array<number>(Math.max(0, (opts.embeddingWidth ?? 2) - 2)).fill(0)]) } })
      ),
    },
    AutoModelForTokenClassification: {
      from_pretrained: async () => async ({ input_ids }: { input_ids: FakeTensor }) => {
        log.push({ name: "classify", args: [Array.from(input_ids.data, Number)] });
        // logits: [drop, keep]; keep grows with position
        return { logits: { tolist: () => [Array.from(input_ids.data, (_, i) => [0, i - 1])] } };
      },
    },
    AutoProcessor: { from_pretrained: async () => processor },
    Qwen3_5ForConditionalGeneration: { from_pretrained: async (repo: string, o: unknown) => (log.push({ name: "vision.load", args: [repo, o] }), visionModel) },
    LightOnOcrForConditionalGeneration: { from_pretrained: async () => visionModel },
    Tensor: class {
      type: string;
      data: BigInt64Array;
      dims: number[];
      constructor(type: string, data: BigInt64Array, dims: number[]) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    },
    RawImage: { fromBlob: async (blob: Blob) => ({ image: blob.type }) },
    InterruptableStoppingCriteria: class {
      interrupted = false;
      interrupt() {
        this.interrupted = true;
      }
    },
    TextStreamer: class {
      opts: unknown;
      constructor(_t: unknown, o: unknown) {
        this.opts = o;
      }
    },
  };
  return { module, log, processor };
}
