import { encodeModel } from "./onnx-builder.ts";

const special = (id: number, content: string, extra: object = {}) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true, ...extra });

/**
 * A SentencePiece-style BPE tokenizer.json (Gemma's shape): spaces become ▁, a Metaspace
 * pre-tokenizer that splits at each ▁, and "▁▁" both a merge (ranked first) and an
 * added token that is not normalized.
 */
export function sentencePieceTokenizer(split = true): Record<string, unknown> {
  return {
    version: "1.0",
    truncation: null,
    padding: null,
    added_tokens: [special(0, "<pad>"), special(1, "<eos>"), special(2, "<bos>"), special(3, "<unk>"), special(4, "<mask>", { lstrip: true }), { ...special(5, "▁▁"), special: false }],
    normalizer: { type: "Replace", pattern: { String: " " }, content: "▁" },
    pre_tokenizer: { type: "Metaspace", replacement: "▁", prepend_scheme: "always", split },
    post_processor: null,
    decoder: null,
    model: {
      type: "BPE",
      dropout: null,
      unk_token: "<unk>",
      continuing_subword_prefix: null,
      end_of_word_suffix: null,
      fuse_unk: true,
      byte_fallback: false,
      ignore_merges: false,
      vocab: { "<pad>": 0, "<eos>": 1, "<bos>": 2, "<unk>": 3, "<mask>": 4, "▁▁": 5, "▁": 6, a: 7, b: 8, "▁a": 9, "▁b": 10 },
      merges: [
        ["▁", "▁"],
        ["▁", "a"],
        ["▁", "b"],
      ],
    },
  };
}

export const TOKENIZER_CONFIG = { mask_token: "<mask>", cls_token: "<bos>", sep_token: "<eos>", pad_token: "<pad>" };

/** A decision model small enough to write here: each option's score is its marker's position, so the last option wins. */
export function positionDecisionModel(): Uint8Array {
  const INT64 = 7;
  const FLOAT = 1;
  const BOOL = 9;
  return encodeModel({
    opsets: { "": 17 },
    inputs: [
      { name: "input_ids", elemType: INT64, dims: ["batch", "tokens"] },
      { name: "attention_mask", elemType: INT64, dims: ["batch", "tokens"] },
      { name: "marker_pos", elemType: INT64, dims: ["batch", "options"] },
      { name: "marker_mask", elemType: BOOL, dims: ["batch", "options"] },
      { name: "qtype", elemType: INT64, dims: ["batch"] },
    ],
    outputs: [{ name: "logits", elemType: FLOAT, dims: ["batch", "options"] }],
    initializers: [],
    nodes: [{ name: "score", opType: "Cast", inputs: ["marker_pos"], outputs: ["logits"], intAttributes: { to: FLOAT } }],
  });
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The tiny decision model's files, by the paths a catalog entry's `run` names. */
export function decisionFiles(run: { readonly model: string; readonly tokenizer: string; readonly tokenizerConfig: string }): Record<string, Uint8Array> {
  return { [run.model]: positionDecisionModel(), [run.tokenizer]: encode(sentencePieceTokenizer()), [run.tokenizerConfig]: encode(TOKENIZER_CONFIG) };
}
