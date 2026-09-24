import { describe, expect, it } from "vitest";
import { chunkTokens, compressWords, percentile, wordsFromTokens } from "@harness/cognitive";
import type { ScoredToken } from "@harness/cognitive";

const t = (text: string, keep: number, special = false): ScoredToken => ({ text, keep, special });

describe("LLMLingua-2 compression (pure part)", () => {
  it("LL1.1 WordPiece tokens join into words; '##' continues a word; the word keeps the mean probability", () => {
    const words = wordsFromTokens([t("[CLS]", 0, true), t("The", 0.9), t("comp", 0.2), t("##ress", 0.4), t("##ion", 0.6), t("[SEP]", 0, true)], "wordpiece");
    expect(words).toEqual([
      { text: "The", keep: 0.9, tokens: 1 },
      { text: "compression", keep: expect.closeTo(0.4, 9), tokens: 3 },
    ]);
  });

  it("LL1.2 SentencePiece tokens start a word on '▁' or a lone punctuation mark", () => {
    const words = wordsFromTokens([t("▁Hello", 0.8), t("wor", 0.1), t("ld", 0.3), t(",", 0.5), t("▁there", 0.7)], "sentencepiece");
    expect(words.map((w) => w.text)).toEqual(["Helloworld", ",", "there"]);
    expect(words[0]!.keep).toBeCloseTo((0.8 + 0.1 + 0.3) / 3, 9);
  });

  it("LL1.3 percentile uses linear interpolation like numpy", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 9);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([10, 20, 30], 51)).toBeCloseTo(20.2, 9);
    expect(() => percentile([], 50)).toThrow(/empty/);
  });

  it("LL1.4 words above the rate's threshold survive, in their original order", () => {
    const words = [
      { text: "keep", keep: 0.9, tokens: 1 },
      { text: "drop", keep: 0.1, tokens: 1 },
      { text: "also", keep: 0.8, tokens: 1 },
      { text: "gone", keep: 0.2, tokens: 1 },
    ];
    // rate .5 -> threshold = percentile([.9,.1,.8,.2], 51) = 0.2 + 0.03*(0.8-0.2)... -> keeps .9 and .8
    expect(compressWords(words, { rate: 0.5 }).map((w) => w.text)).toEqual(["keep", "also"]);
    expect(compressWords(words, { rate: 1 }).map((w) => w.text)).toEqual(["keep", "drop", "also", "gone"]);
  });

  it("LL1.5 a word's probability counts once per token it spans when setting the threshold", () => {
    const words = [
      { text: "long", keep: 0.3, tokens: 3 },
      { text: "a", keep: 0.6, tokens: 1 },
      { text: "b", keep: 0.9, tokens: 1 },
    ];
    // repeated probs [.3,.3,.3,.6,.9]; rate .6 -> percentile 41 -> 0.3 -> keep a and b
    expect(compressWords(words, { rate: 0.6 }).map((w) => w.text)).toEqual(["a", "b"]);
  });

  it("LL1.6 forced tokens and words with digits always survive", () => {
    const words = [
      { text: "Invoice", keep: 0.1, tokens: 1 },
      { text: "#4521", keep: 0.1, tokens: 2 },
      { text: "total", keep: 0.9, tokens: 1 },
      { text: "the", keep: 0.05, tokens: 1 },
    ];
    // Forced words count at p=1 in the threshold, as in LLMLingua-2: at rate .25 they use up the budget.
    expect(compressWords(words, { rate: 0.25, forceTokens: ["Invoice"], keepDigits: true }).map((w) => w.text)).toEqual(["Invoice", "#4521"]);
    expect(compressWords(words, { rate: 0.8, forceTokens: ["Invoice"], keepDigits: true }).map((w) => w.text)).toEqual(["Invoice", "#4521", "total"]);
    expect(compressWords(words, { rate: 0.25 }).map((w) => w.text)).toEqual(["total"]);
  });

  it("LL1.7 rates outside (0, 1] are rejected", () => {
    expect(() => compressWords([], { rate: 0 })).toThrow(/rate/);
    expect(() => compressWords([], { rate: 1.5 })).toThrow(/rate/);
    expect(compressWords([], { rate: 0.5 })).toEqual([]);
  });

  it("LL2.1 long token runs split into windows that end at a sentence boundary when one is in reach", () => {
    const tokens = ["a", "b", ".", "c", "d", "e", ".", "f"];
    expect(chunkTokens(tokens, 4)).toEqual([
      [0, 3],
      [3, 7],
      [7, 8],
    ]);
    // No boundary inside the window: cut at the limit.
    expect(chunkTokens(["a", "b", "c", "d", "e"], 2)).toEqual([
      [0, 2],
      [2, 4],
      [4, 5],
    ]);
    expect(chunkTokens([], 4)).toEqual([]);
    expect(() => chunkTokens(["a"], 0)).toThrow(/window/);
  });
});
