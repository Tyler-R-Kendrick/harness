import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSettings, settingsJsonSchema } from "@harness/learning";

const file = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("learning settings (data/settings.json)", () => {
  it("LS1.1 the shipped settings parse, and name their JSON Schema, which is generated from the parser", async () => {
    expect(parseSettings(file).ladder.native.threshold).toBeGreaterThan(0);
    expect(file["$schema"]).toBe("./settings.schema.json");
    await expect(`${JSON.stringify(settingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/settings.schema.json");
  });

  it("LS1.2 settings that cannot be right are refused, naming where", () => {
    const edit = (path: readonly string[], value: unknown) => {
      const s = structuredClone(file);
      let o: Record<string, unknown> = s;
      for (const key of path.slice(0, -1)) o = o[key] as Record<string, unknown>;
      o[path.at(-1)!] = value;
      return () => parseSettings(s);
    };
    expect(edit(["ladder", "native", "threshold"], 1.5)).toThrow(/ladder\.native\.threshold/);
    expect(edit(["curation", "duplicate"], -0.1)).toThrow(/curation\.duplicate/);
    expect(edit(["reflection", "system"], "")).toThrow(/reflection\.system/);
    expect(edit(["recall", "extra"], 1)).toThrow(/extra/);
  });
});
