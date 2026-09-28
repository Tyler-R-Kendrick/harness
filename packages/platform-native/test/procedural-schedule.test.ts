import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { usage } from "@harness/cognitive";
import { EchoWorker } from "@harness/workers";
import { DreamIdSchema, exclusiveDream, FORMAT, GraphIdSchema, parseGraph, parseSettings, revisionId, RevisionIdSchema, RevisionRecordSchema, sha256Hex } from "@harness/procedural";
import type { DreamResult, GraphId, ProceduralStore } from "@harness/procedural";
import { loadProceduralSettings, nativeDream, nativeDreamSchedule, NodeHost, proceduralStore } from "@harness/platform-native";

const settings = loadProceduralSettings();
const graph = GraphIdSchema.parse("team/search");
const parsed = parseGraph({
  format: FORMAT,
  nodeTypes: ["ACTION", "REASONING", "STATUS"],
  relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
  nodes: [
    { id: "Start", type: "STATUS", description: "The task begins." },
    { id: "search", type: "ACTION", description: "Search the index." },
    { id: "End", type: "STATUS", description: "Answered." },
  ],
  edges: [
    { from: "Start", relation: "LEADS_TO", to: "search", condition: null, guidance: "Search the index before anything else.", pitfalls: "" },
    { from: "search", relation: "LEADS_TO", to: "End", condition: null, guidance: "Answer.", pitfalls: "" },
  ],
});
if (!parsed.ok) throw new Error("fixture");
const seed = parsed.graph;

async function seeded(store: ProceduralStore, at: number): Promise<void> {
  await store.revisions.put(RevisionRecordSchema.parse({ id: revisionId(seed), graph, parents: [], document: seed, edits: null, origin: "import", evidence: {}, decision: { kind: "head" }, at }));
  await store.heads.set(graph, undefined, revisionId(seed));
}

/** A refiner that proposes nothing parseable, counting its calls. */
function refiner() {
  const calls: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async () => (calls.push("refine"), { content: [{ type: "text", text: "no edits" }], finishReason: { unified: "stop", raw: undefined }, usage: usage(1, 1), warnings: [] }),
  });
  return { model, calls };
}

const until = async (check: () => Promise<boolean> | boolean): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
};

describe("scheduled dream on the native host", () => {
  it("PX2.66 the host's ticks run the schedule: a graph due under the shipped harness preset dreams once, and the store remembers when", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-schedule-"));
    try {
      const store = proceduralStore(dir);
      // The head was set eight days ago: the harness preset dreams every seven.
      await seeded(store, Date.now() - 8 * 86_400_000);
      const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" }, tickMs: 5 });
      const { model, calls } = refiner();
      const logged: string[] = [];
      const dream = exclusiveDream(nativeDream({ store, settings, model, sessions: async () => [] }));
      const schedule = nativeDreamSchedule({ runtime: host.runtime, store, settings, dream, log: (m) => logged.push(m) });
      await until(() => logged.length > 0);
      expect(logged[0]).toBe("procedural: scheduled dream of team/search (every): done, 3 rounds, head unchanged");
      expect(calls).toHaveLength(3);
      // Not due again for a week: later ticks start nothing.
      await new Promise((r) => setTimeout(r, 50));
      expect(calls).toHaveLength(3);
      expect(logged).toHaveLength(1);
      schedule.close();
      await host.close();
      // A restart reads the last run from the store.
      const reopened = proceduralStore(dir);
      const again = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" }, tickMs: 5 });
      const second = refiner();
      const restarted = nativeDreamSchedule({ runtime: again.runtime, store: reopened, settings, dream: nativeDream({ store: reopened, settings, model: second.model, sessions: async () => [] }) });
      expect(await restarted.schedule.due(graph)).toMatchObject({ due: false });
      await new Promise((r) => setTimeout(r, 50));
      expect(second.calls).toEqual([]);
      restarted.close();
      await again.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("PX2.67 each outcome is logged in a line: a dream another holder runs is busy, a failure says why, and closing stops the ticks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-schedule-"));
    try {
      const store = proceduralStore(dir);
      await seeded(store, 0);
      const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" }, tickMs: 5 });
      const moved = RevisionIdSchema.parse(sha256Hex("moved"));
      const results: DreamResult[] = [
        { status: "busy", graph },
        { status: "lease-lost", dream: DreamIdSchema.parse("d1") },
        { status: "done", dream: DreamIdSchema.parse("d2"), graph, initial: revisionId(seed), head: moved, score: null, rounds: [] },
      ];
      // A second graph whose dream log does not parse: its line says so, with no reason.
      const broken = GraphIdSchema.parse("team/broken");
      await store.heads.set(broken, undefined, revisionId(seed));
      await store.dreams(broken).append([{ kind: "mystery" }]);
      let failures = 1;
      const logged: string[] = [];
      const dream = async (g: GraphId): Promise<DreamResult> => {
        if (failures-- > 0) throw new Error("the model is down");
        return results.shift() ?? { status: "no-head", graph: g };
      };
      // Due at every tick: a schedule of one millisecond (a number is milliseconds already).
      const harness = settings.presets["harness"]!;
      const often = parseSettings({ ...settings, presets: { ...settings.presets, harness: { ...harness, dream: { ...harness.dream, every: 1 } } } });
      const schedule = nativeDreamSchedule({ runtime: host.runtime, store, settings: often, dream, log: (m) => logged.push(m) });
      await until(() => logged.filter((l) => l.includes("team/search")).length >= 4);
      schedule.close();
      await new Promise((r) => setTimeout(r, 30));
      const count = logged.length;
      await new Promise((r) => setTimeout(r, 30));
      expect(logged).toHaveLength(count);
      expect(logged.filter((l) => l.includes("team/search")).slice(0, 4)).toEqual([
        "procedural: scheduled dream of team/search (every) failed: the model is down",
        "procedural: scheduled dream of team/search (every): busy",
        "procedural: scheduled dream of team/search (every): lease-lost",
        `procedural: scheduled dream of team/search (every): done, 0 rounds, head now ${moved.slice(0, 12)}`,
      ]);
      expect(logged.find((l) => l.includes("team/broken"))).toMatch(/^procedural: scheduled dream of team\/broken failed: /);
      await host.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
