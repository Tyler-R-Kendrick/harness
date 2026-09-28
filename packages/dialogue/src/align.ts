/**
 * Template mining without a model, as log parsers (Drain) mine log lines: texts that say
 * the same thing are aligned token by token, what they all share is fixed text, and the
 * rest are gaps, with each text's value in each gap.
 */

const TOKEN = /\s+|[\p{L}\p{N}]+(?:['’.\-_][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu;

/** Words (with inner apostrophes, dots, hyphens and underscores), whitespace runs and single other characters; joined, they are the text. */
export function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

const blank = (s: string) => s.trim() === "";
const leading = (s: string) => s.slice(0, s.length - s.trimStart().length);
const trailing = (s: string) => s.slice(s.trimEnd().length);

function commonPrefix(a: string, b: string): string {
  let n = 0;
  while (n < a.length && a[n] === b[n]) n++;
  return a.slice(0, n);
}

function commonSuffix(a: string, b: string): string {
  let n = 0;
  while (n < a.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return a.slice(a.length - n);
}

/**
 * A longest common subsequence of `a` and `b`, as index pairs in order. Where two are
 * equally long, the one using `a`'s later tokens is taken, so the result is the same
 * every time.
 */
export function commonSubsequence(a: readonly string[], b: readonly string[], same: (x: string, y: string) => boolean): [number, number][] {
  // longest[i][j]: the length of a longest common subsequence of a[i:] and b[j:].
  const longest = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) longest[i]![j] = same(a[i]!, b[j]!) ? longest[i + 1]![j + 1]! + 1 : Math.max(longest[i + 1]![j]!, longest[i]![j + 1]!);
  const pairs: [number, number][] = [];
  // Equal tokens always start some longest subsequence of what follows them.
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (same(a[i]!, b[j]!)) pairs.push([i++, j++]);
    else if (longest[i + 1]![j]! >= longest[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** Texts aligned: `segments[0]`, gap 0, `segments[1]`, ..., gap n-1, `segments[n]`. */
export interface Alignment {
  /** The fixed text around the gaps; the first and last may be empty. */
  readonly segments: readonly string[];
  /** Each text's value in each gap (`values[text][gap]`), without surrounding whitespace. */
  readonly values: readonly (readonly string[])[];
}

interface Raw {
  segments: string[];
  /** Untrimmed values, `values[text][gap]`. */
  values: string[][];
}

/** Remove gap `g`, joining the segments around it with `between` (per text, the same for all). */
function closeGap(raw: Raw, g: number, between: string): void {
  raw.segments.splice(g, 2, raw.segments[g]! + between + raw.segments[g + 1]!);
  for (const v of raw.values) v.splice(g, 1);
}

/**
 * Align texts: a longest common subsequence of their tokens, taken text by text, is the
 * fixed text; wherever any text has something between two of its tokens, or before the
 * first or after the last, there is a gap. Gaps separated only by whitespace are one
 * gap; a gap that is only ever whitespace is fixed, as the first text has it; whitespace
 * all values start or end with belongs to the fixed text. With `ignoreCase`, words
 * that differ only in case are shared, and the fixed text is spelled as the first text
 * spells it.
 */
export function align(texts: readonly string[], options: { readonly ignoreCase?: boolean } = {}): Alignment {
  const same = options.ignoreCase ? (x: string, y: string) => x.toLowerCase() === y.toLowerCase() : (x: string, y: string) => x === y;
  const toks = texts.map(tokens);
  let fixed = toks[0] ?? [];
  for (const t of toks) fixed = commonSubsequence(fixed, t, same).map(([i]) => fixed[i]!);
  // Where each text has the fixed tokens, between a token before its first and one after its last.
  const bounds = toks.map((t) => [-1, ...commonSubsequence(fixed, t, same).map(([, j]) => j), t.length]);
  // What text t has before fixed token k (k = fixed.length: after the last).
  const before = (t: number, k: number) => toks[t]!.slice(bounds[t]![k]! + 1, bounds[t]![k + 1]).join("");

  const raw: Raw = { segments: [""], values: toks.map(() => []) };
  for (let k = 0; k <= fixed.length; k++) {
    if (toks.some((_, t) => before(t, k) !== "")) {
      raw.values.forEach((v, t) => v.push(before(t, k)));
      raw.segments.push("");
    }
    raw.segments[raw.segments.length - 1] += fixed[k] ?? "";
  }

  // Gaps only whitespace apart are one gap.
  for (let g = raw.segments.length - 2; g >= 1; g--) {
    const between = raw.segments[g]!;
    if (!blank(between)) continue;
    raw.segments.splice(g, 1);
    for (const v of raw.values) v.splice(g - 1, 2, v[g - 1]! + between + v[g]!);
  }
  // A gap that is only ever whitespace is fixed text.
  for (let g = raw.segments.length - 2; g >= 0; g--) if (raw.values.every((v) => blank(v[g]!))) closeGap(raw, g, raw.values[0]![g]!);
  // Whitespace every value starts (ends) with is fixed text before (after) the gap.
  raw.segments.slice(0, -1).forEach((_, g) => {
    const vs = raw.values.map((v) => v[g]!);
    if (vs.some(blank)) return;
    const lead = vs.map(leading).reduce(commonPrefix);
    const trail = vs.map(trailing).reduce(commonSuffix);
    raw.segments[g] += lead;
    raw.segments[g + 1] = trail + raw.segments[g + 1]!;
  });
  return { segments: raw.segments, values: raw.values.map((v) => v.map((s) => s.trim())) };
}

const words = (text: string) => tokens(text.toLowerCase()).filter((t) => !blank(t));

/**
 * How alike two texts are in shape (Drain's similarity): the share of positions holding
 * the same word, ignoring case and whitespace; texts of different lengths are not alike.
 */
export function shapeSimilarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.length !== y.length) return 0;
  if (x.length === 0) return 1;
  return x.filter((w, i) => w === y[i]).length / x.length;
}
