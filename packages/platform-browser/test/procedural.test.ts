import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { bytes, Ensemble, invokeCognitive } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { parseWorkflow } from "@harness/workflows";
import { scriptedModel } from "@harness/testkit";
import { FORMAT, GraphIdSchema, parseCompositionSettings, parseGraph, parseSettings, revisionId, seedGraph, sha256Hex } from "@harness/procedural";
import type { ApprovalNotice } from "@harness/procedural";
import { browserComposition, browserProcedural, IndexedDbStorage, IndexedDbWorkflows } from "@harness/platform-browser";

const require = createRequire(import.meta.url);
const settings = parseSettings(JSON.parse(readFileSync(require.resolve("@harness/procedural/data/settings.json"), "utf8")));
const composition = parseCompositionSettings(JSON.parse(readFileSync(require.resolve("@harness/procedural/data/composition.json"), "utf8")));

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

  it("PX2.97 composition in the browser: dream stages in an IndexedDB database of its own, never the shared workflow library's (which may not be the same one), and runs staged workflows on QuickJS", async () => {
    const factory = new IDBFactory();
    const ensemble = new Ensemble({ platform: "browser" });
    const next = tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => 7 });
    const c = browserComposition(ensemble, { settings: composition, step: { core: async () => undefined }, base: () => ({ next }), factory });
    const w = parseWorkflow({ name: "call-next", description: "Calls next.", inputs: { type: "object" }, code: "return await tools.next({});" });
    await c.staging.library.stage(w);
    expect(await c.staging.host({ next }).run("call-next", {}, "tool/c1")).toMatchObject({ status: "completed", output: 7 });
    expect(await new IndexedDbWorkflows({ factory, name: "harness-procedural-staging" }).get("call-next")).toEqual(w);
    expect(await new IndexedDbWorkflows({ factory }).list()).toEqual([]);
    expect(() => browserComposition(ensemble, { settings: composition, step: { core: async () => undefined }, factory, shared: "harness-procedural-staging" })).toThrow(
      "the shared workflow library (harness-procedural-staging) cannot be procedural's staging library",
    );
    // Its own database name, when the page gives one; the session tools are dream's catalog and specs.
    const named = browserComposition(ensemble, { settings: composition, step: { core: async () => undefined }, base: () => ({ next }), factory, name: "staged", shared: "harness-workflows", codeMode: async () => "ran elsewhere" });
    await named.staging.library.stage(w);
    expect(await named.staging.host({ next }).run("call-next", {}, "tool/c2")).toMatchObject({ status: "completed", output: "ran elsewhere" });
    expect(await new IndexedDbWorkflows({ factory, name: "staged" }).get("call-next")).toEqual(w);
    expect(await named.catalog()).toEqual(["next"]);
    expect(await named.composer()).toMatchObject({ settings: composition, toolSpecs: { next: { inputSchema: { type: "object" } } } });
  });

  it("PX2.98 a page's sessions get their base tools plus the workflows their pinned core binds, and a workflow's questions go to the ensemble's model", async () => {
    const ensemble = new Ensemble({ platform: "browser" });
    const asked: string[] = [];
    const generator = scriptedModel((o) => (asked.push(JSON.stringify(o.prompt)), "because"));
    ensemble.register({ id: "g", name: "g", publisher: "t", tasks: ["chat"], ports: ["generator"], locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["browser"], license: "MIT", downloadBytes: bytes(1), benchmarks: [] } as ModelDescriptor, async () => ({ generator }));
    const w = parseWorkflow({ name: "ask-once", description: "Asks.", inputs: { type: "object" }, code: "return await tools.ask({ prompt: 'why?' });" });
    const core = parseGraph({
      format: FORMAT,
      nodeTypes: ["ACTION", "REASONING", "STATUS"],
      relations: ["LEADS_TO"],
      nodes: [
        { id: "Start", type: "STATUS", description: "The task begins." },
        { id: "ask-once", type: "ACTION", description: "Asks.", binding: { kind: "workflow", name: "ask-once", code: sha256Hex(w.code) } },
        { id: "End", type: "STATUS", description: "Done." },
      ],
      edges: [
        { from: "Start", relation: "LEADS_TO", to: "ask-once", condition: null, guidance: "Ask.", pitfalls: "" },
        { from: "ask-once", relation: "LEADS_TO", to: "End", condition: null, guidance: "Finish.", pitfalls: "" },
      ],
    });
    if (!core.ok) throw new Error("fixture");
    const c = browserComposition(ensemble, { settings: composition, step: { core: async ({ sessionId }) => (sessionId === "new" ? core.graph : undefined) }, factory: new IDBFactory() });
    await c.staging.library.stage(w);
    const tools = await c.tools({ sessionId: "new", report: () => {} });
    expect(Object.keys(tools)).toEqual(["ask-once"]);
    expect(await tools["ask-once"]!.execute!({}, { toolCallId: "c1", messages: [], context: undefined })).toBe("because");
    expect(asked).toEqual([expect.stringContaining("why?")]);
    expect(await c.tools({ sessionId: "old", report: () => {} })).toEqual({});
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
