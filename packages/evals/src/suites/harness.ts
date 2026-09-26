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
        instructions: "Does `reply` contain the full text of `prompt`, and is `stopReason` equal to end_turn?",
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
    questions: {
      ordered: {
        type: "boolean",
        instructions:
          "Does `turns` have exactly one entry per user prompt, in the order first, second, third, where each assistant reply repeats only its own user prompt (no text from another turn) and every stopReason is end_turn?",
      },
    },
    expect: { ordered: { type: "boolean", expect: true } },
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
          "The approver answered the tool's permission request according to `policy`. Does `reply` contain the full text of `prompt`, showing the tool ran, and is `stopReason` equal to end_turn?",
      },
    },
    expect: { ran: { type: "boolean", expect: true } },
  },
];
