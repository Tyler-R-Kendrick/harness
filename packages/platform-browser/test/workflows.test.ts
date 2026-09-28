import { IDBFactory } from "fake-indexeddb";
import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { Ensemble, invokeCognitive } from "@harness/cognitive";
import { parseWorkflow, workflowTools } from "@harness/workflows";
import { browserWorkflows, IndexedDbWorkflows } from "@harness/platform-browser";

const count = parseWorkflow({
  name: "count",
  description: "Counts twice.",
  inputs: { type: "object" },
  code: "const a: number = await tools.next({}); const b = await tools.next({}); return [a, b];",
});

describe("workflows in the browser host", () => {
  it("BW1.1 the library keeps workflows in IndexedDB: it lists by name, gets, replaces, and refuses what does not parse", async () => {
    const factory = new IDBFactory();
    const library = new IndexedDbWorkflows({ factory });
    expect(await library.list()).toEqual([]);
    await library.put(count);
    await library.put(parseWorkflow({ ...count, name: "alpha" }));
    await library.put({ ...count, description: "Counts, again." });
    // another connection to the same database sees them
    const again = new IndexedDbWorkflows({ factory });
    expect((await again.list()).map((w) => [w.name, w.description])).toEqual([
      ["alpha", "Counts twice."],
      ["count", "Counts, again."],
    ]);
    expect(await again.get("missing")).toBeUndefined();
    await expect(library.put({ ...count, name: "Not Kebab" })).rejects.toThrow(/invalid workflow/);
    await library.close();
    await again.close();
  });

  it("BW1.2 each run's journal is its own record, kept across connections", async () => {
    const factory = new IDBFactory();
    const library = new IndexedDbWorkflows({ factory });
    await library.journal("run/1").save({ step: 1 });
    await library.journal("run/2").save({ step: 2 });
    const again = new IndexedDbWorkflows({ factory });
    expect(await again.journal("run/1").load()).toEqual({ step: 1 });
    expect(await again.journal("run/2").load()).toEqual({ step: 2 });
    expect(await again.journal("run/3").load()).toBeUndefined();
    await library.close();
    await again.close();
  });

  it("BW1.4 a run forgotten has its journal deleted; forgetting one with none is fine", async () => {
    const factory = new IDBFactory();
    const library = new IndexedDbWorkflows({ factory });
    await library.journal("run/1").save({ step: 1 });
    await library.forget("run/1");
    await library.forget("never");
    expect(await library.journal("run/1").load()).toBeUndefined();
    const host = browserWorkflows(new Ensemble({ platform: "browser" }), { library });
    await library.journal("run/2").save({ step: 2 });
    await host.forget("run/2");
    expect(await library.journal("run/2").load()).toBeUndefined();
    await library.close();
  });

  it("BW1.3 installed on the browser ensemble, workflows run durably on QuickJS: a run that stopped resumes by replay, even from a new connection", async () => {
    const factory = new IDBFactory();
    let calls = 0;
    let down = true;
    const next = tool({
      inputSchema: z.object({}).loose(),
      execute: async () => {
        calls++;
        if (calls === 2 && down) {
          down = false;
          throw new Error("next is down");
        }
        return calls;
      },
    });
    const ensemble = new Ensemble({ platform: "browser" });
    const library = new IndexedDbWorkflows({ factory });
    await library.put(count);
    browserWorkflows(ensemble, { library, tools: { next } });
    await expect(invokeCognitive(ensemble, "workflows.run", { name: "count", run: "r1" })).rejects.toThrow("next is down");
    // the page reloads: a new ensemble and a new connection to the same database
    const reloaded = new Ensemble({ platform: "browser" });
    const host = browserWorkflows(reloaded, { library: new IndexedDbWorkflows({ factory }), tools: { next } });
    expect(await invokeCognitive(reloaded, "workflows.run", { name: "count", run: "r1" })).toEqual({ status: "completed", output: [1, 3], replayed: 1, performed: 1 });
    expect(await invokeCognitive(reloaded, "workflows.list", {})).toEqual({ workflows: [{ name: "count", description: "Counts twice.", inputs: { type: "object" } }] });
    // and they are tools for the page's agents
    expect(Object.keys(await workflowTools(host))).toEqual(["count"]);
    await library.close();
  });
});
