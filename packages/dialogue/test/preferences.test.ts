import { describe, expect, it } from "vitest";
import { Ensemble, invokeCognitive } from "@harness/cognitive";
import { Dialogue, dialogueExtension } from "@harness/dialogue";
import { settings } from "./helpers.ts";

const greet = { id: "greet", intent: "Greet", patterns: ["hi"], reply: ["Hello"] };

/** The feedback operation a person already invokes (`dialogue.feedback` over ACP). */
function feedbackFor(dialogue: Dialogue) {
  const ensemble = new Ensemble({ platform: "native" });
  ensemble.install(dialogueExtension({ dialogue }));
  return (input: Record<string, unknown>) => invokeCognitive(ensemble, "dialogue.feedback", input);
}

function session(book?: unknown) {
  const dialogue = new Dialogue({ settings: settings(), book: book ?? { scripts: [greet] } });
  return { dialogue, feedback: feedbackFor(dialogue) };
}

const rating = { id: "greet", kind: "harmful", artifact: "script", utterance: "hi", answer: "Hello", text: "", action: "rating" };
const replacement = { id: "greet", kind: "harmful", artifact: "script", utterance: "hi", answer: "Hello", text: "Goodbye", action: "replacement" };
const steering = { id: "greet", kind: "harmful", artifact: "script", utterance: "hi", answer: "Hello", text: "be brief", action: "steering" };

describe("preference records from the feedback a person gives", () => {
  it("RF1.1 a negative rating is stored as a preference record", async () => {
    const { dialogue, feedback } = session();
    await feedback(rating);
    expect(dialogue.preferences()).toEqual([{ utterance: "hi", answer: "Hello", text: "", signal: "negative", action: "rating", artifact: { kind: "script", id: "greet" } }]);
  });

  it("RF1.2 a replacement correction is stored as a preference record", async () => {
    const { dialogue, feedback } = session();
    await feedback(replacement);
    expect(dialogue.preferences()).toEqual([{ utterance: "hi", answer: "Hello", text: "Goodbye", signal: "negative", action: "replacement", artifact: { kind: "script", id: "greet" } }]);
  });

  it("RF1.3 a steering instruction is stored as a preference record", async () => {
    const { dialogue, feedback } = session();
    await feedback(steering);
    expect(dialogue.preferences()).toEqual([{ utterance: "hi", answer: "Hello", text: "be brief", signal: "negative", action: "steering", artifact: { kind: "script", id: "greet" } }]);
  });

  it("RF1.4 a preference record from one session is kept when another session stores one", async () => {
    const first = session();
    await first.feedback(rating);
    const second = session(first.dialogue.save());
    expect(second.dialogue.preferences()).toEqual([{ utterance: "hi", answer: "Hello", text: "", signal: "negative", action: "rating", artifact: { kind: "script", id: "greet" } }]);
    await second.feedback(steering);
    expect(second.dialogue.preferences()).toEqual([
      { utterance: "hi", answer: "Hello", text: "", signal: "negative", action: "rating", artifact: { kind: "script", id: "greet" } },
      { utterance: "hi", answer: "Hello", text: "be brief", signal: "negative", action: "steering", artifact: { kind: "script", id: "greet" } },
    ]);
  });

  it("RF1.5 a correction of a missing script is refused and stores nothing", async () => {
    const { dialogue, feedback } = session();
    await expect(feedback({ ...rating, id: "missing" })).rejects.toThrow("no script missing");
    expect(dialogue.preferences()).toEqual([]);
  });

  it("RF1.6 a replacement without the person's text is refused", async () => {
    const { dialogue, feedback } = session();
    await expect(feedback({ ...replacement, text: "" })).rejects.toThrow(/person's text/);
    expect(dialogue.preferences()).toEqual([]);
  });
});
