import { describe, expect, it } from "vitest";
import { Memory } from "@harness/memory";
import type { EmbedInput } from "@harness/cognitive";
import { HashEmbedder } from "@harness/testkit";

/** Word-hash vectors: texts that share words are near each other. Records what it was asked. */
function embedder() {
  const inner = new HashEmbedder(64);
  const calls: { inputs: EmbedInput[]; dimensions: number | undefined }[] = [];
  return {
    calls,
    embed: (inputs: readonly EmbedInput[], options: { readonly dimensions?: number } = {}) => {
      calls.push({ inputs: [...inputs], dimensions: options.dimensions });
      return inner.embed(inputs, options);
    },
  };
}

describe("memory", () => {
  it("ME1.1 remembers text as documents and recalls the nearest by meaning, best first, for a query", async () => {
    const e = embedder();
    const memory = new Memory(e, { dimensions: 32 });
    const ids = await memory.remember([{ text: "the deploy key lives in the vault" }, { text: "bananas are rich in potassium" }, { text: "rotate the vault deploy key monthly" }]);
    expect(ids).toEqual(["m1", "m2", "m3"]);
    expect(memory.size).toBe(3);
    const hits = await memory.recall("where is the deploy key", { minScore: 0.3 });
    expect(hits.map((h) => h.text)).toEqual(["the deploy key lives in the vault", "rotate the vault deploy key monthly"]);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
    expect(e.calls.map((c) => [c.inputs[0]!.kind, c.dimensions])).toEqual([
      ["document", 32],
      ["query", 32],
    ]);
  });

  it("ME1.2 recall keeps to a session, or leaves one out, and honours the limit and the score floor", async () => {
    const memory = new Memory(embedder(), { dimensions: 32 });
    await memory.remember([
      { text: "alpha project uses postgres", sessionId: "s1", kind: "user" },
      { text: "alpha project deploys on fridays", sessionId: "s2", kind: "assistant" },
      { text: "alpha project notes", sessionId: "s2" },
    ]);
    const all = await memory.recall("alpha project", { minScore: 0 });
    expect(all).toHaveLength(3);
    expect((await memory.recall("alpha project", { minScore: 0, sessionId: "s1" })).map((h) => h.id)).toEqual(["m1"]);
    expect((await memory.recall("alpha project", { minScore: 0, excludeSession: "s2" })).map((h) => h.id)).toEqual(["m1"]);
    expect(await memory.recall("alpha project", { minScore: 0, limit: 1 })).toHaveLength(1);
    expect(await memory.recall("zebra crossing", { minScore: 0.99 })).toEqual([]);
    expect(all.find((h) => h.id === "m2")).toMatchObject({ sessionId: "s2", kind: "assistant" });
    expect(all.find((h) => h.id === "m3")).not.toHaveProperty("kind");
  });

  it("ME1.3 memory saves to JSON and restores exactly; a saved memory from another setup is refused", async () => {
    const e = embedder();
    const memory = new Memory(e, { dimensions: 32 });
    await memory.remember([{ text: "the vault key rotates monthly", sessionId: "s1" }]);
    const saved = JSON.parse(JSON.stringify(memory.save()));
    const restored = new Memory(e, { dimensions: 32, saved });
    expect(restored.size).toBe(1);
    expect(await restored.recall("vault key", { minScore: 0.1 })).toEqual(await memory.recall("vault key", { minScore: 0.1 }));
    expect(await restored.remember([{ text: "next" }])).toEqual(["m2"]);
    expect(() => new Memory(e, { dimensions: 64, saved })).toThrow(/32.*64|dimensions/);
    expect(() => new Memory(e, { dimensions: 32, saved: { format: "other" } })).toThrow(/memory/);
  });

  it("ME1.4 every change is announced, so the host can persist it", async () => {
    const saves: number[] = [];
    const memory = new Memory(embedder(), { dimensions: 32, onChange: (m) => saves.push(m.size) });
    await memory.remember([{ text: "one" }]);
    await memory.remember([{ text: "two" }, { text: "three" }]);
    await memory.recall("one");
    expect(saves).toEqual([1, 3]);
  });
});

