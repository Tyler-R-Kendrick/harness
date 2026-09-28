import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { Ensemble, invokeCognitive } from "@harness/cognitive";
import { FORMAT, GraphIdSchema, parseSettings, revisionId, seedGraph } from "@harness/procedural";
import type { ApprovalNotice } from "@harness/procedural";
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

  it("PX2.83 the page's approvals inbox: an import proposal is announced through notify, and procedural.approve commits it", async () => {
    const notices: ApprovalNotice[] = [];
    const ensemble = new Ensemble({ platform: "browser" });
    const store = browserProcedural(ensemble, { storage: new IndexedDbStorage({ factory: new IDBFactory(), key: "procedural" }), settings, notify: (n) => void notices.push(n) });
    await invokeCognitive(ensemble, "procedural.import", { graph: "g" });
    const expert = {
      format: FORMAT,
      nodeTypes: ["ACTION", "REASONING", "STATUS"],
      relations: ["LEADS_TO"],
      nodes: [
        { id: "Start", type: "STATUS", description: "The task begins." },
        { id: "End", type: "STATUS", description: "Done." },
      ],
      edges: [{ from: "Start", relation: "LEADS_TO", to: "End", condition: null, guidance: "Finish.", pitfalls: "" }],
    };
    const { revision } = (await invokeCognitive(ensemble, "procedural.import", { graph: "g", document: expert })) as { revision: string };
    expect(notices.map((n) => n.type)).toEqual(["procedural.approval.requested"]);
    expect(await invokeCognitive(ensemble, "procedural.approve", { candidate: revision })).toMatchObject({ status: "committed", revision });
    expect(notices.map((n) => n.type)).toEqual(["procedural.approval.requested", "procedural.approval.decided"]);
    expect((await store.heads.get(GraphIdSchema.parse("g")))?.revision).toBe(revision);
  });
});
