import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GraphIdSchema, parseGraph, parseSettings, proceduralExtension, revisionId, seedGraph } from "@harness/procedural";
import type { GraphId, ProceduralAction, ProceduralExtensionOptions } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";
import { proposed, shortcut } from "./overlay-fixtures.ts";
import { FakeStore } from "./store-fake.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));
const clock = { now: () => 5 };
const graph = GraphIdSchema.parse("team/search");
const core = () => {
  const parsed = parseGraph(hotpot());
  if (!parsed.ok) throw new Error("fixture");
  return parsed.graph;
};

function extension(options: Partial<ProceduralExtensionOptions> = {}) {
  const store = options.store ?? new FakeStore();
  const x = proceduralExtension({ store, settings, clock, ...options });
  const op = (name: string, input?: unknown) => x.operations![name]!(input);
  return { x, op, store: store as FakeStore };
}

describe("proceduralExtension", () => {
  it("PX2.28 is a cognitive extension with id procedural, no models, and the seven operations", () => {
    const { x } = extension();
    expect(x.id).toBe("procedural");
    expect(x.models).toEqual([]);
    expect(Object.keys(x.operations!).sort()).toEqual(["dream", "export", "feedback", "graph", "history", "import", "revert"]);
  });

  it("PX2.29 import, graph, export and history work on the store", async () => {
    const { op } = extension();
    expect(await op("import", { graph, document: hotpot() })).toEqual({ status: "head", revision: revisionId(core()) });
    const view = (await op("graph", { graph })) as { status: string; head: string; origin: string; document: unknown; effective: { overlay: number } };
    expect(view).toMatchObject({ status: "ok", head: revisionId(core()), revision: revisionId(core()), origin: "import", document: core() });
    expect(view.effective.overlay).toBe(0);
    expect(await op("export", { graph })).toEqual({ status: "ok", revision: revisionId(core()), text: `${JSON.stringify(core(), null, 2)}\n` });
    expect(await op("export", { graph, format: "json" })).toEqual(await op("export", { graph }));
    expect(await op("export", { graph, format: "mermaid" })).toMatchObject({ status: "ok", text: expect.stringMatching(/^flowchart TD\n/) });
    expect(await op("history", { graph })).toMatchObject({ head: revisionId(core()), heads: [revisionId(core())], revisions: [{ origin: "import", at: 5 }] });
  });

  it("PX2.30 import without a document seeds the skeleton; import onto a head proposes to dream", async () => {
    const { op } = extension();
    expect(await op("import", { graph })).toEqual({ status: "head", revision: revisionId(seedGraph()) });
    expect(await op("import", { graph, document: hotpot() })).toEqual({ status: "proposed", revision: revisionId(core()), head: revisionId(seedGraph()) });
  });

  it("PX2.31 graph and export take a revision and whether to fold the overlay; a missing graph is a value", async () => {
    const { op, store } = extension();
    await op("import", { graph, document: hotpot() });
    await store.overlay(graph).append([proposed(shortcut, ["s1"])]);
    expect(await op("graph", { graph, overlay: false })).toMatchObject({ effective: { overlay: null } });
    expect(await op("graph", { graph, revision: revisionId(core()) })).toMatchObject({ effective: { overlay: 1 } });
    expect(await op("export", { graph, format: "mermaid", overlay: false })).toMatchObject({ text: expect.not.stringContaining("-.->") });
    expect(await op("export", { graph, revision: revisionId(core()), format: "mermaid" })).toMatchObject({ text: expect.stringContaining("-.->") });
    expect(await op("graph", { graph: "none" })).toEqual({ status: "missing", reason: "graph none has no head" });
  });

  it("PX2.32 revert moves the head back and says so", async () => {
    const { op, store } = extension();
    await op("import", { graph });
    const next = revisionId(core());
    await store.revisions.put({ ...store.records.get(revisionId(seedGraph()))!, id: next, document: core() });
    await store.heads.set(graph, revisionId(seedGraph()), next);
    expect(await op("revert", { graph })).toEqual({ status: "reverted", from: next, to: revisionId(seedGraph()) });
    expect(await op("revert", { graph, to: revisionId(seedGraph()) })).toEqual({ status: "refused", reason: `${revisionId(seedGraph())} is already the head of graph team/search` });
  });

  it("PX2.33 dream runs the host's dream for the graph; without one it is unavailable", async () => {
    const dream = vi.fn(async (g: GraphId) => ({ rounds: 1, graph: g }));
    expect(await extension({ dream }).op("dream", { graph })).toEqual({ status: "done", result: { rounds: 1, graph } });
    expect(dream).toHaveBeenCalledWith(graph);
    expect(await extension().op("dream", { graph })).toEqual({ status: "unavailable", reason: "no dream runner is configured" });
  });

  it("PX2.34 feedback scores a session's turn through the live learner, on the graph the session is pinned to", async () => {
    const feedback = vi.fn(async () => undefined);
    const store = new FakeStore();
    await store.pins.set("s1", { graph, core: revisionId(core()), overlay: 0, salt: "x", at: 0 });
    const { op } = extension({ store, feedback });
    expect(await op("feedback", { session: "s1", turn: "t3", score: 0.25 })).toEqual({ status: "recorded", graph });
    expect(feedback).toHaveBeenCalledWith("s1", "t3", 0.25);
    expect(await op("feedback", { session: "s2", turn: "t1", score: 1 })).toEqual({ status: "missing", reason: "session s2 is not pinned to a graph" });
    expect(await extension({ store }).op("feedback", { session: "s1", turn: "t3", score: 1 })).toEqual({ status: "unavailable", reason: "no live learner is configured" });
  });

  it("PX2.35 every operation checks the policy for its action on its graph first; a refusal throws and nothing runs", async () => {
    const asked: [ProceduralAction, string][] = [];
    const dream = vi.fn(async () => ({}));
    const feedback = vi.fn(async () => undefined);
    const store = new FakeStore();
    await store.pins.set("s1", { graph, core: revisionId(core()), overlay: 0, salt: "x", at: 0 });
    const { op } = extension({ store, dream, feedback, authorize: (action, g) => (asked.push([action, g]), false) });
    const calls: [string, unknown, ProceduralAction][] = [
      ["graph", { graph }, "read"],
      ["history", { graph }, "read"],
      ["export", { graph }, "read"],
      ["feedback", { session: "s1", turn: "t", score: 1 }, "write"],
      ["dream", { graph }, "dream"],
      ["revert", { graph }, "revert"],
      ["import", { graph }, "import"],
    ];
    for (const [name, input, action] of calls) {
      await expect(op(name, input)).rejects.toThrow(`procedural.${name}: ${action} on graph team/search is not allowed`);
      expect(asked.at(-1)).toEqual([action, graph]);
    }
    expect(dream).not.toHaveBeenCalled();
    expect(feedback).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
  });

  it("PX2.36 the policy allows by default, and a policy that allows lets the operation run", async () => {
    expect(await extension({ authorize: () => true }).op("import", { graph })).toMatchObject({ status: "head" });
  });

  it("PX2.37 malformed input throws, naming the operation and where", async () => {
    const { op } = extension();
    await expect(op("graph", { graph: "Not A Graph" })).rejects.toThrow(/invalid procedural\.graph input[\s\S]*graph/);
    await expect(op("history")).rejects.toThrow(/invalid procedural\.history input/);
    await expect(op("export", { graph, format: "svg" })).rejects.toThrow(/invalid procedural\.export input[\s\S]*format/);
    await expect(op("feedback", { session: "s", turn: "t", score: 2 })).rejects.toThrow(/invalid procedural\.feedback input[\s\S]*score/);
    await expect(op("revert", { graph, to: "abc" })).rejects.toThrow(/invalid procedural\.revert input[\s\S]*to/);
    await expect(op("import", { graph, extra: 1 })).rejects.toThrow(/invalid procedural\.import input/);
    await expect(op("dream", {})).rejects.toThrow(/invalid procedural\.dream input/);
  });

  it("PX2.38 import checks cycles under the preset's dream policy", async () => {
    const harness = settings.presets.harness;
    const presets = { ...settings.presets, strict: { ...harness, dream: { ...harness.dream, cycles: "forbidden" as const } } };
    const cyclic = hotpot();
    cyclic.edges.push({ from: "Scan_Index", relation: "LEADS_TO", to: "Start", condition: "retry", guidance: "", pitfalls: "" });
    const strict = extension({ settings: { ...settings, presets }, preset: "strict" });
    expect(await strict.op("import", { graph, document: cyclic })).toMatchObject({ status: "invalid", diagnostics: [{ code: "cycle" }] });
    expect(await extension().op("import", { graph, document: cyclic })).toMatchObject({ status: "head" });
    expect(() => extension({ preset: "absent" })).toThrow(RangeError);
  });
});
