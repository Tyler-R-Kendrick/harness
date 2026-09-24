import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { invokeCognitive } from "@harness/cognitive";
import { buildNativeEnsemble } from "@harness/platform-native";
import { modelCacheDir } from "./models-env.ts";

// Memory on real weights: EmbeddingGemma (pinned, sha256-verified) behind Orama.
describe("memory with EmbeddingGemma, real weights", () => {
  it("MM1.1 recalls the note that answers a question, keeps sessions apart, and survives a restart", async () => {
    let saved: unknown;
    const cacheDir = modelCacheDir;
    const host = buildNativeEnsemble({ cacheDir, allowHosted: false, only: [], memory: { persist: (s) => (saved = s) } });
    await invokeCognitive(host.ensemble, "memory.remember", {
      items: [
        { text: "To change your password, open Settings, choose Security and click Reset password.", sessionId: "support" },
        { text: "Our office is closed on public holidays.", sessionId: "support" },
        { text: "The staging database is backed up every night at 02:00 UTC.", sessionId: "ops" },
      ],
    });
    const recall = async (ensemble: typeof host.ensemble, input: object) => ((await invokeCognitive(ensemble, "memory.recall", input)) as { memories: { text: string; sessionId?: string }[] }).memories;
    expect((await recall(host.ensemble, { query: "How do I reset my password?", limit: 1 }))[0]).toMatchObject({ text: expect.stringContaining("Reset password"), sessionId: "support" });
    expect((await recall(host.ensemble, { query: "When are backups taken?", limit: 1 }))[0]!.text).toContain("backed up");
    expect(await recall(host.ensemble, { query: "When are backups taken?", sessionId: "support", minScore: 0.5 })).toEqual([]);
    const restarted = buildNativeEnsemble({ cacheDir: join(cacheDir), allowHosted: false, only: [], memory: { saved } });
    expect((await recall(restarted.ensemble, { query: "reset my password", limit: 1 }))[0]!.text).toContain("Reset password");
    await Promise.all([host.close(), restarted.close()]);
  });
});
