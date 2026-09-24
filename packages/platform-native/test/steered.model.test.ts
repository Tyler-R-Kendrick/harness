import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BehaviorEngine, compilePack, parseGraph, parseSaeRows } from "@harness/behavior";
import type { GenerationEvent } from "@harness/cognitive";
import { behaviorHook, loadChatTokenizer, OnnxSteerableSession, qwenTap, SteeredGenerator } from "@harness/models";
import { ModelFiles, steerableModel } from "@harness/platform-native";
import { generatorContract } from "@harness/testkit";
import { catalogEntry, modelCacheDir } from "./models-env.ts";

// The local kernel on real weights: Qwen3-1.7B's int4 export, patched with a steering
// tap at layer 14, driven by a behavior graph over real SAE features
// (adamkarvonen/qwen3-1.7b-saes, rows in packages/behavior/fixtures).
const fixtures = join(import.meta.dirname, "../../behavior/fixtures");
const once = <T>(make: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= make());
};
const kernel = once(async () => {
  const m = catalogEntry("Qwen/Qwen3-1.7B");
  const file = m.artifact.files[0]!.path;
  const source = await new ModelFiles({ dir: join(modelCacheDir, "gguf") }).path(m.artifact, file);
  const model = await steerableModel({ source, tap: qwenTap(14, 2048), dir: join(modelCacheDir, "steerable") });
  const session = await OnnxSteerableSession.create({ model, layer: 14, config: { layers: 28, kvHeads: 8, headSize: 128, hidden: 2048 } });
  const tokenizer = await loadChatTokenizer({
    repo: m.artifact.repo,
    revision: m.artifact.revision,
    subfolder: dirname(file),
    cacheDir: join(modelCacheDir, "transformers"),
    templateOptions: { enable_thinking: false },
  });
  const graph = parseGraph(JSON.parse(await readFile(join(fixtures, "qwen3-1.7b-host.graph.json"), "utf8")));
  const pack = compilePack(graph, parseSaeRows(await readFile(join(fixtures, "qwen3-1.7b-l14-rows.json"), "utf8")));
  return { session, tokenizer, graph, pack };
});

async function reply(content: string, steered: boolean) {
  const { session, tokenizer, pack } = await kernel();
  const g = new SteeredGenerator({ session, tokenizer, ...(steered ? { hook: behaviorHook(new BehaviorEngine(pack)) } : {}) });
  const events: GenerationEvent[] = [];
  for await (const e of g.generate({ messages: [{ role: "user", content }], maxTokens: 40 })) events.push(e);
  return {
    events,
    text: events.map((e) => (e.type === "text" ? e.text : "")).join(""),
    states: events.flatMap((e) => (e.type === "state" ? [`${e.from}->${e.state}`] : [])),
  };
}

generatorContract("Qwen3-1.7B steerable kernel, unsteered, real weights", async () => {
  const { session, tokenizer } = await kernel();
  return new SteeredGenerator({ session, tokenizer, maxTokens: 64 });
});

describe("the steerable kernel with a behavior graph, real weights", () => {
  it("KS1.1 the host graph parses, for this model and layer", async () => {
    const { graph, session } = await kernel();
    expect(graph.model).toEqual({ id: "Qwen/Qwen3-1.7B", layer: session.layer });
  });

  it("KS1.2 an insult turns the anger sensor on while reading the prompt: the host is soothing before it says a word", async () => {
    const r = await reply("You useless idiot, I am furious with you!", true);
    expect(r.states).toEqual(["neutral->soothing"]);
    expect(r.events[0]).toMatchObject({ type: "state", state: "soothing", cause: "sensor userAngry on" });
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.text).not.toContain("�");
  });

  it("KS1.3 happy news turns the host cheerful, and the joy steering changes the reply", async () => {
    const steered = await reply("I just got engaged, I'm so happy!", true);
    const plain = await reply("I just got engaged, I'm so happy!", false);
    expect(steered.states).toEqual(["neutral->cheerful"]);
    expect(steered.text).not.toBe(plain.text);
  });

  it("KS1.4 a neutral question changes no state, and the neutral state (no steering) replies exactly as the unsteered model does", async () => {
    const steered = await reply("What is the capital of France?", true);
    const plain = await reply("What is the capital of France?", false);
    expect(steered.states).toEqual([]);
    expect(steered.text).toBe(plain.text);
    expect(steered.text).toMatch(/Paris/);
  });
});
