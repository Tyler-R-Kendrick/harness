import { builtinGrammar } from "./builtins.ts";
import { evaluate, execute, ScriptError, toJson } from "./ecmascript.ts";
import type { Value } from "./ecmascript.ts";
import type { Interpreter, StepInput, StepResult } from "./interpreter.ts";
import { checkRefs, matchSrgs, parseSrgs, srgsFromAbnf, srgsFromXml, wordsOf } from "./srgs.ts";
import type { Grammar, GrammarMatch } from "./srgs.ts";
import { DocumentError, elements, parseXml, resolvePath, textOf } from "./xml.ts";
import type { XNode } from "./xml.ts";

/**
 * VoiceXML 2.1 (W3C) for text: a document's forms and menus are run by the Form
 * Interpretation Algorithm a turn at a time, the turn's utterance matched against the
 * active SRGS grammars (field, form, link and document-scoped dialog grammars, in that
 * order) and builtin types. Everything a document does between two utterances happens in
 * one step, and the step's state is JSON, so a flow keeps it in its journal.
 *
 * What text has no use for is left out: audio, recording, DTMF-only features, timeouts
 * and properties. `<transfer>` hands the person to the model; `<data>` and `<submit>`
 * whose `src`/`next` is `tool:<name>` call that tool (a host tool or a workflow) from the
 * flow; any other URL is refused, as are `<script>`, `<record>` and `<object>`.
 */

// ---- the compiled document ---------------------------------------------------------

type Content = string | { readonly value: string } | { readonly enumerate: readonly Content[] | undefined };

interface Prompt {
  readonly count: number;
  readonly cond?: string;
  readonly content: readonly Content[];
}

type Exec =
  | { readonly op: "var"; readonly name: string; readonly expr?: string }
  | { readonly op: "assign"; readonly name: string; readonly expr: string }
  | { readonly op: "clear"; readonly names?: readonly string[] }
  | { readonly op: "if"; readonly branches: readonly { readonly cond?: string; readonly body: readonly Exec[] }[] }
  | { readonly op: "prompt"; readonly prompt: Prompt }
  | { readonly op: "goto"; readonly next?: string; readonly expr?: string; readonly nextitem?: string; readonly expritem?: string }
  | { readonly op: "call"; readonly tool?: string; readonly expr?: string; readonly namelist: readonly string[]; readonly into?: string; readonly exit: boolean }
  | { readonly op: "exit"; readonly expr?: string; readonly namelist?: readonly string[] }
  | { readonly op: "return"; readonly event?: string; readonly eventexpr?: string; readonly namelist: readonly string[] }
  | { readonly op: "reprompt" }
  | { readonly op: "throw"; readonly event?: string; readonly eventexpr?: string; readonly message?: string; readonly messageexpr?: string }
  | { readonly op: "disconnect" }
  | { readonly op: "none" };

interface Handler {
  /** Event names this catches (a prefix, by dot-separated parts); empty catches every event. */
  readonly events: readonly string[];
  readonly count: number;
  readonly cond?: string;
  /** The body's index in the document's bodies. */
  readonly body: number;
}

type Matcher = (utterance: string) => GrammarMatch | undefined;

interface Link {
  readonly grammars: readonly Matcher[];
  readonly next?: string;
  readonly expr?: string;
  readonly event?: string;
  readonly eventexpr?: string;
}

interface Choice {
  readonly next?: string;
  readonly expr?: string;
  readonly event?: string;
  readonly text: string;
}

/** An option or a choice, for `<enumerate>`: its text and its DTMF key, if it has one. */
interface Option {
  readonly text: string;
  readonly dtmf?: string;
}

/** What an option or a choice accepts: its words (or its own grammars), its key, and with `approximate` any of its words in order. */
interface Choosable {
  readonly value: string;
  readonly phrase?: readonly string[];
  readonly grammars?: readonly Matcher[];
  readonly key?: string;
  readonly approximate?: boolean;
}

interface Item {
  readonly kind: "block" | "field" | "initial" | "subdialog" | "transfer";
  readonly name: string;
  readonly cond?: string;
  readonly expr?: string;
  readonly slot: string;
  readonly modal: boolean;
  readonly prompts: readonly Prompt[];
  readonly grammars: readonly Matcher[];
  readonly handlers: readonly Handler[];
  readonly filled: readonly number[];
  /** A block's content. */
  readonly body?: number;
  /** A field's options (and a menu's choices), for `<enumerate>`. */
  readonly options: readonly Option[];
  /** A menu's choices, by the value its field takes. */
  readonly choices?: readonly Choice[];
  readonly src?: string;
  readonly srcexpr?: string;
  readonly params: readonly { readonly name: string; readonly expr: string }[];
}

interface FormFilled {
  readonly mode: "all" | "any";
  readonly namelist?: readonly string[];
  readonly body: number;
}

interface Dialog {
  readonly id: string;
  readonly file: string;
  readonly vars: readonly Exec[];
  readonly items: readonly Item[];
  readonly grammars: readonly Matcher[];
  /** Its grammars are active in the whole document (scope="document"). */
  readonly documentScope: boolean;
  readonly handlers: readonly Handler[];
  readonly links: readonly Link[];
  readonly filled: readonly FormFilled[];
}

interface VxmlDocument {
  readonly file: string;
  readonly application?: string;
  readonly vars: readonly Exec[];
  readonly dialogs: readonly Dialog[];
  readonly handlers: readonly Handler[];
  readonly links: readonly Link[];
}

interface Compiled {
  readonly main: string;
  readonly documents: ReadonlyMap<string, VxmlDocument>;
  readonly bodies: readonly (readonly Exec[])[];
  readonly nomatch: "model" | "reprompt";
}

// ---- compiling ---------------------------------------------------------------------

/** Elements said as part of the text around them. */
const SAID = new Set(["value", "audio", "enumerate", "break", "mark", "sub", "emphasis", "prosody", "say-as", "voice", "p", "s", "phoneme", "lang"]);

const IGNORED = new Set(["property", "meta", "metadata", "log"]);
const REFUSED: Readonly<Record<string, string>> = {
  script: "<script> is not supported: use cond, expr and <assign>",
  record: "<record> takes audio, which text has none of",
  object: "<object> runs platform code, which is not supported",
};

const GRAMMAR_FILE = /\.(?:grxml|gram|abnf|srgs)$/i;

/** Whether a file is one of a VoiceXML application's: a document or an SRGS grammar. */
export const isVoiceXmlFile = (file: string): boolean => /\.vxml$/i.test(file) || GRAMMAR_FILE.test(file);

class Compiler {
  readonly bodies: Exec[][] = [];
  readonly warnings: string[] = [];
  readonly grammars = new Map<string, Grammar>();
  #inline = 0;
  /** Dialogs compiled so far: an unnamed one is named by its place, so no two share a name. */
  #dialogs = 0;

  readonly files: Readonly<Record<string, string>>;

  constructor(files: Readonly<Record<string, string>>) {
    this.files = files;
    for (const [file, text] of Object.entries(files)) if (GRAMMAR_FILE.test(file)) this.grammars.set(file, parseSrgs(text, file));
  }

  body(execs: Exec[]): number {
    this.bodies.push(execs);
    return this.bodies.length - 1;
  }

  document(file: string): VxmlDocument {
    // Only the names of the files imported are compiled as documents.
    const root = parseXml(this.files[file]!, file);
    if (root.name !== "vxml") throw new DocumentError(`${file}: a VoiceXML document's root is <vxml>, not <${root.name}>`);
    const dialogs: Dialog[] = [];
    const vars: Exec[] = [];
    const handlers: Handler[] = [];
    const links: Link[] = [];
    for (const child of elements(root)) {
      if (child.name === "form") dialogs.push(this.form(child, file));
      else if (child.name === "menu") dialogs.push(this.menu(child, file));
      else if (child.name === "var") vars.push(this.exec(child, file)[0]!);
      else if (child.name === "link") links.push(this.link(child, file));
      else if (this.handler(child, file, handlers)) continue;
      else this.other(child, file, "<vxml>");
    }
    const application = root.attrs["application"];
    return { file, ...(application === undefined ? {} : { application: resolvePath(file, application) }), vars, dialogs, handlers, links };
  }

  other(node: XNode, file: string, where: string): void {
    if (REFUSED[node.name] !== undefined) throw new DocumentError(`${file}: ${REFUSED[node.name]}`);
    if (IGNORED.has(node.name)) return;
    throw new DocumentError(`${file}: <${node.name}> is not supported in ${where}`);
  }

  handler(node: XNode, file: string, into: Handler[]): boolean {
    const shorthand = ["noinput", "nomatch", "help", "error"];
    if (node.name !== "catch" && !shorthand.includes(node.name)) return false;
    const events = node.name === "catch" ? (node.attrs["event"] ?? "").split(/\s+/).filter((e) => e !== "") : [node.name];
    const count = Number(node.attrs["count"] ?? 1);
    if (!Number.isInteger(count) || count < 1) throw new DocumentError(`${file}: a handler's count is a whole number from 1`);
    into.push({ events, count, ...(node.attrs["cond"] === undefined ? {} : { cond: node.attrs["cond"] }), body: this.body(this.execs(node.children, file)) });
    return true;
  }

  link(node: XNode, file: string): Link {
    const grammars = elements(node, "grammar").map((g) => this.grammar(g, file));
    if (grammars.length === 0) throw new DocumentError(`${file}: a <link> needs a grammar`);
    const { next, expr, event, eventexpr } = node.attrs;
    if (next === undefined && expr === undefined && event === undefined && eventexpr === undefined) throw new DocumentError(`${file}: a <link> needs next, expr, event or eventexpr`);
    return { grammars, ...defined({ next, expr, event, eventexpr }) };
  }

  grammar(node: XNode, file: string): Matcher {
    const src = node.attrs["src"];
    if (node.attrs["srcexpr"] !== undefined) throw new DocumentError(`${file}: grammars from srcexpr are not supported`);
    if (src !== undefined) {
      if (src.startsWith("builtin:")) return builtinGrammar(src);
      const [ref, rule] = src.split("#");
      const path = resolvePath(file, ref!);
      const grammar = this.grammars.get(path);
      if (!grammar) throw new DocumentError(`${file}: grammar ${path} is not among the files imported`);
      const root = rule === undefined ? grammar : { ...grammar, root: `${path}#${rule}` };
      if (grammar.rules[root.root] === undefined) throw new DocumentError(`${file}: grammar ${src} has no such rule`);
      return (u) => matchSrgs(root, this.grammars, u);
    }
    const name = `${file}#grammar-${++this.#inline}`;
    // Stryker disable next-line MethodExpression: equivalent; an ABNF grammar may start and end with whitespace
    const inline = elements(node).length > 0 ? srgsFromXml(node, name) : srgsFromAbnf(textOf(node).trim(), name);
    this.grammars.set(name, inline);
    return (u) => matchSrgs(inline, this.grammars, u);
  }

  prompt(node: XNode, file: string): Prompt {
    const count = Number(node.attrs["count"] ?? 1);
    if (!Number.isInteger(count) || count < 1) throw new DocumentError(`${file}: a prompt's count is a whole number from 1`);
    return { count, ...(node.attrs["cond"] === undefined ? {} : { cond: node.attrs["cond"] }), content: this.content(node.children, file) };
  }

  content(children: readonly (XNode | string)[], file: string): Content[] {
    const out: Content[] = [];
    for (const c of children) {
      if (typeof c === "string") out.push(c);
      else if (c.name === "value") out.push({ value: required(c, "expr", file) });
      else if (c.name === "enumerate") out.push({ enumerate: c.children.length === 0 ? undefined : this.content(c.children, file) });
      else if (c.name === "break" || c.name === "mark") out.push(" ");
      else if (c.name === "sub") out.push(c.attrs["alias"] ?? textOf(c));
      else out.push(...this.content(c.children, file));
    }
    return out;
  }

  execs(children: readonly (XNode | string)[], file: string): Exec[] {
    const out: Exec[] = [];
    // Text and what is said with it (values, audio, SSML) run together as one prompt.
    let said: (XNode | string)[] = [];
    const flush = () => {
      if (said.some((c) => typeof c !== "string" || c.trim() !== "")) out.push({ op: "prompt", prompt: { count: 1, content: this.content(said, file) } });
      said = [];
    };
    for (const c of children) {
      if (typeof c === "string" || SAID.has(c.name)) {
        said.push(c);
        continue;
      }
      flush();
      out.push(...this.exec(c, file));
    }
    flush();
    return out;
  }

  exec(node: XNode, file: string): Exec[] {
    const a = node.attrs;
    const names = (list: string | undefined) => (list ?? "").split(/\s+/).filter((n) => n !== "");
    switch (node.name) {
      case "var":
        return [{ op: "var", name: required(node, "name", file), ...defined({ expr: a["expr"] }) }];
      case "assign":
        return [{ op: "assign", name: required(node, "name", file), expr: required(node, "expr", file) }];
      case "clear":
        return [{ op: "clear", ...(a["namelist"] === undefined ? {} : { names: names(a["namelist"]) }) }];
      case "if": {
        // <elseif> and <else> are markers: what follows each, up to the next, is its branch.
        const groups: { cond?: string; children: (XNode | string)[] }[] = [{ cond: required(node, "cond", file), children: [] }];
        for (const c of node.children) {
          if (typeof c !== "string" && c.name === "elseif") groups.push({ cond: required(c, "cond", file), children: [] });
          else if (typeof c !== "string" && c.name === "else") groups.push({ children: [] });
          else groups[groups.length - 1]!.children.push(c);
        }
        return [{ op: "if", branches: groups.map((g) => ({ ...(g.cond === undefined ? {} : { cond: g.cond }), body: this.execs(g.children, file) })) }];
      }
      case "prompt":
        return [{ op: "prompt", prompt: this.prompt(node, file) }];
      case "goto":
        // A goto names exactly where: a dialog or document (next, expr) or an item (nextitem, expritem).
        if ([a["next"], a["expr"], a["nextitem"], a["expritem"]].filter((x) => x !== undefined).length !== 1) throw new DocumentError(`${file}: a <goto> needs exactly one of next, expr, nextitem or expritem`);
        return [{ op: "goto", ...defined({ next: a["next"], expr: a["expr"], nextitem: a["nextitem"], expritem: a["expritem"] }) }];
      case "submit":
      case "data": {
        const url = node.name === "submit" ? a["next"] : a["src"];
        const urlexpr = node.name === "submit" ? a["expr"] : a["srcexpr"];
        if (url !== undefined && !url.startsWith("tool:")) throw new DocumentError(`${file}: <${node.name}> to ${url}: only tool:<name> is supported (a host tool or a workflow)`);
        if (url === undefined && urlexpr === undefined) throw new DocumentError(`${file}: <${node.name}> needs a tool:<name>`);
        return [
          {
            op: "call",
            ...(url === undefined ? { expr: urlexpr! } : { tool: url.slice("tool:".length) }),
            namelist: names(a["namelist"]),
            ...defined({ into: node.name === "data" ? a["name"] : undefined }),
            exit: node.name === "submit",
          },
        ];
      }
      case "exit":
        return [{ op: "exit", ...defined({ expr: a["expr"] }), ...(a["namelist"] === undefined ? {} : { namelist: names(a["namelist"]) }) }];
      case "return":
        return [{ op: "return", ...defined({ event: a["event"], eventexpr: a["eventexpr"] }), namelist: names(a["namelist"]) }];
      case "reprompt":
        return [{ op: "reprompt" }];
      case "throw":
        return [{ op: "throw", ...defined({ event: a["event"], eventexpr: a["eventexpr"], message: a["message"], messageexpr: a["messageexpr"] }) }];
      case "disconnect":
        return [{ op: "disconnect" }];
      default:
        this.other(node, file, "executable content");
        return [];
    }
  }

  item(node: XNode, file: string, index: number, handlers: Handler[]): Item | undefined {
    const kinds = ["block", "field", "initial", "subdialog", "transfer"] as const;
    const kind = kinds.find((k) => k === node.name);
    if (!kind) return undefined;
    const name = node.attrs["name"] ?? `_${kind}${index}`;
    const itemHandlers: Handler[] = [];
    // Stryker disable next-line ArrayDeclaration: equivalent; a prompt without a count is never the count said
    const prompts: Prompt[] = [];
    const grammars: Matcher[] = [];
    const filled: number[] = [];
    const options: Option[] = [];
    const optionValues: Choosable[] = [];
    const params: { name: string; expr: string }[] = [];
    if (kind === "block") {
      // Stryker disable next-line BooleanLiteral: equivalent; a block hears no answer, so whether it is modal is never read
      return { kind, name, ...defined({ cond: node.attrs["cond"], expr: node.attrs["expr"] }), slot: name, modal: false, prompts, grammars, handlers: itemHandlers, filled, options, params, body: this.body(this.execs(node.children, file)) };
    }
    for (const c of elements(node)) {
      if (c.name === "prompt") prompts.push(this.prompt(c, file));
      else if (c.name === "grammar") grammars.push(this.grammar(c, file));
      else if (c.name === "filled") filled.push(this.body(this.execs(c.children, file)));
      else if (c.name === "option") {
        const text = textOf(c).trim();
        const key = c.attrs["dtmf"];
        options.push({ text, ...(key === undefined ? {} : { dtmf: key }) });
        optionValues.push({ value: c.attrs["value"] ?? text, phrase: wordsOf(text), ...(key === undefined ? {} : { key }), approximate: c.attrs["accept"] === "approximate" });
      } else if (c.name === "param") params.push({ name: required(c, "name", file), expr: c.attrs["expr"] ?? JSON.stringify(c.attrs["value"] ?? "") });
      else if (this.handler(c, file, itemHandlers)) continue;
      else if (c.name === "link") throw new DocumentError(`${file}: a <link> in a <${kind}> is not supported; put it in the form or document`);
      else this.other(c, file, `<${kind}>`);
    }
    if (optionValues.length > 0) grammars.push(choicesGrammar(optionValues));
    const type = node.attrs["type"];
    if (type !== undefined) grammars.push(builtinGrammar(type));
    if (kind === "field" && grammars.length === 0) throw new DocumentError(`${file}: field ${name} has no grammar, type or option`);
    if (kind === "subdialog" && node.attrs["src"] === undefined && node.attrs["srcexpr"] === undefined) throw new DocumentError(`${file}: subdialog ${name} needs a src`);
    void handlers;
    return {
      kind,
      name,
      ...defined({ cond: node.attrs["cond"], expr: node.attrs["expr"], src: node.attrs["src"], srcexpr: node.attrs["srcexpr"] }),
      slot: node.attrs["slot"] ?? name,
      modal: node.attrs["modal"] === "true",
      prompts,
      grammars,
      handlers: itemHandlers,
      filled,
      options,
      params,
    };
  }

  form(node: XNode, file: string): Dialog {
    const id = node.attrs["id"] ?? `_form${this.#dialogs}`;
    this.#dialogs++;
    const vars: Exec[] = [];
    const items: Item[] = [];
    const grammars: Matcher[] = [];
    const handlers: Handler[] = [];
    const links: Link[] = [];
    const filled: FormFilled[] = [];
    for (const [i, c] of elements(node).entries()) {
      const item = this.item(c, file, i, handlers);
      if (item) items.push(item);
      else if (c.name === "var") vars.push(...this.exec(c, file));
      else if (c.name === "grammar") grammars.push(this.grammar(c, file));
      else if (c.name === "link") links.push(this.link(c, file));
      else if (c.name === "filled") {
        const mode = c.attrs["mode"] ?? "all";
        if (mode !== "all" && mode !== "any") throw new DocumentError(`${file}: <filled mode="${mode}"> is all or any`);
        filled.push({ mode, ...(c.attrs["namelist"] === undefined ? {} : { namelist: c.attrs["namelist"].split(/\s+/).filter((n) => n !== "") }), body: this.body(this.execs(c.children, file)) });
      } else if (this.handler(c, file, handlers)) continue;
      else this.other(c, file, "<form>");
    }
    const names = new Set<string>();
    for (const item of items) {
      if (names.has(item.name)) throw new DocumentError(`${file}: form item ${item.name} is named twice`);
      names.add(item.name);
    }
    return { id, file, vars, items, grammars, documentScope: node.attrs["scope"] === "document", handlers, links, filled };
  }

  menu(node: XNode, file: string): Dialog {
    const id = node.attrs["id"] ?? `_menu${this.#dialogs}`;
    this.#dialogs++;
    const dtmf = node.attrs["dtmf"] === "true";
    // Stryker disable next-line ArrayDeclaration: equivalent; a prompt without a count is never the count said
    const prompts: Prompt[] = [];
    const handlers: Handler[] = [];
    const choices: Choice[] = [];
    const options: Option[] = [];
    const values: Choosable[] = [];
    // With dtmf="true", the first nine choices without a key of their own are numbered 1 to 9;
    // two choices with the same key are refused, as no key could tell them apart.
    let numbered = 0;
    const keys = new Set<string>();
    for (const c of elements(node)) {
      if (c.name === "prompt") prompts.push(this.prompt(c, file));
      else if (c.name === "choice") {
        const text = textOf(c).trim();
        const { next, expr, event } = c.attrs;
        if (next === undefined && expr === undefined && event === undefined) throw new DocumentError(`${file}: a <choice> needs next, expr or event`);
        const value = String(choices.length);
        const key = c.attrs["dtmf"] ?? (dtmf && numbered < 9 ? String(++numbered) : undefined);
        if (key !== undefined && keys.has(key)) throw new DocumentError(`${file}: menu ${id} has two choices with the key ${key}`);
        if (key !== undefined) keys.add(key);
        choices.push({ text, ...defined({ next, expr, event }) });
        options.push({ text, ...(key === undefined ? {} : { dtmf: key }) });
        // A choice with grammars of its own is said by them, not by its text.
        const grammars = elements(c, "grammar").map((g) => this.grammar(g, file));
        values.push({
          value,
          ...(grammars.length > 0 ? { grammars } : { phrase: wordsOf(text) }),
          ...(key === undefined ? {} : { key }),
          approximate: (c.attrs["accept"] ?? node.attrs["accept"]) === "approximate",
        });
      } else if (this.handler(c, file, handlers)) continue;
      else this.other(c, file, "<menu>");
    }
    if (choices.length === 0) throw new DocumentError(`${file}: menu ${id} has no <choice>`);
    const field: Item = {
      kind: "field",
      name: "_menu",
      // Stryker disable next-line StringLiteral: equivalent; a menu's interpretation is a choice's index, which has no slots
      slot: "_menu",
      modal: false,
      prompts,
      grammars: [choicesGrammar(values)],
      handlers: [],
      // Stryker disable next-line ArrayDeclaration: equivalent; a choice is taken before filled actions would be queued
      filled: [],
      options,
      choices,
      // Stryker disable next-line ArrayDeclaration: equivalent; only a subdialog reads its params
      params: [],
    };
    return { id, file, vars: [], items: [field], grammars: node.attrs["scope"] === "document" ? field.grammars : [], documentScope: node.attrs["scope"] === "document", handlers, links: [], filled: [] };
  }
}

function required(node: XNode, attr: string, file: string): string {
  const v = node.attrs[attr];
  if (v === undefined) throw new DocumentError(`${file}: <${node.name}> needs ${attr}`);
  return v;
}

function defined<T extends Record<string, string | undefined>>(o: T): { [K in keyof T]?: string } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: string };
}

/** Whether `words` are some of `phrase`'s words, in its order (an approximate choice's "subphrase"). */
function subphrase(words: readonly string[], phrase: readonly string[]): boolean {
  let at = 0;
  for (const w of words) {
    while (at < phrase.length && phrase[at] !== w) at++;
    if (at === phrase.length) return false;
    at++;
  }
  return words.length > 0;
}

/**
 * Options or choices as a grammar: the first that takes the whole utterance (its words,
 * its own grammars, or its key), else the first approximate one it is a subphrase of.
 */
function choicesGrammar(values: readonly Choosable[]): Matcher {
  return (u) => {
    const words = wordsOf(u);
    const said = words.join(" ");
    // A key (# and * among them) is the whole utterance as typed.
    const exact = (v: Choosable) => v.key === u.trim() || v.key === said || (v.phrase !== undefined ? v.phrase.join(" ") === said : v.grammars!.some((g) => g(u) !== undefined));
    const found = values.find(exact) ?? values.find((v) => v.approximate && v.phrase !== undefined && subphrase(words, v.phrase));
    return found ? { value: found.value, text: said } : undefined;
  };
}

/** Compiles a VoiceXML application: its main document, the documents it goes to and the grammar files they use. */
export function compileVoiceXml(files: Readonly<Record<string, string>>, main: string, options: { readonly nomatch?: "model" | "reprompt" } = {}): { readonly compiled: Compiled; readonly warnings: readonly string[] } {
  const compiler = new Compiler(files);
  const documents = new Map<string, VxmlDocument>();
  for (const file of Object.keys(files).filter((f) => /\.vxml$/i.test(f))) documents.set(file, compiler.document(file));
  const first = documents.get(main);
  if (!first) throw new DocumentError(`${main} is not a VoiceXML document among the files imported`);
  // An application root may hold only variables, handlers and links; the document a call starts in has a dialog.
  if (first.dialogs.length === 0) throw new DocumentError(`${main}: the document has no <form> or <menu>`);
  for (const g of compiler.grammars.values()) checkRefs(g, compiler.grammars);
  for (const doc of documents.values()) if (doc.application !== undefined && !documents.has(doc.application)) throw new DocumentError(`${doc.file}: application root ${doc.application} is not among the files imported`);
  return { compiled: { main, documents, bodies: compiler.bodies, nomatch: options.nomatch ?? "model" }, warnings: compiler.warnings };
}

// ---- running -----------------------------------------------------------------------

/** A scope as JSON: its values, and the names declared but not set. */
interface SavedScope {
  readonly vars: Readonly<Record<string, unknown>>;
  readonly unset: readonly string[];
}

interface Running {
  readonly body: number;
  /** Where in the body to go on: statement indexes, and after each `if` the branch taken. */
  readonly path: readonly number[];
  readonly scope: SavedScope;
  /** The form item the body belongs to (its `<filled>`, or a handler of its events): an event the body throws is that item's. */
  readonly item?: string;
}

interface Frame {
  readonly file: string;
  readonly dialog: string;
  readonly doc: SavedScope;
  readonly vars: SavedScope;
  readonly prompts: Readonly<Record<string, number>>;
  readonly events: Readonly<Record<string, number>>;
  readonly queue: readonly Running[];
  readonly nextitem?: string;
  /** The item not prompted when next visited (a handler for its event did not reprompt). */
  readonly quiet?: string;
  /** The caller's subdialog item, in the frame below. */
  readonly caller?: string;
}

interface VxmlState {
  readonly app: SavedScope;
  readonly frames: readonly Frame[];
  /** The item waiting for an utterance. */
  readonly waiting?: string;
  /** The body waiting for a tool's result, and the variable the result goes in. */
  readonly calling?: { readonly into?: string; readonly exit: boolean };
}

type Vars = Record<string, Value>;

const load = (s: SavedScope): Vars => ({ ...Object.fromEntries(s.unset.map((n) => [n, undefined])), ...(s.vars as Vars) });
function save(scope: Vars): SavedScope {
  const vars: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(scope)) {
    const json = toJson(v);
    if (json === undefined) unset.push(k);
    else vars[k] = json;
  }
  return { vars, unset };
}
const EMPTY: SavedScope = { vars: {}, unset: [] };

type Signal =
  | { readonly kind: "goto"; readonly next?: string; readonly nextitem?: string }
  | { readonly kind: "event"; readonly event: string; readonly message?: string }
  | { readonly kind: "exit"; readonly output: unknown }
  | { readonly kind: "return"; readonly event?: string; readonly values: Vars }
  | { readonly kind: "call"; readonly tool: string; readonly input: unknown; readonly into?: string; readonly exit: boolean; readonly path: number[] }
  | { readonly kind: "reprompt" };

class Halt {
  readonly result: StepResult;
  constructor(result: StepResult) {
    this.result = result;
  }
}

/** An error the document cannot catch: an event no handler took, or a document that never waits. */
class Uncaught extends ScriptError {}

/** The event a script error is thrown to the document as: `error.badfetch` for what could not be fetched, else `error.semantic`. */
function eventOf(e: ScriptError): { readonly event: string; readonly message: string } {
  const m = /^(error\.[a-z.]+): (.*)$/s.exec(e.message);
  return m ? { event: m[1]!, message: m[2]! } : { event: "error.semantic", message: e.message };
}

const MAX_ACTIONS = 1000;

/** One step of a VoiceXML application: everything up to the next utterance it waits for. */
class Session {
  readonly say: string[] = [];
  app: Vars;
  frames: { file: string; dialog: Dialog; doc: Vars; vars: Vars; prompts: Record<string, number>; events: Record<string, number>; queue: Running[]; nextitem?: string; quiet?: string; caller?: string }[];
  waiting: string | undefined;
  #actions = 0;
  /** The item being visited, whose handlers take an error in visiting it. */
  #visiting: string | undefined;

  readonly c: Compiled;

  constructor(c: Compiled, state: VxmlState | undefined) {
    this.c = c;
    this.app = state ? load(state.app) : {};
    this.frames = (state?.frames ?? []).map((f) => ({
      file: f.file,
      dialog: this.dialog(f.file, f.dialog),
      doc: load(f.doc),
      vars: load(f.vars),
      prompts: { ...f.prompts },
      events: { ...f.events },
      queue: [...f.queue],
      ...(f.nextitem === undefined ? {} : { nextitem: f.nextitem }),
      ...(f.quiet === undefined ? {} : { quiet: f.quiet }),
      ...(f.caller === undefined ? {} : { caller: f.caller }),
    }));
    this.waiting = state?.waiting;
  }

  get frame() {
    return this.frames[this.frames.length - 1]!;
  }

  state(): VxmlState {
    return {
      app: save(this.app),
      frames: this.frames.map((f) => ({
        file: f.file,
        dialog: f.dialog.id,
        doc: save(f.doc),
        vars: save(f.vars),
        prompts: f.prompts,
        events: f.events,
        queue: f.queue,
        ...(f.nextitem === undefined ? {} : { nextitem: f.nextitem }),
        ...(f.quiet === undefined ? {} : { quiet: f.quiet }),
        ...(f.caller === undefined ? {} : { caller: f.caller }),
      })),
      ...(this.waiting === undefined ? {} : { waiting: this.waiting }),
    };
  }

  document(file: string): VxmlDocument {
    const doc = this.c.documents.get(file);
    if (!doc) throw new ScriptError(`error.badfetch: ${file} is not among the documents`);
    return doc;
  }

  dialog(file: string, id: string | undefined): Dialog {
    const doc = this.document(file);
    const dialog = id === undefined ? doc.dialogs[0] : doc.dialogs.find((d) => d.id === id);
    if (!dialog) throw new ScriptError(`error.badfetch: ${file} has no dialog ${id}`);
    return dialog;
  }

  /** Scopes for script, innermost first: a body's own, the dialog's, the document's, the application's, and the scope names. */
  scopes(own?: Vars): Vars[] {
    const f = this.frame;
    const named: Vars = { application: this.app, document: f.doc, dialog: f.vars, session: Object.freeze({}) as Vars };
    return [...(own ? [own] : []), f.vars, f.doc, this.app, named];
  }

  eval(expr: string, own?: Vars): Value {
    return evaluate(expr, this.scopes(own));
  }

  // ---- entering documents and dialogs

  start(slots: Readonly<Record<string, string>>): void {
    const doc = this.document(this.c.main);
    if (doc.application !== undefined) this.initDocument(this.document(doc.application), this.app);
    const docScope: Vars = {};
    this.initDocument(doc, docScope);
    // Stryker disable next-line StringLiteral: equivalent; at the start there is no frame, so replacing the top one is pushing one
    this.enter(doc.file, doc.dialogs[0]!, docScope, "replace");
    for (const item of this.frame.dialog.items) if (item.kind === "field" && Object.hasOwn(slots, item.name)) this.frame.vars[item.name] = slots[item.name]!;
  }

  initDocument(doc: VxmlDocument, scope: Vars): void {
    for (const v of doc.vars) this.declare(v as Extract<Exec, { op: "var" }>, scope, [scope, this.app]);
  }

  declare(v: Extract<Exec, { op: "var" }>, into: Vars, scopes: Vars[]): void {
    into[v.name] = v.expr === undefined ? undefined : evaluate(v.expr, scopes);
  }

  enter(file: string, dialog: Dialog, doc: Vars, how: "replace" | "push", params: Vars = {}, caller?: string): void {
    const vars: Vars = {};
    const frame = { file, dialog, doc, vars, prompts: {}, events: {}, queue: [], ...(caller === undefined ? {} : { caller }) };
    if (how === "replace") this.frames[Math.max(0, this.frames.length - 1)] = frame;
    else this.frames.push(frame);
    for (const v of dialog.vars) {
      const decl = v as Extract<Exec, { op: "var" }>;
      if (Object.hasOwn(params, decl.name)) vars[decl.name] = params[decl.name];
      else this.declare(decl, vars, this.scopes());
    }
    for (const item of dialog.items) vars[item.name] = item.expr === undefined ? undefined : this.eval(item.expr);
  }

  transition(next: string | undefined, nextitem: string | undefined): void {
    if (nextitem !== undefined) {
      if (!this.frame.dialog.items.some((i) => i.name === nextitem)) throw new ScriptError(`error.badfetch: no form item ${nextitem}`);
      this.frame.nextitem = nextitem;
      this.frame.queue = [];
      return;
    }
    const [path, id] = (next ?? "").split("#");
    // A path is relative to the document going there.
    const file = path === "" ? this.frame.file : resolvePath(this.frame.file, path!);
    const doc = this.document(file);
    const docScope = file === this.frame.file ? this.frame.doc : {};
    if (file !== this.frame.file) this.initDocument(doc, docScope);
    // In a subdialog, a goto stays in it: its <return> still returns to the caller.
    this.enter(file, this.dialog(file, id === "" ? undefined : id), docScope, "replace", {}, this.frame.caller);
  }

  // ---- the form interpretation algorithm

  run(): StepResult {
    for (;;) {
      if (++this.#actions > MAX_ACTIONS) throw new Uncaught("error.semantic: the document never waits for input");
      const result = this.advance();
      if (result) return result;
    }
  }

  /** One action of the algorithm: a queued body goes on, or the next item is visited; a script error in it is thrown to the document as an event. */
  advance(): StepResult | undefined {
    const f = this.frame;
    if (f.queue.length > 0) {
      const running = f.queue[0]!;
      let signal: Signal | undefined;
      try {
        signal = this.execute(running);
      } catch (e) {
        // The body stops where it failed; the event is its item's.
        f.queue.shift();
        return this.failed(e, running.item);
      }
      if (signal === undefined) {
        f.queue.shift();
        return undefined;
      }
      try {
        this.handle(signal);
      } catch (e) {
        // A goto to nowhere, say: error.badfetch.
        return this.failed(e, running.item);
      }
      return undefined;
    }
    this.#visiting = undefined;
    try {
      return this.visit();
    } catch (e) {
      // An error visiting an item (its prompt, a subdialog's src or params) is that item's.
      return this.failed(e, this.#visiting);
    }
  }

  /** A script error as the event it is (`error.semantic`, `error.badfetch`), thrown to the document; anything else goes on up. */
  failed(e: unknown, item: string | undefined): undefined {
    if (!(e instanceof ScriptError) || e instanceof Uncaught) throw e;
    const { event, message } = eventOf(e);
    this.throwEvent(event, message, item);
    return undefined;
  }

  /** Visits the next form item: a block's content, a subdialog, a transfer, or a field that waits. */
  visit(): StepResult | undefined {
    const f = this.frame;
    const item = this.select();
    // Stryker disable next-line ObjectLiteral: equivalent; finish ends with null for an output not given
    if (!item) return this.finish({ output: null });
    this.#visiting = item.name;
    if (item.kind === "block") {
      f.vars[item.name] = true;
      f.queue.push({ body: item.body!, path: [], scope: EMPTY, item: item.name });
      return undefined;
    }
    if (item.kind === "subdialog") {
      const target = item.src ?? String(this.eval(item.srcexpr!));
      const [path, id] = target.split("#");
      const file = path === "" ? f.file : resolvePath(f.file, path!);
      const params: Vars = Object.fromEntries(item.params.map((p) => [p.name, this.eval(p.expr)]));
      const doc = file === f.file ? f.doc : {};
      if (file !== f.file) this.initDocument(this.document(file), doc);
      this.enter(file, this.dialog(file, id === "" || id === undefined ? undefined : id), doc, "push", params, item.name);
      return undefined;
    }
    this.queuePrompts(item);
    if (item.kind === "transfer") {
      f.vars[item.name] = true;
      throw new Halt({ say: this.say, state: this.state() as never, end: "transfer" });
    }
    this.waiting = item.name;
    return { say: this.say, state: this.state() as never };
  }

  select(): Item | undefined {
    const f = this.frame;
    if (f.nextitem !== undefined) {
      const name = f.nextitem;
      delete f.nextitem;
      return f.dialog.items.find((i) => i.name === name);
    }
    return f.dialog.items.find((i) => f.vars[i.name] === undefined && (i.cond === undefined || Boolean(this.eval(i.cond))));
  }

  queuePrompts(item: Item): void {
    const f = this.frame;
    const count = (f.prompts[item.name] ?? 0) + 1;
    f.prompts[item.name] = count;
    if (f.quiet !== undefined) {
      // Only the item whose event was handled is quiet; any other item selected next is prompted.
      const quiet = f.quiet === item.name;
      delete f.quiet;
      if (quiet) return;
    }
    const eligible = item.prompts.filter((p) => p.cond === undefined || Boolean(this.eval(p.cond)));
    const best = Math.max(0, ...eligible.filter((p) => p.count <= count).map((p) => p.count));
    for (const p of eligible.filter((q) => q.count === best)) this.prompt(p, item);
  }

  prompt(p: Prompt, item?: Item, own?: Vars): void {
    const render = (content: readonly Content[], extra?: Vars): string =>
      content
        .map((c) => {
          if (typeof c === "string") return c;
          if ("value" in c) return String(evaluate(c.value, [...(extra ? [extra] : []), ...this.scopes(own)]) ?? "");
          const options = item?.options ?? [];
          if (c.enumerate === undefined) return options.map((o) => o.text).join(", ");
          return options.map((o) => render(c.enumerate!, { _prompt: o.text, _dtmf: o.dtmf })).join(" ");
        })
        .join("");
    const text = render(p.content).replace(/\s+/g, " ").trim();
    if (text !== "") this.say.push(text);
  }

  /** Runs a body from where it stopped; a signal stops it (and a tool call keeps where). */
  execute(running: Running): Signal | undefined {
    const own = load(running.scope);
    const walk = (body: readonly Exec[], path: readonly number[], at: number[]): Signal | undefined => {
      for (let i = path[0] ?? 0; i < body.length; i++) {
        const e = body[i]!;
        const resuming = i === path[0] && path.length > 1;
        const signal = this.statement(e, own, resuming ? path.slice(1) : [], [...at, i], walk);
        if (signal) {
          if (signal.kind === "call") this.frame.queue[0] = { ...running, path: signal.path, scope: save(own) };
          return signal;
        }
      }
      return undefined;
    };
    return walk(this.c.bodies[running.body]!, running.path, []);
  }

  statement(e: Exec, own: Vars, resume: readonly number[], at: number[], walk: (body: readonly Exec[], path: readonly number[], at: number[]) => Signal | undefined): Signal | undefined {
    switch (e.op) {
      case "var":
        own[e.name] = e.expr === undefined ? undefined : this.eval(e.expr, own);
        return undefined;
      case "assign":
        execute(`${e.name} = (${e.expr})`, this.scopes(own));
        return undefined;
      case "clear": {
        const f = this.frame;
        const names = e.names ?? f.dialog.items.map((i) => i.name);
        for (const n of names) {
          const scope = this.scopes(own).find((s) => Object.hasOwn(s, n));
          if (!scope) throw new ScriptError(`error.semantic: ${n} is not declared`);
          scope[n] = undefined;
          // A cleared item is asked again from its first prompt, after a handler too.
          delete f.quiet;
          delete f.prompts[n];
          for (const key of Object.keys(f.events)) if (key.startsWith(`${n}:`)) delete f.events[key];
        }
        return undefined;
      }
      case "if": {
        const taken = resume.length > 0 ? resume[0]! : e.branches.findIndex((b) => b.cond === undefined || Boolean(this.eval(b.cond, own)));
        if (taken < 0) return undefined;
        const signal = walk(e.branches[taken]!.body, resume.slice(1), [...at, taken]);
        return signal;
      }
      case "prompt":
        if (e.prompt.cond === undefined || Boolean(this.eval(e.prompt.cond, own))) this.prompt(e.prompt, undefined, own);
        return undefined;
      case "goto":
        return { kind: "goto", ...defined({ next: e.expr === undefined ? e.next : String(this.eval(e.expr, own)), nextitem: e.expritem === undefined ? e.nextitem : String(this.eval(e.expritem, own)) }) };
      case "call": {
        const tool = e.tool ?? String(this.eval(e.expr!, own)).replace(/^tool:/, "");
        const input = Object.fromEntries(e.namelist.map((n) => [n, toJson(this.eval(n, own)) ?? null]));
        // The statement after this one is where the body goes on once the result is in.
        const path = [...at];
        path[path.length - 1] = path[path.length - 1]! + 1;
        return { kind: "call", tool, input, ...(e.into === undefined ? {} : { into: e.into }), exit: e.exit, path };
      }
      case "exit": {
        const output = e.expr !== undefined ? toJson(this.eval(e.expr, own)) : e.namelist ? Object.fromEntries(e.namelist.map((n) => [n, toJson(this.eval(n, own)) ?? null])) : null;
        return { kind: "exit", output: output ?? null };
      }
      case "return": {
        const values: Vars = Object.fromEntries(e.namelist.map((n) => [n, this.eval(n, own)]));
        const event = e.eventexpr === undefined ? e.event : String(this.eval(e.eventexpr, own));
        return { kind: "return", ...(event === undefined ? {} : { event }), values };
      }
      case "reprompt":
        return { kind: "reprompt" };
      case "throw": {
        const event = e.eventexpr === undefined ? e.event : String(this.eval(e.eventexpr, own));
        if (event === undefined) throw new ScriptError("error.semantic: <throw> needs an event");
        const message = e.messageexpr === undefined ? e.message : String(this.eval(e.messageexpr, own));
        return { kind: "event", event, ...(message === undefined ? {} : { message }) };
      }
      case "disconnect":
        return { kind: "exit", output: null };
      case "none":
        return undefined;
    }
  }

  handle(signal: Signal): void {
    const f = this.frame;
    switch (signal.kind) {
      case "goto":
        f.queue = [];
        this.transition(signal.next, signal.nextitem);
        return;
      case "event": {
        // An event a body throws is its item's (a <throw> in a field's <filled> goes to that field's handlers first).
        const running = f.queue.shift();
        // Stryker disable next-line OptionalChaining: equivalent; a signal comes from the body at the head of the queue
        this.throwEvent(signal.event, signal.message, running?.item);
        return;
      }
      case "reprompt":
        f.queue.shift();
        delete f.quiet;
        return;
      case "exit":
        throw new Halt(this.finish(signal));
      case "return": {
        if (f.caller === undefined) throw new ScriptError("error.semantic: <return> outside a subdialog");
        this.frames.pop();
        const caller = this.frame;
        if (signal.event !== undefined) {
          this.throwEvent(signal.event, undefined, f.caller);
          return;
        }
        caller.vars[f.caller] = Object.fromEntries(Object.entries(signal.values).map(([k, v]) => [k, toJson(v) ?? null])) as Value;
        this.filled([f.caller]);
        return;
      }
      case "call":
        throw new Halt({ say: this.say, state: { ...this.state(), calling: { ...(signal.into === undefined ? {} : { into: signal.into }), exit: signal.exit } } as never, call: { tool: signal.tool, input: signal.input as never } });
    }
  }

  finish(signal: { readonly output: unknown }): StepResult {
    return { say: this.say, state: this.state() as never, end: "exit", output: (signal.output ?? null) as never };
  }

  /** A tool that could not be called (the host has none of its name): error.badfetch where the body called it. */
  unfetched(error: string): void {
    const running = this.frame.queue.shift();
    const { event, message } = eventOf(new ScriptError(error));
    // Stryker disable next-line OptionalChaining: equivalent; a tool is called by the body at the head of the queue
    this.throwEvent(event, message, running?.item);
  }

  /** A tool's result, into the variable the call named, and the body goes on (a submit's ends the application). */
  resume(result: unknown, calling: NonNullable<VxmlState["calling"]>): void {
    if (calling.exit) throw new Halt(this.finish({ output: result }));
    const f = this.frame;
    const running = f.queue[0]!;
    if (calling.into !== undefined) {
      const own = load(running.scope);
      const scope = this.scopes(own).find((s) => Object.hasOwn(s, calling.into!)) ?? own;
      scope[calling.into] = result as Value;
      f.queue[0] = { ...running, scope: scope === own ? save(own) : running.scope };
    }
  }

  // ---- events

  throwEvent(event: string, message: string | undefined, itemName = this.waiting): void {
    const f = this.frame;
    const item = f.dialog.items.find((i) => i.name === itemName);
    const key = `${item?.name ?? "_form"}:${event}`;
    const count = (f.events[key] ?? 0) + 1;
    f.events[key] = count;
    const doc = this.document(f.file);
    const app = doc.application === undefined ? undefined : this.document(doc.application);
    const candidates = [...(item?.handlers ?? []), ...f.dialog.handlers, ...doc.handlers, ...(app?.handlers ?? [])].filter(
      (h) => (h.events.length === 0 || h.events.some((e) => event === e || event.startsWith(`${e}.`))) && (h.cond === undefined || Boolean(this.eval(h.cond))),
    );
    const best = Math.max(0, ...candidates.filter((h) => h.count <= count).map((h) => h.count));
    const handler = candidates.find((h) => h.count === best);
    if (handler) {
      // After a handler the algorithm selects the next item as ever (the same one, unless the
      // handler filled it or went elsewhere), with its prompts only if the handler reprompts.
      if (item) f.quiet = item.name;
      else delete f.quiet;
      f.queue.unshift({ body: handler.body, path: [], scope: save({ _event: event, _message: message ?? null }), ...(item ? { item: item.name } : {}) });
      return;
    }
    // The platform's own handling reprompts: the item is not quiet (as it is after a turn handed on).
    if (event === "noinput") {
      delete f.quiet;
      if (item) f.nextitem = item.name;
      return;
    }
    if (event === "nomatch" || event === "help") {
      // A turn goes to the model only from an item waiting for it (which hears the next answer); thrown outside one, the form goes on.
      if (item && (this.c.nomatch === "model" || event === "help")) throw new Halt({ say: this.say, state: this.quietState(item), pass: true });
      if (!item && (this.c.nomatch === "model" || event === "help")) return;
      this.say.push("Sorry, I didn't understand.");
      delete f.quiet;
      if (item) f.nextitem = item.name;
      return;
    }
    // The platform's cancel stops what is being said and does not reprompt.
    if (event === "cancel") {
      if (item) f.quiet = item.name;
      return;
    }
    // Stryker disable next-line ObjectLiteral: equivalent; finish ends with null for an output not given
    if (event.startsWith("connection.disconnect") || event === "exit") throw new Halt(this.finish({ output: null }));
    throw new Uncaught(`${event}${message === undefined ? "" : `: ${message}`}`);
  }

  /** The state for a turn handed on: the item still waits (its next utterance is heard by it), and is not prompted again. */
  quietState(item: Item | undefined): never {
    if (item) this.frame.quiet = item.name;
    return { ...this.state(), ...(item ? { waiting: item.name } : {}) } as never;
  }

  // ---- hearing

  hear(utterance: string): void {
    const item = this.frame.dialog.items.find((i) => i.name === this.waiting);
    if (!item) throw new ScriptError("error.semantic: no item is waiting");
    if (utterance.trim() === "") return this.throwEvent("noinput", undefined);
    for (const g of item.grammars) {
      const m = g(utterance);
      if (m) return this.fillField(item, m, utterance);
    }
    if (!item.modal) {
      const f = this.frame;
      for (const g of f.dialog.grammars) {
        const m = g(utterance);
        if (m && this.fillForm(m, utterance)) return;
      }
      const doc = this.document(f.file);
      const app = doc.application === undefined ? undefined : this.document(doc.application);
      for (const link of [...f.dialog.links, ...doc.links, ...(app?.links ?? [])]) {
        if (!link.grammars.some((g) => g(utterance))) continue;
        const event = link.eventexpr === undefined ? link.event : String(this.eval(link.eventexpr));
        if (event !== undefined) return this.throwEvent(event, undefined);
        return this.transition(link.expr === undefined ? link.next : String(this.eval(link.expr)), undefined);
      }
      for (const other of doc.dialogs.filter((d) => d.documentScope && d !== f.dialog)) {
        for (const g of other.grammars) {
          const m = g(utterance);
          if (!m) continue;
          this.enter(f.file, other, f.doc, "replace", {}, f.caller);
          if (other.items[0]?.choices) return this.fillField(other.items[0], m, utterance);
          this.fillForm(m, utterance);
          return;
        }
      }
    }
    this.throwEvent("nomatch", undefined);
  }

  shadow(item: Item, m: GrammarMatch, utterance: string): void {
    const result = { utterance, interpretation: m.value as Value, confidence: 1, inputmode: "voice" };
    this.frame.vars[`${item.name}$`] = result;
    this.app["lastresult$"] = [result];
  }

  fillField(item: Item, m: GrammarMatch, utterance: string): void {
    const f = this.frame;
    this.shadow(item, m, utterance);
    const value = m.value;
    const slotValue = typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, item.slot) ? (value as Record<string, unknown>)[item.slot] : value;
    if (item.choices) {
      const choice = item.choices[Number(slotValue)]!;
      delete f.quiet;
      if (choice.event !== undefined) return this.throwEvent(choice.event, undefined);
      return this.transition(choice.expr === undefined ? choice.next : String(this.eval(choice.expr)), undefined);
    }
    f.vars[item.name] = slotValue as Value;
    this.filled([item.name]);
  }

  /** A form-level grammar's interpretation fills every field whose slot it names; false when it names none. */
  fillForm(m: GrammarMatch, utterance: string): boolean {
    const f = this.frame;
    const value = m.value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const names: string[] = [];
    for (const item of f.dialog.items.filter((i) => i.kind === "field" && Object.hasOwn(value, i.slot))) {
      f.vars[item.name] = (value as Record<string, Value>)[item.slot];
      this.shadow(item, { value: (value as Record<string, unknown>)[item.slot], text: m.text }, utterance);
      names.push(item.name);
    }
    if (names.length === 0) return false;
    // An <initial> is done once the form's grammar has filled something.
    // Stryker disable next-line BooleanLiteral: equivalent; an item with any value but undefined is done
    for (const i of f.dialog.items) if (i.kind === "initial") f.vars[i.name] = true;
    this.filled(names);
    return true;
  }

  /** Queues the filled actions for items just filled: each item's own, then the form's that apply. */
  filled(names: readonly string[]): void {
    const f = this.frame;
    delete f.quiet;
    for (const item of f.dialog.items.filter((i) => names.includes(i.name))) for (const body of item.filled) f.queue.push({ body, path: [], scope: EMPTY, item: item.name });
    const fields = f.dialog.items.filter((i) => i.kind === "field" || i.kind === "subdialog").map((i) => i.name);
    for (const ff of f.dialog.filled) {
      const list = ff.namelist ?? fields;
      const touched = list.some((n) => names.includes(n));
      const ready = ff.mode === "any" ? touched : touched && list.every((n) => f.vars[n] !== undefined);
      if (ready) f.queue.push({ body: ff.body, path: [], scope: EMPTY });
    }
  }
}

/** One step: starts the application (state null), hears an utterance, or takes a tool's result. */
export function stepVoiceXml(compiled: Compiled, input: StepInput): StepResult {
  const state = input.state as VxmlState | null;
  const session = new Session(compiled, state ?? undefined);
  try {
    if (state === null) session.start(input.slots ?? {});
    else if (state.calling !== undefined && input.error !== undefined) session.unfetched(input.error);
    else if (state.calling !== undefined) session.resume(input.result ?? null, state.calling);
    else {
      try {
        session.hear(input.utterance ?? "");
      } catch (e) {
        // A link to nowhere, say: the event is the waiting item's.
        session.failed(e, session.waiting);
      }
    }
    session.waiting = undefined;
    return session.run();
  } catch (e) {
    if (e instanceof Halt) return e.result;
    throw e;
  }
}

export const voiceXml: Interpreter = {
  type: "voicexml",
  compile(files, options) {
    const main = typeof options["main"] === "string" ? options["main"] : Object.keys(files).find((f) => /\.vxml$/i.test(f));
    if (main === undefined) throw new DocumentError("no VoiceXML document (.vxml) among the files");
    const nomatch = options["nomatch"] === "reprompt" ? "reprompt" : "model";
    const { compiled, warnings } = compileVoiceXml(files, main, { nomatch });
    return { warnings, step: (input) => stepVoiceXml(compiled, input) };
  },
};
