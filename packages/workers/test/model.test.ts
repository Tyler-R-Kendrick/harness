import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { WorkerEvent } from "@harness/core";
import { ModelWorker } from "@harness/workers";

const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };

function streamingModel(deltas: string[], finish: "stop" | "length" | "content-filter" = "stop") {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "1" },
          ...deltas.map((delta) => ({ type: "text-delta" as const, id: "1", delta })),
          { type: "text-end" as const, id: "1" },
          { type: "finish" as const, finishReason: { unified: finish, raw: finish }, usage },
        ],
      }),
    }),
  });
}

const cmd = (text: string, turnId = "t1") => ({ type: "prompt" as const, sessionId: "s1", turnId, cwd: "/", prompt: [{ type: "text", text }] });

function collect() {
  const events: WorkerEvent[] = [];
  return { events, emit: (e: WorkerEvent) => void events.push(e) };
}

describe("ModelWorker", () => {
  it("WK2.1 streams model text as agent message chunks and ends the turn", async () => {
    const w = new ModelWorker({ model: streamingModel(["Hel", "lo"]) });
    const { events, emit } = collect();
    await w.run(cmd("hi"), emit);
    expect(events.filter((e) => e.type === "update").map((e) => (e.update["content"] as { text: string }).text)).toEqual(["Hel", "lo"]);
    expect(events.at(-1)).toEqual({ type: "end", sessionId: "s1", turnId: "t1", stopReason: "end_turn" });
  });

  it("WK2.2 maps finish reasons to ACP stop reasons", async () => {
    for (const [finish, stop] of [["length", "max_tokens"], ["content-filter", "refusal"]] as const) {
      const w = new ModelWorker({ model: streamingModel(["x"], finish) });
      const { events, emit } = collect();
      await w.run(cmd("hi"), emit);
      expect(events.at(-1)).toMatchObject({ type: "end", stopReason: stop });
    }
  });

  it("WK2.3 keeps per-session history and sends it with the next turn", async () => {
    const model = streamingModel(["answer"]);
    const w = new ModelWorker({ model, system: "be brief" });
    await w.run(cmd("first"), () => {});
    await w.run(cmd("second", "t2"), () => {});
    const prompt = model.doStreamCalls[1]!.prompt;
    expect(prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("WK2.4 a model error becomes an error notice and the turn still ends", async () => {
    const model = new MockLanguageModelV4({ doStream: async () => { throw new Error("gateway unauthorized"); } });
    const w = new ModelWorker({ model });
    const { events, emit } = collect();
    await w.run(cmd("hi"), emit);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "update", update: expect.objectContaining({ sessionUpdate: "notice", severity: "error", description: expect.stringContaining("gateway unauthorized") }) }),
    );
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
  });

  it("WK2.5 cancel aborts the stream and ends the turn as cancelled", async () => {
    let started!: () => void;
    const began = new Promise<void>((r) => (started = r));
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        started();
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "1" });
              abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason));
            },
          }),
        };
      },
    });
    const w = new ModelWorker({ model });
    const { events, emit } = collect();
    const done = w.run(cmd("hi"), emit);
    await began;
    w.cancel("s1", "t1");
    await done;
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "cancelled" });
  });
});

describe("ModelWorker finish reasons", () => {
  it("WK2.6 unmapped finish reasons end the turn normally", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [{ type: "finish" as const, finishReason: { unified: "other" as const, raw: "other" }, usage }],
        }),
      }),
    });
    const w = new ModelWorker({ model });
    const events: WorkerEvent[] = [];
    await w.run(cmd("hi"), (e) => void events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
    expect(() => w.permission()).not.toThrow();
  });
});
