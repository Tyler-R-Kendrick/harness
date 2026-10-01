import { describe, expect, it } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { jsonSchema, tool } from "ai";
import type { ToolExecutionOptions, ToolSet } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { usage } from "@harness/cognitive";
import { AgentWorker, sessionAgent } from "@harness/workers";
import type { ToolContext } from "@harness/workers";
import { clockTool, sessionTools } from "../src/clock.ts";
import type { ClockReading } from "../src/clock.ts";

const finish = (): LanguageModelV4StreamPart => ({ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() });
const text = (delta: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta },
  { type: "text-end", id: "0" },
];

const turn: ToolContext = { sessionId: "s1", messages: [], report: () => {} };

async function read(clock: ToolSet[string]): Promise<ClockReading> {
  const execute = clock.execute;
  expect(execute).toBeTypeOf("function");
  const options: ToolExecutionOptions<unknown> = { toolCallId: "c1", messages: [], context: undefined };
  return (await execute!({}, options)) as ClockReading;
}

describe("the session clock", () => {
  it("CK1.1 the clock reports an instant in UTC, as a local stamp, and with the time zone", async () => {
    const at = new Date("2026-10-01T15:04:05.000Z");
    const clock = clockTool(() => at);
    expect(clock.description).toContain("date");
    expect(clock.description).toContain("time");
    expect(clock.description).toContain("time zone");
    const reading = await read(clock);
    expect(reading.utc).toBe("2026-10-01T15:04:05.000Z");
    expect(reading.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(Date.parse(reading.local)).toBe(at.getTime());
  });

  it("CK1.2 session tools keep the offered set and the clock is the system clock", async () => {
    const at = new Date("2026-10-01T15:04:05.000Z");
    const echo = tool({ description: "Echo.", inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }), execute: async () => "echo" });
    const seen: string[] = [];
    const tools = await sessionTools({
      echo,
      clock: tool({ description: "not the clock", inputSchema: jsonSchema({ type: "object" }), execute: async () => (seen.push("other"), "other") }),
    }, () => at)(turn);
    expect(Object.keys(tools).sort()).toEqual(["clock", "echo"]);
    const reading = await read(tools["clock"]!);
    expect(reading.utc).toBe(at.toISOString());
    expect(seen).toEqual([]);
    const told: string[] = [];
    const fromTurn = await sessionTools((scope) => {
      told.push(scope.sessionId);
      return { echo };
    })(turn);
    expect(told).toEqual(["s1"]);
    expect(Object.keys(fromTurn).sort()).toEqual(["clock", "echo"]);
    const alone = await sessionTools()(turn);
    expect(Object.keys(alone)).toEqual(["clock"]);
    const live = await read(alone["clock"]!);
    expect(Math.abs(Date.parse(live.utc) - Date.now())).toBeLessThan(2000);
    expect(Date.parse(live.local)).toBe(Date.parse(live.utc));
  });

  it("CK1.3 a session agent offers the clock beside the turn's other tools", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: convertArrayToReadableStream([{ type: "stream-start", warnings: [] }, ...text("noon"), finish()]) }),
    });
    const echo = tool({ description: "Echo.", inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }), execute: async () => "echo" });
    const worker = new AgentWorker({ agent: sessionAgent({ model, tools: sessionTools({ echo }) }) });
    const events: { type: string }[] = [];
    await worker.run({ type: "prompt", sessionId: "s1", turnId: "t1", prompt: [{ type: "text", text: "what time is it?" }], cwd: "/" }, (event) => events.push(event));
    expect(model.doStreamCalls[0]?.tools?.map((item) => item.name).sort()).toEqual(["clock", "echo"]);
    expect(events.at(-1)).toMatchObject({ type: "end" });
  });
});
