import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { HARNESS } from "@harness/cognitive";
import { promptText } from "@harness/testkit";
import { guide, GuidanceCache, NodeNameSchema, parseSettings, RevisionIdSchema, sha256Hex } from "@harness/procedural";
import type { NodeName } from "@harness/procedural";
import { answering } from "./models.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));

const request = (model: MockLanguageModelV4) => ({
  model,
  template: settings.prompts.guidance,
  task: "answer a multi-hop question",
  graphContext: "Active Cognitive Node: [Start] (Type: STATUS)",
  graphContextDesc: settings.graphContext.local.desc,
  graphSource: settings.graphContext.local.source,
  query: "Who directed the film?",
  recent: "Thought: search\nAction: first_hop_retrieve(q=film)",
});

describe("guide", () => {
  it("PG4.7 renders the guidance template with all six slots and sends it as the prompt", async () => {
    const model = answering("Retrieve first.");
    await guide(request(model));
    const [call] = model.doGenerateCalls;
    expect(call!.prompt).toHaveLength(1);
    expect(promptText(call!.prompt)).toBe(
      settings.prompts.guidance
        .replace("{task_description}", "answer a multi-hop question")
        .replace("{graph_context_desc}", settings.graphContext.local.desc)
        .replace("{subgraph_summary}", "Active Cognitive Node: [Start] (Type: STATUS)")
        .replace("{query}", "Who directed the film?")
        .replace("{recent_context}", "Thought: search\nAction: first_hop_retrieve(q=film)")
        .replace("{graph_source}", settings.graphContext.local.source),
    );
  });

  it("PG4.8 returns the model's text and the call's token usage", async () => {
    const result = await guide(request(answering("Retrieve first.", { input: 40, output: 7 })));
    expect(result.text).toBe("Retrieve first.");
    expect(result.usage).toMatchObject({ inputTokens: 40, outputTokens: 7 });
  });

  it("PG4.9 passes temperature, topK and maxOutputTokens through to the model", async () => {
    const model = answering("ok");
    await guide({ ...request(model), temperature: 0, topK: 1, maxOutputTokens: 2048 });
    expect(model.doGenerateCalls[0]).toMatchObject({ temperature: 0, topK: 1, maxOutputTokens: 2048 });
  });

  it("PG4.10 leaves decoding to the model when no option is given, and asks for no constraint (guidance is free text)", async () => {
    const model = answering("ok");
    await guide(request(model));
    const [call] = model.doGenerateCalls;
    expect(call!.temperature).toBeUndefined();
    expect(call!.topK).toBeUndefined();
    expect(call!.maxOutputTokens).toBeUndefined();
    expect(call!.providerOptions?.[HARNESS]?.["constraint"]).toBeUndefined();
    expect(call!.responseFormat?.type ?? "text").toBe("text");
  });

  it("PG4.11 passes the abort signal through, so an aborted step cancels its guidance call", async () => {
    const controller = new AbortController();
    const model = answering("ok");
    await guide({ ...request(model), abortSignal: controller.signal });
    expect(model.doGenerateCalls[0]!.abortSignal).toBe(controller.signal);
  });
});

const core = RevisionIdSchema.parse("a".repeat(64));
const other = RevisionIdSchema.parse("b".repeat(64));
const node = (name: string): NodeName => NodeNameSchema.parse(name);
type KeyParts = Parameters<GuidanceCache["key"]>[0];
const base: KeyParts = { core, overlay: 3, node: node("Start"), query: "q1", window: "w1", model: "provider:model" };
const keyOf = (patch: Partial<KeyParts> = {}) => new GuidanceCache().key({ ...base, ...patch });

describe("GuidanceCache", () => {
  it("PG4.12 two different queries at Start never share an entry", () => {
    const cache = new GuidanceCache();
    const first = cache.key({ ...base, query: "Who directed the film?" });
    const second = cache.key({ ...base, query: "Where was the director born?" });
    expect(first).not.toBe(second);
    cache.set(first, "guidance for the first query");
    expect(cache.get(second)).toBeUndefined();
    expect(cache.get(first)).toBe("guidance for the first query");
  });

  it("PG4.13 the key is the same for the same step inputs", () => {
    expect(keyOf()).toBe(keyOf());
    expect(new GuidanceCache().key({ window: "w1", query: "q1", model: "provider:model", node: node("Start"), overlay: 3, core })).toBe(keyOf());
  });

  it("PG4.14 the key changes with the core, the overlay version, the node, the query, the window and the model", () => {
    const variants = [
      keyOf(),
      keyOf({ core: other }),
      keyOf({ overlay: 4 }),
      keyOf({ overlay: null }),
      keyOf({ overlay: 0 }),
      keyOf({ node: node("Scan_Index") }),
      keyOf({ node: undefined }),
      keyOf({ query: "q2" }),
      keyOf({ window: "w2" }),
      keyOf({ model: "provider:other" }),
    ];
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("PG4.15 the key holds digests of the query and the window, never their text", () => {
    const key = keyOf({ query: "a secret query", window: "a private window" });
    expect(key).not.toContain("a secret query");
    expect(key).not.toContain("a private window");
    expect(key).toContain(sha256Hex("a secret query"));
    expect(key).toContain(sha256Hex("a private window"));
    expect(key).toContain(core);
    expect(key).toContain("provider:model");
  });

  it("PG4.16 a node named like the fallback's absence and no node at all differ", () => {
    expect(keyOf({ node: undefined })).not.toBe(keyOf({ node: node("null") }));
  });

  it("PG4.17 names a model by its provider and id, and a model id string as itself", () => {
    const cache = new GuidanceCache();
    const model = new MockLanguageModelV4({ provider: "prov", modelId: "m1" });
    expect(cache.key({ ...base, model })).toBe(cache.key({ ...base, model: "prov:m1" }));
    expect(cache.key({ ...base, model })).not.toBe(cache.key({ ...base, model: new MockLanguageModelV4({ provider: "prov", modelId: "m2" }) }));
  });

  it("PG4.18 counts a get of a stored key as a hit and any other get as a miss", () => {
    const cache = new GuidanceCache();
    expect([cache.hits(), cache.misses()]).toEqual([0, 0]);
    expect(cache.get("k")).toBeUndefined();
    expect([cache.hits(), cache.misses()]).toEqual([0, 1]);
    cache.set("k", "text");
    expect(cache.get("k")).toBe("text");
    expect(cache.get("k")).toBe("text");
    expect(cache.get("j")).toBeUndefined();
    expect([cache.hits(), cache.misses()]).toEqual([2, 2]);
  });

  it("PG4.19 a set replaces the text a key held, and an empty guidance text is still a hit", () => {
    const cache = new GuidanceCache();
    cache.set("k", "old");
    cache.set("k", "");
    expect(cache.get("k")).toBe("");
    expect(cache.hits()).toBe(1);
  });

  it("PG4.20 each cache is scoped by its instance", () => {
    const one = new GuidanceCache();
    const two = new GuidanceCache();
    one.set("k", "text");
    expect(two.get("k")).toBeUndefined();
    expect([one.misses(), two.misses()]).toEqual([0, 1]);
  });
});
