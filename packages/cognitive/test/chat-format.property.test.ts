import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { ChatStreamParser, parseChatOutput } from "@harness/cognitive";
import type { ChatEvent } from "@harness/cognitive";

const piece = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom("<", ">", "<|im_end|>", "<think>", "</think>", "<tool_call>", "</tool_call>", "\n"),
  fc.constantFrom(
    "<think>plan</think>",
    "<tool_call>\n<function=f>\n<parameter=a>\n1\n</parameter>\n</function>\n</tool_call>",
    '<tool_call>{"name":"g","arguments":{"b":"x"}}</tool_call>',
  ),
);

function collapse(events: readonly ChatEvent[]) {
  const text = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  const reasoning = events.filter((e) => e.type === "reasoning").map((e) => e.text).join("\n");
  const toolCalls = events.flatMap((e) => (e.type === "tool-call" ? [e.call] : []));
  return { text, reasoning, toolCalls };
}

describe("chat output parsing properties", () => {
  test.prop([fc.array(piece, { maxLength: 12 }), fc.array(fc.nat(), { maxLength: 8 })])(
    "QF3.1 any chunking of the stream yields the same calls, reasoning and text as parsing it whole",
    (pieces, cuts) => {
      const raw = pieces.join("");
      const points = [...new Set(cuts.map((c) => c % (raw.length + 1)))].sort((a, b) => a - b);
      const parser = new ChatStreamParser();
      const events: ChatEvent[] = [];
      let prev = 0;
      for (const p of [...points, raw.length]) {
        events.push(...parser.push(raw.slice(prev, p)));
        prev = p;
      }
      events.push(...parser.end());
      const whole = parseChatOutput(raw);
      const streamed = collapse(events);
      expect(streamed.toolCalls).toEqual(whole.toolCalls);
      expect(streamed.reasoning.trim()).toBe(whole.reasoning);
      expect(streamed.text.trim()).toBe(whole.text);
    },
  );

  test.prop([fc.string().filter((s) => !s.includes("<"))])("QF3.2 text without tags passes through unchanged", (s) => {
    expect(parseChatOutput(s)).toEqual({ text: s.trim(), reasoning: "", toolCalls: [] });
  });
});
