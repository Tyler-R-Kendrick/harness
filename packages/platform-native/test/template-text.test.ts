import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ensemble, invokeCognitive } from "@harness/cognitive";
import { Dialogue, dialogueExtension, parseSettings } from "@harness/dialogue";
import { directoryTemplates } from "../src/template-text.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../../dialogue/data/settings.json", import.meta.url), "utf8")));

describe("answer templates on the native host", () => {
  it("DT1.1 dialogue.feedback replacement rewrites the template the host keeps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-templates-"));
    try {
      const templates = directoryTemplates(dir);
      await templates.write("greet", "Hello");
      const dialogue = new Dialogue({ settings, book: { scripts: [] } });
      const ensemble = new Ensemble({ platform: "native" });
      ensemble.install(dialogueExtension({ dialogue, artifacts: { template: templates } }));
      await invokeCognitive(ensemble, "dialogue.feedback", {
        id: "greet",
        kind: "harmful",
        artifact: "template",
        utterance: "hi",
        answer: "Hello",
        text: "Goodbye",
        action: "replacement",
      });
      expect(await templates.read("greet")).toBe("Goodbye");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("DT1.2 a template id that is not one filename segment is refused and leaves the file outside the directory unchanged", async () => {
    const parent = await mkdtemp(join(tmpdir(), "harness-templates-"));
    const dir = join(parent, "templates");
    await mkdir(dir);
    const outside = join(parent, "outside.txt");
    await writeFile(outside, "SAFE");
    try {
      const templates = directoryTemplates(dir);
      const dialogue = new Dialogue({ settings, book: { scripts: [] } });
      const ensemble = new Ensemble({ platform: "native" });
      ensemble.install(dialogueExtension({ dialogue, artifacts: { template: templates } }));
      await expect(
        invokeCognitive(ensemble, "dialogue.feedback", {
          id: "../outside",
          kind: "harmful",
          artifact: "template",
          utterance: "hi",
          answer: "Hello",
          text: "OVERWRITTEN",
          action: "replacement",
        }),
      ).rejects.toThrow(/filename segment/);
      expect(readFileSync(outside, "utf8")).toBe("SAFE");
      expect(dialogue.preferences()).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
