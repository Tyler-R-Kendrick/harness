import type { Interpreter, StepInput, StepResult } from "./interpreter.ts";
import { DocumentError, elements, parseXml } from "./xml.ts";
import type { XNode } from "./xml.ts";

/**
 * AIML 2.0 (the Artificial Intelligence Markup Language of ALICE and Pandorabots bots):
 * categories matched by the graphmaster (words, the wildcards `$`, `#`, `_`, `^` and `*`
 * in AIML 2.0's order, and sets), against the input, the bot's last sentence (`<that>`)
 * and the topic; templates evaluated with `<srai>` reductions, predicates, `<random>`,
 * `<condition>` and `<learn>`. A bot's files are imported as they are: `.aiml` files,
 * sets, maps, properties and substitutions in Pandorabots' JSON or Program AB's text.
 *
 * A turn the bot could only answer with its catch-all category (`*`) is handed to the
 * model, as is one reaching `<sraix>` (a question for another service): the harness's
 * model is that service. `<system>` and `<javascript>` categories are dropped.
 */

type PatternToken =
  | { readonly t: "word"; readonly w: string }
  | { readonly t: "priority"; readonly w: string }
  | { readonly t: "wild"; readonly w: "#" | "_" | "^" | "*" }
  | { readonly t: "set"; readonly name: string };

interface Category {
  readonly path: readonly PatternToken[];
  readonly template: XNode;
  /** The ultimate default: pattern, that and topic all `*`. */
  readonly catchAll: boolean;
}

interface GraphNode {
  readonly words: Map<string, GraphNode>;
  readonly priority: Map<string, GraphNode>;
  readonly sets: Map<string, GraphNode>;
  readonly wild: Map<string, GraphNode>;
  category?: Category;
}

const node = (): GraphNode => ({ words: new Map(), priority: new Map(), sets: new Map(), wild: new Map() });
// Stryker disable next-line StringLiteral: equivalent; a section marker need only differ from every word (which has no "<") and from the other marker
const THAT = "<THAT>";
// Stryker disable next-line StringLiteral: equivalent; a section marker need only differ from every word (which has no "<") and from the other marker
const TOPIC = "<TOPIC>";

interface Bot {
  readonly graph: GraphNode;
  readonly size: number;
  readonly sets: ReadonlyMap<string, readonly (readonly string[])[]>;
  readonly maps: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly properties: ReadonlyMap<string, string>;
  readonly substitutions: ReadonlyMap<string, readonly (readonly [string, string])[]>;
  readonly fallback: "model" | "bot";
}

/** Input words as AIML matches them: upper case, punctuation gone (an apostrophe joins its word). */
export const aimlWords = (text: string): string[] => {
  const spaced = text.normalize("NFKC").toUpperCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ");
  // Stryker disable next-line Regex: equivalent; the empty words a split at each space leaves are filtered out
  return spaced.split(/\s+/).filter((w) => w !== "");
};

// ---- compiling ---------------------------------------------------------------------

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("//"));
const pairs = (text: string, file: string): [string, string][] => {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "string"))) throw new DocumentError(`${file}: expected [["key", "value"], ...]`);
    return parsed as [string, string][];
  }
  return lines(trimmed).map((l) => {
    const quoted = /^"(.*)"\s*,\s*"(.*)"$/.exec(l);
    if (quoted) return [quoted[1]!, quoted[2]!];
    const at = l.indexOf(":");
    if (at < 0) throw new DocumentError(`${file}: expected key:value, not ${JSON.stringify(l)}`);
    return [l.slice(0, at).trim(), l.slice(at + 1).trim()];
  });
};

const baseName = (file: string) => {
  // Stryker disable next-line Regex: equivalent; a greedy .* reaching a "/" starts at the start anyway
  const name = file.replace(/^.*\//, "");
  return name.replace(/\.[^.]+$/, "").toLowerCase();
};

const UNSUPPORTED = new Set(["system", "javascript"]);
const IGNORED_TEMPLATE = new Set(["interval", "uniq", "select", "addtriple", "deletetriple", "search", "gossip"]);
const KNOWN = new Set([
  "star", "thatstar", "topicstar", "that", "input", "request", "response", "get", "set", "think", "srai", "sr", "sraix", "random", "li", "condition", "loop", "bot", "uppercase", "lowercase", "formal", "sentence", "explode",
  "normalize", "denormalize", "person", "person2", "gender", "date", "size", "version", "id", "program", "vocabulary", "map", "learn", "learnf", "eval", "first", "rest", "oob", "br", "name", "var", "value", "index", "format", "jformat", "default", "category", "pattern", "template",
  ...UNSUPPORTED, ...IGNORED_TEMPLATE,
]);

class Compiler {
  readonly warnings = new Set<string>();
  readonly graph = node();
  size = 0;
  readonly properties: Map<string, string>;

  constructor(properties: Map<string, string>) {
    this.properties = properties;
  }

  /** A pattern's tokens: words, wildcards, sets, and bot properties spelled out. */
  tokens(pattern: XNode | undefined, file: string): PatternToken[] {
    if (!pattern) return [{ t: "wild", w: "*" }];
    const out: PatternToken[] = [];
    for (const c of pattern.children) {
      if (typeof c === "string") {
        // Stryker disable next-line Regex: equivalent; the empty words a split at each space leaves spell no word
        for (const raw of c.split(/\s+/)) {
          if (raw === "#" || raw === "_" || raw === "^" || raw === "*") out.push({ t: "wild", w: raw });
          // aimlWords drops the "$" as it does any punctuation.
          else if (raw.startsWith("$")) out.push(...aimlWords(raw).map((w) => ({ t: "priority" as const, w })));
          else out.push(...aimlWords(raw).map((w) => ({ t: "word" as const, w })));
        }
      } else if (c.name === "set") out.push({ t: "set", name: textOf(c).trim().toLowerCase() });
      else if (c.name === "bot") out.push(...aimlWords(this.properties.get((c.attrs["name"] ?? textOf(c)).trim().toLowerCase()) ?? "unknown").map((w) => ({ t: "word" as const, w })));
      else throw new DocumentError(`${file}: <${c.name}> is not allowed in a pattern`);
    }
    return out.length === 0 ? [{ t: "wild", w: "*" }] : out;
  }

  category(cat: XNode, topic: XNode | undefined, file: string): Category | undefined {
    const pattern = elements(cat, "pattern")[0];
    const template = elements(cat, "template")[0];
    if (!pattern || !template) throw new DocumentError(`${file}: a <category> needs a <pattern> and a <template>`);
    const bad = findElement(template, (n) => UNSUPPORTED.has(n.name));
    if (bad) {
      this.warnings.add(`${file}: categories using <${bad.name}> are dropped (it runs code on the host)`);
      return undefined;
    }
    this.check(template, file);
    const that = elements(cat, "that")[0];
    const catTopic = elements(cat, "topic")[0] ?? topic;
    const p = this.tokens(pattern, file);
    const th = this.tokens(that, file);
    const tp = this.tokens(catTopic, file);
    const star = (ts: PatternToken[]) =>
      ts.length === 1 &&
      // Stryker disable next-line ConditionalExpression: equivalent; only a wildcard token is spelled "*" (words and sets never are)
      ts[0]!.t === "wild" &&
      ts[0]!.w === "*";
    return { path: [...p, { t: "word", w: THAT }, ...th, { t: "word", w: TOPIC }, ...tp], template, catchAll: star(p) && star(th) && star(tp) };
  }

  check(template: XNode, file: string): void {
    for (const n of descendants(template)) {
      if (IGNORED_TEMPLATE.has(n.name)) this.warnings.add(`${file}: <${n.name}> is not supported and says nothing`);
      else if (!KNOWN.has(n.name)) this.warnings.add(`${file}: <${n.name}> is not AIML; its text is said`);
    }
  }

  add(category: Category): void {
    insert(this.graph, category);
    this.size++;
  }
}

function insert(graph: GraphNode, category: Category): void {
  let at = graph;
  for (const token of category.path) {
    const map = token.t === "word" ? at.words : token.t === "priority" ? at.priority : token.t === "set" ? at.sets : at.wild;
    const key = token.t === "set" ? token.name : token.w;
    let next = map.get(key);
    if (!next) map.set(key, (next = node()));
    at = next;
  }
  // A later category with the same pattern, that and topic replaces an earlier one, as AIML loaders do.
  at.category = category;
}

function descendants(n: XNode): XNode[] {
  return elements(n).flatMap((c) => [c, ...descendants(c)]);
}
function findElement(n: XNode, test: (n: XNode) => boolean): XNode | undefined {
  return descendants(n).find(test);
}
const textOf = (n: XNode | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));

/** Whether a file is one of an AIML bot's: AIML, sets, maps, properties and substitutions (Pandorabots' or Program AB's). */
export const isAimlFile = (file: string): boolean =>
  /\.(?:aiml|set|map|properties|substitution)$/i.test(file) || /(?:^|\/)(?:(?:sets|maps)\/[^/]+|properties|normal|denormal|person|person2|gender)\.txt$/i.test(file);

/** Compiles a bot from its files. */
export function compileAiml(files: Readonly<Record<string, string>>, options: { readonly fallback?: "model" | "bot" } = {}): { readonly bot: Bot; readonly warnings: readonly string[] } {
  const sets = new Map<string, string[][]>();
  const maps = new Map<string, Map<string, string>>();
  const properties = new Map<string, string>();
  const substitutions = new Map<string, [string, string][]>();
  const aiml: [string, string][] = [];
  for (const [file, text] of Object.entries(files)) {
    const name = baseName(file);
    const lower = file.toLowerCase();
    if (!isAimlFile(file)) throw new DocumentError(`${file} is not an AIML bot file (.aiml, .set, .map, .properties, .substitution, or Program AB's text files)`);
    if (lower.endsWith(".aiml")) aiml.push([file, text]);
    else if (lower.endsWith(".set") || /(^|\/)sets\/[^/]+\.txt$/.test(lower)) {
      const trimmed = text.trim();
      const entries = trimmed.startsWith("[") ? (JSON.parse(trimmed) as unknown[]).map((e) => (Array.isArray(e) ? e.join(" ") : String(e))) : lines(trimmed);
      sets.set(name, entries.map(aimlWords).filter((w) => w.length > 0));
    } else if (lower.endsWith(".map") || /(^|\/)maps\/[^/]+\.txt$/.test(lower)) maps.set(name, new Map(pairs(text, file).map(([k, v]) => [aimlWords(k).join(" "), v])));
    else if (lower.endsWith(".properties") || /(^|\/)properties\.txt$/.test(lower)) for (const [k, v] of pairs(text, file)) properties.set(k.toLowerCase(), v);
    else substitutions.set(name, pairs(text, file));
  }
  if (aiml.length === 0) throw new DocumentError("no AIML file (.aiml) among the files");
  const compiler = new Compiler(properties);
  for (const [file, text] of aiml) {
    const root = parseXml(text, file);
    if (root.name !== "aiml") throw new DocumentError(`${file}: an AIML file's root is <aiml>, not <${root.name}>`);
    const add = (cat: XNode, topic: XNode | undefined) => {
      const category = compiler.category(cat, topic, file);
      if (category) compiler.add(category);
    };
    for (const c of elements(root)) {
      if (c.name === "category") add(c, undefined);
      else if (c.name === "topic") {
        const name = c.attrs["name"];
        // Stryker disable next-line StringLiteral: equivalent; a topic is read by its words, not its element name, and an empty topic is `*`
        const topic: XNode = { name: "topic", attrs: {}, children: [name ?? "*"] };
        for (const cat of elements(c, "category")) add(cat, topic);
      } else throw new DocumentError(`${file}: <${c.name}> is not a category or a topic`);
    }
  }
  return { bot: { graph: compiler.graph, size: compiler.size, sets, maps, properties, substitutions, fallback: options.fallback ?? "model" }, warnings: [...compiler.warnings] };
}

// ---- matching ----------------------------------------------------------------------

interface Found {
  readonly category: Category;
  /** Wildcard values by section: the input's, the that's and the topic's. */
  readonly stars: readonly (readonly string[])[];
}

class OutOfSteps extends Error {}

/** What a turn may spend on matching: graph steps, across all its searches (reductions included). */
interface Budget {
  steps: number;
}

/**
 * The category an input path (input, `<THAT>`, that, `<TOPIC>`, topic) reaches, in AIML
 * 2.0's order of precedence, over graphs searched as one (the first graph's category wins
 * at the same path: a learned category replaces the bot's, as a later one would). Searching
 * spends the turn's budget; a search that runs out finds nothing.
 */
function search(graphs: readonly GraphNode[], path: readonly string[], sets: Bot["sets"], budget: Budget): Found | undefined {
  const sectionEnd = (i: number) => {
    // Stryker disable next-line EqualityOperator: equivalent for k <= path.length, which reads one past the end, no marker (k >= path.length, dropping the bound, is killed by AM7.12)
    for (let k = i; k < path.length; k++) if (path[k] === THAT || path[k] === TOPIC) return k;
    return path.length;
  };
  const sectionOf = (i: number) => path.slice(0, i).filter((w) => w === THAT || w === TOPIC).length;
  const children = (ats: readonly GraphNode[], pick: (at: GraphNode) => GraphNode | undefined): GraphNode[] => ats.flatMap((a) => pick(a) ?? []);
  const walk = (ats: readonly GraphNode[], i: number, stars: readonly (readonly string[])[]): Found | undefined => {
    if (--budget.steps < 0) throw new OutOfSteps();
    const category = i === path.length ? ats.find((a) => a.category)?.category : undefined;
    if (category) return { category, stars };
    const w = path[i];
    const capture = (next: readonly GraphNode[], from: number, to: number): Found | undefined => {
      const section = sectionOf(from);
      return walk(next, to, stars.map((s, k) => (k === section ? [...s, path.slice(from, to).join(" ")] : s)));
    };
    const wildcard = (key: "#" | "_" | "^" | "*", min: number): Found | undefined => {
      const next = children(ats, (a) => a.wild.get(key));
      if (next.length === 0) return undefined;
      const end = sectionEnd(i);
      for (let to = i + min; to <= end; to++) {
        const found = capture(next, i, to);
        if (found) return found;
      }
      return undefined;
    };
    const exact = (map: (at: GraphNode) => Map<string, GraphNode>): Found | undefined => {
      // Stryker disable next-line ConditionalExpression: equivalent; no graph key is undefined, so at the end of the path a lookup finds nothing either way
      const next = w === undefined ? [] : children(ats, (a) => map(a).get(w));
      return next.length === 0 ? undefined : walk(next, i + 1, stars);
    };
    const inSet = (): Found | undefined => {
      // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent; a set's phrases are words, never the path's end or a section marker, so the loop below would find nothing
      if (w === undefined || w === THAT || w === TOPIC) return undefined;
      for (const name of new Set(ats.flatMap((a) => [...a.sets.keys()]))) {
        const next = children(ats, (a) => a.sets.get(name));
        const phrases = name === "number" ? (/^\d+$/.test(w) ? [[w]] : []) : [...(sets.get(name) ?? [])].sort((a, b) => b.length - a.length);
        for (const phrase of phrases) {
          if (!phrase.every((p, k) => path[i + k] === p)) continue;
          const found = capture(next, i, i + phrase.length);
          if (found) return found;
        }
      }
      return undefined;
    };
    return exact((a) => a.priority) ?? wildcard("#", 0) ?? wildcard("_", 1) ?? exact((a) => a.words) ?? inSet() ?? wildcard("^", 0) ?? wildcard("*", 1);
  };
  try {
    return walk(graphs, 0, [[], [], []]);
  } catch (e) {
    // A search too deep for the stack (a very long learned pattern) finds nothing, as one out of steps does.
    if (e instanceof OutOfSteps || e instanceof RangeError) return undefined;
    throw e;
  }
}

// ---- state -------------------------------------------------------------------------

interface LearnedCategory {
  readonly pattern: XNode;
  readonly that?: XNode;
  readonly topic?: XNode;
  readonly template: XNode;
}

interface AimlState {
  readonly predicates: Readonly<Record<string, string>>;
  /** Recent inputs and responses, most recent last. */
  readonly inputs: readonly string[];
  readonly responses: readonly string[];
  readonly seed: number;
  readonly learned: readonly LearnedCategory[];
}

const HISTORY = 10;
const LEARNED = 100;
/** The most tokens (pattern, that and topic) a learned category may have: longer ones are not learned. */
const LEARNED_TOKENS = 64;
const MAX_DEPTH = 16;
/** Graph steps a turn may take, over all its searches. */
const TURN_STEPS = 100_000;
/** Reductions (`<srai>`, `<sr>`) a turn may make, however they nest. */
const TURN_REDUCTIONS = 256;

/** A record without a prototype: a predicate named "constructor" is only ever the bot's own. */
const record = (from: Readonly<Record<string, string>> = {}): Record<string, string> => Object.assign(Object.create(null) as Record<string, string>, from);

/** A deterministic random choice (mulberry32), its seed kept in the state so replays choose alike. */
function next(seed: number): { value: number; seed: number } {
  const s = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: s };
}

const hash = (text: string) => [...text].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

class Pass extends Error {}

/** A learned category as the graph holds it; none when it does not compile or is longer than LEARNED_TOKENS. */
function learnedCategory(compiler: Compiler, l: LearnedCategory): Category | undefined {
  // Stryker disable next-line StringLiteral,ArrayDeclaration: equivalent; a category is read by its parts (a string among them is no part), not its element name
  const cat: XNode = { name: "category", attrs: {}, children: [l.pattern, ...(l.that ? [l.that] : []), ...(l.topic ? [l.topic] : []), l.template] };
  try {
    const category = compiler.category(cat, undefined, "learned");
    return category && category.path.length <= LEARNED_TOKENS ? category : undefined;
  } catch {
    return undefined;
  }
}

/** One turn of a bot's conversation: the state changes as the templates run. */
class Turn {
  predicates: Record<string, string>;
  inputs: string[];
  responses: string[];
  seed: number;
  learned: LearnedCategory[];
  learnedGraph: GraphNode | undefined;
  defaulted = false;
  readonly budget: Budget = { steps: TURN_STEPS };
  reductions = TURN_REDUCTIONS;

  readonly bot: Bot;
  readonly now: number | undefined;

  constructor(bot: Bot, state: AimlState, now: number | undefined) {
    this.bot = bot;
    this.now = now;
    this.predicates = record(state.predicates);
    this.inputs = [...state.inputs];
    this.responses = [...state.responses];
    this.seed = state.seed;
    this.learned = [...state.learned];
  }

  state(): AimlState {
    return { predicates: this.predicates, inputs: this.inputs.slice(-HISTORY), responses: this.responses.slice(-HISTORY), seed: this.seed, learned: this.learned };
  }

  graphOfLearned(): GraphNode {
    // Stryker disable next-line ConditionalExpression: equivalent; rebuilding the learned graph each time builds the same graph
    if (!this.learnedGraph) {
      this.learnedGraph = node();
      const compiler = new Compiler(new Map(this.bot.properties));
      for (const l of this.learned) {
        const category = learnedCategory(compiler, l);
        if (category) insert(this.learnedGraph, category);
      }
    }
    return this.learnedGraph;
  }

  /** The last sentence the bot said, normalized as input is, as `<that>` matches it. */
  that(): string[] {
    const last = this.responses[this.responses.length - 1];
    const sentences = last === undefined ? [] : splitSentences(this.substitute("normal", last));
    const words = aimlWords(sentences[sentences.length - 1] ?? "");
    return words.length === 0 ? ["UNKNOWN"] : words;
  }

  topic(): string[] {
    const words = aimlWords(this.predicates["topic"] ?? "");
    return words.length === 0 ? ["UNKNOWN"] : words;
  }

  /** A substitution table applied in one pass, longest match first and ignoring case (what it put in is not substituted again). */
  substitute(kind: string, text: string): string {
    const table = [...(this.bot.substitutions.get(kind) ?? [])].sort((a, b) => b[0].length - a[0].length);
    if (table.length === 0) return text;
    const padded = ` ${text} `;
    const lower = padded.toLowerCase();
    let out = "";
    for (let i = 0; i < padded.length; ) {
      const hit = table.find(([from]) => from !== "" && lower.startsWith(from.toLowerCase(), i));
      if (hit) {
        out += hit[1];
        i += hit[0].length;
      } else out += padded[i++];
    }
    return out.trim();
  }

  /** The bot's answer to one sentence (normalized already), `depth` reductions in; past the turn's budget, nothing. */
  respond(sentence: string, depth: number): string {
    if (depth > MAX_DEPTH) return "";
    if (depth > 0 && --this.reductions < 0) return "";
    const input = aimlWords(sentence);
    if (input.length === 0) return "";
    const path = [...input, THAT, ...this.that(), TOPIC, ...this.topic()];
    // Learned categories and the bot's are one graph: precedence is by pattern, wherever a category came from.
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent; an empty learned graph adds nothing to the search
    const found = search(this.learned.length > 0 ? [this.graphOfLearned(), this.bot.graph] : [this.bot.graph], path, this.bot.sets, this.budget);
    if (!found) throw new Pass();
    if (found.category.catchAll && this.bot.fallback === "model") this.defaulted = true;
    return this.template(found.category.template, { stars: found.stars, depth, locals: record() });
  }

  template(n: XNode, ctx: Ctx): string {
    return collapse(n.children.map((c) => (typeof c === "string" ? c : this.element(c, ctx))).join(""));
  }

  /** An attribute, or the same-named child element (AIML 2.0), evaluated. */
  attr(n: XNode, name: string, ctx: Ctx): string | undefined {
    if (n.attrs[name] !== undefined) return n.attrs[name];
    const child = elements(n, name)[0];
    return child && this.template(child, ctx).trim();
  }

  /** An element's content without its attribute elements. */
  content(n: XNode, ctx: Ctx): string {
    const attrs = new Set(["name", "var", "value", "index", "format", "jformat", "default"]);
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent; a string has no name, so none of an attribute's
    return this.template({ ...n, children: n.children.filter((c) => typeof c === "string" || !attrs.has(c.name)) }, ctx);
  }

  element(n: XNode, ctx: Ctx): string {
    const index = (fallback = 1) => {
      const raw = this.attr(n, "index", ctx);
      // Stryker disable next-line ConditionalExpression: equivalent; parsing no index gives NaN, which falls back as no index does
      const i = raw === undefined ? fallback : Number.parseInt(raw, 10);
      // Parsing gives an integer or NaN, which is not >= 1.
      // Stryker disable next-line EqualityOperator: equivalent for i > 1; the fallback is 1
      return i >= 1 ? i : fallback;
    };
    // Stryker disable next-line OptionalChaining: equivalent; a match has stars for all three sections
    const star = (section: number) => ctx.stars[section]?.[index() - 1] ?? "";
    const or = (text: string) => (n.children.length === 0 ? star(0) : text);
    switch (n.name) {
      case "star":
        return star(0);
      case "thatstar":
        return star(1);
      case "topicstar":
        return star(2);
      case "that": {
        const [response = 1, sentence = 1] = (this.attr(n, "index", ctx) ?? "1,1").split(",").map((x) => Number.parseInt(x, 10));
        const said = this.responses[this.responses.length - response];
        const sentences = said === undefined ? [] : splitSentences(said);
        return sentences[sentences.length - sentence] ?? "";
      }
      case "input":
      case "request":
        return this.inputs[this.inputs.length - index()] ?? "";
      case "response":
        return this.responses[this.responses.length - index()] ?? "";
      case "get": {
        const local = this.attr(n, "var", ctx);
        if (local !== undefined) return ctx.locals[local] ?? "unknown";
        return this.predicates[(this.attr(n, "name", ctx) ?? "").toLowerCase()] ?? "unknown";
      }
      case "set": {
        const value = this.content(n, ctx).trim();
        const local = this.attr(n, "var", ctx);
        if (local !== undefined) ctx.locals[local] = value;
        else this.predicates[(this.attr(n, "name", ctx) ?? "").toLowerCase()] = value;
        return value;
      }
      case "think":
        this.template(n, ctx);
        return "";
      case "srai":
        return this.respond(this.template(n, ctx), ctx.depth + 1);
      case "sr":
        return this.respond(star(0), ctx.depth + 1);
      case "sraix":
        // A question for another service: the harness's model answers the turn.
        throw new Pass();
      case "random": {
        const items = elements(n, "li");
        if (items.length === 0) return "";
        const r = next(this.seed);
        this.seed = r.seed;
        return this.template(items[Math.floor(r.value * items.length)]!, ctx);
      }
      case "condition":
        return this.condition(n, ctx);
      case "bot":
        return this.bot.properties.get((this.attr(n, "name", ctx) ?? "").toLowerCase()) ?? "unknown";
      case "uppercase":
        return or(this.template(n, ctx)).toUpperCase();
      case "lowercase":
        return or(this.template(n, ctx)).toLowerCase();
      case "formal":
        return or(this.template(n, ctx)).toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, s: string, c: string) => s + c.toUpperCase());
      case "sentence": {
        const t = or(this.template(n, ctx)).trim();
        return t.charAt(0).toUpperCase() + t.slice(1);
      }
      case "explode":
        // Stryker disable next-line Regex: equivalent; removing each space removes every run of them
        return [...or(this.template(n, ctx)).replace(/\s+/g, "")].join(" ");
      case "normalize":
        return this.substitute("normal", or(this.template(n, ctx)));
      case "denormalize":
        return this.substitute("denormal", or(this.template(n, ctx)));
      case "person":
      case "person2":
      case "gender":
        return this.substitute(n.name, or(this.template(n, ctx)));
      case "first":
        // Stryker disable next-line Regex,StringLiteral: equivalent; a template's spaces are collapsed already, and a split has a first part
        return this.template(n, ctx).trim().split(/\s+/)[0] ?? "";
      case "rest":
        // Stryker disable next-line Regex: equivalent; a template's spaces are collapsed already
        return this.template(n, ctx).trim().split(/\s+/).slice(1).join(" ");
      case "date":
        if (this.now === undefined) return "";
        {
          // format is strftime's; jformat, Java's SimpleDateFormat (as Program AB reads it).
          const jformat = this.attr(n, "jformat", ctx);
          return jformat !== undefined && this.attr(n, "format", ctx) === undefined ? formatJavaDate(this.now, jformat) : formatDate(this.now, this.attr(n, "format", ctx) ?? "%B %d, %Y");
        }
      case "size":
        return String(this.bot.size);
      case "version":
        return "2.0";
      case "program":
        return "harness";
      case "id":
        return "user";
      case "vocabulary":
        return String(this.bot.size);
      case "map": {
        const name = (this.attr(n, "name", ctx) ?? "").toLowerCase();
        const key = aimlWords(this.content(n, ctx)).join(" ");
        return this.bot.maps.get(name)?.get(key) ?? "unknown";
      }
      case "learn":
      case "learnf":
        for (const cat of elements(n, "category")) this.learn(cat, ctx);
        return "";
      case "loop":
      case "oob":
      case "br":
        return n.name === "br" ? " " : "";
      default:
        return IGNORED_TEMPLATE.has(n.name) ? "" : this.template(n, ctx);
    }
  }

  condition(n: XNode, ctx: Ctx): string {
    const name = this.attr(n, "name", ctx);
    const variable = this.attr(n, "var", ctx);
    const valueOf = (pred: string | undefined, local: string | undefined) => (local !== undefined ? (ctx.locals[local] ?? "unknown") : (this.predicates[(pred ?? "").toLowerCase()] ?? "unknown"));
    const matches = (actual: string, expected: string) => (expected.trim() === "*" ? actual !== "unknown" : aimlWords(actual).join(" ") === aimlWords(expected).join(" "));
    const value = this.attr(n, "value", ctx);
    if (value !== undefined) return matches(valueOf(name, variable), value) ? this.content(n, ctx) : "";
    let said = "";
    for (let round = 0; round < MAX_DEPTH; round++) {
      let looped = false;
      let out = "";
      for (const li of elements(n, "li")) {
        const expected = this.attr(li, "value", ctx);
        const actual = valueOf(this.attr(li, "name", ctx) ?? name, this.attr(li, "var", ctx) ?? variable);
        if (expected !== undefined && !matches(actual, expected)) continue;
        out = this.content(li, ctx);
        looped = elements(li, "loop").length > 0;
        break;
      }
      said += out;
      if (!looped) return said;
    }
    return said;
  }

  /** Learns a category for this conversation, its `<eval>`s evaluated now. */
  learn(cat: XNode, ctx: Ctx): void {
    const evaluated = (x: XNode): XNode => ({ ...x, children: x.children.map((c) => (typeof c === "string" ? c : c.name === "eval" ? this.template(c, ctx) : evaluated(c))) });
    const part = (name: string) => elements(cat, name)[0];
    const pattern = part("pattern");
    const template = part("template");
    if (!pattern || !template) return;
    const that = part("that");
    const topic = part("topic");
    const learned: LearnedCategory = { pattern: evaluated(pattern), ...(that ? { that: evaluated(that) } : {}), ...(topic ? { topic: evaluated(topic) } : {}), template: evaluated(template) };
    // A category that would not compile (an element a pattern cannot hold), or one too long, is not learned.
    if (!learnedCategory(new Compiler(new Map(this.bot.properties)), learned)) return;
    this.learned = [...this.learned, learned].slice(-LEARNED);
    this.learnedGraph = undefined;
  }
}

interface Ctx {
  readonly stars: readonly (readonly string[])[];
  readonly depth: number;
  readonly locals: Record<string, string>;
}

const collapse = (text: string) => text.replace(/\s+/g, " ");

/** Sentences as AIML splits (normalized) input: at . ! ? followed by whitespace or the end, so "3.14" and "e.g" stay whole. */
export const splitSentences = (text: string): string[] =>
  text
    .split(/[.!?]+(?=\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s !== "");

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_NAMES = ["Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday"];

/** A UTC date from epoch milliseconds, in strftime's common fields (%A %B %d %Y %H %M %S %p %m %y %I %j is not). */
/** A UTC time's calendar fields, from epoch milliseconds. */
function dateParts(ms: number) {
  const days = Math.floor(ms / 86400000);
  // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const secs = Math.floor(ms / 1000) - days * 86400;
  return { weekday: DAY_NAMES[((days % 7) + 7) % 7]!, day, month, year, hour: Math.floor(secs / 3600), minute: Math.floor((secs % 3600) / 60), second: secs % 60 };
}

const two = (n: number) => String(n).padStart(2, "0");

export function formatDate(ms: number, format: string): string {
  const { weekday, day, month, year, hour, minute, second } = dateParts(ms);
  const fields: Record<string, string> = {
    A: weekday,
    a: weekday.slice(0, 3),
    B: MONTH_NAMES[month - 1]!,
    b: MONTH_NAMES[month - 1]!.slice(0, 3),
    d: two(day),
    e: String(day),
    m: two(month),
    Y: String(year),
    y: two(year % 100),
    H: two(hour),
    I: two(hour % 12 === 0 ? 12 : hour % 12),
    M: two(minute),
    S: two(second),
    p: hour < 12 ? "AM" : "PM",
    "%": "%",
  };
  return format.replace(/%([A-Za-z%])/g, (all, f: string) => fields[f] ?? all);
}

/**
 * A UTC date from epoch milliseconds in a Java SimpleDateFormat pattern (AIML's `jformat`):
 * y, M, d, E, H, h, m, s and a, each letter repeated for its width or its long form;
 * text in single quotes as it is ('' for a quote); other characters as they are.
 */
export function formatJavaDate(ms: number, pattern: string): string {
  const { weekday, day, month, year, hour, minute, second } = dateParts(ms);
  const padded = (n: number, width: number) => String(n).padStart(width, "0");
  const field = (letter: string, width: number): string | undefined => {
    switch (letter) {
      case "y":
        return width === 2 ? two(year % 100) : padded(year, width);
      case "M":
        return width >= 4 ? MONTH_NAMES[month - 1]! : width === 3 ? MONTH_NAMES[month - 1]!.slice(0, 3) : padded(month, width);
      case "d":
        return padded(day, width);
      case "E":
        return width >= 4 ? weekday : weekday.slice(0, 3);
      case "H":
        return padded(hour, width);
      case "h":
        return padded(hour % 12 === 0 ? 12 : hour % 12, width);
      case "m":
        return padded(minute, width);
      case "s":
        return padded(second, width);
      case "a":
        return hour < 12 ? "AM" : "PM";
      default:
        return undefined;
    }
  };
  return pattern.replace(/'([^']*)'|([A-Za-z])\2*/g, (all, quoted: string | undefined, letter: string | undefined) => {
    if (quoted !== undefined) return quoted === "" ? "'" : quoted;
    return field(letter!, all.length) ?? all;
  });
}

/** One step: the bot's answer to the utterance, sentence by sentence; handed to the model when it has no real answer. */
export function stepAiml(bot: Bot, input: StepInput): StepResult {
  const utterance = input.utterance ?? "";
  // A turn handed on changes nothing: it goes on from the state it started with.
  const state = (input.state as AimlState | null) ?? { predicates: {}, inputs: [], responses: [], seed: hash(utterance), learned: [] };
  const turn = new Turn(bot, state, input.now);
  // Input is normalized (the bot's "normal" substitutions: "e.g." as "eg", "Mr." as "mister") before it is split into sentences.
  const sentences = splitSentences(turn.substitute("normal", utterance));
  const answers: string[] = [];
  try {
    for (const sentence of sentences) {
      turn.inputs.push(sentence);
      const answer = turn.respond(sentence, 0).trim();
      if (answer !== "") answers.push(answer);
    }
  } catch (e) {
    if (e instanceof Pass) return { say: [], state: state as never, pass: true };
    throw e;
  }
  if (turn.defaulted || sentences.length === 0) return { say: [], state: state as never, pass: true };
  const reply = answers.join(" ");
  turn.responses.push(reply);
  return { say: reply === "" ? [] : [reply], state: turn.state() as never };
}

export const aimlInterpreter: Interpreter = {
  type: "aiml",
  compile(files, options) {
    const { bot, warnings } = compileAiml(files, { fallback: options["fallback"] === "bot" ? "bot" : "model" });
    return { warnings, step: (input) => stepAiml(bot, input) };
  },
};
