import { describe, expect, it } from "vitest";
import { bytes, ConstraintSchema, Ensemble, readTemplate } from "@harness/cognitive";
import type { Constraint, ConstraintType, GenerateRequest, ModelDescriptor } from "@harness/cognitive";
import { ScriptedGenerator } from "@harness/testkit";

const card: Constraint = {
  type: "template",
  parts: ["Name: ", { hole: "name" }, "\nAge: ", { hole: "age", constraint: { type: "regex", pattern: "[0-9]+" } }, "\n"],
};

describe("constraints on generation", () => {
  it("CN1.1 constraints are parsed: JSON Schema, grammar, regex, or a template of fixed text and holes", () => {
    expect(ConstraintSchema.parse({ type: "json-schema", schema: { type: "object" } })).toEqual({ type: "json-schema", schema: { type: "object" } });
    expect(ConstraintSchema.parse(card)).toEqual(card);
    expect(() => ConstraintSchema.parse({ type: "grammar", ebnf: "" })).toThrow();
    expect(() => ConstraintSchema.parse({ type: "template", parts: ["a", { hole: "Bad Name" }] })).toThrow(/hole/);
    expect(() => ConstraintSchema.parse({ type: "template", parts: [{ hole: "a" }, { hole: "b" }] })).toThrow(/next to each other/);
    expect(() => ConstraintSchema.parse({ type: "template", parts: [{ hole: "a", constraint: card }] })).toThrow(/template in a template/);
    expect(() => ConstraintSchema.parse({ type: "template", parts: ["x", { hole: "a" }, "y", { hole: "a" }] })).toThrow(/named twice/);
  });

  it("CN1.2 a template's output reads back into its holes; output that does not follow the template is refused", () => {
    expect(readTemplate(card, "Name: Ada Lovelace\nAge: 36\n")).toEqual({ name: "Ada Lovelace", age: "36" });
    expect(readTemplate({ type: "template", parts: [{ hole: "all" }] }, "anything")).toEqual({ all: "anything" });
    expect(() => readTemplate(card, "Nom: Ada\nAge: 36\n")).toThrow('the output does not start with "Name: "');
    expect(() => readTemplate(card, "Name: Ada\nAge: 36")).toThrow('the output has no "\\n" after hole age');
    expect(() => readTemplate(card, "Name: Ada\nAge: old\n")).toThrow("hole age does not match /[0-9]+/: old");
    expect(() => readTemplate(card, "Name: Ada\nAge: 36\nextra")).toThrow("the output goes on after the template");
  });

  it("CN1.3 a constrained request goes first to generators that enforce that kind of constraint, then to the rest", async () => {
    const e = new Ensemble({ platform: "native" });
    const served: string[] = [];
    const generator = (id: string) => new ScriptedGenerator(() => (served.push(id), "{}"));
    const d = (id: string, constraints?: ConstraintType[]) => ({ id, name: id, publisher: "t", tasks: ["chat"], ports: ["generator"], locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["native"], license: "MIT", downloadBytes: bytes(1), benchmarks: [], ...(constraints ? { constraints } : {}) }) as ModelDescriptor;
    e.register(d("free"), async () => ({ generator: generator("free") }));
    e.register(d("json", ["json-schema"]), async () => ({ generator: generator("json") }));
    const run = async (request: GenerateRequest) => {
      for await (const _ of e.generate(request));
    };
    await run({ messages: [{ role: "user", content: "hi" }] });
    await run({ messages: [{ role: "user", content: "hi" }], constraint: { type: "json-schema", schema: {} } });
    await run({ messages: [{ role: "user", content: "hi" }], constraint: card });
    expect(served).toEqual(["free", "json", "free"]);
  });
});
