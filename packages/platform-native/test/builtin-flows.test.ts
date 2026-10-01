import { describe, expect, it } from "vitest";
import { Ensemble } from "@harness/cognitive";
import { parseBook } from "@harness/dialogue";
import { MemoryStorage } from "@harness/testkit";
import { MemoryLibrary, WorkflowHost } from "@harness/workflows";
import { aiCodeMode } from "@harness/workflows/node";
import { builtinDialogue, installDocumentFlows, loadBuiltinBook, withBuiltinBook } from "@harness/platform-native";

const book = () => loadBuiltinBook();

function hostFor() {
  const journals = new Map<string, MemoryStorage>();
  const library = new MemoryLibrary();
  const host = new WorkflowHost({
    codeMode: aiCodeMode,
    library,
    journal: (run) => journals.get(run) ?? (journals.set(run, new MemoryStorage()), journals.get(run)!),
    ask: async () => "",
    forget: async () => undefined,
  });
  return { host, library };
}

async function dialogue() {
  const loaded = book();
  const { host, library } = hostFor();
  await installDocumentFlows(library, loaded);
  return builtinDialogue({ ensemble: new Ensemble({ platform: "native" }), flows: host });
}

describe("builtin harness chat and menu", () => {
  it("BF1.1 the AIML chat answers a meta conversation and leaves other turns to the scripts and the model", async () => {
    const loaded = parseBook(book());
    expect(loaded.entry).toBe("harness-chat");
    expect(loaded.documents.map((document) => document.type)).toEqual(["aiml", "voicexml"]);
    const capabilities = loaded.scripts.find((script) => script.id === "capabilities")!.reply[0];
    const session = await dialogue();
    expect(await session.respond({ sessionId: "s", utterance: "hello" })).toMatchObject({ kind: "flow", flow: "harness-chat", text: expect.stringContaining("What should I explain?") });
    expect(await session.respond({ sessionId: "s", utterance: "sessions" })).toMatchObject({ kind: "flow", flow: "harness-chat", text: expect.stringContaining("/sessions new") });
    expect(String(capabilities)).toContain("/sessions new");
    expect(String(capabilities)).not.toContain("/new ");
    expect(await session.respond({ sessionId: "s", utterance: "what can you do?" })).toMatchObject({ kind: "reply", script: "capabilities", text: capabilities });
    expect(await session.respond({ sessionId: "s", utterance: "what is the capital of France?" })).toMatchObject({ kind: "pass", reason: "no script matches" });
  });

  it("BF1.2 the VoiceXML menu walks through the same topics and then lets the chat hear again", async () => {
    const session = await dialogue();
    expect(await session.respond({ sessionId: "m", utterance: "harness menu" })).toMatchObject({ kind: "flow", flow: "harness-menu", script: "harness-menu", text: expect.stringContaining("Say sessions") });
    const choice = await session.respond({ sessionId: "m", utterance: "sessions" });
    expect(choice).toMatchObject({ kind: "flow", flow: "harness-menu", text: expect.stringContaining("/sessions new") });
    expect(await session.respond({ sessionId: "m", utterance: "done" })).toMatchObject({ kind: "flow", flow: "harness-menu", text: expect.stringContaining("Back to the session.") });
    expect(await session.respond({ sessionId: "m", utterance: "hello" })).toMatchObject({ kind: "flow", flow: "harness-chat" });
  });

  it("BF1.3 a user book keeps the builtin documents unless it replaces one, and its own entry wins", () => {
    const added = parseBook(withBuiltinBook({ scripts: [{ id: "hours", intent: "Opening hours", reply: ["We open at 9."] }] }));
    expect(added.entry).toBe("harness-chat");
    expect(added.documents.map((document) => document.name)).toEqual(["harness-chat", "harness-menu"]);
    const replaced = parseBook(withBuiltinBook({ entry: "mine", documents: [{ name: "harness-chat", type: "aiml", files: { "x.aiml": "<aiml/>" } }] }));
    expect(replaced.entry).toBe("mine");
    expect(replaced.documents.map((document) => document.name)).toEqual(["harness-menu", "harness-chat"]);
    expect(replaced.documents.find((document) => document.name === "harness-chat")?.files["x.aiml"]).toBe("<aiml/>");
  });
});
