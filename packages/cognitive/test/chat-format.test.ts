import { describe, expect, it } from "vitest";
import { ChatStreamParser, parseChatOutput } from "@harness/cognitive";

describe("ChatML / qwen3_xml output parsing", () => {
  it("QF1.1 plain text loses end-of-turn markers", () => {
    expect(parseChatOutput("Paris<|im_end|>")).toEqual({ text: "Paris", reasoning: "", toolCalls: [] });
    expect(parseChatOutput("Paris<|endoftext|>")).toEqual({ text: "Paris", reasoning: "", toolCalls: [] });
  });

  it("QF1.2 a think block becomes reasoning, not text", () => {
    expect(parseChatOutput("<think>\nFrance's capital.\n</think>\n\nParis")).toEqual({ text: "Paris", reasoning: "France's capital.", toolCalls: [] });
  });

  it("QF1.3 a qwen3_xml tool call is parsed, with JSON parameter values decoded", () => {
    const raw = "<tool_call>\n<function=set_timer>\n<parameter=minutes>\n5\n</parameter>\n<parameter=label>\ntea\n</parameter>\n<parameter=loud>\ntrue\n</parameter>\n</function>\n</tool_call><|im_end|>";
    expect(parseChatOutput(raw)).toEqual({ text: "", reasoning: "", toolCalls: [{ name: "set_timer", arguments: { minutes: 5, label: "tea", loud: true } }] });
  });

  it("QF1.4 several tool calls keep their order, and surrounding text is kept", () => {
    const call = (n: string, v: string) => `<tool_call>\n<function=${n}>\n<parameter=city>\n${v}\n</parameter>\n</function>\n</tool_call>`;
    const out = parseChatOutput(`Checking both.\n${call("get_weather", "Lagos")}\n${call("get_time", "Paris")}`);
    expect(out.text).toBe("Checking both.");
    expect(out.toolCalls).toEqual([
      { name: "get_weather", arguments: { city: "Lagos" } },
      { name: "get_time", arguments: { city: "Paris" } },
    ]);
  });

  it("QF1.5 the JSON tool-call form is parsed too", () => {
    expect(parseChatOutput('<tool_call>\n{"name": "get_weather", "arguments": {"city": "Lagos"}}\n</tool_call>').toolCalls).toEqual([
      { name: "get_weather", arguments: { city: "Lagos" } },
    ]);
  });

  it("QF1.6 an unterminated or unreadable tool call stays in the text rather than becoming a call", () => {
    expect(parseChatOutput("<tool_call>\n<function=x>").toolCalls).toEqual([]);
    expect(parseChatOutput("<tool_call>\n<function=x>").text).toBe("<tool_call>\n<function=x>");
    expect(parseChatOutput("<tool_call>not a call</tool_call>")).toEqual({ text: "<tool_call>not a call</tool_call>", reasoning: "", toolCalls: [] });
  });

  it("QF2.1 the streaming parser emits text as it arrives and holds back possible tags", () => {
    const p = new ChatStreamParser();
    expect(p.push("Hello <")).toEqual([{ type: "text", text: "Hello " }]);
    expect(p.push("b>world")).toEqual([{ type: "text", text: "<b>world" }]);
    expect(p.push("<think>hm")).toEqual([]);
    expect(p.push("m</think>ok<|im_")).toEqual([{ type: "reasoning", text: "hmm" }, { type: "text", text: "ok" }]);
    expect(p.push("end|>")).toEqual([]);
    expect(p.end()).toEqual([]);
  });

  it("QF2.2 the streaming parser emits a tool call once it closes", () => {
    const p = new ChatStreamParser();
    expect(p.push("<tool_call>\n<function=f>\n<parameter=a>\n1\n</para")).toEqual([]);
    expect(p.push("meter>\n</function>\n</tool_call>")).toEqual([{ type: "tool-call", call: { name: "f", arguments: { a: 1 } } }]);
  });

  it("QF2.3 end() flushes held-back text and unterminated blocks as text", () => {
    const p = new ChatStreamParser();
    expect(p.push("tail <|im")).toEqual([{ type: "text", text: "tail " }]);
    expect(p.end()).toEqual([{ type: "text", text: "<|im" }]);
    const q = new ChatStreamParser();
    q.push("<tool_call>\n<function=x>");
    expect(q.end()).toEqual([{ type: "text", text: "<tool_call>\n<function=x>" }]);
  });
});
