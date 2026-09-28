import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { engineSettingsJsonSchema, parseEngineSettings } from "../src/engine-settings.ts";

const file = JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("template engine settings (data/templates.json)", () => {
  it("TS1.1 the shipped settings parse, and name their JSON Schema, which is generated from the parser", async () => {
    expect(parseEngineSettings(file).decision.accept).toBeGreaterThan(0.5);
    expect(file["$schema"]).toBe("./templates.schema.json");
    await expect(`${JSON.stringify(engineSettingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/templates.schema.json");
  });

  it("TS1.2 settings out of range are refused", () => {
    expect(() => parseEngineSettings({ ...file, decision: { ...(file["decision"] as object), accept: 1 } })).toThrow();
    expect(() => parseEngineSettings({ ...file, extra: true })).toThrow();
  });
});
