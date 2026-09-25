import { describe, expect, it } from "vitest";
import { base64 } from "@scure/base";
import { Learning, Plugins } from "@harness/learning";
import { parsePluginSettings, recordingTeacher } from "@harness/learning-plugins";
import { readFileSync } from "node:fs";
import { reply, settings as learningSettings, setup } from "../../learning/test/helpers.ts";

const settings = parsePluginSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));

describe("recording teacher", () => {
  it("LP5.1 transcripts and input events translate deterministically into the steps of a demonstration", async () => {
    const teacher = recordingTeacher({ vision: setup().ensemble.languageModel("vision-qa"), settings });
    expect(teacher.modalities).toEqual(["transcript", "events", "screen"]);
    const demo = await teacher.demonstrate({
      task: "Export the monthly report",
      note: "watch me do it once",
      parts: [
        { modality: "transcript", mediaType: "text/plain", data: "Ada: open the reports page\nassistant: opening it\n\nthen export as CSV" },
        { modality: "events", mediaType: "application/x-ndjson", data: '{"action":"click","target":"Reports"}\n{"action":"type","target":"search","value":"monthly"}\n{"action":"call","tool":"export_report","args":{"format":"csv"},"output":"report.csv"}' },
        { modality: "events", mediaType: "application/json", data: '[{"action":"run","target":"ls","output":"report.csv"}]' },
      ],
    });
    expect(demo).toEqual({
      id: "demonstration-export-the-monthly-report-3",
      task: "Export the monthly report",
      steps: [
        { role: "user", content: "watch me do it once" },
        { role: "user", content: "open the reports page" },
        { role: "assistant", content: "opening it" },
        { role: "user", content: "then export as CSV" },
        { role: "observation", content: "click Reports" },
        { role: "observation", content: 'type search "monthly"' },
        { role: "assistant", content: "call: export_report", call: { name: "export_report", arguments: { format: "csv" } } },
        { role: "tool", content: "report.csv" },
        { role: "observation", content: "run ls → report.csv" },
      ],
      outcome: { status: "success", feedback: "demonstrated by a person" },
    });
  });

  it("LP5.2 screen frames are described by a vision model, in order", async () => {
    let n = 0;
    const s = setup({ reflect: (r) => (r.prompt.some((m) => m.role === "user" && m.content.some((p) => p.type === "file")) ? `clicks button ${++n}` : "?") });
    const png = base64.encode(new Uint8Array([137, 80, 78, 71]));
    const demo = await recordingTeacher({ vision: s.ensemble.languageModel("vision-qa"), settings }).demonstrate({ task: "t", parts: [{ modality: "screen", mediaType: "image/png", data: png }, { modality: "screen", mediaType: "image/png", data: png }] });
    expect(demo.steps).toEqual([
      { role: "observation", content: "screen 1: clicks button 1" },
      { role: "observation", content: "screen 2: clicks button 2" },
    ]);
    expect(s.generator.doGenerateCalls[0]!.prompt[0]!.content).toEqual([{ type: "file", data: { type: "data", data: new Uint8Array([137, 80, 78, 71]) }, mediaType: "image/png" }, { type: "text", text: settings.teacher.screen }]);
    expect(s.generator.doGenerateCalls[0]!.maxOutputTokens).toBe(settings.teacher.maxTokens);
  });

  it("LP5.3 taught through learning, the demonstration is learned from; malformed events are refused", async () => {
    const s = setup({ reflect: (r) => (r.prompt[0]!.role === "system" && r.prompt[0]!.content === learningSettings.reflection.system ? reply([{ op: "add", kind: "procedure", title: "monthly export", text: "export the report as CSV", steps: ["open Reports", "export as CSV"] }]) : "") });
    const learning = new Learning({ reasoner: s.reasoner, memory: s.memory, settings: learningSettings });
    const plugins = new Plugins();
    plugins.use(recordingTeacher({ vision: s.ensemble.languageModel("vision-qa"), settings }));
    const taught = await plugins.teach(learning, { task: "export the monthly report", parts: [{ modality: "transcript", mediaType: "text/plain", data: "Ada: open Reports, export as CSV" }] });
    expect(taught.changes).toEqual([{ op: "added", id: "l1" }]);
    expect(learning.lesson("l1").sources).toEqual(["demonstration-export-the-monthly-report-1"]);
    await expect(plugins.teach(learning, { task: "x", parts: [{ modality: "events", mediaType: "application/json", data: '[{"target":"no action"}]' }] })).rejects.toThrow(/action/);
  });

  it("LP5.4 lines without a speaker are the person's; the agent speaks as assistant; events may be a padded JSON array; frames are trimmed", async () => {
    const s = setup({ reflect: () => "  presses Save  \n" });
    const demo = await recordingTeacher({ vision: s.ensemble.languageModel("vision-qa"), settings }).demonstrate({
      task: "t",
      parts: [
        { modality: "transcript", mediaType: "text/plain", data: "  just do it  \nagent: done" },
        { modality: "events", mediaType: "application/json", data: '  [{"action":"open"},{"action":"call","tool":"save"}]  ' },
        { modality: "screen", mediaType: "image/png", data: base64.encode(new Uint8Array([1])) },
      ],
    });
    expect(demo.steps).toEqual([
      { role: "user", content: "just do it" },
      { role: "assistant", content: "done" },
      { role: "observation", content: "open" },
      { role: "assistant", content: "call: save", call: { name: "save", arguments: {} } },
      { role: "observation", content: "screen 1: presses Save" },
    ]);
  });
});

