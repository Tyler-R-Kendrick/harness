import { describe, expect, it } from "vitest";
import { EnsembleWorker } from "@harness/workers";
import type { GenerateRequest, GenerationEvent, TaskCategory } from "@harness/cognitive";
import type { WorkerEvent } from "@harness/core";

class FakeEnsemble {
  readonly calls: { request: GenerateRequest; task: TaskCategory }[] = [];
  readonly script: (request: GenerateRequest) => GenerationEvent[] | Error;
  readonly gate: Promise<void> | undefined;
  constructor(script: (request: GenerateRequest) => GenerationEvent[] | Error, gate?: Promise<void>) {
    this.script = script;
    this.gate = gate;
  }
  async *generate(request: GenerateRequest, task: TaskCategory = "chat"): AsyncIterable<GenerationEvent> {
    this.calls.push({ request, task });
    const events = this.script(request);
    if (events instanceof Error) throw events;
    for (const e of events) {
      if (this.gate) await this.gate;
      yield e;
    }
  }
}

function run(worker: EnsembleWorker, prompt: unknown[], sessionId = "s1", turnId = "t1") {
  const events: WorkerEvent[] = [];
  const done = worker.run({ type: "prompt", sessionId, turnId, prompt, cwd: "/" }, (e) => events.push(e));
  return { events, done };
}

describe("EnsembleWorker", () => {
  it("EW1.1 streams the chosen generator's text as message chunks and its reasoning as thought chunks", async () => {
    const ensemble = new FakeEnsemble(() => [{ type: "reasoning", text: "plan" }, { type: "text", text: "Hel" }, { type: "text", text: "lo" }, { type: "finish", reason: "stop" }]);
    const { events, done } = run(new EnsembleWorker({ ensemble }), [{ type: "text", text: "hi" }]);
    await done;
    expect(events).toEqual([
      { type: "update", sessionId: "s1", turnId: "t1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan" } } },
      { type: "update", sessionId: "s1", turnId: "t1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } } },
      { type: "update", sessionId: "s1", turnId: "t1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } } },
      { type: "end", sessionId: "s1", turnId: "t1", stopReason: "end_turn" },
    ]);
    expect(ensemble.calls[0]!.task).toBe("chat");
  });

  it("EW1.2 keeps each session's history so follow-up turns carry context", async () => {
    const ensemble = new FakeEnsemble(() => [{ type: "text", text: "ok" }, { type: "finish", reason: "stop" }]);
    const worker = new EnsembleWorker({ ensemble, system: "Be brief." });
    await run(worker, [{ type: "text", text: "My name is Ada." }]).done;
    await run(worker, [{ type: "text", text: "What is my name?" }], "s1", "t2").done;
    expect(ensemble.calls[1]!.request.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "My name is Ada." },
      { role: "assistant", content: "ok" },
      { role: "user", content: "What is my name?" },
    ]);
  });

  it("EW1.3 a prompt with an image goes to the vision task with the image attached", async () => {
    const ensemble = new FakeEnsemble(() => [{ type: "text", text: "a cat" }, { type: "finish", reason: "stop" }]);
    await run(new EnsembleWorker({ ensemble }), [{ type: "text", text: "what is this?" }, { type: "image", mimeType: "image/png", data: "AQID" }]).done;
    expect(ensemble.calls[0]!.task).toBe("vision-qa");
    expect(ensemble.calls[0]!.request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", image: { mediaType: "image/png", data: new Uint8Array([1, 2, 3]) } }] },
    ]);
  });

  it("EW1.4 hitting the token limit ends as max_tokens; a failure is reported as a notice", async () => {
    const cut = run(new EnsembleWorker({ ensemble: new FakeEnsemble(() => [{ type: "text", text: "a" }, { type: "finish", reason: "length" }]) }), [{ type: "text", text: "x" }]);
    await cut.done;
    expect(cut.events.at(-1)).toMatchObject({ type: "end", stopReason: "max_tokens" });
    const failed = run(new EnsembleWorker({ ensemble: new FakeEnsemble(() => new Error("no generator member available for chat on browser")) }), [{ type: "text", text: "x" }]);
    await failed.done;
    expect(failed.events).toEqual([
      { type: "update", sessionId: "s1", turnId: "t1", update: { sessionUpdate: "notice", severity: "error", title: "Model call failed", description: "no generator member available for chat on browser" } },
      { type: "end", sessionId: "s1", turnId: "t1", stopReason: "end_turn" },
    ]);
  });

  it("EW1.5 cancelling stops the stream and ends the turn as cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const worker = new EnsembleWorker({ ensemble: new FakeEnsemble(() => [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "finish", reason: "stop" }], gate) });
    const { events, done } = run(worker, [{ type: "text", text: "x" }]);
    worker.cancel("s1", "t1");
    release();
    await done;
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "cancelled" });
    expect(events.filter((e) => e.type === "update")).toEqual([]);
  });

  it("EW1.6 a worker for steered chat asks for that task, and behavior transitions reach the client as notices", async () => {
    const ensemble = new FakeEnsemble(() => [{ type: "state", state: "soothing", from: "neutral", cause: "sensor userAngry on" }, { type: "text", text: "Sorry" }, { type: "finish", reason: "stop" }]);
    const { events, done } = run(new EnsembleWorker({ ensemble, task: "steered-chat" }), [{ type: "text", text: "you idiot" }]);
    await done;
    expect(ensemble.calls[0]!.task).toBe("steered-chat");
    expect(events[0]).toEqual({
      type: "update",
      sessionId: "s1",
      turnId: "t1",
      update: {
        sessionUpdate: "notice",
        severity: "info",
        title: "Behavior: soothing",
        description: "neutral → soothing (sensor userAngry on)",
        _meta: { harness: { behavior: { state: "soothing", from: "neutral", cause: "sensor userAngry on" } } },
      },
    });
    // a state with no recorded origin still names the state
    const bare = new FakeEnsemble(() => [{ type: "state", state: "calm" }, { type: "state", state: "alert", from: "calm" }, { type: "finish", reason: "stop" }]);
    const second = run(new EnsembleWorker({ ensemble: bare }), [{ type: "text", text: "x" }]);
    await second.done;
    expect(second.events[0]).toMatchObject({ update: { title: "Behavior: calm", description: "calm", _meta: { harness: { behavior: { state: "calm" } } } } });
    expect(second.events[1]).toMatchObject({ update: { description: "calm → alert" } });
  });

  it("EW1.7 with memory, a turn is given related memories from other sessions and is remembered afterwards", async () => {
    const ensemble = new FakeEnsemble(() => [{ type: "text", text: "It is in the vault." }, { type: "finish", reason: "stop" }]);
    const asked: unknown[] = [];
    const kept: unknown[] = [];
    const memory = {
      recall: async (query: string, options: unknown) => (asked.push({ query, options }), [{ id: "m1", text: "the deploy key lives in the vault", score: 0.8, sessionId: "old" }]),
      remember: async (items: unknown) => (kept.push(items), ["m2", "m3"]),
    };
    const { done } = run(new EnsembleWorker({ ensemble, memory }), [{ type: "text", text: "where is the deploy key?" }], "s9");
    await done;
    expect(asked).toEqual([{ query: "where is the deploy key?", options: { excludeSession: "s9", limit: 3 } }]);
    expect(ensemble.calls[0]!.request.messages[0]).toEqual({ role: "system", content: "Relevant memories from earlier sessions:\n- the deploy key lives in the vault" });
    expect(kept).toEqual([
      [
        { text: "where is the deploy key?", sessionId: "s9", kind: "user" },
        { text: "It is in the vault.", sessionId: "s9", kind: "assistant" },
      ],
    ]);
    // nothing related: no memory message; a memory that fails does not fail the turn
    const quiet = new FakeEnsemble(() => [{ type: "text", text: "ok" }, { type: "finish", reason: "stop" }]);
    const broken = { recall: async () => [], remember: async () => Promise.reject(new Error("disk full")) };
    const second = run(new EnsembleWorker({ ensemble: quiet, memory: broken }), [{ type: "text", text: "hi" }]);
    await second.done;
    expect(quiet.calls[0]!.request.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(second.events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
  });
});

