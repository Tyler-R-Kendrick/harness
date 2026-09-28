import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evolutionConfigJsonSchema, parseEvolutionConfig } from "../src/evolution-config.ts";

const file = JSON.parse(readFileSync(new URL("../data/evolution.example.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("evolution config (data/evolution.example.json)", () => {
  it("EH1.1 the example config parses, and names its JSON Schema, which is generated from the parser", async () => {
    const c = parseEvolutionConfig(file);
    expect(Object.keys(c.documents)).toEqual(["dialogue"]);
    expect(c.evaluator.concurrency).toBe(2);
    expect(file["$schema"]).toBe("./evolution.schema.json");
    await expect(`${JSON.stringify(evolutionConfigJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/evolution.schema.json");
  });

  it("EH1.2 a minimal config takes the defaults: no structural components, no rules, a ten-minute evaluator with two at once", () => {
    const c = parseEvolutionConfig({ documents: { a: { path: "a.json" } }, components: ["prompt", "config"], tasks: { evolve: [{ id: "t1", text: "x" }] }, evaluator: { command: ["node"] } });
    expect(c.structural).toEqual([]);
    expect(c.classify).toEqual({ rules: [] });
    expect(c.evaluator).toEqual({ command: ["node"], timeoutMs: 600_000, concurrency: 2 });
  });

  it("EH1.3 configs that cannot be right are refused, naming where", () => {
    const edit = (path: readonly (string | number)[], value: unknown) => {
      const s = structuredClone(file);
      let o: Record<string | number, unknown> = s;
      for (const key of path.slice(0, -1)) o = o[key] as Record<string | number, unknown>;
      o[path.at(-1)!] = value;
      return () => parseEvolutionConfig(s);
    };
    expect(edit(["documents"], {})).toThrow(/at least one document/);
    expect(edit(["structural"], ["skill"])).toThrow(/structural components must be components: skill/);
    expect(edit(["classify", "rules", 0, "component"], "nope")).toThrow(/classify\.rules\[0\]\.component/);
    expect(edit(["classify", "rules", 0, "document"], "absent")).toThrow(/not a document: absent/);
    expect(edit(["classify", "fallback"], "nope")).toThrow(/classify\.fallback/);
    expect(edit(["classify", "rules", 0, "prefix"], "draft")).toThrow(/JSON Pointer/);
    expect(edit(["tasks", "holdout"], [{ id: "booking-1", text: "again" }])).toThrow(/unique across the evolve set and the holdout: booking-1/);
    expect(edit(["tasks", "evolve"], [])).toThrow(/tasks\.evolve/);
    expect(edit(["evaluator", "command"], [])).toThrow(/evaluator\.command/);
    expect(edit(["evaluator", "concurrency"], 0)).toThrow(/evaluator\.concurrency/);
    expect(edit(["extra"], 1)).toThrow(/extra/);
  });
});
