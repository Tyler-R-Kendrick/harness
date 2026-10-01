import { describe, expect, it } from "vitest";
import { Dialogue } from "@harness/dialogue";
import type { Draft, Step } from "@harness/dialogue";
import { routerModel, settings, textModel } from "./helpers.ts";

const step = (utterance: string, sessionId = "a"): Step => ({ sessionId, utterance });

const hours: Draft = {
  intent: "Opening hours",
  exemplars: ["when do you open"],
  slots: [],
  reply: [{ text: "We're open from " }, { generate: "time" }, { text: " in the morning." }],
  followUps: [],
};

const drafter = (answer: Draft) => textModel(() => JSON.stringify(answer));

describe("a template for the session when nothing matched", () => {
  it("ST1.1 a fallback drafts a general template for that session, and a later turn there uses it", async () => {
    const model = drafter(hours);
    const router = routerModel((input, tools) => (tools.includes("s1") && input.includes("open") ? { tool: "s1", confidence: 0.95 } : undefined));
    const dialogue = new Dialogue({ settings: settings(), drafter: model, router, sessionTemplates: true });
    const first = await dialogue.respond(step("when do you open"));
    expect(first).toMatchObject({ kind: "pass", reason: "no script matches" });
    dialogue.observe(step("when do you open"), first, "We're open from nine in the morning.");
    await dialogue.idle();
    expect(dialogue.scripts).toEqual([]);
    expect(model.calls[0]!.prompt[0]).toMatchObject({ role: "system", content: expect.stringContaining("later request of the same kind") });
    const second = await dialogue.respond(step("when do you open on a holiday"));
    expect(second).toMatchObject({ kind: "generate", script: "s1", template: { parts: ["We're open from ", { hole: "time" }, " in the morning."] }, match: { by: "router" } });
    expect(await dialogue.respond(step("when do you open", "b"))).toMatchObject({ kind: "pass", reason: "no script matches" });
  });

  it("ST1.2 a draft that is only the one reply, with nothing left open, is not kept", async () => {
    const model = drafter({ ...hours, reply: [{ text: "We're open from nine in the morning." }] });
    const router = routerModel(() => ({ tool: "s1", confidence: 0.95 }));
    const dialogue = new Dialogue({ settings: settings(), drafter: model, router, sessionTemplates: true });
    const first = await dialogue.respond(step("when do you open"));
    dialogue.observe(step("when do you open"), first, "We're open from nine in the morning.");
    await dialogue.idle();
    expect(model.calls).toHaveLength(1);
    expect(await dialogue.respond(step("when do you open tomorrow"))).toMatchObject({ kind: "pass", reason: "no script matches" });
  });

  it("ST1.3 a draft that is only a hole, with no fixed text, is not kept", async () => {
    const model = drafter({ ...hours, reply: [{ generate: "time" }] });
    const router = routerModel(() => ({ tool: "s1", confidence: 0.95 }));
    const dialogue = new Dialogue({ settings: settings(), drafter: model, router, sessionTemplates: true });
    const first = await dialogue.respond(step("when do you open"));
    dialogue.observe(step("when do you open"), first, "We're open from nine in the morning.");
    await dialogue.idle();
    expect(model.calls).toHaveLength(1);
    expect(await dialogue.respond(step("when do you open tomorrow"))).toMatchObject({ kind: "pass", reason: "no script matches" });
  });
});
