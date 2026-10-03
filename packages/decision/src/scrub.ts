/**
 * What records and models may be shown of text and of JSON a person or an agent wrote: the
 * same text and the same facts with the secrets they carry removed. One scrubber for every
 * path that stores or shows such text (permission requests, the user's words, tool titles,
 * the stuck fork's goal and actions), so that a secret is removed the same way everywhere.
 *
 * It takes time linear in the text, whatever the text is: no pattern here has two unbounded
 * parts that can trade characters, and a name is found by one scan over the text (a name
 * is a run of word characters; see `scrubText`). The work on a value of many strings is
 * bounded by a budget shared by all of it (`scrubJson`), not only by the cut of each string.
 *
 * It is a heuristic that removes what it can tell is a secret by its name or its shape. What
 * it does not catch (the limits, kept in the open):
 *
 * - a secret with no name near it and no shape of its own: a password typed after `mysql -p`
 *   with no quote, a password piped to a command, a secret in prose;
 * - a value of a secret-named key that continues past a delimiter in a shell command
 *   (`token=a;b` ends at the `;`; a quoted or JSON value, and a cookie, go whole);
 * - short flags other than `-u`, `-U` and a quoted `-p`: `curl -b sid=abc`, `-H` values whose
 *   header name is not secret-like;
 * - a JSON value that is an object or an array under a secret-named key inside a string (in
 *   structured input the whole value is removed).
 */
import type { Json } from "./types.ts";

export const REDACTED = "[redacted]";
/** What stands for the part of a value that was cut. */
export const TRUNCATED = "[truncated]";
/** Text is cut to this many characters (before it is searched for secrets) unless a length is given. */
export const SCAN_LIMIT = 4096;

/** Levels of JSON followed. */
const DEPTH = 16;
/** The characters scrubbed in one value are at most this many times the cut of one string. */
const BUDGET_STRINGS = 64;
/** The values (entries, items, strings and the rest) scrubbed in one value. */
const BUDGET_VALUES = 2048;

// ---- names ----------------------------------------------------------------------------------------------

/**
 * A name that says its value is secret: it holds token, key, secret, password, credential,
 * cookie or auth (but not author or authority), or has a part (between . _ -) that is
 * session, sessionid, sid, sig or signature. Linear in the name.
 */
const SECRET_NAME = /token|key|secret|passw(?:or)?d|credential|cookie|auth(?!or(?!iz))|(?:^|[._-])(?:sig|signature|session|sessionid|sid)(?![^._-])/i;
export const secretName = (name: string): boolean => SECRET_NAME.test(name);

/** The flags that take a user and a password as `user:password`. */
const USER_FLAG = /^(?:-u|--user|--proxy-user)$/i;

/** What a command-line word asks for the next argument of: a secret (`--password`) or `user:password`. */
function flagKind(word: string): "secret" | "user" | undefined {
  if (USER_FLAG.test(word)) return "user";
  return word.startsWith("--") && secretName(word) ? "secret" : undefined;
}

// ---- text -----------------------------------------------------------------------------------------------

/** The schemes of an authorization header: `Authorization: Bearer <token>` is two words, and both go. */
const SCHEME = /^(?:bearer|basic|digest|token|negotiate)$/i;
const BEARER_WORD = /^bearer$/i;
// A bearer token (the characters of a base64 or JWT token).
const BEARER_TOKEN = /[\w.~+/=-]*/y;
// An unquoted value ends at whitespace, a quote, or a shell operator (which a secret could not contain unquoted).
const UNQUOTED = /[^\s"'&;|]*/y;
// ... in a url's query, at the next parameter, the fragment, whitespace or a quote.
const QUERY_VALUE = /[^&\s#"']*/y;
// A cookie header holds several values; it ends with its line (or the quote that closes it).
const LINE_VALUE = /[^\n"']*/y;
const USERINFO_RUN = /[^/\s@"']*/y;
const SPACE = /\s/;

const isQuote = (c: string | undefined): boolean => c === '"' || c === "'";
const isSpace = (c: string | undefined): boolean => SPACE.test(c ?? "");
// A word is a run of letters, digits and _ . -
const WORD = /[\w.-]+/g;
// A character of a url's scheme (letters, digits and + . -), and a letter.
const SCHEME_CHAR = /[\w.+-]/;
const LETTER = /[A-Za-z]/;

/** Where the sticky pattern's match from `at` ends (the patterns above match nothing or more, so there is always one). */
function runOf(pattern: RegExp, text: string, at: number): number {
  pattern.lastIndex = at;
  pattern.exec(text);
  return pattern.lastIndex;
}

const skipSpace = (text: string, at: number): number => {
  let i = at;
  while (isSpace(text[i])) i += 1;
  return i;
};

/** Whether a quoted value starts at `at`: a quote, or a backslash and a quote (a JSON string inside a string). */
const startsQuoted = (text: string, at: number): boolean => isQuote(text[at]) || (text[at] === "\\" && isQuote(text[at + 1]));

/**
 * Where the quoted value that starts at `at` ends: after its closing quote, or at the end of
 * the text when it is not closed (what follows an open quote is taken as the secret). A quote
 * that was escaped does not close a quote that was not, and the other way round.
 */
function quotedEnd(text: string, at: number): number {
  const escaped = text[at] === "\\";
  const quote = text[at + (escaped ? 1 : 0)]!;
  let from = at + (escaped ? 2 : 1);
  for (;;) {
    const close = text.indexOf(quote, from);
    if (close === -1) return text.length;
    if ((text[close - 1] === "\\") === escaped) return close + 1;
    from = close + 1;
  }
}

/** Where the value that starts at `at` ends: quoted as above, or as far as the pattern runs. */
const valueEnd = (text: string, at: number, pattern: RegExp): number => (startsQuoted(text, at) ? quotedEnd(text, at) : runOf(pattern, text, at));

interface Span {
  readonly from: number;
  readonly to: number;
}

/** The value at `from`, or nothing when there is none (an empty value hides nothing). */
function valueAt(text: string, from: number, pattern: RegExp): Span | undefined {
  const to = valueEnd(text, from, pattern);
  return to > from ? { from, to } : undefined;
}

/** After a name, the closing quote it may have (a JSON key), the = or :, and the space around it: where the value starts. */
function afterSeparator(text: string, end: number): number | undefined {
  let at = end;
  if (text[at] === "\\" && isQuote(text[at + 1])) at += 2;
  else if (isQuote(text[at])) at += 1;
  at = skipSpace(text, at);
  if (text[at] !== "=" && text[at] !== ":") return undefined;
  return skipSpace(text, at + 1);
}

/** A value that is only a scheme (`Bearer`, `Basic`) is followed by its token: both are the secret. */
function withScheme(text: string, value: Span | undefined): Span | undefined {
  if (value === undefined || !SCHEME.test(text.slice(value.from, value.to))) return value;
  const token = valueAt(text, skipSpace(text, value.to), UNQUOTED);
  return token === undefined ? value : { from: value.from, to: token.to };
}

/** The secret that the word at [start, end) introduces, if it is a name that asks for one. */
function secretOf(text: string, start: number, end: number): Span | undefined {
  const word = text.slice(start, end);
  if (BEARER_WORD.test(word)) {
    return valueAt(text, skipSpace(text, end), BEARER_TOKEN);
  }
  if (secretName(word)) {
    const before = text[start - 1];
    if ((before === "?" || before === "&") && text[end] === "=") return valueAt(text, end + 1, QUERY_VALUE);
    const value = afterSeparator(text, end);
    if (value !== undefined) return withScheme(text, valueAt(text, value, word.toLowerCase().includes("cookie") ? LINE_VALUE : UNQUOTED));
    // a flag with the value after it: `--token abc`, `--password 'a b'` (not another flag)
    const next = skipSpace(text, end);
    return word.startsWith("--") && next > end && text[next] !== "-" ? valueAt(text, next, UNQUOTED) : undefined;
  }
  if (word === "-p" && isQuote(text[end])) return { from: end, to: quotedEnd(text, end) };
  if (USER_FLAG.test(word)) {
    // `-u bob:pw`, `--user=bob:pw`: the password after the first colon of the argument goes, the user stays
    // Stryker disable next-line ArithmeticOperator: equivalent; from the flag's last character the argument ends and has its colon in the same places
    const at = text[end] === "=" ? end + 1 : skipSpace(text, end);
    const to = valueEnd(text, at, UNQUOTED);
    const colon = text.slice(at, to).indexOf(":");
    return colon === -1 ? undefined : { from: at + colon + 1, to };
  }
  return undefined;
}

/** Every secret that a name, a flag or a header asks for. One pass over the words of the text. */
function redactNamed(text: string): string {
  const pieces: string[] = [];
  let copied = 0;
  WORD.lastIndex = 0;
  for (let word = WORD.exec(text); word !== null; word = WORD.exec(text)) {
    const secret = secretOf(text, word.index, word.index + word[0].length);
    if (secret === undefined) continue;
    pieces.push(text.slice(copied, secret.from), REDACTED);
    copied = secret.to;
    WORD.lastIndex = secret.to;
  }
  pieces.push(text.slice(copied));
  return pieces.join("");
}

/** The credentials in urls (`scheme://user:password@host`). */
function redactUserinfo(text: string): string {
  const pieces: string[] = [];
  let copied = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", at + 3)) {
    // a scheme is letters, digits and + . - with a letter among them
    let back = at;
    let scheme = false;
    while (!scheme && SCHEME_CHAR.test(text.charAt(back - 1))) {
      back -= 1;
      scheme = LETTER.test(text.charAt(back));
    }
    if (!scheme) continue;
    const from = at + 3;
    const to = runOf(USERINFO_RUN, text, from);
    if (to === from || text[to] !== "@") continue;
    pieces.push(text.slice(copied, from), REDACTED);
    copied = to;
  }
  pieces.push(text.slice(copied));
  return pieces.join("");
}

/**
 * Text with the secrets it carries removed: authorization headers, bearer tokens, the
 * credentials in urls, and the values that names and flags for secret-like names ask for (`name=value`,
 * `name: value`, the JSON `"name": "value"` with either quote and escaped quotes, `--flag value`,
 * cookies, `-u user:password`, `-p'password'`, url query parameters). Cut to `chars` first, which
 * bounds the work: the time is linear in the characters kept, whatever they are.
 */
export function scrubText(text: string, chars: number): string {
  return redactNamed(redactUserinfo(text.slice(0, chars)));
}

// ---- JSON -----------------------------------------------------------------------------------------------

/** What a value may still use: characters and values, shared by everything in it. */
interface Budget {
  chars: number;
  values: number;
}

const spent = (budget: Budget): boolean => budget.chars <= 0 || budget.values <= 0;

/** A value removed still counts as a value looked at. */
function redacted(budget: Budget, value: string = REDACTED): string {
  budget.values -= 1;
  return value;
}

/** The header, given as a name and a value in an object, whose name is secret: its `value` is. */
function isSecretPair(value: { readonly [key: string]: Json }): boolean {
  return (["name", "header"] as const).some((field) => {
    const name = value[field];
    return typeof name === "string" && secretName(name);
  });
}

function scrubItems(items: readonly Json[], chars: number, depth: number, budget: Budget): Json[] {
  const out: Json[] = [];
  let flag: ReturnType<typeof flagKind>;
  for (const item of items) {
    if (spent(budget)) {
      out.push(TRUNCATED);
      break;
    }
    // the argument after a flag that asks for a secret, in a list of arguments
    const asked = flag;
    flag = typeof item === "string" ? flagKind(item) : undefined;
    if (typeof item === "string" && asked === "secret" && !item.startsWith("-")) out.push(redacted(budget));
    else if (typeof item === "string" && asked === "user" && item.includes(":")) out.push(redacted(budget, `${item.slice(0, item.indexOf(":") + 1)}${REDACTED}`));
    else out.push(walk(item, chars, depth + 1, budget));
  }
  return out;
}

function scrubEntries(value: { readonly [key: string]: Json }, chars: number, depth: number, budget: Budget): { [key: string]: Json } {
  const entries = Object.entries(value);
  const pair = isSecretPair(value);
  const out: { [key: string]: Json } = {};
  for (const [index, [key, item]] of entries.entries()) {
    if (spent(budget)) {
      out[TRUNCATED] = entries.length - index;
      break;
    }
    const name = key.slice(0, chars);
    budget.chars -= name.length;
    out[name] = secretName(key) || (pair && key === "value") ? redacted(budget) : walk(item, chars, depth + 1, budget);
  }
  return out;
}

function walk(value: Json, chars: number, depth: number, budget: Budget): Json {
  budget.values -= 1;
  if (typeof value === "string") {
    if (budget.chars <= 0) return TRUNCATED;
    const kept = value.slice(0, Math.min(chars, budget.chars));
    budget.chars -= kept.length;
    return scrubText(kept, chars);
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= DEPTH) return TRUNCATED;
  return Array.isArray(value) ? scrubItems(value as readonly Json[], chars, depth, budget) : scrubEntries(value as { readonly [key: string]: Json }, chars, depth, budget);
}

/**
 * A JSON value with its secrets removed: the value of a key named like a secret (see
 * `secretName`), at any depth; the `value` next to a `name` or `header` that is; the argument
 * after a secret flag in a list of arguments; and, in every string, what `scrubText` removes.
 * Sixteen levels are followed. What one value costs to scrub is bounded as a whole, not by
 * string: at most 64 times `chars` characters and 2048 values are looked at, and what lies
 * beyond is cut (`[truncated]`, or for an object the number of entries cut, under that name).
 */
export function scrubJson(value: Json, chars: number): Json {
  return walk(value, chars, 0, { chars: chars * BUDGET_STRINGS, values: BUDGET_VALUES });
}
