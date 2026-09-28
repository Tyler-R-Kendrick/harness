import { builtin, execute, ScriptError } from "./ecmascript.ts";
import type { Value } from "./ecmascript.ts";
import { DocumentError, elements, parseXml, resolvePath, textOf } from "./xml.ts";
import type { XNode } from "./xml.ts";

/**
 * SRGS 1.0 grammars (W3C Speech Recognition Grammar Specification), in their XML and
 * ABNF forms, matched against text: a grammar accepts an utterance when its root rule
 * derives the utterance's words, and its SISR tags (Semantic Interpretation for Speech
 * Recognition, `semantics/1.0` or `semantics/1.0-literals`) make the interpretation.
 * No JavaScript library implements SRGS for text; see ADR 0012.
 */

export type Expansion =
  | { readonly type: "words"; readonly words: readonly string[] }
  /** A rule, by qualified name `<file>#<id>`; `<file>#` is that file's root rule. */
  | { readonly type: "ref"; readonly rule: string }
  | { readonly type: "null" }
  | { readonly type: "void" }
  | { readonly type: "garbage" }
  | { readonly type: "seq"; readonly items: readonly Expansion[] }
  /** Alternatives, the heaviest first. */
  | { readonly type: "alt"; readonly items: readonly Expansion[] }
  | { readonly type: "repeat"; readonly item: Expansion; readonly min: number; readonly max: number }
  | { readonly type: "tag"; readonly code: string };

/** One grammar file's rules, by qualified name. */
export interface Grammar {
  readonly file: string;
  readonly root: string;
  readonly rules: Readonly<Record<string, Expansion>>;
  /** Tags are the rule's value as literal text (`semantics/1.0-literals`), not script. */
  readonly literals: boolean;
}

/** Grammars that may refer to each other's rules, by file. */
export type Grammars = ReadonlyMap<string, Grammar>;

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** A word without the punctuation around it (in time linear in its length). */
function trimWord(word: string): string {
  const chars = Array.from(word);
  let start = 0;
  let end = chars.length;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent; a scan past the last character reads undefined, which tests as the word "undefined" and stops it there anyway
  while (start < end && !WORD_CHAR.test(chars[start]!)) start++;
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent; a scan below the start stops at a word character or at chars[-1], and either way the slice from start is empty
  while (end > start && !WORD_CHAR.test(chars[end - 1]!)) end--;
  return chars.slice(start, end).join("");
}

// Stryker disable Regex: equivalent; splitting on single spaces leaves empty words, which the filter drops
/** An utterance's words as grammars see them: lower case, without punctuation around them. */
export const wordsOf = (text: string): string[] =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .map(trimWord)
    .filter((w) => w !== "");
// Stryker restore Regex

const seq = (items: Expansion[]): Expansion => (items.length === 1 ? items[0]! : { type: "seq", items });

function repeatOf(spec: string, where: string): { min: number; max: number } {
  const m = /^\s*(\d+)\s*(?:(-)\s*(\d*))?\s*$/.exec(spec);
  if (!m) throw new DocumentError(`${where}: repeat "${spec}" is not n, n-m or n-`);
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : m[3] === "" ? Number.POSITIVE_INFINITY : Number(m[3]);
  if (max < min || max === 0) throw new DocumentError(`${where}: repeat "${spec}" is empty`);
  return { min, max };
}

const byWeight = (items: readonly { readonly expansion: Expansion; readonly weight: number }[]): Expansion => ({
  type: "alt",
  items: [...items].sort((a, b) => b.weight - a.weight).map((i) => i.expansion),
});

function weightOf(spec: string | undefined, where: string): number {
  if (spec === undefined) return 1;
  const w = Number(spec);
  if (!Number.isFinite(w) || w < 0) throw new DocumentError(`${where}: weight "${spec}" is not a non-negative number`);
  return w;
}

/** A rule reference's qualified name: a local `#rule`, else a file (relative to the referring one) and its rule or root. */
function refOf(uri: string, file: string): string {
  if (uri.startsWith("#")) return `${file}${uri}`;
  const hash = uri.indexOf("#");
  // Stryker disable next-line EqualityOperator: equivalent; hash is never 0 here, a uri starting with # having returned above
  const path = hash < 0 ? uri : uri.slice(0, hash);
  // Stryker disable next-line EqualityOperator: equivalent; hash is never 0 here, a uri starting with # having returned above
  return `${resolvePath(file, path)}#${hash < 0 ? "" : uri.slice(hash + 1)}`;
}

const tagFormat = (format: string | undefined, where: string): boolean => {
  const f = format?.trim();
  if (f === undefined || /^semantics\/1\.0(?:\.\d+)?$/.test(f)) return false;
  if (/^semantics\/1\.0(?:\.\d+)?-literals$/.test(f)) return true;
  throw new DocumentError(`${where}: tag-format ${format} is not supported (semantics/1.0 or semantics/1.0-literals)`);
};

// ---- the XML form ------------------------------------------------------------------

function xmlExpansion(children: readonly (XNode | string)[], file: string): Expansion {
  const items: Expansion[] = [];
  for (const child of children) {
    if (typeof child === "string") {
      const words = wordsOf(child);
      if (words.length > 0) items.push({ type: "words", words });
      continue;
    }
    switch (child.name) {
      case "token": {
        const words = wordsOf(textOf(child));
        if (words.length > 0) items.push({ type: "words", words });
        break;
      }
      case "item": {
        const body = xmlExpansion(child.children, file);
        const repeat = child.attrs["repeat"];
        items.push(repeat === undefined ? body : { type: "repeat", item: body, ...repeatOf(repeat, `${file} <item>`) });
        break;
      }
      case "one-of":
        items.push(byWeight(elements(child, "item").map((item) => ({ expansion: xmlExpansion([item], file), weight: weightOf(item.attrs["weight"], `${file} <item>`) }))));
        break;
      case "ruleref": {
        const special = child.attrs["special"];
        if (special === "NULL") items.push({ type: "null" });
        else if (special === "VOID") items.push({ type: "void" });
        else if (special === "GARBAGE") items.push({ type: "garbage" });
        else if (child.attrs["uri"] !== undefined) items.push({ type: "ref", rule: refOf(child.attrs["uri"], file) });
        else throw new DocumentError(`${file}: a <ruleref> needs a uri or a special of NULL, VOID or GARBAGE`);
        break;
      }
      case "tag":
        items.push({ type: "tag", code: textOf(child).trim() });
        break;
      case "example":
      case "meta":
      case "metadata":
      case "lexicon":
        break;
      default:
        throw new DocumentError(`${file}: <${child.name}> is not an SRGS rule element`);
    }
  }
  return items.length === 0 ? { type: "null" } : seq(items);
}

/** A grammar from its XML form's `<grammar>` element (a file's, or one inline in a VoiceXML document). */
export function srgsFromXml(grammar: XNode, file: string): Grammar {
  if (grammar.name !== "grammar") throw new DocumentError(`${file}: an SRGS grammar's root is <grammar>, not <${grammar.name}>`);
  const rules: Record<string, Expansion> = {};
  const ids: string[] = [];
  for (const rule of elements(grammar, "rule")) {
    const id = rule.attrs["id"];
    if (id === undefined) throw new DocumentError(`${file}: a <rule> needs an id`);
    ids.push(id);
    rules[`${file}#${id}`] = xmlExpansion(rule.children, file);
  }
  const root = grammar.attrs["root"] ?? ids[0];
  if (root === undefined) throw new DocumentError(`${file}: the grammar has no rules`);
  if (rules[`${file}#${root}`] === undefined) throw new DocumentError(`${file}: the root rule ${root} is not defined`);
  return { file, root: `${file}#${root}`, rules, literals: tagFormat(grammar.attrs["tag-format"], file) };
}

// ---- the ABNF form -----------------------------------------------------------------

type Lexeme =
  | { readonly k: "punct"; readonly v: string }
  | { readonly k: "rule"; readonly v: string }
  | { readonly k: "uri"; readonly v: string }
  | { readonly k: "angle"; readonly v: string }
  | { readonly k: "weight"; readonly v: string }
  | { readonly k: "tag"; readonly v: string }
  | { readonly k: "word"; readonly v: string }
  | { readonly k: "quoted"; readonly v: string };

/** The lexemes of an ABNF grammar's body, which starts `base` characters into its file (so offsets are the file's). */
function lex(text: string, file: string, base: number): Lexeme[] {
  const out: Lexeme[] = [];
  let i = 0;
  const fail = (what: string): never => {
    throw new DocumentError(`${file}: ${what} at offset ${base + i}`);
  };
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      // Stryker disable next-line EqualityOperator: equivalent; the newline is found at or after the comment's own offset, never at 0 unless not found
      i = end < 0 ? text.length : end;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      // Stryker disable next-line EqualityOperator: equivalent; the close is searched from i + 2, so it is -1 or at least 2
      if (end < 0) fail("an unclosed comment");
      i = end + 2;
    } else if (";=|()[]".includes(c)) {
      out.push({ k: "punct", v: c });
      i++;
    } else if (c === "$") {
      if (text[i + 1] === "<") {
        const end = text.indexOf(">", i);
        // Stryker disable next-line EqualityOperator: equivalent; text[i] is $, so a > is -1 or at least 1
        if (end < 0) fail("an unclosed rule reference");
        out.push({ k: "uri", v: text.slice(i + 2, end).trim() });
        i = end + 1;
      } else {
        const m = /^\$([A-Za-z_][\w.:-]*)/.exec(text.slice(i));
        if (!m) fail("a rule name expected");
        out.push({ k: "rule", v: m![1]! });
        i += m![0].length;
      }
    } else if (c === "<") {
      const end = text.indexOf(">", i);
      // Stryker disable next-line EqualityOperator: equivalent; text[i] is <, so a > is -1 or at least 1
      if (end < 0) fail("an unclosed <");
      out.push({ k: "angle", v: text.slice(i + 1, end).trim() });
      i = end + 1;
    } else if (c === "/") {
      const m = /^\/\s*([\d.]+)\s*\//.exec(text.slice(i));
      if (!m) fail("a weight expected");
      out.push({ k: "weight", v: m![1]! });
      i += m![0].length;
    } else if (text.startsWith("{!{", i)) {
      const end = text.indexOf("}!}", i);
      // Stryker disable next-line EqualityOperator: equivalent; text[i] is {, so a }!} is -1 or at least 1
      if (end < 0) fail("an unclosed tag");
      out.push({ k: "tag", v: text.slice(i + 3, end).trim() });
      i = end + 3;
    } else if (c === "{") {
      const end = text.indexOf("}", i);
      // Stryker disable next-line EqualityOperator: equivalent; text[i] is {, so a } is -1 or at least 1
      if (end < 0) fail("an unclosed tag");
      out.push({ k: "tag", v: text.slice(i + 1, end).trim() });
      i = end + 1;
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      // Stryker disable next-line EqualityOperator: equivalent; the close is searched from i + 1, so it is -1 or at least 1
      if (end < 0) fail("an unclosed quote");
      out.push({ k: "quoted", v: text.slice(i + 1, end) });
      i = end + 1;
    } else {
      const m = /^[^\s;=|()[\]{}<>"/$]+/.exec(text.slice(i));
      if (!m) fail(`unexpected ${JSON.stringify(c)}`);
      // A language attachment (word!en-US) says how to pronounce the word: text ignores it.
      // Stryker disable next-line Regex: equivalent; a word has no whitespace, so no newline for $ to stop before
      out.push({ k: "word", v: m![0].replace(/!.*$/, "") });
      i += m![0].length;
    }
  }
  return out;
}

/** A grammar from its ABNF form (`#ABNF 1.0;` and on). */
export function srgsFromAbnf(text: string, file: string): Grammar {
  const header = /^\s*#ABNF\s+1\.0[^;]*;/.exec(text);
  if (!header) throw new DocumentError(`${file}: an ABNF grammar starts with "#ABNF 1.0;"`);
  const lexemes = lex(text.slice(header[0].length), file, header[0].length);
  let at = 0;
  const peek = () => lexemes[at];
  const is = (k: Lexeme["k"], v?: string) => peek()?.k === k && (v === undefined || peek()!.v === v);
  const expect = (k: Lexeme["k"], v?: string): Lexeme => {
    if (!is(k, v)) throw new DocumentError(`${file}: expected ${v ?? k}, not ${peek() ? JSON.stringify(peek()!.v) : "the end"}`);
    return lexemes[at++]!;
  };
  const until = () => {
    // Stryker disable next-line EqualityOperator: equivalent; one step past the end reads no ; and fails the same expect
    while (at < lexemes.length && !is("punct", ";")) at++;
    expect("punct", ";");
  };

  let root: string | undefined;
  let literals = false;
  const rules: Record<string, Expansion> = {};
  const order: string[] = [];

  const unit = (): Expansion | undefined => {
    const l = peek();
    if (!l) return undefined;
    let x: Expansion;
    if (l.k === "word") {
      at++;
      x = { type: "words", words: wordsOf(l.v) };
    } else if (l.k === "quoted") {
      at++;
      x = { type: "words", words: wordsOf(l.v) };
    } else if (l.k === "rule") {
      at++;
      x = l.v === "NULL" ? { type: "null" } : l.v === "VOID" ? { type: "void" } : l.v === "GARBAGE" ? { type: "garbage" } : { type: "ref", rule: `${file}#${l.v}` };
    } else if (l.k === "uri") {
      at++;
      x = { type: "ref", rule: refOf(l.v, file) };
    } else if (l.k === "tag") {
      at++;
      return { type: "tag", code: l.v };
    } else if (is("punct", "(")) {
      at++;
      x = alternatives();
      expect("punct", ")");
    } else if (is("punct", "[")) {
      at++;
      x = { type: "repeat", item: alternatives(), min: 0, max: 1 };
      expect("punct", "]");
    } else {
      return undefined;
    }
    while (is("angle")) {
      const spec = lexemes[at++]!.v.replace(/\/.*$/, "");
      x = { type: "repeat", item: x, ...repeatOf(spec, `${file} <${spec}>`) };
    }
    return x;
  };
  const sequence = (): Expansion => {
    const items: Expansion[] = [];
    for (let u = unit(); u !== undefined; u = unit()) if (!(u.type === "words" && u.words.length === 0)) items.push(u);
    if (items.length === 0) throw new DocumentError(`${file}: an empty expansion`);
    return seq(items);
  };
  const alternatives = (): Expansion => {
    const items: { expansion: Expansion; weight: number }[] = [];
    for (;;) {
      const weight = is("weight") ? weightOf(lexemes[at++]!.v, file) : 1;
      items.push({ expansion: sequence(), weight });
      if (!is("punct", "|")) break;
      at++;
    }
    return items.length === 1 ? items[0]!.expansion : byWeight(items);
  };

  while (at < lexemes.length) {
    const l = peek()!;
    if (l.k === "word" && (l.v === "public" || l.v === "private")) {
      at++;
      continue;
    }
    if (l.k === "rule") {
      at++;
      expect("punct", "=");
      const name = `${file}#${l.v}`;
      rules[name] = alternatives();
      order.push(name);
      expect("punct", ";");
    } else if (l.k === "word" && l.v === "root") {
      at++;
      root = `${file}#${expect("rule").v}`;
      expect("punct", ";");
    } else if (l.k === "word" && l.v === "tag-format") {
      at++;
      literals = tagFormat(expect("angle").v, file);
      expect("punct", ";");
    } else if (l.k === "word" && ["language", "mode", "base", "lexicon", "meta", "http-equiv"].includes(l.v)) {
      until();
    } else if (l.k === "tag") {
      // A header tag: script run before the grammar is used, which text interpretation does not need.
      at++;
      expect("punct", ";");
    } else {
      throw new DocumentError(`${file}: unexpected ${JSON.stringify(l.v)}`);
    }
  }
  const start = root ?? order[0];
  if (start === undefined) throw new DocumentError(`${file}: the grammar has no rules`);
  if (rules[start] === undefined) throw new DocumentError(`${file}: the root rule ${start.slice(file.length + 1)} is not defined`);
  return { file, root: start, rules, literals };
}

/** A grammar file in either form. */
export const parseSrgs = (text: string, file: string): Grammar => (/^\s*</.test(text) ? srgsFromXml(parseXml(text, file), file) : srgsFromAbnf(text, file));

/** Every rule reference resolves in `grammars`; throws naming the first that does not. */
export function checkRefs(grammar: Grammar, grammars: Grammars): void {
  const visit = (x: Expansion): void => {
    if (x.type === "ref") resolve(x.rule, grammars);
    else if (x.type === "seq" || x.type === "alt") x.items.forEach(visit);
    else if (x.type === "repeat") visit(x.item);
  };
  Object.values(grammar.rules).forEach(visit);
}

function resolve(rule: string, grammars: Grammars): { name: string; body: Expansion; grammar: Grammar } {
  // A rule id has no #: the last one ends the file's name.
  const hash = rule.lastIndexOf("#");
  const grammar = grammars.get(rule.slice(0, hash));
  const name = grammar && rule.endsWith("#") ? grammar.root : rule;
  const body = grammar?.rules[name];
  if (!grammar || body === undefined) throw new DocumentError(`rule ${rule} is not defined`);
  return { name, body, grammar };
}

// ---- matching ----------------------------------------------------------------------

type Event = { readonly t: "word"; readonly w: string } | { readonly t: "tag"; readonly code: string; readonly literals: boolean } | { readonly t: "enter"; readonly rule: string } | { readonly t: "exit" };
type Trail = { readonly ev: Event; readonly prev: Trail | undefined };

class OutOfSteps extends Error {}

const MAX_DEPTH = 1000;

/** What a grammar made of an utterance: its interpretation and the words it matched. */
export interface GrammarMatch {
  readonly value: unknown;
  readonly text: string;
}

/**
 * Whether `grammar` (with the grammars it refers to) accepts all of `utterance`, and the
 * interpretation if it does. The first derivation found is taken (alternatives heaviest
 * first, repeats longest first). Matching takes at most `steps` steps, so a grammar that
 * would take long (or recurse on the left) does not match.
 */
export function matchSrgs(grammar: Grammar, grammars: Grammars, utterance: string, steps = 20000): GrammarMatch | undefined {
  const words = wordsOf(utterance);
  let taken = 0;
  // Continuations nest: the stack grows with the derivation, so its depth is bounded too.
  let depth = 0;
  const m = (x: Expansion, pos: number, trail: Trail | undefined, k: (pos: number, trail: Trail | undefined) => Trail | undefined, literals: boolean): Trail | undefined => {
    if (++taken > steps || depth > MAX_DEPTH) throw new OutOfSteps();
    depth++;
    try {
      return step(x, pos, trail, k, literals);
    } finally {
      depth--;
    }
  };
  const step = (x: Expansion, pos: number, trail: Trail | undefined, k: (pos: number, trail: Trail | undefined) => Trail | undefined, literals: boolean): Trail | undefined => {
    switch (x.type) {
      case "words": {
        let t = trail;
        for (const [i, w] of x.words.entries()) {
          if (words[pos + i] !== w) return undefined;
          t = { ev: { t: "word", w }, prev: t };
        }
        return k(pos + x.words.length, t);
      }
      case "null":
        return k(pos, trail);
      // Stryker disable next-line StringLiteral: equivalent; an expansion of no listed type falls out of the switch, returning undefined as void does
      case "void":
        return undefined;
      case "garbage": {
        let t = trail;
        for (let end = pos; end <= words.length; end++) {
          const found = k(end, t);
          if (found) return found;
          if (end < words.length) t = { ev: { t: "word", w: words[end]! }, prev: t };
        }
        return undefined;
      }
      case "seq": {
        const from = (i: number, p: number, t: Trail | undefined): Trail | undefined => (i === x.items.length ? k(p, t) : m(x.items[i]!, p, t, (q, u) => from(i + 1, q, u), literals));
        return from(0, pos, trail);
      }
      case "alt": {
        for (const item of x.items) {
          const found = m(item, pos, trail, k, literals);
          if (found) return found;
        }
        return undefined;
      }
      case "repeat": {
        const again = (count: number, p: number, t: Trail | undefined): Trail | undefined => {
          if (count < x.max) {
            // An iteration that consumed nothing is not repeated past the minimum.
            const found = m(x.item, p, t, (q, u) => (q === p && count >= x.min ? undefined : again(count + 1, q, u)), literals);
            if (found) return found;
          }
          return count >= x.min ? k(p, t) : undefined;
        };
        return again(0, pos, trail);
      }
      case "ref": {
        const { name, body, grammar: g } = resolve(x.rule, grammars);
        return m(body, pos, { ev: { t: "enter", rule: name }, prev: trail }, (q, u) => k(q, { ev: { t: "exit" }, prev: u }), g.literals);
      }
      case "tag":
        return k(pos, { ev: { t: "tag", code: x.code, literals }, prev: trail });
    }
  };
  let found: Trail | undefined;
  try {
    found = m({ type: "ref", rule: grammar.root }, 0, undefined, (pos, trail) => (pos === words.length ? trail : undefined), grammar.literals);
  } catch (e) {
    if (e instanceof OutOfSteps) return undefined;
    throw e;
  }
  if (!found) return undefined;
  const events: Event[] = [];
  for (let t: Trail | undefined = found; t; t = t.prev) events.push(t.ev);
  return { value: interpret(events.reverse()), text: words.join(" ") };
}

interface Frame {
  readonly id: string;
  out: Value;
  tagged: boolean;
  readonly rules: Record<string, Value>;
  latest: Value;
  /** A rule reference in it has been matched (so `rules.latest()` is its value). */
  referred: boolean;
  readonly meta: Record<string, Value>;
  readonly words: string[];
}

/**
 * SISR: each rule's value is what its tags made `out`; a rule with no tags takes the value
 * of the last rule it referred to (`rules.latest()`), or its words when it referred to none.
 */
function interpret(events: readonly Event[]): unknown {
  const stack: Frame[] = [];
  let result: unknown;
  for (const ev of events) {
    if (ev.t === "enter") {
      stack.push({ id: ev.rule.slice(ev.rule.lastIndexOf("#") + 1), out: {}, tagged: false, rules: {}, latest: undefined, referred: false, meta: {}, words: [] });
    } else if (ev.t === "word") {
      for (const f of stack) f.words.push(ev.w);
    } else if (ev.t === "tag") {
      const f = stack[stack.length - 1]!;
      f.tagged = true;
      if (ev.literals) {
        f.out = ev.code;
        continue;
      }
      const scope: Record<string, Value> = {
        out: f.out,
        rules: { ...f.rules, latest: builtin(() => f.latest) },
        meta: { ...f.meta, current: builtin(() => ({ text: f.words.join(" ") })) },
      };
      try {
        execute(ev.code, [scope]);
      } catch (e) {
        throw new ScriptError(`tag {${ev.code}}: ${(e as Error).message}`);
      }
      f.out = scope["out"];
    } else {
      const f = stack.pop()!;
      const value = f.tagged ? f.out : f.referred ? f.latest : f.words.join(" ");
      const parent = stack[stack.length - 1];
      if (!parent) {
        result = value;
        continue;
      }
      parent.rules[f.id] = value;
      parent.latest = value;
      parent.referred = true;
      parent.meta[f.id] = { text: f.words.join(" ") };
    }
  }
  return result;
}
