import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSettings, settingsJsonSchema } from "@harness/evolution";

const file = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("evolution settings (data/settings.json)", () => {
  it("RS11.1 the shipped settings parse, use the calibrated rule, and name their JSON Schema, which is generated from the parser", async () => {
    const s = parseSettings(file);
    expect(s.select.rule).toBe("calibrated");
    expect(s.budget.min).toBeLessThanOrEqual(s.budget.max);
    expect(file["$schema"]).toBe("./settings.schema.json");
    await expect(`${JSON.stringify(settingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/settings.schema.json");
  });

  it("RS11.2 settings that cannot be right are refused, naming where", () => {
    const edit = (path: readonly string[], value: unknown) => {
      const s = structuredClone(file);
      let o: Record<string, unknown> = s;
      for (const key of path.slice(0, -1)) o = o[key] as Record<string, unknown>;
      o[path.at(-1)!] = value;
      return () => parseSettings(s);
    };
    expect(edit(["budget", "min"], 5)).toThrow(/budget\.min must not exceed budget\.max/);
    expect(edit(["explore", "reserved"], 3)).toThrow(/explore\.reserved must not exceed candidates/);
    expect(edit(["select", "alpha"], 1.5)).toThrow(/select\.alpha/);
    expect(edit(["select", "rule"], "greedy")).toThrow(/select\.rule/);
    expect(edit(["candidates"], 26)).toThrow(/candidates/);
    expect(edit(["proposer", "system"], "")).toThrow(/proposer\.system/);
  });
});
