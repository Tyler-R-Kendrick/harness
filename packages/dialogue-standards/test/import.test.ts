import { describe, expect, it } from "vitest";
import { importDialogue, isDialogueFile, standardOf } from "@harness/dialogue-standards";

const vxml = `<vxml version="2.1"><form><block>Hi.</block></form></vxml>`;
const aiml = `<aiml><category><pattern>HI</pattern><template>Hello <b>you</b>.</template></category></aiml>`;

describe("importing a dialogue", () => {
  it("IM1.1 a VoiceXML application or an AIML bot becomes a book document and the flow that runs it", () => {
    const imported = importDialogue({ name: "front-desk", files: { "main.vxml": vxml }, options: { nomatch: "reprompt" } });
    expect(imported.document).toEqual({ name: "front-desk", type: "voicexml", files: { "main.vxml": vxml }, options: { nomatch: "reprompt" } });
    expect(imported.flow).toMatchObject({ name: "front-desk", kind: "flow", description: "Runs the imported VoiceXML application front-desk a turn at a time." });
    expect(imported.flow.code).toContain('const document = "front-desk";');
    expect(imported.warnings).toEqual([]);
    const bot = importDialogue({ name: "alice", files: { "bot.aiml": aiml } });
    expect(bot.document).toMatchObject({ type: "aiml", options: {} });
    expect(bot.flow.description).toBe("Runs the imported AIML bot alice a turn at a time.");
    expect(bot.warnings).toEqual(["bot.aiml: <b> is not AIML; its text is said"]);
  });

  it("IM1.2 the standard is told by the files; mixed or unknown files, a bad name or a bad document are refused", () => {
    expect(standardOf({ "a.VXML": "" })).toBe("voicexml");
    expect(standardOf({ "a.aiml": "", "a.set": "" })).toBe("aiml");
    expect(() => standardOf({ "a.vxml": "", "b.aiml": "" })).toThrow("mix VoiceXML and AIML");
    expect(() => standardOf({ "a.txt": "" })).toThrow("no VoiceXML (.vxml) or AIML (.aiml) file");
    expect(() => importDialogue({ name: "Front Desk", files: { "a.vxml": vxml } })).toThrow("kebab-case");
    expect(() => importDialogue({ name: "bad", files: { "a.vxml": "<vxml><form><block><script/></block></form></vxml>" } })).toThrow("<script> is not supported");
  });

  it("IM1.3 the files a standard reads are its documents, grammars and bot files, wherever they are; nothing else", () => {
    const read = ["app.vxml", "g/sizes.grxml", "a.gram", "a.abnf", "a.srgs", "bot.AIML", "x.set", "x.map", "bot.properties", "x.substitution", "sets/colors.txt", "bot/maps/ages.txt", "properties.txt", "normal.txt", "config/person2.txt"];
    const not = ["README.md", "hello.wav", "notes.txt", "sets/deep/x.txt", "vxml", "app.vxml.bak"];
    expect(read.filter((f) => !isDialogueFile(f))).toEqual([]);
    expect(not.filter((f) => isDialogueFile(f))).toEqual([]);
  });

  it("IM2.1 the standard is told by the extension at the end of a file's name, not one inside it", () => {
    expect(standardOf({ "a.vxml.bak": "", "b.aiml": "" })).toBe("aiml");
    expect(standardOf({ "a.aiml.txt": "", "b.vxml": "" })).toBe("voicexml");
  });

  it("IM2.2 the flow takes an object as its input", () => {
    expect(importDialogue({ name: "front-desk", files: { "main.vxml": vxml } }).flow.inputs).toEqual({ type: "object" });
  });
});
