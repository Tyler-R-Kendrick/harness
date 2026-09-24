import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { BlockedError, calibrationSuite, harnessSuite } from "@harness/evals";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const replying = (text: string) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "1" },
          { type: "text-delta" as const, id: "1", delta: text },
          { type: "text-end" as const, id: "1" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage },
        ],
      }),
    }),
  });
const failing = (message: string) => new MockLanguageModelV4({ doStream: async () => { throw new Error(message); } });

/** Every `name` a question refers to in backticks must exist in the judged state. */
function referencedKeys(instructions: unknown): string[] {
  return [...String(instructions).matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1]!);
}

describe("eval suites", () => {
  it("EV7.1 calibration cases have unique ids, and every referenced field exists in their state", async () => {
    const ids = calibrationSuite.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of calibrationSuite) {
      const state = (await c.subject()) as Record<string, unknown>;
      for (const q of Object.values(c.questions)) for (const key of referencedKeys(q.instructions)) expect(state, `${c.id} -> ${key}`).toHaveProperty(key);
      expect(Object.keys(c.expect).sort()).toEqual(Object.keys(c.questions).sort());
    }
  });

  it("EV7.2 calibration pairs include both positive and negative expectations", () => {
    const expectations = calibrationSuite.flatMap((c) => Object.values(c.expect)).filter((e) => e.type === "boolean");
    expect(expectations.some((e) => e.type === "boolean" && e.expect)).toBe(true);
    expect(expectations.some((e) => e.type === "boolean" && !e.expect)).toBe(true);
  });

  it("EV7.3 harness cases run prompts through the daemon and model worker and expose referenced fields", async () => {
    const suite = harnessSuite("mock", () => replying("Paris"));
    for (const c of suite) {
      const state = (await c.subject()) as Record<string, unknown>;
      for (const q of Object.values(c.questions)) for (const key of referencedKeys(q.instructions)) expect(state, `${c.id} -> ${key}`).toHaveProperty(key);
    }
    const [first] = suite;
    expect(await first!.subject()).toEqual({ prompt: "What is the capital of France? Answer in one word.", reply: "Paris" });
  });

  it("EV7.4 a model access failure blocks the case; any other model failure fails it", async () => {
    const [blocked] = harnessSuite("mock", () => failing("Gateway 401: unauthorized"));
    await expect(blocked!.subject()).rejects.toBeInstanceOf(BlockedError);
    const [broken] = harnessSuite("mock", () => failing("model exploded"));
    await expect(broken!.subject()).rejects.toThrow(/model exploded/);
    await expect(broken!.subject()).rejects.not.toBeInstanceOf(BlockedError);
  });
});
