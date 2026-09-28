import { describe, expect, it } from "vitest";
import * as tokenizers from "@huggingface/tokenizers";
import { decisionTokenizer, faithfulTokenizer } from "@harness/models";
import { sentencePieceTokenizer as sentencePiece, TOKENIZER_CONFIG as CONFIG } from "./decision-fixture.ts";

type Encoder = ReturnType<typeof faithfulTokenizer>;
/** tokenizers.js as it reads a tokenizer.json on its own. */
const { Tokenizer } = tokenizers as unknown as { Tokenizer: new (json: object, config: object) => Encoder };
const ids = (t: Encoder, text: string) => t.encode(text, { add_special_tokens: false }).ids;

describe("tokenizers read as Hugging Face's Rust tokenizers read them (faithfulTokenizer)", () => {
  it("TK1.1 a Metaspace that splits cuts before every ▁, so a run of spaces is ▁ tokens then ▁word (tokenizers.js alone merges them)", () => {
    expect(ids(faithfulTokenizer(sentencePiece(), CONFIG), "a  b")).toEqual([9, 6, 10]);
    expect(ids(faithfulTokenizer(sentencePiece(), CONFIG), "a b")).toEqual([9, 10]);
    expect(ids(new Tokenizer(sentencePiece(), CONFIG), "a  b")).toEqual([9, 5, 8]);
  });

  it("TK1.2 text that is only spaces is not taken for an added token of ▁s, which only its literal text matches", () => {
    const t = faithfulTokenizer(sentencePiece(), CONFIG);
    expect(ids(t, "  ")).toEqual([6, 6]);
    expect(ids(t, "▁▁")).toEqual([5]);
    expect(ids(t, "a▁▁b")).toEqual([9, 5, 10]);
    expect(ids(new Tokenizer(sentencePiece(), CONFIG), "  ")).toEqual([5]);
  });

  it("TK1.3 a tokenizer whose Metaspace does not split, or whose added tokens are normalized, keeps the library's reading", () => {
    const plain = sentencePiece(false);
    expect(ids(faithfulTokenizer(plain, CONFIG), "a  b")).toEqual(ids(new Tokenizer(plain, CONFIG), "a  b"));
    const normalized = sentencePiece();
    (normalized["added_tokens"] as { normalized: boolean }[])[5]!.normalized = true;
    // The normalizer stays (it makes the added token's normalized form), and splitting still applies.
    expect(faithfulTokenizer(normalized, CONFIG).normalizer).not.toBeNull();
    expect(faithfulTokenizer(sentencePiece(), CONFIG).normalizer).toBeNull();
  });

  it("TK1.4 a decision tokenizer takes its marker, start, separator and padding tokens from the config's mask, cls, sep and pad tokens", () => {
    const t = decisionTokenizer(sentencePiece(), { ...CONFIG, mask_token: { content: "<mask>" } });
    expect(t.marker).toBe("<mask>");
    expect(t.ids).toEqual({ marker: 4, start: 2, separator: 1, pad: 0 });
    expect(t.encode("a  b")).toEqual([9, 6, 10]);
    const { pad_token: _, ...noPad } = CONFIG;
    expect(() => decisionTokenizer(sentencePiece(), noPad)).toThrow(/the tokenizer config names no pad_token/);
    expect(() => decisionTokenizer(sentencePiece(), { ...CONFIG, cls_token: "<cls>" })).toThrow(/cls_token <cls> is not in the vocabulary/);
  });
});
