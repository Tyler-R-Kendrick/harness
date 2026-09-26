import { describe, expect, it } from "vitest";
import { ConstraintEngine, templateTag } from "@harness/constrained";
import type { Constraint, TemplateConstraint } from "@harness/cognitive";
import { loadXGrammar } from "./xgrammar.ts";

// A character-level vocabulary with a few multi-character tokens, and an end token.
const VOCAB = [..."abcdefghijklmnopqrstuvwxyz0123456789{}[]():;,.\"' \n=+-*/<>_", "<eos>", "async function workflow(input, ctx) {", "return ", "Name: "];
const EOS = VOCAB.indexOf("<eos>");
const id = (token: string) => {
  const i = VOCAB.indexOf(token);
  if (i < 0) throw new Error(`no token ${JSON.stringify(token)}`);
  return i;
};
const engine = () => ConstraintEngine.create(() => loadXGrammar(), { tokens: VOCAB, stopTokens: [EOS] });

/** Which tokens the constraint allows next. */
function allowed(matcher: { mask(logits: Float32Array): void }): string[] {
  const logits = new Float32Array(VOCAB.length);
  matcher.mask(logits);
  return VOCAB.filter((_, i) => logits[i] !== -Infinity);
}

/** Feed text one character token at a time (or a whole token when it is one). */
function feed(matcher: { accept(token: number): boolean }, ...tokens: string[]): boolean[] {
  return tokens.map((t) => matcher.accept(id(t)));
}

describe("constrained decoding (XGrammar)", () => {
  it("CD1.1 a JSON Schema allows only tokens that keep the output valid, then only the end", async () => {
    const m = await (await engine()).matcher({ type: "json-schema", schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } });
    expect(allowed(m)).toEqual(["{"]);
    expect(m.forced()).toBe('{"n": ');
    expect(feed(m, "{", '"', "n", '"', ":", " ", "4", "2")).toEqual([true, true, true, true, true, true, true, true]);
    expect(allowed(m)).toEqual(expect.arrayContaining(["0", "}"]));
    expect(allowed(m)).not.toContain("a");
    expect(feed(m, "}")).toEqual([true]);
    expect(allowed(m)).toEqual(["<eos>"]);
    expect(m.done).toBe(false);
    expect(feed(m, "<eos>")).toEqual([true]);
    expect(m.done).toBe(true);
  });

  it("CD1.2 a token the constraint does not allow is refused and changes nothing", async () => {
    const m = await (await engine()).matcher({ type: "regex", pattern: "[0-9]+" });
    expect(feed(m, "a")).toEqual([false]);
    expect(feed(m, "7", "<eos>")).toEqual([true, true]);
    const logits = new Float32Array(VOCAB.length).fill(1);
    const g = await (await engine()).matcher({ type: "grammar", ebnf: 'root ::= "yes" | "no"' });
    g.mask(logits);
    expect(VOCAB.filter((_, i) => logits[i] === 1)).toEqual(["n", "y"]);
  });

  it("CD1.3 a template forces its fixed text (jump-forward) and leaves the model only the holes", async () => {
    const template: TemplateConstraint = {
      type: "template",
      parts: ["async function workflow(input, ctx) {\n", { hole: "body" }, "\n}\n"],
    };
    const m = await (await engine()).matcher(template);
    expect(m.forced()).toBe("async function workflow(input, ctx) {\n");
    expect(feed(m, "async function workflow(input, ctx) {", "\n", "return ", "1", ";")).toEqual([true, true, true, true, true]);
    expect(feed(m, "\n", "}", "\n", "<eos>")).toEqual([true, true, true, true]);
    expect(m.done).toBe(true);
  });

  it("CD1.4 template holes can be constrained themselves", async () => {
    const card: Constraint = { type: "template", parts: ["Name: ", { hole: "name" }, "\nage=", { hole: "age", constraint: { type: "regex", pattern: "[0-9]+" } }, ";"] };
    const m = await (await engine()).matcher(card);
    // "\n" could still be part of the name, so nothing is forced until the fixed text is complete
    expect(feed(m, "Name: ", "a", "d", "a", "\n")).toEqual([true, true, true, true, true]);
    expect(m.forced()).toBe("");
    expect(feed(m, "a", "g", "e", "=")).toEqual([true, true, true, true]);
    expect(feed(m, "x")).toEqual([false]);
    expect(feed(m, "3", "6", ";", "<eos>")).toEqual([true, true, true, true]);
  });

  it("CD1.5 templates map to XGrammar-2 structural tags: fixed text, then each hole up to the text after it", () => {
    expect(templateTag({ type: "template", parts: ["A", { hole: "x" }, "B", { hole: "y", constraint: { type: "json-schema", schema: { type: "integer" } } }, "C", { hole: "z" }] })).toEqual({
      type: "structural_tag",
      format: {
        type: "sequence",
        elements: [
          { type: "const_string", value: "A" },
          { type: "tag", begin: "", content: { type: "any_text" }, end: "B" },
          { type: "tag", begin: "", content: { type: "json_schema", json_schema: { type: "integer" } }, end: "C" },
          { type: "any_text" },
        ],
      },
    });
    expect(templateTag({ type: "template", parts: [{ hole: "g", constraint: { type: "grammar", ebnf: 'root ::= "a"' } }, "!"] }).format.elements).toEqual([
      { type: "tag", begin: "", content: { type: "grammar", grammar: 'root ::= "a"' }, end: "!" },
    ]);
  });

  it("CD1.6 a constraint is compiled once per engine, however many matchers use it", async () => {
    const e = await engine();
    const c: Constraint = { type: "regex", pattern: "[a-z]+" };
    await e.matcher(c);
    await e.matcher({ ...c });
    expect(e.compiled).toBe(1);
    await e.matcher({ type: "regex", pattern: "[0-9]+" });
    expect(e.compiled).toBe(2);
  });

  it("CD1.7 a constraint XGrammar cannot compile is an error, and the engine recovers on a fresh instance", async () => {
    const loads: boolean[] = [];
    const e = await ConstraintEngine.create((fresh) => (loads.push(fresh), loadXGrammar()), { tokens: VOCAB, stopTokens: [EOS] });
    await expect(e.matcher({ type: "grammar", ebnf: "root ::= [\n" })).rejects.toThrow(/the constraint does not compile/);
    expect(loads).toEqual([false, true]);
    const m = await e.matcher({ type: "regex", pattern: "[0-9]" });
    expect(feed(m, "7", "<eos>")).toEqual([true, true]);
  });
});

