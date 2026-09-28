import { describe, expect, it } from "vitest";
import { ManualClock, MemoryStorage, SeededEntropy } from "@harness/testkit";
import { DreamSchedule, exclusiveDream, GraphIdSchema, MemoryProceduralStore, presetOf, revisionId, RevisionIdSchema, RevisionRecordSchema, runDream, sha256Hex, SnapshotProceduralStore } from "@harness/procedural";
import type { DreamResult, DreamRun, GraphId, OverlayEvent, Preset, ProceduralStore } from "@harness/procedural";
import { core, GRAPH, settings } from "./dream-fixtures.ts";
import { observed, proposed } from "./overlay-fixtures.ts";

const HOUR = 3_600_000;
const G0 = core();
const G0_ID = revisionId(G0);
const OTHER = GraphIdSchema.parse("team/other");
const harness = presetOf(settings, "harness");
/** A schedule of its own, over the harness preset (one round per dream, to keep logs short). */
const scheduled = (dream: Partial<Preset["dream"]>): Preset => {
  const { every: _every, afterTurns: _turns, ...rest } = harness.dream;
  return { ...harness, dream: { ...rest, rounds: 1, ...dream } };
};

async function seed(store: ProceduralStore, graph: GraphId = GRAPH, at = 0): Promise<void> {
  await store.revisions.put(RevisionRecordSchema.parse({ id: G0_ID, graph, parents: [], document: G0, edits: null, origin: "seed", evidence: {}, decision: { kind: "head" }, at }));
  await store.heads.set(graph, undefined, G0_ID);
}

/** The real runner, with a refiner that proposes nothing parseable; counts its runs. */
function runner(store: ProceduralStore, preset: Preset, clock: ManualClock): DreamRun & { runs: GraphId[] } {
  const runs: GraphId[] = [];
  const run = async (graph: GraphId) => {
    runs.push(graph);
    return runDream({
      store,
      graph,
      settings: preset,
      holder: "host",
      ports: { refiner: { refine: async () => ({ error: "nothing to propose", raw: "" }) }, trajectories: { select: async () => [] }, clock, entropy: new SeededEntropy(3) },
    });
  };
  return Object.assign(run, { runs });
}

const turns = (n: number, from = 0): OverlayEvent[] => Array.from({ length: n }, (_, i) => observed(`s${from + i}/t`, ["Start"], 1));
const rescore = (turnKey: string): OverlayEvent => ({ kind: "observed", turnKey, path: [], unmatched: [], score: 1, exposure: [], rescore: { seq: 1, previous: null, observedAt: 1 } });

async function setup(dream: Partial<Preset["dream"]>, clock = new ManualClock(0)) {
  const store = new MemoryProceduralStore();
  await seed(store);
  const preset = scheduled(dream);
  const run = runner(store, preset, clock);
  const schedule = new DreamSchedule({ store, settings: preset, graphs: () => store.graphs(), dream: run, clock });
  return { store, clock, run, schedule, preset };
}

describe("dream on a schedule", () => {
  it("PD4.1 a preset without a schedule dreams only on demand: a tick reads nothing", async () => {
    let listed = 0;
    const store = new MemoryProceduralStore();
    await seed(store);
    const schedule = new DreamSchedule({ store, settings: scheduled({}), graphs: async () => (listed++, [GRAPH]), dream: runner(store, harness, new ManualClock(0)), clock: new ManualClock(10 ** 12) });
    expect(schedule.enabled).toBe(false);
    expect(await schedule.tick()).toEqual([]);
    expect(listed).toBe(0);
    expect(presetOf(settings, "paper").dream.every).toBeUndefined();
  });

  it("PD4.2 every: due once that long has passed since the head was set, then since the last dream's latest entry", async () => {
    const { store, clock, run, schedule } = await setup({ every: 6 * HOUR }, new ManualClock(HOUR));
    expect(schedule.enabled).toBe(true);
    clock.advance(5 * HOUR - 1);
    expect(await schedule.due(GRAPH)).toMatchObject({ due: false, last: 0 });
    expect(await schedule.tick()).toEqual([]);
    clock.advance(1);
    expect(await schedule.due(GRAPH)).toEqual({ due: true, reason: "every", last: 0, turns: 0, overlay: 0 });
    const [ran] = await schedule.tick();
    expect(ran).toMatchObject({ graph: GRAPH, reason: "every", result: { status: "done" } });
    expect(run.runs).toEqual([GRAPH]);
    // The last dream's entries are stamped at 6h; the next is due 6h later.
    clock.advance(6 * HOUR - 1);
    expect(await schedule.due(GRAPH)).toMatchObject({ due: false, last: 6 * HOUR });
    clock.advance(1);
    expect((await schedule.tick()).map((r) => r.reason)).toEqual(["every"]);
    expect(run.runs).toHaveLength(2);
    expect((await store.dreams(GRAPH).read(0)).filter(({ event }) => (event as { kind: string }).kind === "started")).toHaveLength(2);
  });

  it("PD4.3 afterTurns: due once the learner observed that many turns since the overlay offset the last dream started from; re-observations do not count", async () => {
    const { store, run, schedule } = await setup({ afterTurns: 3 });
    const log = store.overlay(GRAPH);
    await log.append([...turns(2), rescore("s0/t"), rescore("s1/t"), proposed({ kind: "note", on: { from: "Start", to: "First_Hop_Retrieve" }, text: "Be brief." }, ["s0"])]);
    expect(await schedule.due(GRAPH)).toStrictEqual({ due: false, last: 0, turns: 2, overlay: 5 });
    await log.append(turns(1, 2));
    expect(await schedule.due(GRAPH)).toMatchObject({ due: true, reason: "afterTurns", turns: 3 });
    expect(await schedule.tick()).toMatchObject([{ reason: "afterTurns", result: { status: "done" } }]);
    // The dream started from offset 6 (and appended nothing there); turns after it count anew.
    expect(await schedule.due(GRAPH)).toMatchObject({ due: false, turns: 0 });
    await log.append(turns(2, 10));
    expect(await schedule.due(GRAPH)).toMatchObject({ due: false, turns: 2 });
    // A new schedule (a restart) reads the offset from the dream's started entry.
    const restarted = new DreamSchedule({ store, settings: scheduled({ afterTurns: 3 }), graphs: () => store.graphs(), dream: run, clock: new ManualClock(0) });
    expect(await restarted.due(GRAPH)).toMatchObject({ due: false, turns: 2 });
    await log.append(turns(1, 20));
    expect(await schedule.due(GRAPH)).toMatchObject({ due: true, reason: "afterTurns", turns: 3 });
    expect(run.runs).toHaveLength(1);
  });

  it("PD4.4 with both, whichever comes first; a schedule that counts no turns reports none", async () => {
    const { store, clock, schedule } = await setup({ every: HOUR, afterTurns: 2 });
    await store.overlay(GRAPH).append(turns(2));
    expect(await schedule.due(GRAPH)).toMatchObject({ reason: "afterTurns", turns: 2 });
    clock.advance(HOUR);
    expect(await schedule.due(GRAPH)).toMatchObject({ reason: "every" });
    const timed = await setup({ every: HOUR });
    await timed.store.overlay(GRAPH).append(turns(2));
    expect(await timed.schedule.due(GRAPH)).toStrictEqual({ due: false, last: 0, turns: 0, overlay: 2 });
  });

  it("PD4.5 the last run is read from the store, so the schedule survives a restart", async () => {
    const storage = new MemoryStorage();
    const clock = new ManualClock(0);
    const preset = scheduled({ every: HOUR });
    const first = new SnapshotProceduralStore(storage);
    await seed(first);
    clock.advance(HOUR);
    const before = new DreamSchedule({ store: first, settings: preset, graphs: () => first.graphs(), dream: runner(first, preset, clock), clock });
    expect(await before.tick()).toHaveLength(1);
    // A new process, 59 minutes later: nothing is due until an hour after the last dream.
    clock.advance(HOUR - 60_000);
    const reopened = new SnapshotProceduralStore(storage);
    const run = runner(reopened, preset, clock);
    const after = new DreamSchedule({ store: reopened, settings: preset, graphs: () => reopened.graphs(), dream: run, clock });
    expect(await after.due(GRAPH)).toMatchObject({ due: false, last: HOUR });
    expect(await after.tick()).toEqual([]);
    clock.advance(60_000);
    expect(await after.tick()).toMatchObject([{ reason: "every", result: { status: "done" } }]);
    expect(run.runs).toEqual([GRAPH]);
  });

  it("PD4.6 a graph whose dream is running is skipped, and a tick while another is still checking does nothing", async () => {
    const store = new MemoryProceduralStore();
    await seed(store);
    await seed(store, OTHER);
    const clock = new ManualClock(HOUR);
    let release: (r: DreamResult) => void = () => {};
    const calls: GraphId[] = [];
    const dream: DreamRun = (graph) => {
      calls.push(graph);
      return graph === GRAPH ? new Promise((resolve) => (release = resolve)) : Promise.resolve({ status: "no-head", graph });
    };
    const schedule = new DreamSchedule({ store, settings: scheduled({ every: HOUR }), graphs: () => store.graphs(), dream, clock });
    const firstTick = schedule.tick();
    expect(await schedule.tick()).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([GRAPH, OTHER]);
    // An hour on, the other graph dreams again; the running one is skipped.
    clock.advance(HOUR);
    expect(await schedule.tick()).toMatchObject([{ graph: OTHER }]);
    expect(calls).toEqual([GRAPH, OTHER, OTHER]);
    release({ status: "busy", graph: GRAPH });
    expect(await firstTick).toEqual([
      { graph: GRAPH, reason: "every", result: { status: "busy", graph: GRAPH } },
      { graph: OTHER, reason: "every", result: { status: "no-head", graph: OTHER } },
    ]);
    // Ended: the graph is checked again (its start, remembered, is the last run).
    expect(await schedule.due(GRAPH)).toMatchObject({ due: true, last: HOUR });
    const lastTick = schedule.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((g) => g === GRAPH)).toHaveLength(2);
    release({ status: "busy", graph: GRAPH });
    expect(await lastTick).toEqual([{ graph: GRAPH, reason: "every", result: { status: "busy", graph: GRAPH } }]);
  });

  it("PD4.7 a dream that fails is reported, not thrown; one that failed before logging anything waits until it is due again", async () => {
    const store = new MemoryProceduralStore();
    await seed(store);
    await seed(store, OTHER);
    const clock = new ManualClock(HOUR);
    const calls: GraphId[] = [];
    const dream: DreamRun = async (graph) => {
      calls.push(graph);
      if (graph === GRAPH) throw new Error("the evaluator is down");
      throw "not an error";
    };
    const schedule = new DreamSchedule({ store, settings: scheduled({ every: HOUR, afterTurns: 2 }), graphs: () => store.graphs(), dream, clock });
    await store.overlay(OTHER).append(turns(2));
    expect(await schedule.tick()).toEqual([
      { graph: GRAPH, reason: "every", error: "the evaluator is down" },
      { graph: OTHER, reason: "every", error: "not an error" },
    ]);
    expect(await schedule.tick()).toEqual([]);
    await store.overlay(OTHER).append(turns(1, 5));
    expect(await schedule.due(OTHER)).toMatchObject({ due: false, turns: 1, last: HOUR });
    clock.advance(HOUR);
    expect(await schedule.tick()).toHaveLength(2);
    expect(calls).toEqual([GRAPH, OTHER, GRAPH, OTHER]);
  });

  it("PD4.8 a graph with no head is never due, and a dream log that does not parse is reported for its graph alone", async () => {
    const store = new MemoryProceduralStore();
    await seed(store);
    const clock = new ManualClock(10 * HOUR);
    const bare = GraphIdSchema.parse("team/bare");
    const schedule = new DreamSchedule({ store, settings: scheduled({ every: HOUR }), graphs: async () => [bare, OTHER, GRAPH], dream: async (graph) => ({ status: "no-head", graph }), clock });
    await seed(store, OTHER);
    await store.dreams(OTHER).append([{ kind: "mystery" }]);
    expect(await schedule.due(bare)).toEqual({ due: false, last: 0, turns: 0, overlay: 0 });
    // A head whose record is gone counts from the start of time.
    const lost = GraphIdSchema.parse("team/lost");
    await store.heads.set(lost, undefined, RevisionIdSchema.parse(sha256Hex("gone")));
    expect(await schedule.due(lost)).toMatchObject({ due: true, reason: "every", last: 0 });
    const results = await schedule.tick();
    expect(results[0]).toMatchObject({ graph: OTHER });
    expect(results[0]).toHaveProperty("error");
    expect(results[0]).not.toHaveProperty("reason");
    expect(results[1]).toEqual({ graph: GRAPH, reason: "every", result: { status: "no-head", graph: GRAPH } });
  });

  it("PD4.9 the last run is the latest time in the dream log, and a head record's time only before any dream", async () => {
    const store = new MemoryProceduralStore();
    await seed(store, GRAPH, 2 * HOUR);
    const clock = new ManualClock(3 * HOUR);
    const schedule = new DreamSchedule({ store, settings: scheduled({ every: HOUR }), graphs: () => store.graphs(), dream: runner(store, harness, clock), clock });
    expect(await schedule.due(GRAPH)).toMatchObject({ due: true, last: 2 * HOUR });
    // A log written before starts were stamped: its events' times count.
    await store.dreams(GRAPH).append([{ kind: "started", dream: "d", head: G0_ID, overlay: 0, rejections: [], train: [], stride: 1 }]);
    expect(await schedule.due(GRAPH)).toMatchObject({ last: 2 * HOUR });
    await store.dreams(GRAPH).append([{ kind: "event", dream: "d", event: { command: 0, at: 2.5 * HOUR, kind: "selected", trajectories: [] } }]);
    await store.dreams(GRAPH).append([{ kind: "event", dream: "d", event: { command: 0, at: 1.5 * HOUR, kind: "selected", trajectories: [] } }]);
    expect(await schedule.due(GRAPH)).toMatchObject({ due: false, last: 2.5 * HOUR });
    await store.dreams(GRAPH).append([{ kind: "started", dream: "e", head: G0_ID, overlay: 0, rejections: [], train: [], stride: 1, at: 0 }]);
    expect(await schedule.due(GRAPH)).toMatchObject({ last: 2.5 * HOUR });
    const fresh = new DreamSchedule({ store, settings: scheduled({ every: HOUR }), graphs: () => store.graphs(), dream: runner(store, harness, clock), clock });
    expect(await fresh.due(GRAPH)).toMatchObject({ last: 2.5 * HOUR });
  });

  it("PD4.12 the dream log is read incrementally: each check reads only the entries past those read before", async () => {
    const { store, clock, schedule } = await setup({ every: HOUR });
    const reads: number[] = [];
    const dreams = store.dreams.bind(store);
    store.dreams = (graph) => {
      const log = dreams(graph);
      return { ...log, read: (from, limit) => (reads.push(from), log.read(from, limit)) };
    };
    clock.advance(HOUR);
    await schedule.tick();
    const entries = await store.dreams(GRAPH).head();
    reads.length = 0;
    await schedule.due(GRAPH);
    await schedule.due(GRAPH);
    // The tick checked before the dream logged anything; the first check after reads what it logged, the next nothing again.
    expect(reads).toEqual([0, entries]);
  });

  it("PD4.10 exclusiveDream: a graph's second dream in this process is busy while the first runs, leaving its lease alone; others run", async () => {
    const store = new MemoryProceduralStore();
    await seed(store);
    const gates: ((r: DreamResult) => void)[] = [];
    const inner: DreamRun = async (graph) => {
      if (graph === OTHER) return { status: "no-head", graph };
      await store.lease.acquire(graph, "host");
      return new Promise((resolve) => gates.push(resolve));
    };
    const dream = exclusiveDream(inner);
    const first = dream(GRAPH);
    await new Promise((r) => setTimeout(r, 0));
    expect(await dream(GRAPH)).toEqual({ status: "busy", graph: GRAPH });
    expect(await dream(OTHER)).toEqual({ status: "no-head", graph: OTHER });
    expect((await store.document()).leases).toEqual([{ graph: GRAPH, holder: "host", epoch: 1 }]);
    gates[0]!({ status: "no-head", graph: GRAPH });
    expect(await first).toEqual({ status: "no-head", graph: GRAPH });
    const again = dream(GRAPH);
    await new Promise((r) => setTimeout(r, 0));
    expect(gates).toHaveLength(2);
    gates[1]!({ status: "no-head", graph: GRAPH });
    await again;
    const failing = exclusiveDream(async () => {
      throw new Error("down");
    });
    await expect(failing(GRAPH)).rejects.toThrow("down");
    await expect(failing(GRAPH)).rejects.toThrow("down");
  });

  it("PD4.11 a scheduled dream holds the graph's lease: one another holder has is busy and runs nothing", async () => {
    const { store, clock, schedule } = await setup({ every: HOUR });
    await store.lease.acquire(GRAPH, "harness-procedural");
    clock.advance(HOUR);
    expect(await schedule.tick()).toEqual([{ graph: GRAPH, reason: "every", result: { status: "busy", graph: GRAPH } }]);
    expect(await store.dreams(GRAPH).head()).toBe(0);
  });
});
