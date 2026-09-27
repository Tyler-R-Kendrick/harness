import { EchoWorker } from "@harness/workers";
import type { EvalCase } from "../runner.ts";
import { runSession } from "../session.ts";

/**
 * End-to-end harness behavior. Prompts go through the real daemon core with the
 * deterministic echo worker, so the only model in the pipeline is the judge,
 * which checks what the multiplexer did: replies, turn order and permission routing.
 */
export const harnessSuite: readonly EvalCase[] = [
  {
    id: "harness.prompt-roundtrip",
    description: "A prompt reaches the worker and its reply comes back on the same turn",
    subject: async () => {
      const [turn] = await runSession(new EchoWorker(), ["Summarize the release notes"]);
      return { prompt: turn!.prompt, reply: turn!.reply, stopReason: turn!.stopReason ?? "none" };
    },
    questions: {
      roundtrip: {
        type: "boolean",
        instructions: "Does the text of `prompt` appear in `reply` as a substring, and is `stopReason` equal to end_turn?",
      },
    },
    expect: { roundtrip: { type: "boolean", expect: true } },
  },
  {
    id: "harness.multi-turn-order",
    description: "Turns in one session stay separate and in order",
    subject: async () => {
      const turns = await runSession(new EchoWorker(), ["first: open the file", "second: edit line 3", "third: save"]);
      return { turns: turns.map((t) => ({ user: t.prompt, assistant: t.reply, stopReason: t.stopReason ?? "none" })) };
    },
    // One property per question: a judge weighs a single claim more reliably than a conjunction.
    questions: {
      ordered: { type: "boolean", instructions: "Does `turns` have exactly three entries, whose \"user\" texts begin with first, second and third, in that order?" },
      separate: { type: "boolean", instructions: "Does each entry of `turns` have an \"assistant\" text that contains that entry's own \"user\" text and no text from any other entry's \"user\"?" },
      ended: { type: "boolean", instructions: "Is the \"stopReason\" of every entry of `turns` equal to end_turn?" },
    },
    expect: { ordered: { type: "boolean", expect: true }, separate: { type: "boolean", expect: true }, ended: { type: "boolean", expect: true } },
  },
  {
    id: "harness.permission-denied",
    description: "A denied permission request stops the tool from running",
    subject: async () => {
      const prompt = "!permission delete the build folder";
      const [turn] = await runSession(new EchoWorker(), [prompt], { permission: "deny" });
      return { policy: "deny", prompt, reply: turn!.reply, stopReason: turn!.stopReason ?? "none" };
    },
    questions: {
      refused: {
        type: "boolean",
        instructions:
          "The approver answered the tool's permission request according to `policy`. Does `reply` report that permission was denied, without repeating the text of `prompt`?",
      },
    },
    expect: { refused: { type: "boolean", expect: true } },
  },
  {
    id: "harness.permission-allowed",
    description: "An allowed permission request lets the tool run",
    subject: async () => {
      const prompt = "!permission list the build folder";
      const [turn] = await runSession(new EchoWorker(), [prompt], { permission: "allow" });
      return { policy: "allow", prompt, reply: turn!.reply, stopReason: turn!.stopReason ?? "none" };
    },
    questions: {
      ran: {
        type: "boolean",
        instructions:
          "The approver answered the tool's permission request according to `policy`. Does the text of `prompt` appear in `reply` as a substring, showing the tool ran, and is `stopReason` equal to end_turn?",
      },
    },
    expect: { ran: { type: "boolean", expect: true } },
  },
];
