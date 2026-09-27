import { describe, expect, it } from "vitest";
import { Dialogue } from "@harness/dialogue";
import type { ScriptInput, Step } from "@harness/dialogue";
import { settings } from "./helpers.ts";

const step = (utterance: string, sessionId = "s-1"): Step => ({ sessionId, utterance });
const table = (confirm = "So {value}, right?", prompts = ["For what time?"]): ScriptInput => ({
  id: "table",
  intent: "Book a table",
  patterns: ["book a table at (?<time>\\S+)", "book a table"],
  slots: { time: { pattern: "\\d+(?:am|pm)", prompts, confirm } },
  reply: ["Booked for ", { slot: "time" }, "."],
});
const dialogue = (script = table()) => new Dialogue({ settings: settings(), book: { scripts: [script] } });

describe("slot confirmation (IVR: \"you said 8pm, right?\")", () => {
  it("CF1.1 a slot to confirm is read back before the reply; a yes gives the reply", async () => {
    const d = dialogue();
    expect(await d.respond(step("book a table at 8pm"))).toEqual({ kind: "ask", script: "table", slot: "time", text: "So 8pm, right?", match: { by: "pattern" } });
    expect(await d.respond(step("Yes!"))).toEqual({ kind: "reply", script: "table", text: "Booked for 8pm.", match: { by: "form" } });
  });

  it("CF1.2 a no asks for the slot again, and the new value is confirmed in its turn", async () => {
    const d = dialogue();
    await d.respond(step("book a table at 8pm"));
    expect(await d.respond(step("no"))).toMatchObject({ kind: "ask", slot: "time", text: "For what time?" });
    expect(await d.respond(step("9pm"))).toMatchObject({ kind: "ask", text: "So 9pm, right?" });
    expect(await d.respond(step("yeah"))).toMatchObject({ kind: "reply", text: "Booked for 9pm." });
  });

  it("CF1.3 an answer with a new value corrects it, to be confirmed again", async () => {
    const d = dialogue();
    await d.respond(step("book a table at 8pm"));
    expect(await d.respond(step("no, make it 9pm"))).toMatchObject({ kind: "ask", text: "So 9pm, right?" });
    expect(await d.respond(step("correct"))).toMatchObject({ kind: "reply", text: "Booked for 9pm." });
  });

  it("CF1.4 an answer that is neither asks again once; then the turn is the model's", async () => {
    const d = dialogue();
    await d.respond(step("book a table at 8pm"));
    expect(await d.respond(step("hmm"))).toMatchObject({ kind: "ask", text: "So 8pm, right?" });
    expect(await d.respond(step("what?"))).toMatchObject({ kind: "pass", reason: "time not confirmed" });
  });

  it("CF1.5 without a session nothing can be confirmed, and a denied slot with no prompt is the model's", async () => {
    expect(await dialogue().respond({ utterance: "book a table at 8pm" })).toMatchObject({ kind: "pass", reason: "slot time needs confirming, in a session" });
    const d = dialogue(table("So {value}?", []));
    await d.respond(step("book a table at 8pm"));
    expect(await d.respond(step("nope"))).toMatchObject({ kind: "pass", reason: "no time after it was denied" });
  });

  it("CF1.6 a slot asked for is confirmed when it is given; a confirmation in progress survives a restart", async () => {
    const d = dialogue();
    expect(await d.respond(step("book a table"))).toMatchObject({ kind: "ask", text: "For what time?" });
    expect(await d.respond(step("7pm"))).toMatchObject({ kind: "ask", text: "So 7pm, right?" });
    const back = new Dialogue({ settings: settings(), book: JSON.parse(JSON.stringify(d.save())) });
    expect(await back.respond(step("yes please"))).toMatchObject({ kind: "reply", text: "Booked for 7pm." });
  });

  it("CF1.7 the words for yes and no are the settings'", async () => {
    const d = new Dialogue({ settings: settings({ confirm: { yes: ["oui"], no: ["non"] } }), book: { scripts: [table()] } });
    await d.respond(step("book a table at 8pm"));
    expect(await d.respond(step("yes"))).toMatchObject({ kind: "ask", text: "So 8pm, right?" });
    expect(await d.respond(step("oui"))).toMatchObject({ kind: "reply" });
  });

  it("CF1.8 a confirmed slot a later answer changes is read back again", async () => {
    const d = new Dialogue({
      settings: settings(),
      book: {
        scripts: [
          {
            id: "t",
            intent: "t",
            patterns: ["book a table for (?<people>\\d+) at (?<time>\\S+)"],
            slots: { people: { prompts: ["How many?"], confirm: "{value} people?" }, time: { prompts: ["When?"], confirm: "At {value}?" } },
            reply: ["Booked ", { slot: "people" }, " at ", { slot: "time" }, "."],
          },
        ],
      },
    });
    expect(await d.respond(step("book a table for 2 at 8pm"))).toMatchObject({ text: "2 people?" });
    expect(await d.respond(step("yes"))).toMatchObject({ text: "At 8pm?" });
    expect(await d.respond(step("no"))).toMatchObject({ text: "When?" });
    expect(await d.respond(step("book a table for 4 at 9pm"))).toMatchObject({ text: "4 people?" });
    expect(await d.respond(step("yes"))).toMatchObject({ text: "At 9pm?" });
    expect(await d.respond(step("yes"))).toMatchObject({ kind: "reply", text: "Booked 4 at 9pm." });
  });

  it("CF1.9 a yes with more words is a yes; one with a new value corrects it", async () => {
    const d = dialogue();
    await d.respond(step("book a table at 8pm"));
    expect(await d.respond(step("Yes, that's correct."))).toMatchObject({ kind: "reply", text: "Booked for 8pm." });
    await d.respond(step("book a table at 8pm", "s-2"));
    expect(await d.respond(step("yes, 9pm", "s-2"))).toMatchObject({ kind: "ask", text: "So 9pm, right?" });
  });

  it("CF1.10 a turn a read-back or a form gave up on is the model's, and teaches nothing", async () => {
    const d = dialogue();
    await d.respond(step("book a table at 8pm"));
    await d.respond(step("hmm"));
    const s = step("what?");
    const decision = await d.respond(s);
    expect(decision).toMatchObject({ kind: "pass", teaches: false });
    d.observe(s, decision, "Could you say that again?");
    await d.idle();
    expect(d.save()).toMatchObject({ clusters: [] });
  });

  it("CF1.11 a script changed meanwhile to not confirm the slot gives its reply to any answer to the read-back", async () => {
    const d = dialogue();
    await d.respond(step("book a table at 8pm"));
    d.put({ ...table(), slots: { time: { pattern: "\\d+(?:am|pm)", prompts: ["For what time?"] } } });
    expect(await d.respond(step("hmm"))).toMatchObject({ kind: "reply", text: "Booked for 8pm." });
  });
});
