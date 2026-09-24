import { describe, expect, it } from "vitest";
import { Ensemble, invokeCognitive, mirrorCapabilities } from "@harness/cognitive";
import { Memory, MEMORY_MODELS, memoryExtension } from "@harness/memory";
import { HashEmbedder } from "@harness/testkit";

function setup() {
  const ensemble = new Ensemble({ platform: "native" });
  const offered = new Set<string>();
  mirrorCapabilities(ensemble, { offer: (n) => offered.add(n), withdraw: (n) => offered.delete(n) });
  const loaded: string[] = [];
  const memory = new Memory(ensemble, { dimensions: 32 });
  const extension = memoryExtension({ memory, load: async (d) => (loaded.push(d.id), { embedder: new HashEmbedder(64) }) });
  return { ensemble, offered, loaded, memory, extension };
}

describe("memory as a cognitive-core extension", () => {
  it("MX1.1 installing memory brings its embedding model; the core then offers text embedding and memory", async () => {
    const { ensemble, offered, loaded, extension } = setup();
    expect(offered.has("cognitive.text-embedding")).toBe(false);
    const uninstall = ensemble.install(extension);
    expect([...offered].sort()).toEqual(["cognitive.text-embedding", "memory"]);
    expect(ensemble.candidates("text-embedding").map((c) => c.id)).toEqual(MEMORY_MODELS.map((m) => m.id));
    await ensemble.embed([{ kind: "query", text: "x" }]);
    expect(loaded).toEqual(["google/embeddinggemma-300m"]);
    uninstall();
    expect(offered.size).toBe(0);
  });

  it("MX1.2 remember and recall are served through the cognitive invoke operation", async () => {
    const { ensemble, extension } = setup();
    ensemble.install(extension);
    expect(await invokeCognitive(ensemble, "memory.remember", { items: [{ text: "the vault key rotates monthly", sessionId: "s1" }, { text: "bananas are yellow" }] })).toEqual({ ids: ["m1", "m2"] });
    const recalled = (await invokeCognitive(ensemble, "memory.recall", { query: "vault key", limit: 1, minScore: 0.2 })) as { memories: { id: string; sessionId?: string }[] };
    expect(recalled.memories).toMatchObject([{ id: "m1", text: "the vault key rotates monthly", sessionId: "s1" }]);
  });

  it("MX1.3 malformed input is refused before anything is embedded, naming the field", async () => {
    const { ensemble, extension, loaded } = setup();
    ensemble.install(extension);
    await expect(invokeCognitive(ensemble, "memory.remember", { items: [{ text: 5 }] })).rejects.toThrow(/at items\[0\]\.text/);
    await expect(invokeCognitive(ensemble, "memory.recall", { query: "x", limit: 0 })).rejects.toThrow(/at limit/);
    await expect(invokeCognitive(ensemble, "memory.recall", {})).rejects.toThrow(/at query/);
    expect(loaded).toEqual([]);
  });
});
