import * as tokenizers from "@huggingface/tokenizers";

type Json = Record<string, unknown>;

/**
 * The parts of tokenizers.js used here. Its bundled type declarations import their own
 * files without extensions, which NodeNext resolution cannot follow, so they are typed here.
 */
export interface Tokenizer {
  encode(text: string, options?: { readonly add_special_tokens?: boolean }): { readonly ids: number[] };
  token_to_id(token: string): number | undefined;
  readonly normalizer: unknown;
  readonly pre_tokenizer: { pre_tokenize_text(text: string, options?: object): string[] } | null;
}
const { Tokenizer: TokenizerClass } = tokenizers as unknown as { Tokenizer: new (json: Json, config: Json) => Tokenizer };

/** Cut before every replacement character (each starts a piece), as Rust's Metaspace does with `split: true`. */
const splitAt = (replacement: string) => (piece: string) => piece.split(replacement).flatMap((part, i) => (i === 0 ? (part === "" ? [] : [part]) : [replacement + part]));

/**
 * A tokenizer.json read the way Hugging Face's Rust tokenizers (and so Python) read it.
 * tokenizers.js 0.2 differs on SentencePiece-style tokenizers whose Metaspace
 * pre-tokenizer splits (`split: true`, as Gemma's and mmBERT's do): it does not split
 * before each ▁, so a run of spaces merges into one token where Rust keeps "▁" and
 * "▁word"; and once its normalizer has turned spaces into ▁, a section that is only ▁s
 * is taken for an added token of that text even when the added token is not normalized.
 * A model trained on Rust's ids reads the library's as different text. Here the
 * library's Metaspace splits, and a normalizer that only turns spaces into ▁ is dropped
 * (the Metaspace does the same replacement, after added tokens are matched) unless an
 * added token is normalized and needs it.
 */
export function faithfulTokenizer(json: Json, config: Json): Tokenizer {
  const pre = json["pre_tokenizer"] as Json | null | undefined;
  if (pre?.["type"] !== "Metaspace" || pre["split"] !== true) return new TokenizerClass(json, config);
  const normalizer = json["normalizer"] as Json | null | undefined;
  const replacement = (pre["replacement"] as string | undefined) ?? "▁";
  const onlySpaces = normalizer?.["type"] === "Replace" && (normalizer["pattern"] as Json | undefined)?.["String"] === " " && normalizer["content"] === replacement;
  const normalizedTokens = ((json["added_tokens"] as Json[] | undefined) ?? []).some((t) => t["normalized"] === true);
  const tokenizer = new TokenizerClass(onlySpaces && !normalizedTokens ? { ...json, normalizer: null } : json, config);
  // The library's own Metaspace, made to split: its method, then a cut before every replacement character.
  const metaspace = tokenizer.pre_tokenizer!;
  const own = metaspace.pre_tokenize_text.bind(metaspace);
  metaspace.pre_tokenize_text = (text, options) => own(text, options).flatMap(splitAt(replacement));
  return tokenizer;
}

/** What a decision model's encoding needs from its tokenizer. */
export interface DecisionTokenizer {
  /** Token ids for text, with no special tokens added. */
  encode(text: string): number[];
  /** The marker token's text (the tokenizer's mask token), which a request may not contain. */
  readonly marker: string;
  readonly ids: { readonly marker: number; readonly start: number; readonly separator: number; readonly pad: number };
}

/** A decision model's tokenizer from its tokenizer.json and config: the mask token marks options, cls starts, sep separates, pad pads. */
export function decisionTokenizer(json: Json, config: Json): DecisionTokenizer {
  const tokenizer = faithfulTokenizer(json, config);
  const token = (key: string) => {
    const value = config[key];
    const text = typeof value === "string" ? value : ((value as Json | undefined)?.["content"] as string | undefined);
    if (!text) throw new Error(`the tokenizer config names no ${key}`);
    const id = tokenizer.token_to_id(text);
    if (id === undefined) throw new Error(`${key} ${text} is not in the vocabulary`);
    return { text, id };
  };
  const marker = token("mask_token");
  return {
    marker: marker.text,
    ids: { marker: marker.id, start: token("cls_token").id, separator: token("sep_token").id, pad: token("pad_token").id },
    encode: (text) => tokenizer.encode(text, { add_special_tokens: false }).ids,
  };
}
