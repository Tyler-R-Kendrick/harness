/**
 * The model-independent half of LLMLingua-2 prompt compression (Pan et al. 2024,
 * arXiv:2403.12968; reference: microsoft/LLMLingua prompt_compressor.py). A token
 * classifier scores each subword with P(keep); words take the mean of their
 * subwords; the keep rate sets a percentile threshold over word probabilities,
 * weighted by how many tokens each word spans; surviving words keep their order.
 */

export interface ScoredToken {
  readonly text: string;
  /** P(keep) from the classifier (softmax index 1). */
  readonly keep: number;
  readonly special: boolean;
}

export interface ScoredWord {
  readonly text: string;
  readonly keep: number;
  /** Tokens the word spans, which weights it in the threshold. */
  readonly tokens: number;
}

const PUNCTUATION = /^[\p{P}\p{S}]$/u;

/** Rebuild words from subword tokens: WordPiece ("##" continues) or SentencePiece ("▁" starts). */
export function wordsFromTokens(tokens: readonly ScoredToken[], style: "wordpiece" | "sentencepiece"): ScoredWord[] {
  const words: { text: string; sum: number; tokens: number }[] = [];
  for (const token of tokens) {
    if (token.special) continue;
    let text = token.text;
    let starts: boolean;
    if (style === "wordpiece") {
      starts = !text.startsWith("##");
      if (!starts) text = text.slice(2);
    } else {
      starts = text.startsWith("▁") || PUNCTUATION.test(text);
      if (text.startsWith("▁")) text = text.slice(1);
    }
    const last = words.at(-1);
    if (starts || !last) words.push({ text, sum: token.keep, tokens: 1 });
    else {
      last.text += text;
      last.sum += token.keep;
      last.tokens++;
    }
  }
  return words.map((w) => ({ text: w.text, keep: w.sum / w.tokens, tokens: w.tokens }));
}

/** The q-th percentile with linear interpolation between closest ranks (numpy's default). */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) throw new Error("percentile of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const index = ((sorted.length - 1) * q) / 100;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo);
}

export interface CompressWordsOptions {
  /** Fraction of tokens to keep, in (0, 1]. */
  readonly rate: number;
  readonly forceTokens?: readonly string[];
  /** Always keep words that contain a digit. */
  readonly keepDigits?: boolean;
}

/** Keep the words whose probability clears the rate's threshold, in their original order. */
export function compressWords(words: readonly ScoredWord[], options: CompressWordsOptions): ScoredWord[] {
  if (!(options.rate > 0 && options.rate <= 1)) throw new Error(`rate must be in (0, 1], got ${options.rate}`);
  // The reference formula takes the 1st percentile at rate 1 and still drops a word; rate 1 means no compression.
  if (words.length === 0 || options.rate === 1) return [...words];
  const forced = new Set(options.forceTokens ?? []);
  const scored = words.map((w) => ({ word: w, p: forced.has(w.text) || (options.keepDigits === true && /\d/.test(w.text)) ? 1 : w.keep }));
  const weighted = scored.flatMap((s) => Array<number>(s.word.tokens).fill(s.p));
  const threshold = percentile(weighted, Math.trunc(100 * (1 - options.rate) + 1));
  return scored.filter((s) => s.p > threshold || (threshold === 1 && s.p === 1)).map((s) => s.word);
}

/**
 * Split a token run into windows of at most `window` tokens (510 for 512-token
 * encoders), ending each window after the last sentence-ending token inside it when
 * there is one. Returns [start, end) index pairs.
 */
export function chunkTokens(tokens: readonly string[], window: number, endTokens: readonly string[] = [".", "\n"]): [number, number][] {
  if (!Number.isInteger(window) || window < 1) throw new Error(`window must be a positive integer, got ${window}`);
  const chunks: [number, number][] = [];
  let start = 0;
  while (start < tokens.length) {
    let end = Math.min(start + window, tokens.length);
    if (end < tokens.length) {
      for (let i = end - 1; i > start; i--) {
        if (endTokens.includes(tokens[i]!)) {
          end = i + 1;
          break;
        }
      }
    }
    chunks.push([start, end]);
    start = end;
  }
  return chunks;
}
