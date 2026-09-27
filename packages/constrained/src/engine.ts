import type { Constraint, TemplateConstraint, TokenConstraint } from "@harness/cognitive";
import type * as XGrammarModule from "@mlc-ai/web-xgrammar";
import type { StructuralTag, StructuralTagFormat as TagFormat } from "@mlc-ai/web-xgrammar";

/** The XGrammar web binding (`@mlc-ai/web-xgrammar`); the host loads it for its platform. */
export type XGrammar = typeof XGrammarModule;
type CompiledGrammar = Awaited<ReturnType<XGrammarModule.GrammarCompiler["compileGrammar"]>>;

/** A tokenizer's vocabulary as XGrammar needs it: every token in id order, how tokens encode text, and the tokens that end a turn. */
export interface Vocabulary {
  readonly tokens: readonly string[];
  /** "raw" (tokens are text), "byte_level" (GPT-2 style byte mapping) or "byte_fallback" (SentencePiece <0xNN> pieces). */
  readonly encoding?: "raw" | "byte_level" | "byte_fallback";
  readonly prependSpace?: boolean;
  /** The model's logits size when it is larger than the vocabulary (padding). */
  readonly size?: number;
  readonly stopTokens: readonly number[];
}

type Hole = Exclude<TemplateConstraint["parts"][number], string>;
const holeFormat = (constraint: Hole["constraint"]): TagFormat =>
  constraint === undefined
    ? { type: "any_text" }
    : constraint.type === "json-schema"
      ? { type: "json_schema", json_schema: constraint.schema }
      : constraint.type === "grammar"
        ? { type: "grammar", grammar: constraint.ebnf }
        : { type: "regex", pattern: constraint.pattern };

/**
 * A template as an XGrammar-2 structural tag: fixed text is a constant string, and each
 * hole is its constraint (free text by default) running up to the fixed text after it.
 */
export function templateTag(template: TemplateConstraint): StructuralTag & { format: { type: "sequence"; elements: TagFormat[] } } {
  const elements: TagFormat[] = [];
  template.parts.forEach((part, i) => {
    if (typeof part === "string") {
      if (typeof template.parts[i - 1] !== "object") elements.push({ type: "const_string", value: part });
      return;
    }
    const end = template.parts[i + 1] as string | undefined;
    elements.push(end === undefined ? holeFormat(part.constraint) : { type: "tag", begin: "", content: holeFormat(part.constraint), end });
  });
  return { type: "structural_tag", format: { type: "sequence", elements } };
}

/**
 * Constrained decoding for one tokenizer, on XGrammar: constraints compile to token
 * masks once (cached by constraint), and each generation gets a matcher. XGrammar's
 * adaptive mask cache keeps a mask to microseconds, and its jump-forward string is the
 * text a template or schema forces, which a decoder can append without sampling.
 */
export class ConstraintEngine {
  readonly #load: (fresh: boolean) => XGrammar | Promise<XGrammar>;
  readonly #vocabulary: Vocabulary;
  readonly #size: number;
  #xgr!: XGrammar;
  #compiler!: XGrammarModule.GrammarCompiler;
  readonly #cache = new Map<string, Promise<CompiledGrammar>>();

  private constructor(load: (fresh: boolean) => XGrammar | Promise<XGrammar>, vocabulary: Vocabulary) {
    this.#load = load;
    this.#vocabulary = vocabulary;
    this.#size = vocabulary.size ?? vocabulary.tokens.length;
  }

  /**
   * An engine for a vocabulary. `load` gives the XGrammar binding; asked for a fresh one,
   * it must load a new instance, because XGrammar aborts its WebAssembly instance on a
   * grammar it cannot parse and that instance is unusable afterwards.
   */
  static async create(load: (fresh: boolean) => XGrammar | Promise<XGrammar>, vocabulary: Vocabulary): Promise<ConstraintEngine> {
    const engine = new ConstraintEngine(load, vocabulary);
    await engine.#start(false);
    return engine;
  }

  async #start(fresh: boolean): Promise<void> {
    const v = this.#vocabulary;
    this.#xgr = await this.#load(fresh);
    const info = await this.#xgr.TokenizerInfo.createTokenizerInfo([...v.tokens], v.encoding ?? "raw", v.prependSpace ?? false, this.#size, [...v.stopTokens]);
    this.#compiler = await this.#xgr.GrammarCompiler.createGrammarCompiler(info, true);
  }

  /** How many distinct constraints have been compiled. */
  get compiled(): number {
    return this.#cache.size;
  }

  async matcher(constraint: Constraint): Promise<TokenConstraint> {
    const key = JSON.stringify(constraint);
    let compiled = this.#cache.get(key);
    if (!compiled) {
      compiled = this.#compile(constraint).catch(async (e: unknown) => {
        this.#cache.clear();
        await this.#start(true);
        throw new Error(`the constraint does not compile (XGrammar's log says why): ${e instanceof Error ? e.message : String(e)}`);
      });
      this.#cache.set(key, compiled);
    }
    const matcher = await this.#xgr.GrammarMatcher.createGrammarMatcher(await compiled, [...this.#vocabulary.stopTokens]);
    // The binding's own mask call is async only to await its first load; once a matcher
    // exists the binding is loaded, so the mask is read synchronously through its handle.
    const handle = (matcher as unknown as { handle: { GetNextTokenBitmask(size: number): { size(): number; get(i: number): number; delete(): void } } }).handle;
    const size = this.#size;
    return {
      mask(logits) {
        const words = handle.GetNextTokenBitmask(size);
        try {
          for (let i = 0; i < size; i++) if (((words.get(i >> 5) >>> (i & 31)) & 1) === 0) logits[i] = -Infinity;
        } finally {
          words.delete();
        }
      },
      accept: (token) => matcher.acceptToken(token),
      forced: () => matcher.findJumpForwardString(),
      get done() {
        return matcher.isTerminated();
      },
      dispose: () => matcher.dispose(),
    };
  }

  #compile(constraint: Constraint): Promise<CompiledGrammar> {
    switch (constraint.type) {
      case "json-schema":
        // Compact JSON (no indentation), which costs the fewest tokens.
        return this.#compiler.compileJSONSchema(JSON.stringify(constraint.schema), false, -1, [", ", ": "], true);
      case "grammar":
        return this.#compiler.compileGrammar(constraint.ebnf);
      case "regex":
        return this.#compiler.compileStructuralTag({ type: "structural_tag", format: { type: "regex", pattern: constraint.pattern } });
      case "template":
        return this.#compiler.compileStructuralTag(templateTag(constraint));
    }
  }
}
