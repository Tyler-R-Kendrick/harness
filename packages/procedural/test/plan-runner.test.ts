import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { MemoryStorage } from "@harness/testkit";
import { GraphIdSchema, importGraph, MemoryProceduralStore, modelTasks, parseSettings, planFromSubgraph, planRunner, PlanRunRecordSchema, readGraph, revisionId, SnapshotPlanRuns } from "@harness/procedural";
import type { TaskGraph } from "@harness/core";
import type { PlanNotice, PlanPayload, PlanRunRecord, PlanRunStore, PlanTask, PlanTaskContext } from "@harness/procedural";
import { chain, chainDoc } from "./compose-fixtures.ts";
import { scripted } from "./task-fixtures.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));
const graph = GraphIdSchema.parse("team/web");
const clock = { now: () => 7 };

/** Entropy that counts: each run id is different and known. */
function counting() {
  let n = 0;
  return { bytes: (length: number) => new Uint8Array(length).fill(++n) };
}

async function seeded() {
  const store = new MemoryProceduralStore();
  await importGraph({ store, graph, document: chainDoc(), clock });
  return store;
}

async function planOf(store: MemoryProceduralStore, from = "Start", to = "End"): Promise<TaskGraph<PlanPayload>> {
  const view = await readGraph({ store, graph });
  if (view.status !== "ok") throw new Error("fixture");
  const built = planFromSubgraph(view.effective, from, to);
  if (!built.ok) throw new Error("fixture");
  return built.plan;
}

/** Plan runs kept in memory, with every write recorded. */
function recording(): PlanRunStore & { writes: string[]; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const runs = new SnapshotPlanRuns(storage);
  const writes: string[] = [];
  return {
    storage,
    writes,
    list: () => runs.list(),
    put: async (record) => {
      writes.push(`put ${record.id} ${(record.state as { plan: { nodes: { status: string }[] } }).plan.nodes.map((n) => n.status).join(",")}`);
      await runs.put(record);
    },
    delete: async (id) => {
      writes.push(`delete ${id}`);
      await runs.delete(id);
    },
  };
}

const echo: PlanTask = async ({ id, inputs }) => ({ ok: true, output: `${id}(${Object.keys(inputs).join(",")})` });

describe("plan runs on a host (planRunner)", () => {
  it("PC1.67 a run is kept from before it starts until it ends, is announced as procedural.plan.completed, and its tasks get the graph's head and effective graph", async () => {
    const store = await seeded();
    const runs = recording();
    const notices: PlanNotice[] = [];
    const contexts: PlanTaskContext[] = [];
    const runner = planRunner({
      store,
      runs,
      settings,
      entropy: counting(),
      task: (context) => {
        contexts.push(context);
        return echo;
      },
      notify: (notice) => void notices.push(notice),
    });
    const outcome = await runner.run(graph, await planOf(store, "search", "summarize"));
    const id = "0101010101010101";
    expect(outcome).toEqual({
      run: id,
      graph,
      status: "succeeded",
      tasks: [
        { id: "search", status: "succeeded", output: "search()" },
        { id: "Fetch_Page", status: "succeeded", output: "Fetch_Page(search)" },
        { id: "summarize", status: "succeeded", output: "summarize()" },
      ],
    });
    expect(runs.writes).toEqual([
      `put ${id} pending,pending,pending`,
      `put ${id} running,pending,pending`,
      `put ${id} succeeded,pending,pending`,
      `put ${id} succeeded,running,pending`,
      `put ${id} succeeded,succeeded,pending`,
      `put ${id} succeeded,succeeded,running`,
      `put ${id} succeeded,succeeded,succeeded`,
      `delete ${id}`,
    ]);
    expect(await runs.list()).toEqual([]);
    expect(notices).toEqual([{ type: "procedural.plan.completed", payload: outcome }]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.graph).toBe(graph);
    expect(contexts[0]!.view?.core).toEqual(chain());
    expect(contexts[0]!.view?.effective.core).toBe(revisionId(chain()));
    // Another run gets another id; a graph with no head gives its tasks no view.
    const other = GraphIdSchema.parse("team/none");
    expect(await runner.run(other, await planOf(store, "search", "search"))).toMatchObject({ run: "0202020202020202", graph: other, status: "succeeded" });
    expect(contexts[1]).toEqual({ graph: other });
  });

  it("PC1.68 resume continues every kept run from its state, as a restarted host does: finished tasks stay finished, and each run is announced and dropped", async () => {
    const store = await seeded();
    const runs = recording();
    const log: string[] = [];
    let crash = true;
    const flaky: PlanTask = async (input) => {
      log.push(input.id);
      if (input.id === "Fetch_Page" && crash) throw new Error("the host went down");
      return echo(input);
    };
    // A save that fails once Fetch_Page has started stands for the host going down there.
    const failing: PlanRunStore = {
      list: () => runs.list(),
      delete: (id) => runs.delete(id),
      put: async (record) => {
        const statuses = (record.state as { plan: { nodes: { status: string }[] } }).plan.nodes.map((n) => n.status).join(",");
        if (statuses === "succeeded,running,pending" && crash) {
          await runs.put(record);
          throw new Error("the host went down");
        }
        await runs.put(record);
      },
    };
    const first = planRunner({ store, runs: failing, settings, entropy: counting(), task: () => flaky });
    await expect(first.run(graph, await planOf(store, "search", "summarize"))).rejects.toThrow("the host went down");
    expect(await runs.list()).toHaveLength(1);
    crash = false;
    log.length = 0;
    const notices: PlanNotice[] = [];
    const restarted = planRunner({ store, runs, settings, entropy: counting(), task: () => flaky, notify: (n) => void notices.push(n) });
    const resumed = await restarted.resume();
    expect(log).toEqual(["Fetch_Page", "summarize"]);
    expect(resumed).toEqual([
      {
        run: "0101010101010101",
        graph,
        status: "succeeded",
        tasks: [
          { id: "search", status: "succeeded", output: "search()" },
          { id: "Fetch_Page", status: "succeeded", output: "Fetch_Page(search)" },
          { id: "summarize", status: "succeeded", output: "summarize()" },
        ],
      },
    ]);
    expect(notices.map((n) => n.payload.run)).toEqual(["0101010101010101"]);
    expect(await runs.list()).toEqual([]);
    expect(await restarted.resume()).toEqual([]);
  });

  it("PC1.69 a kept run whose state does not parse is dropped on resume and reported invalid", async () => {
    const store = await seeded();
    const runs = recording();
    await runs.put(PlanRunRecordSchema.parse({ id: "abababababababab", graph, state: { plan: { nodes: [], edges: [] }, outcomes: { ghost: { ok: true, output: 1 } } } }));
    const runner = planRunner({ store, runs, settings, entropy: counting(), task: () => echo });
    expect(await runner.resume()).toEqual([{ run: "abababababababab", graph, status: "invalid", reason: "task ghost is not in the plan" }]);
    expect(await runs.list()).toEqual([]);
  });

  it("PC1.70 SnapshotPlanRuns keeps runs through a SnapshotStorage: another over the same storage reads them; a saved document that does not parse is refused", async () => {
    const storage = new MemoryStorage();
    const runs = new SnapshotPlanRuns(storage);
    expect(await runs.list()).toEqual([]);
    const record = (id: string, n: number): PlanRunRecord => PlanRunRecordSchema.parse({ id, graph, state: { n } });
    await Promise.all([runs.put(record("0000000000000001", 1)), runs.put(record("0000000000000002", 2)), runs.put(record("0000000000000001", 3))]);
    expect(await new SnapshotPlanRuns(storage).list()).toEqual([record("0000000000000001", 3), record("0000000000000002", 2)]);
    await runs.delete("0000000000000001");
    await runs.delete("0000000000000009");
    expect(await new SnapshotPlanRuns(storage).list()).toEqual([record("0000000000000002", 2)]);
    // A change whose save fails is rejected and forgotten; the next change starts from what was saved.
    let broken = true;
    const flaky = { load: () => storage.load(), save: async (s: unknown) => (broken ? Promise.reject(new Error("disk full")) : storage.save(s)) };
    const kept = new SnapshotPlanRuns(flaky);
    await expect(kept.put(record("0000000000000003", 3))).rejects.toThrow("disk full");
    broken = false;
    expect(await kept.list()).toEqual([record("0000000000000002", 2)]);
    await kept.put(record("0000000000000004", 4));
    expect(await new SnapshotPlanRuns(storage).list()).toEqual([record("0000000000000002", 2), record("0000000000000004", 4)]);
    await storage.save({ runs: [{ id: "not hex", graph, state: {} }] });
    await expect(new SnapshotPlanRuns(storage).list()).rejects.toThrow(/invalid plan runs[\s\S]*runs\[0\]\.id/);
    expect(() => PlanRunRecordSchema.parse({ id: "0000000000000001", graph: "", state: {} })).toThrow();
  });

  it("PC1.71 modelTasks runs each task on the model with the tools given for the graph's view, guided by its effective graph", async () => {
    const store = await seeded();
    const prompts: string[] = [];
    const model = scripted(() => [{ type: "tool-call", toolCallId: "c1", toolName: "fetch", input: JSON.stringify({ url: "u" }) }], prompts);
    const seen: unknown[] = [];
    const tools = (context: PlanTaskContext) => {
      seen.push(context.view?.core.nodes.length);
      return { fetch: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "page" }) };
    };
    const runner = planRunner({ store, runs: recording(), settings, entropy: counting(), task: modelTasks({ model, tools, settings }) });
    const outcome = await runner.run(graph, await planOf(store, "Fetch_Page", "Fetch_Page"));
    expect(outcome.tasks).toEqual([{ id: "Fetch_Page", status: "succeeded", output: "page" }]);
    expect(seen).toEqual([chain().nodes.length]);
    expect(prompts[0]).toContain("Transition: [search]");
    // Tools may be given once, for every graph.
    const fixed = planRunner({ store, runs: recording(), settings, entropy: counting(), task: modelTasks({ model, tools: tools({ graph }), settings }) });
    expect((await fixed.run(graph, await planOf(store, "Fetch_Page", "Fetch_Page"))).status).toBe("succeeded");
    // A graph with no head: its tasks run unguided.
    expect((await fixed.run(GraphIdSchema.parse("team/none"), await planOf(store, "Fetch_Page", "Fetch_Page"))).status).toBe("succeeded");
    expect(prompts.at(-1)).not.toContain("Transition:");
  });
});
