import { describe, expect, it } from "vitest";
import { Memory, memoryExtension } from "@harness/memory";
import { calibrationSuite, chatSuite, cognitiveSuite, harnessSuite } from "@harness/evals";
import { bytes, dimensions, Ensemble } from "@harness/cognitive";
import type { ModelDescriptor, TaskCategory } from "@harness/cognitive";
import { hashEmbeddingModel, HeuristicCompressor, keywordRouterModel, scriptedModel, stubDocumentParser } from "@harness/testkit";

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

  it("EV7.3 harness cases run prompts through the daemon and expose every referenced field", async () => {
    const ids = harnessSuite.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of harnessSuite) {
      const state = (await c.subject()) as Record<string, unknown>;
      for (const q of Object.values(c.questions)) for (const key of referencedKeys(q.instructions)) expect(state, `${c.id} -> ${key}`).toHaveProperty(key);
      expect(Object.keys(c.expect).sort()).toEqual(Object.keys(c.questions).sort());
    }
  });

  it("EV7.4 the harness suite needs no model besides the judge: subjects are deterministic daemon runs", async () => {
    for (const c of harnessSuite) expect(await c.subject(), c.id).toEqual(await c.subject());
    const roundtrip = harnessSuite.find((c) => c.id === "harness.prompt-roundtrip")!;
    expect(await roundtrip.subject()).toMatchObject({ reply: expect.stringContaining("Summarize the release notes"), stopReason: "end_turn" });
  });

  it("EV7.5 permission cases route the worker's request and apply the stated policy", async () => {
    const denied = (await harnessSuite.find((c) => c.id === "harness.permission-denied")!.subject()) as Record<string, unknown>;
    expect(denied).toMatchObject({ policy: "deny", reply: "permission denied", stopReason: "end_turn" });
    const allowed = (await harnessSuite.find((c) => c.id === "harness.permission-allowed")!.subject()) as Record<string, unknown>;
    expect(allowed).toMatchObject({ policy: "allow", stopReason: "end_turn" });
    expect(allowed["reply"]).toContain(allowed["prompt"]);
  });

  it("EV9.1 chat cases have unique ids and every referenced field exists in their state", async () => {
    const ids = chatSuite.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["chat.answers", "chat.thread", "chat.echo-is-not-an-answer"]);
    for (const c of chatSuite) {
      const state = (await c.subject()) as Record<string, unknown>;
      for (const q of Object.values(c.questions)) for (const key of referencedKeys(q.instructions)) expect(state, `${c.id} -> ${key}`).toHaveProperty(key);
      expect(Object.keys(c.expect).sort()).toEqual(Object.keys(c.questions).sort());
    }
  });

  it("EV9.2 the session agent answers the question through the daemon and does not label the prompt", async () => {
    const answered = chatSuite.find((c) => c.id === "chat.answers")!;
    expect(await answered.subject()).toEqual(await answered.subject());
    expect(await answered.subject()).toMatchObject({ reply: "The capital of France is Paris.", stopReason: "end_turn" });
  });

  it("EV9.3 a later turn uses the earlier question", async () => {
    const thread = (await chatSuite.find((c) => c.id === "chat.thread")!.subject()) as { second: string };
    expect(thread.second).toContain("Paris");
  });

  it("EV9.4 the echo worker fails the same answer check", async () => {
    const echoed = (await chatSuite.find((c) => c.id === "chat.echo-is-not-an-answer")!.subject()) as { reply: string; prompt: string };
    expect(echoed.reply).toBe(`echo: ${echoed.prompt}`);
    expect(echoed.reply).not.toContain("Paris");
    expect(chatSuite.find((c) => c.id === "chat.echo-is-not-an-answer")!.expect["useful"]).toEqual({ type: "boolean", expect: false });
  });

  it("EV8.1 cognitive cases run real ensemble work and expose every field their questions reference", async () => {
    const d = (id: string, tasks: readonly TaskCategory[], ports: ModelDescriptor["ports"]): ModelDescriptor => ({ id, name: id, publisher: "t", tasks, ports, locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["native"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] });
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.register(d("router", ["tool-calling"], ["router"]), async () => ({ router: keywordRouterModel() }));
    ensemble.install(memoryExtension({ memory: new Memory(ensemble.embeddingModel(), { dimensions: dimensions(32) }), models: [d("embedder", ["text-embedding"], ["embedder"])], load: async () => ({ embedder: hashEmbeddingModel(64) }) }));
    ensemble.register(d("compressor-a", ["prompt-compression"], ["compressor"]), async () => ({ compressor: new HeuristicCompressor() }));
    ensemble.register(d("ocr", ["document-parsing"], ["document-parser"]), async () => ({ "document-parser": stubDocumentParser() }));
    ensemble.register(d("vlm", ["vision-qa"], ["generator"]), async () => ({ generator: scriptedModel(() => "A circle and a square.") }));
    const suite = cognitiveSuite(async () => ensemble);
    expect(new Set(suite.map((c) => c.id)).size).toBe(suite.length);
    expect(suite.map((c) => c.id)).toEqual(["cognitive.tool-decision", "cognitive.compression-keeps-facts", "cognitive.document-ocr", "cognitive.vision-answer", "cognitive.memory-recall"]);
    for (const c of suite) {
      const state = (await c.subject()) as Record<string, unknown>;
      for (const q of Object.values(c.questions)) for (const key of referencedKeys(q.instructions)) expect(state, `${c.id} -> ${key}`).toHaveProperty(key);
      expect(state, c.id).toHaveProperty("model");
      expect(Object.keys(c.expect).sort()).toEqual(Object.keys(c.questions).sort());
    }
  });
});
