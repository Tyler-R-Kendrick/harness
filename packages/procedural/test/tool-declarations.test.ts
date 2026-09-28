import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseToolDeclarations, ToolDeclarationsSchema, toolDeclarationsJsonSchema } from "@harness/procedural";

const file = JSON.parse(readFileSync(new URL("../data/tools.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("tool declarations (data: data/tools.json)", () => {
  it("PGR1.58 the declarations file parses, names its schema, declares no tool free of side effects by default, and the schema matches the zod schema (drift)", async () => {
    expect(parseToolDeclarations(file)).toEqual({ $schema: "./tools.schema.json", sideEffectFree: [] });
    await expect(`${JSON.stringify(toolDeclarationsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/tools.schema.json");
  });

  it("PGR1.59 a deployment declares the tools free of side effects by name; an empty name, a name twice, another field or a missing list throws, naming where", () => {
    expect(parseToolDeclarations({ sideEffectFree: ["search", "Read"] }).sideEffectFree).toEqual(["search", "Read"]);
    expect(() => parseToolDeclarations({ sideEffectFree: [""] })).toThrow(/invalid tool declarations[\s\S]*sideEffectFree/);
    expect(() => parseToolDeclarations({ sideEffectFree: ["search", "search"] })).toThrow(/declared twice: search/);
    expect(() => parseToolDeclarations({ sideEffectFree: [], other: 1 })).toThrow(/other/);
    expect(() => parseToolDeclarations({})).toThrow(/sideEffectFree/);
    expect(ToolDeclarationsSchema.safeParse({ sideEffectFree: [] }).success).toBe(true);
  });
});
