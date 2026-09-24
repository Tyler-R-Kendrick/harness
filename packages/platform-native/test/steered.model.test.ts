import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compilePack, parseGraph, parseSaeRows } from "@harness/behavior";
import type { BehaviorPack } from "@harness/behavior";
import type { GenerationEvent, Generator } from "@harness/cognitive";
import { buildNativeEnsemble, loadCatalog } from "@harness/platform-native";
import { generatorContract } from "@harness/testkit";
import { modelCacheDir } from "./models-env.ts";

// The local kernel on real weights, loaded by the host as in production: the catalog's
// onnxruntime model, patched with its steering tap, driven by the behavior graph and SAE
// rows in packages/behavior/fixtures that were made for it.
const kernelModel = loadCatalog().models.find((m) => m.runtime === "onnxruntime")!;
const fixtures = join(import.meta.dirname, "../../behavior/fixtures");
const hosts: ReturnType<typeof buildNativeEnsemble>[] = [];
afterAll(async () => {
  await Promise.all(hosts.map((h) => h.close()));
});
const once = <T>(make: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= make());
};
async function kernel(behavior?: BehaviorPack): Promise<Generator> {
  const host = buildNativeEnsemble({ cacheDir: modelCacheDir, allowHosted: false, catalog: { models: [kernelModel], preferences: {} }, ...(behavior ? { behavior } : {}) });
  hosts.push(host);
  return (await host.ensemble.resolve("steered-chat", "generator")).port;
}
const behavior = once(async () => {
  const files = await readdir(fixtures);
  const read = async (f: string) => readFile(join(fixtures, f), "utf8");
  const graphs = await Promise.all(files.filter((f) => f.endsWith(".graph.json")).map(async (f) => parseGraph(JSON.parse(await read(f)))));
  const graph = graphs.find((g) => g.model.id === kernelModel.id);
  if (!graph) throw new Error(`no behavior graph fixture for ${kernelModel.id}`);
  const rowFiles = files.filter((f) => f.endsWith("-rows.json"));
  const rows = (await Promise.all(rowFiles.map(read))).find((text) => (JSON.parse(text) as { source: { model: string } }).source.model === kernelModel.id);
  if (!rows) throw new Error(`no SAE rows fixture for ${kernelModel.id}`);
  return { graph, pack: compilePack(graph, parseSaeRows(rows)) };
});
const steered = once(async () => kernel((await behavior()).pack));
const plain = once(() => kernel());

async function reply(content: string, isSteered: boolean) {
  const g = await (isSteered ? steered() : plain());
  const events: GenerationEvent[] = [];
  for await (const e of g.generate({ messages: [{ role: "user", content }], maxTokens: 40 })) events.push(e);
  return {
    events,
    text: events.map((e) => (e.type === "text" ? e.text : "")).join(""),
    states: events.flatMap((e) => (e.type === "state" ? [`${e.from}->${e.state}`] : [])),
  };
}

generatorContract(`${kernelModel.id} steerable kernel, unsteered, real weights`, plain);

describe("the steerable kernel with a behavior graph, real weights", () => {
  it("KS1.1 the host graph parses, for this model and the layer its tap carries", async () => {
    const { graph } = await behavior();
    expect(graph.model).toEqual({ id: kernelModel.id, layer: kernelModel.runtime === "onnxruntime" ? kernelModel.run.tap.layer : -1 });
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
