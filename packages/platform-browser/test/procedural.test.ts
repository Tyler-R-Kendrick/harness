import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { Ensemble, invokeCognitive } from "@harness/cognitive";
import { GraphIdSchema, parseSettings, revisionId, seedGraph } from "@harness/procedural";
import { browserProcedural, IndexedDbStorage } from "@harness/platform-browser";

const require = createRequire(import.meta.url);
const settings = parseSettings(JSON.parse(readFileSync(require.resolve("@harness/procedural/data/settings.json"), "utf8")));

describe("procedural graphs in the browser host", () => {
  it("PX2.49 the ensemble serves procedural.* over a store in IndexedDB, which a later page reads back", async () => {
    const factory = new IDBFactory();
    const storage = () => new IndexedDbStorage({ factory, key: "procedural" });
    const first = new Ensemble({ platform: "browser" });
    browserProcedural(first, { storage: storage(), settings });
    expect(first.extensions()).toEqual(["procedural"]);
    expect(await invokeCognitive(first, "procedural.import", { graph: "g" })).toEqual({ status: "head", revision: revisionId(seedGraph()) });
    const second = new Ensemble({ platform: "browser" });
    const store = browserProcedural(second, { storage: storage(), settings, authorize: (action) => action !== "import" });
    expect(await invokeCognitive(second, "procedural.export", { graph: "g", format: "mermaid" })).toMatchObject({ status: "ok", text: expect.stringMatching(/^flowchart TD\n/) });
    await expect(invokeCognitive(second, "procedural.import", { graph: "g" })).rejects.toThrow("import on graph g is not allowed");
    expect(await store.heads.get(GraphIdSchema.parse("g"))).toEqual({ revision: revisionId(seedGraph()), history: [] });
  });
});
