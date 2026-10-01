import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ensemble, invokeCognitive } from "@harness/cognitive";
import { parseSettings } from "@harness/dialogue";
import { browserDialogue, browserWorkflows, IndexedDbStorage, IndexedDbWorkflows } from "@harness/platform-browser";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../../dialogue/data/settings.json", import.meta.url), "utf8")));
const bot = `<aiml><category><pattern>HELLO</pattern><template>Hi from the page.</template></category><category><pattern>CALL ME *</pattern><template><think><set name="n"><star/></set></think>OK <get name="n"/>.</template></category></aiml>`;

describe("the dialogue in the browser host", () => {
  it("BD1.1 a dialogue kept in IndexedDB, managed over ACP as the dialogue extension: an imported bot runs on QuickJS flows, and a reloaded page goes on", async () => {
    const factory = new IDBFactory();
    const open = async () => {
      const ensemble = new Ensemble({ platform: "browser" });
      const flows = browserWorkflows(ensemble, { library: new IndexedDbWorkflows({ factory }) });
      const storage = new IndexedDbStorage({ factory, key: "dialogue" });
      return { ensemble, ...(await browserDialogue(ensemble, { settings, storage, flows })) };
    };
    const first = await open();
    expect(await invokeCognitive(first.ensemble, "dialogue.import", { name: "page-bot", files: { "bot.aiml": bot }, entry: true })).toEqual({ name: "page-bot", type: "aiml", warnings: [] });
    expect(await first.dialogue.respond({ sessionId: "s", utterance: "hello" })).toMatchObject({ kind: "flow", text: "Hi from the page." });
    expect(await first.dialogue.respond({ sessionId: "s", utterance: "call me Ada" })).toMatchObject({ text: "OK ADA." });
    await first.saved();
    const second = await open();
    expect(await invokeCognitive(second.ensemble, "dialogue.status", {})).toMatchObject({ documents: ["page-bot"], entry: "page-bot", sessions: 1 });
    expect(await second.dialogue.respond({ sessionId: "s", utterance: "hello" })).toMatchObject({ text: "Hi from the page." });
  });

  it("BD1.2 without flows, a dialogue still answers scripts; failed saves are reported", async () => {
    const errors: unknown[] = [];
    const storage = { load: async () => ({ scripts: [{ id: "hi", intent: "h", patterns: ["hi"], reply: ["Hi."] }] }), save: async () => Promise.reject(new Error("quota")) };
    const { dialogue, saved } = await browserDialogue(new Ensemble({ platform: "browser" }), { settings, storage, onError: (e) => void errors.push(e) });
    expect(await dialogue.respond({ sessionId: "s", utterance: "hi" })).toMatchObject({ kind: "reply", text: "Hi." });
    await saved();
    expect(errors.map((e) => (e as Error).message)).toEqual(["quota"]);
  });

  it("BD1.3 a correction can replace an answer template the host keeps", async () => {
    const ensemble = new Ensemble({ platform: "browser" });
    const storage = { load: async () => undefined, save: async () => {} };
    const { templates } = await browserDialogue(ensemble, { settings, storage });
    await templates.write("greet", "Hello");
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
  });
});
