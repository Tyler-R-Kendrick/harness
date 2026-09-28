import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ESLint } from "eslint";
import { BookSchema, bookJsonSchema, parseBook, parseScript, parseSettings, scriptId, ScriptSchema, settingsJsonSchema } from "@harness/dialogue";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<string, unknown>;
const script = (fields: Record<string, unknown>) => ({ id: "s1", intent: "greet", reply: ["Hi."], ...fields });
/** The custom issues a schema finds in an input: each message at its path. */
const issues = (schema: typeof ScriptSchema | typeof BookSchema, input: unknown) =>
  (schema.safeParse(input).error?.issues ?? []).filter((i) => i.code === "custom").map((i) => ({ message: i.message, path: i.path }));

describe("settings and books are data", () => {
  it("SB1.1 the settings file parses, and its JSON Schema is generated from the parser", async () => {
    const file = read("../data/settings.json");
    expect(file["$schema"]).toBe("./settings.schema.json");
    expect(() => parseSettings(file)).not.toThrow();
    await expect(`${JSON.stringify(settingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/settings.schema.json");
  });

  it("SB1.2 a script book names its JSON Schema, generated from the parser, and parses", async () => {
    const file = read("./fixtures/support.book.json");
    expect(file["$schema"]).toBe("../../data/book.schema.json");
    expect(parseBook(file).scripts.map((s) => s.id)).toEqual(["order-status", "tracking", "confirm-cancel"]);
    await expect(`${JSON.stringify(bookJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/book.schema.json");
  });

  it("SB1.3 an authored script is active, with no evidence, and a book starts numbering at 1", () => {
    const parsed = parseScript(script({}));
    expect(parsed).toMatchObject({ status: "active", origin: "authored", patterns: [], exemplars: [], slots: {}, evidence: { fits: 0, misses: 0, served: 0 } });
    expect(parseBook({})).toEqual({ next: 1, scripts: [], clusters: [], sessions: [], runs: 0, documents: [] });
  });

  it("SB1.4 a pattern's named groups must be declared slots", () => {
    expect(() => parseScript(script({ patterns: ["order (?<id>\\d+)"] }))).toThrow(/pattern names slot id, which is not declared/);
    expect(() => parseScript(script({ patterns: ["order (?<id>\\d+)"], slots: { id: {} } }))).not.toThrow();
  });

  it("SB1.5 patterns must be regular expressions", () => {
    expect(() => parseScript(script({ patterns: ["order (\\d+"] }))).toThrow(/not a regular expression/);
    expect(() => parseScript(script({ slots: { id: { pattern: "[" } } }))).toThrow(/not a regular expression/);
  });

  it("SB1.6 a reply's slots must be declared", () => {
    expect(() => parseScript(script({ reply: ["Order ", { slot: "id" }, "."] }))).toThrow(/reply names slot id, which is not declared/);
  });

  it("SB1.7 holes next to each other are refused: no text tells where one ends", () => {
    expect(() => parseScript(script({ slots: { a: {} }, reply: [{ slot: "a" }, { generate: "b" }] }))).toThrow(/holes next to each other/);
  });

  it("SB1.8 only a result script reads the tool's input and output, and it has no utterance triggers or slots", () => {
    expect(() => parseScript(script({ reply: ["Order ", { input: ["id"] }] }))).toThrow(/only a result script/);
    expect(() => parseScript(script({ result: { tool: "t" }, patterns: ["x"] }))).toThrow(/a result script is not matched by patterns, exemplars or slots/);
    expect(() => parseScript(script({ result: { tool: "t" }, slots: { a: {} } }))).toThrow(/a result script is not matched by patterns, exemplars or slots/);
    expect(() => parseScript(script({ result: { tool: "t" }, reply: ["Order ", { output: ["a", 0] }] }))).not.toThrow();
  });

  it("SB1.9 a generated hole is named once, and holds no template", () => {
    expect(() => parseScript(script({ reply: [{ generate: "a" }, ", ", { generate: "a" }] }))).toThrow(/hole a is named twice/);
    expect(() => parseScript(script({ reply: [{ generate: "a", constraint: { type: "template", parts: ["x"] } }] }))).toThrow(/a template in a template/);
  });

  it("SB1.10 script ids are names, unique in a book; a context names another script in it", () => {
    expect(() => scriptId("Order Status")).toThrow(/invalid script id/);
    expect(scriptId("order-status")).toBe("order-status");
    expect(() => parseBook({ scripts: [script({}), script({})] })).toThrow(/script s1 is in the book twice/);
    expect(() => parseBook({ scripts: [script({ context: "s9" })] })).toThrow(/context s9 is not a script in the book/);
    expect(() => parseScript(script({ context: "s1" }))).toThrow(/its own context/);
    expect(() => parseBook({ scripts: [script({})], clusters: [{ script: "s2", observations: [] }] })).toThrow(/cluster's script s2 is not in the book/);
  });

  it("SB1.11 settings keep at least as many observations as induction needs", () => {
    const file = read("../data/settings.json") as { induce: Record<string, unknown> };
    expect(() => parseSettings({ ...file, induce: { ...file.induce, support: 3, keep: 2 } })).toThrow(/keep at least support/);
  });

  it("SB1.15 settings keep at least as many of a script's sessions as promotion needs", () => {
    const file = read("../data/settings.json") as { promote: Record<string, unknown> };
    expect(() => parseSettings({ ...file, promote: { ...file.promote, sessions: 3, sessionsKept: 2 } })).toThrow(/keep at least as many sessions/);
  });
});

describe("under static analysis", () => {
  const lint = async (code: string) => {
    const eslint = new ESLint({ cwd: new URL("../../..", import.meta.url).pathname });
    const [result] = await eslint.lintText(code, { filePath: "packages/dialogue/src/example.ts" });
    return result!.messages.map((m) => m.message);
  };

  it("SB1.13 each refusal names its reason and where it is", () => {
    expect(issues(ScriptSchema, script({ context: "s1" }))).toEqual([{ message: "a script cannot be its own context", path: ["context"] }]);
    expect(issues(ScriptSchema, script({ patterns: ["x", "order (?<id>\\d+)"] }))).toEqual([{ message: "pattern names slot id, which is not declared", path: ["patterns", 1] }]);
    expect(issues(ScriptSchema, script({ result: { tool: "t" }, exemplars: ["x"] }))).toEqual([{ message: "a result script is not matched by patterns, exemplars or slots", path: ["result"] }]);
    expect(issues(ScriptSchema, script({ slots: { a: {} }, reply: ["x", { slot: "a" }, { generate: "b" }] }))).toEqual([{ message: "holes next to each other have no text between them to tell where one ends", path: ["reply", 2] }]);
    expect(issues(ScriptSchema, script({ reply: ["x", { slot: "a" }] }))).toEqual([{ message: "reply names slot a, which is not declared", path: ["reply", 1] }]);
    expect(issues(ScriptSchema, script({ reply: ["x", { output: ["a"] }] }))).toEqual([{ message: "only a result script reads a tool's input or output", path: ["reply", 1] }]);
    expect(issues(ScriptSchema, script({ reply: [{ generate: "a" }, ", ", { generate: "a" }] }))).toEqual([{ message: "hole a is named twice", path: ["reply", 2] }]);
    expect(issues(ScriptSchema, script({ patterns: ["("] }))).toEqual([{ message: "not a regular expression: Invalid regular expression: /(/isu: Unterminated group", path: ["patterns", 0] }]);
    expect(issues(BookSchema, { scripts: [script({}), script({ id: "s2" }), script({})] })).toEqual([{ message: "script s1 is in the book twice", path: ["scripts", 2] }]);
    expect(issues(BookSchema, { scripts: [script({}), script({ id: "s2", context: "s9" })] })).toEqual([{ message: "context s9 is not a script in the book", path: ["scripts", 1, "context"] }]);
    expect(issues(BookSchema, { scripts: [script({})], clusters: [{ observations: [] }, { script: "s1", observations: [] }, { script: "s2", observations: [] }] })).toEqual([
      { message: "cluster's script s2 is not in the book", path: ["clusters", 2, "script"] },
    ]);
    expect(ScriptSchema.safeParse(script({ context: "s1" })).error?.issues[0]?.code).toBe("custom");
    expect(() => parseSettings({})).toThrow(/^invalid dialogue settings\n/);
    expect(() => parseScript({})).toThrow(/^invalid script\n/);
    expect(() => scriptId("Order Status")).toThrow(/a script id is a lower-case name/);
    expect(() => parseScript(script({ reply: [{ generate: "Bad" }] }))).toThrow(/a slot or hole is named in snake_case/);
  });

  it("SB1.14 a flow is a reply of its own, named in kebab-case; a book's entry is a flow; sessions keep what they have", () => {
    expect(issues(ScriptSchema, script({ reply: ["Hi ", { flow: "order-flow" }] }))).toEqual([{ message: "a flow is a reply of its own", path: ["reply", 1] }]);
    expect(() => parseScript(script({ reply: [{ flow: "Order Flow" }] }))).toThrow(/a flow is named in kebab-case/);
    expect(parseScript(script({ reply: [{ flow: "order-flow" }] })).reply).toEqual([{ flow: "order-flow" }]);
    expect(() => parseBook({ entry: "Main" })).toThrow(/a flow is named in kebab-case/);
    const sessions = [{ id: "a", last: "s1", form: { script: "s1", slots: { x: "1" }, slot: "y", tries: 1 }, flow: { name: "f", run: "dialogue/a/1", input: { utterance: "hi", slots: {} }, script: "s1" } }];
    expect(parseBook({ scripts: [script({})], sessions, runs: 1, entry: "f" })).toMatchObject({ sessions, runs: 1, entry: "f" });
    expect(() => parseBook({ sessions: [{ id: "a", form: { script: "s1", slots: {}, slot: "y", tries: -1 } }] })).toThrow(/invalid script book/);
  });

  it("SB1.12 a script id is made by parsing, never by a cast, and the dialogue is pure: no ambient time", async () => {
    expect(await lint(`import type { ScriptId } from "./schemas.ts";\nexport const id = "s1" as ScriptId;\n`)).toEqual(["Refined types are made by parsing: use the type's constructor or schema, not a cast."]);
    expect(await lint(`export const t = Date.now();\n`)).toEqual(["'Date.now' is restricted from being used. Use the Clock port."]);
  });
});
