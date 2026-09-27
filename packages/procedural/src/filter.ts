/**
 * The deterministic edit filter (plan §9). Text a refiner or reflection writes into a
 * graph is read by every later session on that graph, so a tool output that smuggles an
 * instruction into guidance becomes a persistent prompt injection. The filter rejects
 * text that copies a long run of its source observations, and text that carries what a
 * procedure never needs: URLs, absolute paths, high-entropy strings and secrets.
 *
 * A finding says what was found, never the matched text itself, so a rejection that is
 * shown back to a refiner does not re-inject it.
 */

export type FilterCode = "shared-ngram" | "url" | "absolute-path" | "high-entropy" | "secret";

/** One problem with one text. `text` is the text checked; `detail` describes the problem without quoting it. */
export interface FilterFinding {
  code: FilterCode;
  text: string;
  detail: string;
}

export interface EntropyOptions {
  /** The shortest run that can be high entropy. Default 20. */
  minLength?: number;
  /** Bits per character at which a hex run is high entropy. Default 3. */
  hexBits?: number;
  /** Bits per character at which any other base64-alphabet run is high entropy. Default 3.5. */
  base64Bits?: number;
}

export interface FilterOptions {
  /** How many consecutive tokens shared with an observation reject a text. Default 8. */
  ngram?: number;
  entropy?: EntropyOptions;
}

// ---- shared n-grams ------------------------------------------------------------------

/**
 * Words and numbers, case folded: punctuation, spacing and case do not hide a copy.
 * Upper then lower folds as Unicode case folding does for `ß` (`SS`) and the Kelvin sign (`k`).
 */
const tokens = (text: string): string[] => text.toUpperCase().toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Every run of `n` consecutive tokens, as one key. */
function ngrams(text: string, n: number): string[] {
  const t = tokens(text);
  const out: string[] = [];
  for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n).join(" "));
  return out;
}

/** Each n-gram of the observations, with the first observation it occurs in. */
function observationIndex(observations: readonly string[], n: number): Map<string, number> {
  const index = new Map<string, number>();
  observations.forEach((o, i) => {
    for (const g of ngrams(o, n)) if (!index.has(g)) index.set(g, i);
  });
  return index;
}

// ---- shapes ---------------------------------------------------------------------------

/** A scheme URL (`https://…`, `ftp://…`) or a bare `www.` host. */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S|\bwww\.[\w-]+\.[\w-]/i;

/**
 * Absolute paths: POSIX with at least two segments (`/etc/passwd`; a lone `/tmp` reads
 * like a slash command), home (`~/…`), a Windows drive (`C:\…`, `d:/…`) and UNC
 * (`\\server\share`). Each must start a word, so `and/or`, `a/b/c` and a URL's path
 * are not paths.
 */
const PATH_PATTERNS: readonly RegExp[] = [
  /(?<![\w.:/~\\-])\/[\w.-]+\/[\w.-]/,
  /(?<![\w.~/-])~\/[\w.-]/,
  /(?<!\w)[A-Za-z]:[\\/][\w.-]/,
  /(?<![\w\\])\\\\[\w.-]+\\[\w.$-]/,
];

/** Common secret shapes, each named in the finding. */
const SECRETS: readonly (readonly [string, RegExp])[] = [
  ["a private key header", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["an AWS access key id", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_\w{22,}/],
  ["an API key", /\bsk-[\w-]{20,}/],
  ["a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["a Google API key", /\bAIza[\w-]{35}/],
  ["a payment key", /\b[prs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["a JSON web token", /\beyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]{5,}/],
  ["a credential assignment", /\b(?:password|passwd|secret|api[_-]?key|(?:access|auth)[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/i],
];

/** Shannon entropy of a string's characters, in bits per character. */
function entropy(run: string): number {
  const counts = new Map<string, number>();
  for (const c of run) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const k of counts.values()) {
    const p = k / run.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * The length of the first run of base64 characters that looks random: long enough,
 * mixing letters and digits (so words and numbers are not), and above the entropy of
 * its alphabet's threshold (hex runs have at most 4 bits per character, so theirs is
 * lower).
 */
function highEntropyRun(text: string, options: Required<EntropyOptions>): number | undefined {
  for (const [match] of text.matchAll(/[A-Za-z0-9+/]+/g)) {
    const hex = /^(?:[0-9a-f]+|[0-9A-F]+)$/.test(match);
    const random = match.length >= options.minLength && /\d/.test(match) && /[A-Za-z]/.test(match) && entropy(match) >= (hex ? options.hexBits : options.base64Bits);
    if (random) return match.length;
  }
  return undefined;
}

// ---- the filter -------------------------------------------------------------------------

/**
 * Check each text: a run of `ngram` (8) tokens shared with any one observation, URLs,
 * absolute paths, high-entropy strings and secret shapes. Each detector reports at most
 * once per text; findings come text by text, in that detector order.
 */
export function editFilter(texts: readonly string[], observations: readonly string[], options: FilterOptions = {}): FilterFinding[] {
  const n = options.ngram ?? 8;
  const shape: Required<EntropyOptions> = { minLength: 20, hexBits: 3, base64Bits: 3.5, ...options.entropy };
  const shared = observationIndex(observations, n);
  const findings: FilterFinding[] = [];
  for (const text of texts) {
    const found = (code: FilterCode, detail: string) => findings.push({ code, text, detail });
    const copied = ngrams(text, n).find((g) => shared.has(g));
    if (copied !== undefined) found("shared-ngram", `shares ${n} consecutive tokens with observation ${shared.get(copied)}`);
    if (URL_PATTERN.test(text)) found("url", "contains a URL");
    if (PATH_PATTERNS.some((p) => p.test(text))) found("absolute-path", "contains an absolute path");
    const run = highEntropyRun(text, shape);
    if (run !== undefined) found("high-entropy", `contains a high-entropy string of ${run} characters`);
    const secret = SECRETS.find(([, pattern]) => pattern.test(text));
    if (secret !== undefined) found("secret", `contains ${secret[0]}`);
  }
  return findings;
}
