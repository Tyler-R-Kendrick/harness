import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { Dialogue, parseSettings } from "@harness/dialogue";
import type { Step } from "@harness/dialogue";
import { importDialogue, STANDARD_INTERPRETERS } from "@harness/dialogue-standards";
import { MemoryLibrary, WorkflowHost } from "@harness/workflows";
import type { Workflow } from "@harness/workflows";
import { aiCodeMode } from "@harness/workflows/node";
import { MemoryStorage } from "@harness/testkit";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../../dialogue/data/settings.json", import.meta.url), "utf8")));
const step = (utterance: string, sessionId = "s-1"): Step => ({ sessionId, utterance });

const ivr = `<vxml version="2.1">
  <form id="order">
    <field name="size"><prompt>What size?</prompt><grammar root="s"><rule id="s"><one-of><item>small</item><item>large</item></one-of></rule></grammar></field>
    <field name="ok" type="boolean"><prompt>A <value expr="size"/> pizza, right?</prompt>
      <filled><if cond="ok"><data name="receipt" src="tool:place-order" namelist="size"/>Order <value expr="receipt.id"/> placed.<exit/><else/><goto next="#agent"/></if></filled>
    </field>
  </form>
  <form id="agent"><transfer name="t"><prompt>Let me get someone.</prompt></transfer></form>
</vxml>`;
const bot = `<aiml><category><pattern>HELLO</pattern><template>Hi! I am a bot.</template></category><category><pattern>CALL ME *</pattern><template><think><set name="name"><star/></set></think>Hi <get name="name"/>.</template></category><category><pattern>WHO AM I</pattern><template><get name="name"/></template></category></aiml>`;

/** A dialogue over a book of imported documents, their flows in a workflow host with a place-order tool; journals outlive the dialogue. */
function setup(book: object, flows: Workflow[], journals = new Map<string, MemoryStorage>()) {
  const placed: unknown[] = [];
  const host = new WorkflowHost({
    codeMode: aiCodeMode,
    library: new MemoryLibrary(flows),
    journal: (run) => journals.get(run) ?? (journals.set(run, new MemoryStorage()), journals.get(run)!),
    ask: async () => "",
    tools: { "place-order": tool({ inputSchema: z.object({ size: z.string() }), execute: async (input) => (placed.push(input), { id: `P${placed.length}` }) }) },
  });
  const onError = vi.fn();
  const dialogue = new Dialogue({ settings, book, flows: host, interpreters: STANDARD_INTERPRETERS, now: () => Date.UTC(2024, 0, 1), onError });
  return { dialogue, placed, onError, journals };
}

describe("imported dialogues run as durable flows", () => {
  it("SD1.1 a VoiceXML application a script starts runs a turn at a time, calls the host's tool, and ends; its slots prefill its fields", async () => {
    const { document, flow } = importDialogue({ name: "pizza", files: { "pizza.vxml": ivr } });
    const book = { documents: [document], scripts: [{ id: "order", intent: "Order a pizza", patterns: ["order a pizza", "order a (?<size>small|large) pizza"], slots: { size: {} }, reply: [{ flow: "pizza" }] }] };
    const { dialogue, placed, onError } = setup(book, [flow]);
    expect(await dialogue.respond(step("order a pizza"))).toMatchObject({ kind: "flow", flow: "pizza", script: "order", text: "What size?" });
    expect(await dialogue.respond(step("large"))).toMatchObject({ kind: "flow", text: "A large pizza, right?", match: { by: "flow" } });
    expect(await dialogue.respond(step("yes"))).toMatchObject({ kind: "flow", text: "Order P1 placed." });
    expect(placed).toEqual([{ size: "large" }]);
    expect(await dialogue.respond(step("order a small pizza", "s-2"))).toMatchObject({ text: "A small pizza, right?" });
    // A transfer hands the person over to the model, after what it says first, and the application is over.
    expect(await dialogue.respond(step("no", "s-2"))).toMatchObject({ kind: "pass", reason: "the flow handed the person to the model", said: "Let me get someone." });
    expect((dialogue.save() as { sessions: { id: string; next?: unknown }[] }).sessions.find((s) => s.id === "s-2")?.next).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it("SD1.2 between turns a document's state is the session's, saved with the book: a new dialogue from the save goes on", async () => {
    const { document, flow } = importDialogue({ name: "pizza", files: { "pizza.vxml": ivr } });
    const book = { documents: [document], scripts: [{ id: "order", intent: "o", patterns: ["order a pizza"], reply: [{ flow: "pizza" }] }] };
    const first = setup(book, [flow]);
    await first.dialogue.respond(step("order a pizza"));
    await first.dialogue.respond(step("small"));
    const saved = JSON.parse(JSON.stringify(first.dialogue.save())) as { sessions: { next?: unknown }[]; documents: unknown[] };
    expect(saved.sessions[0]!.next).toMatchObject({ name: "pizza", script: "order" });
    expect(saved.documents).toEqual([document]);
    // A fresh workflow host (no journals): each turn's run is its own, so nothing is lost.
    const second = setup(saved, [flow]);
    expect(await second.dialogue.respond(step("yes"))).toMatchObject({ text: "Order P1 placed." });
  });

  it("SD1.3 an AIML bot as the book's entry flow keeps its predicates across turns; what it cannot answer goes to the scripts, then the model", async () => {
    const { document, flow } = importDialogue({ name: "chatbot", files: { "bot.aiml": bot } });
    const book = { entry: "chatbot", documents: [document], scripts: [{ id: "hours", intent: "h", patterns: ["opening hours"], reply: ["We open at 9."] }] };
    const { dialogue, journals } = setup(book, [flow]);
    expect(await dialogue.respond(step("hello"))).toEqual({ kind: "flow", flow: "chatbot", text: "Hi! I am a bot.", match: { by: "flow" } });
    expect(await dialogue.respond(step("call me Ada"))).toMatchObject({ text: "Hi ADA." });
    expect(await dialogue.respond(step("opening hours"))).toMatchObject({ kind: "reply", script: "hours" });
    expect(await dialogue.respond(step("tell me a joke"))).toMatchObject({ kind: "pass", reason: "no script matches" });
    expect(await dialogue.respond(step("who am i"))).toMatchObject({ text: "ADA" });
    // Every turn's run is short: its journal holds that turn's steps only.
    expect([...journals.keys()]).toEqual(["dialogue/s-1/1", "dialogue/s-1/2", "dialogue/s-1/3", "dialogue/s-1/4", "dialogue/s-1/5"]);
  });

  it("SD1.4 a document with no interpreter for its type, or one its interpreter refuses, is refused with the book", () => {
    const { document } = importDialogue({ name: "chatbot", files: { "bot.aiml": bot } });
    expect(() => new Dialogue({ settings, book: { documents: [document] } })).toThrow("no interpreter for aiml documents");
    expect(() => new Dialogue({ settings, book: { documents: [{ ...document, files: { "bot.aiml": "<aiml" } }] }, interpreters: STANDARD_INTERPRETERS })).toThrow("bot.aiml");
  });

  it("SD1.5 a flow that asks for a document the book does not have fails, and is reported", async () => {
    const { flow } = importDialogue({ name: "chatbot", files: { "bot.aiml": bot } });
    const { dialogue, onError } = setup({ entry: "chatbot", scripts: [] }, [flow]);
    expect(await dialogue.respond(step("hello"))).toMatchObject({ kind: "pass" });
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual([expect.stringContaining("no document chatbot")]);
  });

  it("SD1.7 a document calling a tool the host does not have hears error.badfetch, and can go on; one that keeps doing so is reported", async () => {
    const saving = `<vxml version="2.1"><form><block>Saving.<data name="r" src="tool:save-order"/>Saved.</block><catch event="error.badfetch">Sorry, <value expr="_message"/>.<exit/></catch></form></vxml>`;
    const { document, flow } = importDialogue({ name: "saver", files: { "saver.vxml": saving } });
    const { dialogue, onError } = setup({ documents: [document], entry: "saver", scripts: [] }, [flow]);
    expect(await dialogue.respond(step("hi"))).toMatchObject({ kind: "flow", text: "Saving.\nSorry, no tool save-order." });
    expect(onError).not.toHaveBeenCalled();
    const looping = `<vxml version="2.1"><form><block><data name="r" src="tool:save-order"/></block><catch event="error.badfetch"><data name="r" src="tool:save-order"/></catch></form></vxml>`;
    const again = importDialogue({ name: "looper", files: { "looper.vxml": looping } });
    const second = setup({ documents: [again.document], entry: "looper", scripts: [] }, [again.flow]);
    expect(await second.dialogue.respond(step("hi"))).toMatchObject({ kind: "pass" });
    expect(second.onError.mock.calls.map(([e]) => (e as Error).message)).toEqual([expect.stringContaining("kept calling tools the host does not have")]);
  });

  it("SD1.6 documents are added and replaced with the book's other content, and saved", () => {
    const { document } = importDialogue({ name: "chatbot", files: { "bot.aiml": bot } });
    const d = new Dialogue({ settings, interpreters: STANDARD_INTERPRETERS });
    d.putDocument(document);
    d.putDocument({ ...document, options: { fallback: "bot" } });
    expect((d.save() as { documents: unknown[] }).documents).toEqual([{ ...document, options: { fallback: "bot" } }]);
    expect(() => d.putDocument({ ...document, files: { "bot.aiml": "<aiml" } })).toThrow("bot.aiml");
  });
});
