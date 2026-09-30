import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { usage } from "@harness/cognitive";
import { AgentWorker, EchoWorker, sessionAgent } from "@harness/workers";
import type { EvalCase } from "../runner.ts";
import { runSession } from "../session.ts";

/**
 * The session agent, judged through the daemon. The subject is deterministic: a scripted
 * model answers, and the echo worker is the negative case (a labeled copy of the prompt
 * is not an answer). The judge is still the only model an eval run calls.
 */
const QUESTION = "What is the capital of France?";
const FOLLOW = "What city did I just ask about?";

function userTexts(prompt: LanguageModelV4Prompt): string[] {
  const texts: string[] = [];
  for (const message of prompt) {
    if (message.role !== "user") continue;
    for (const part of message.content) if (part.type === "text") texts.push(part.text);
  }
  return texts;
}

/** Answers the two questions the suite asks. Anything else is a direct reply, not a labeled echo. */
function answer(prompt: LanguageModelV4Prompt): string {
  const said = userTexts(prompt);
  const latest = said.at(-1) ?? "";
  if (said.length > 1 && latest === FOLLOW) return "You asked about Paris, the capital of France.";
  if (latest === QUESTION) return "The capital of France is Paris.";
  return "Ask a question and I will answer it.";
}

function chatWorker(): AgentWorker {
  const model = new MockLanguageModelV4({
    doStream: async (options) => ({
      stream: convertArrayToReadableStream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: answer(options.prompt) },
        { type: "text-end", id: "0" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(8, 4) },
      ]),
    }),
  });
  return new AgentWorker({
    agent: sessionAgent({ model, instructions: "You are the harness session agent. Answer the person directly." }),
  });
}

export const chatSuite: readonly EvalCase[] = [
  {
    id: "chat.answers",
    description: "The session agent answers the question instead of labeling the prompt",
    subject: async () => {
      const [turn] = await runSession(chatWorker(), [QUESTION]);
      return { prompt: turn!.prompt, reply: turn!.reply, stopReason: turn!.stopReason ?? "none" };
    },
    questions: {
      answered: {
        type: "boolean",
        instructions: "Does `reply` say that Paris is the capital of France, and is `stopReason` equal to end_turn?",
      },
      direct: {
        type: "boolean",
        instructions: "Does `reply` avoid starting with the label echo: and avoid repeating `prompt` unchanged after that label?",
      },
    },
    expect: { answered: { type: "boolean", expect: true }, direct: { type: "boolean", expect: true } },
  },
  {
    id: "chat.thread",
    description: "A later turn uses what was asked earlier",
    subject: async () => {
      const turns = await runSession(chatWorker(), [QUESTION, FOLLOW]);
      return { earlier: turns[0]!.prompt, first: turns[0]!.reply, second: turns[1]!.reply };
    },
    questions: {
      followed: {
        type: "boolean",
        instructions: "Does `second` name Paris, the city `earlier` asked about, rather than repeating `earlier` with an echo label?",
      },
    },
    expect: { followed: { type: "boolean", expect: true } },
  },
  {
    id: "chat.echo-is-not-an-answer",
    description: "The echo worker repeats the prompt and does not answer it",
    subject: async () => {
      const [turn] = await runSession(new EchoWorker(), [QUESTION]);
      return { prompt: turn!.prompt, reply: turn!.reply, stopReason: turn!.stopReason ?? "none" };
    },
    questions: {
      useful: {
        type: "boolean",
        instructions: "Does `reply` name Paris as the capital of France, rather than repeating `prompt` after the label echo:?",
      },
    },
    expect: { useful: { type: "boolean", expect: false } },
  },
];
