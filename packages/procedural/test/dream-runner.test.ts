import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { usage } from "@harness/cognitive";
import { ManualClock, MemoryStorage, SeededEntropy } from "@harness/testkit";
import { DEFAULT_SELECT, DreamIdSchema, foldAll, MemoryProceduralStore, ScoredTrajectorySchema, SnapshotProceduralStore, modelRefiner, presetOf, revisionId, RevisionRecordSchema, runDream } from "@harness/procedural";
import type { ProceduralStore, DreamPorts, DreamRefineRequest, Evaluator, OverlayEvent, Preset, ProceduralGraph, RefineResult, ScoredTrajectory } from "@harness/procedural";
import { addVerify, core, edits, GRAPH, graphOf, renameGuidance, settings, toGhost } from "./dream-fixtures.ts";
import { hotpot } from "./fixtures.ts";
import { FakeStore } from "./dream-store.ts";
import { observed, proposed, status, idOf } from "./overlay-fixtures.ts";

const G0 = core();
const G0_ID = revisionId(G0);
const paper = presetOf(settings, "paper");
const harness = presetOf(settings, "harness");

function seeded(): FakeStore {
  const store = new FakeStore();
  const seed = RevisionRecordSchema.parse({ id: G0_ID, graph: GRAPH, parents: [], document: G0, edits: null, origin: "seed", evidence: {}, decision: { kind: "head" }, at: 0 });
  store.records.set(G0_ID, seed);
  store.headOf.set(GRAPH, { revision: G0_ID, history: [] });
  return store;
}

/** An evaluator whose validation score is a function of the graph (by node count), counting its calls. */
function evaluator(score: (g: ProceduralGraph) => number, train = ["t0", "t1", "t2"]): Evaluator & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async tasks(split) {
      return split === "train" ? train : ["v0", "v1"];
    },
    async evaluate(graph, split, batch) {
      calls.push(`${split}:${revisionId(graph).slice(0, 6)}:${batch?.join(",") ?? "all"}`);
      if (split === "validation") return ["v0", "v1"].map((task) => ({ task, score: score(graph) }));
      return (batch ?? train).map((task) => ({ task, score: 0.5, query: `q ${task}`, steps: [{ role: "tool" as const, content: `obs ${task}` }] }));
    },
  };
}

/** A refiner that answers from a script, one per call, counting its calls. */
function refiner(script: (RefineResult | Error)[]): DreamPorts["refiner"] & { requests: DreamRefineRequest[] } {
  const requests: DreamRefineRequest[] = [];
  return {
    requests,
    async refine(request) {
      requests.push(request);
      const next = script[requests.length - 1] ?? { error: "no more script", raw: "" };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const ports = (over: Partial<DreamPorts>): DreamPorts => ({
  refiner: refiner([]),
  trajectories: { select: async () => [] },
  clock: new ManualClock(1000),
  entropy: new SeededEntropy(7),
  ...over,
});
const withRounds = (preset: Preset, rounds: number): Preset => ({ ...preset, dream: { ...preset.dream, rounds } });

describe("runDream", () => {
  it("PD2.1 runs the paper preset through the store: S₀ once, rollouts, commit by compare-and-set, every event logged", async () => {
    const store = seeded();
    const ev = evaluator((g) => (g.nodes.length > 5 ? 1 : 0.5));
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(paper, 2), ports: ports({ evaluator: ev, refiner: refiner([{ edits: addVerify, raw: "{}" }, { edits: toGhost, raw: "{}" }]) }), stride: 2, task: "Answer." });
    expect(result.status).toBe("done");
    if (result.status !== "done") return;
    const head = store.headOf.get(GRAPH)!;
    expect(result.head).toBe(head.revision);
    expect(head.history).toEqual([G0_ID]);
    expect(result.rounds.map((r) => r.outcome)).toEqual(["committed", "rejected"]);
    expect(ev.calls.filter((c) => c.startsWith("validation")).length).toBe(2);
    expect(ev.calls[0]).toBe(`validation:${G0_ID.slice(0, 6)}:all`);
    expect(ev.calls[1]).toBe(`train:${G0_ID.slice(0, 6)}:t0,t1`);
    expect(ev.calls.at(-1)).toBe(`train:${head.revision.slice(0, 6)}:t2,t0`);
    expect(store.records.get(head.revision)).toMatchObject({ origin: "dream", decision: { kind: "head" }, parents: [G0_ID] });
    expect([...store.records.values()].filter((r) => r.decision.kind === "rejected-structure")).toHaveLength(1);
    const log = store.dreamLog.get(GRAPH)!;
    expect(log[0]).toMatchObject({ kind: "started", head: G0_ID, overlay: 0, rejections: [], train: ["t0", "t1", "t2"], stride: 2 });
    expect(log.slice(1).map((e) => (e as { event: { kind: string } }).event.kind)).toEqual(["evaluated", "rolled-out", "refined", "evaluated", "committed", "rolled-out", "refined", "recorded"]);
    expect(store.leases.get(GRAPH)).toEqual({ holder: null, epoch: 1 });
  });

  it("PD2.2 a dream does not start while another holder has the graph's lease", async () => {
    const store = seeded();
    await store.lease.acquire(GRAPH, "someone-else");
    expect(await runDream({ store, graph: GRAPH, settings: paper, ports: ports({}) })).toEqual({ status: "busy", graph: GRAPH });
    expect(store.dreamLog.get(GRAPH) ?? []).toEqual([]);
  });

  it("PD2.3 a graph with no head has nothing to dream about", async () => {
    const store = new FakeStore();
    expect(await runDream({ store, graph: GRAPH, settings: paper, ports: ports({}) })).toEqual({ status: "no-head", graph: GRAPH });
    expect(store.leases.get(GRAPH)?.holder).toBeNull();
  });

  it("PD2.4 after a crash a dream resumes by replay, re-issuing only unfinished commands", async () => {
    const store = seeded();
    const ev = evaluator((g) => (g.nodes.length > 5 ? 1 : 0.5));
    const script: (RefineResult | Error)[] = [{ edits: addVerify, raw: "{}" }, new Error("crash"), { edits: renameGuidance("Go."), raw: "{}" }];
    const r = refiner(script);
    const settings2 = withRounds(paper, 2);
    await expect(runDream({ store, graph: GRAPH, settings: settings2, ports: ports({ evaluator: ev, refiner: r }), stride: 2 })).rejects.toThrow("crash");
    const before = [...ev.calls];
    // A new process: the lease is still held by the same holder, which may take it again.
    const result = await runDream({ store, graph: GRAPH, settings: settings2, ports: ports({ evaluator: ev, refiner: r }), stride: 2 });
    expect(result.status).toBe("done");
    // Only the unfinished refine was re-issued: no second S₀, no second rollout.
    expect(ev.calls.slice(before.length).filter((c) => c.startsWith("train"))).toEqual([]);
    expect(ev.calls.filter((c) => c === `validation:${G0_ID.slice(0, 6)}:all`)).toHaveLength(1);
    expect(r.requests).toHaveLength(3);
    const started = store.dreamLog.get(GRAPH)!.filter((e) => (e as { kind: string }).kind === "started");
    expect(started).toHaveLength(1);
  });

  it("PD2.5 a commit whose event was lost in a crash is re-issued and finds the head already moved", async () => {
    const store = seeded();
    let crash = true;
    store.beforeDreamAppend = (events) => {
      const [e] = events as { kind: string; event?: { kind: string } }[];
      if (crash && e?.event?.kind === "committed") {
        crash = false;
        throw new Error("crash after commit");
      }
    };
    const ev = evaluator((g) => (g.nodes.length > 5 ? 1 : 0.5));
    const script = [{ edits: addVerify, raw: "{}" }];
    await expect(runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev, refiner: refiner(script) }), stride: 2 })).rejects.toThrow("crash after commit");
    const moved = store.headOf.get(GRAPH)!;
    expect(moved.history).toEqual([G0_ID]);
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev, refiner: refiner(script) }), stride: 2 });
    expect(result).toMatchObject({ status: "done", head: moved.revision, rounds: [{ outcome: "committed" }] });
    expect(store.headOf.get(GRAPH)).toEqual(moved);
  });

  it("PD2.6 a stale epoch cannot commit: a dream that lost its lease stops before writing", async () => {
    const store = seeded();
    const ev = evaluator((g) => (g.nodes.length > 5 ? 1 : 0.5));
    const takeover: DreamPorts["refiner"] = {
      async refine() {
        await store.lease.acquire(GRAPH, "dream");
        return { edits: addVerify, raw: "{}" };
      },
    };
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev, refiner: takeover }), stride: 2 });
    expect(result).toMatchObject({ status: "lease-lost" });
    expect(store.headOf.get(GRAPH)).toEqual({ revision: G0_ID, history: [] });
    expect(store.dreamLog.get(GRAPH)!.map((e) => (e as { event?: { kind: string } }).event?.kind)).toEqual([undefined, "evaluated", "rolled-out"]);
  });

  it("PD2.7 without an evaluator a dream selects trajectories, and a commit rebases the overlay once", async () => {
    const store = seeded();
    const shortcut = { kind: "edge", from: "Scan_Index", relation: "LEADS_TO", to: "End", condition: null, guidance: "Answer directly.", pitfalls: "" };
    const events: OverlayEvent[] = [proposed(shortcut, ["a", "b", "c"]), status(idOf(shortcut), "active"), observed("x/1", ["Start", "First_Hop_Retrieve"], 1)];
    store.overlayLog.set(GRAPH, [...events]);
    const selects: unknown[] = [];
    const trajectory: ScoredTrajectory = ScoredTrajectorySchema.parse({ id: "tr", graph: GRAPH, core: G0_ID, overlay: 3, session: "s", turn: "t", query: "q", steps: [], score: 1, scoreSource: "metric", localization: { matched: 0, fallback: 0, inert: 0 }, usage: { steps: 0, inputTokens: 0, outputTokens: 0, guidanceTokens: 0 } });
    const absorb = edits({ add_edges: [{ source: "Scan_Index", target: "End", relation: "LEADS_TO", condition: null, guidance: "Answer directly.", pitfalls: "" }] });
    let crash = true;
    store.beforeDreamAppend = (appended) => {
      const [e] = appended as { event?: { kind: string } }[];
      if (crash && e?.event?.kind === "rebased") {
        crash = false;
        throw new Error("crash after rebase");
      }
    };
    const run = () =>
      runDream({
        store,
        graph: GRAPH,
        settings: withRounds(harness, 1),
        ports: ports({ refiner: refiner([{ edits: absorb, raw: "{}" }]), trajectories: { select: async (request) => (selects.push(request), [trajectory]) } }),
        tools: ["first_hop_retrieve", "Scan_Index"],
      });
    await expect(run()).rejects.toThrow("crash after rebase");
    const result = await run();
    expect(result.status).toBe("done");
    expect(selects).toEqual([{ graph: GRAPH, revision: G0_ID, limit: 20 }]);
    const overlay = store.overlayLog.get(GRAPH)!;
    expect(overlay.filter((e) => e.kind === "rebased")).toHaveLength(1);
    const head = store.headOf.get(GRAPH)!.revision;
    expect(overlay.at(-1)).toEqual({ kind: "rebased", core: head, absorbed: [idOf(shortcut)], dropped: [], frozenAt: 3 });
    expect(foldAll(G0_ID, overlay).entries[idOf(shortcut)]?.status).toBe("retired");
  });

  it("PD2.8 the approver port decides candidates that route into side-effecting tools", async () => {
    const store = seeded();
    const seen: unknown[] = [];
    const toTool = edits({ add_edges: [{ source: "Bridge_Extract", target: "First_Hop_Retrieve", relation: "LEADS_TO", condition: null, guidance: "Again.", pitfalls: "" }] });
    const evidence = Array.from({ length: 3 }, (_, i) => observed(`s${i}/t`, ["Bridge_Extract", "First_Hop_Retrieve"], null));
    store.overlayLog.set(GRAPH, evidence);
    const result = await runDream({
      store,
      graph: GRAPH,
      settings: withRounds(harness, 1),
      ports: ports({ refiner: refiner([{ edits: toTool, raw: "{}" }]), approver: { approve: async (request) => (seen.push(request), false) } }),
      tools: ["first_hop_retrieve", "Scan_Index"],
    });
    expect(result).toMatchObject({ status: "done", rounds: [{ outcome: "rejected", gate: "approval-for-side-effects", reason: "declined by the approver" }] });
    expect(seen).toEqual([{ graph: GRAPH, candidate: expect.objectContaining({ decision: { kind: "pending-approval" } }), tools: ["first_hop_retrieve"] }]);
    expect(store.headOf.get(GRAPH)!.revision).toBe(G0_ID);
  });

  it("PD2.9 when another writer moves the head, the commit fails, its record is marked rejected and the dream ends", async () => {
    const store = seeded();
    store.beforeHeadSet = () => {
      store.headOf.set(GRAPH, { revision: revisionId(renamed()), history: [G0_ID] });
    };
    const ev = evaluator(() => 1);
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(paper, 3), ports: ports({ evaluator: ev, refiner: refiner([{ edits: addVerify, raw: "{}" }]) }), stride: 2 });
    expect(result).toMatchObject({ status: "done", head: G0_ID, rounds: [{ round: 1, outcome: "conflict" }] });
    const candidate = (result as { rounds: { revision: string }[] }).rounds[0]!.revision;
    expect(store.records.get(candidate as never)?.decision).toEqual({ kind: "rejected-gate", gate: "head", reason: "the head moved during the dream" });
  });

  it("PD2.10 a finished dream is not resumed: the next run starts a new dream with a fresh id", async () => {
    const store = seeded();
    const ev = evaluator(() => 0.5);
    await runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev }), stride: 2 });
    const second = await runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev, entropy: new SeededEntropy(8) }), stride: 2 });
    const started = store.dreamLog.get(GRAPH)!.filter((e) => (e as { kind: string }).kind === "started") as { dream: string }[];
    expect(started).toHaveLength(2);
    expect(started[0]!.dream).not.toBe(started[1]!.dream);
    expect(started.every((s) => /^[0-9a-f]{16}$/.test(s.dream))).toBe(true);
    expect(second).toMatchObject({ status: "done", dream: started[1]!.dream });
    const named = await runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev }), stride: 2, dream: DreamIdSchema.parse("nightly-1") });
    expect(named).toMatchObject({ dream: "nightly-1" });
  });

  it("PD2.11 a corrupt dream log refuses to replay, and an evaluator's out-of-range score is refused", async () => {
    const corrupt = seeded();
    corrupt.dreamLog.set(GRAPH, [{ kind: "started", dream: "" }]);
    await expect(runDream({ store: corrupt, graph: GRAPH, settings: paper, ports: ports({}) })).rejects.toThrow();
    const store = seeded();
    await expect(runDream({ store, graph: GRAPH, settings: paper, ports: ports({ evaluator: evaluator(() => 1.5) }) })).rejects.toThrow();
  });

  it("PD2.12 the harness remembers rejections across dreams; the paper preset starts each dream with none", async () => {
    const store = seeded();
    const rejected = RevisionRecordSchema.parse({ id: revisionId(renamed()), graph: GRAPH, parents: [G0_ID], document: renamed(), edits: null, origin: "dream", evidence: {}, decision: { kind: "rejected-gate", gate: "evidence", reason: "old" }, at: 1 });
    store.records.set(rejected.id, rejected);
    const r = refiner([]);
    await runDream({ store, graph: GRAPH, settings: withRounds(harness, 1), ports: ports({ refiner: r }) });
    expect(store.dreamLog.get(GRAPH)![0]).toMatchObject({ rejections: [rejected.id] });
    expect(r.requests[0]!.rejected).toContain("rejected by evidence");
    const p = seeded();
    p.records.set(rejected.id, rejected);
    const pr = refiner([]);
    await runDream({ store: p, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ refiner: pr, evaluator: evaluator(() => 1) }) });
    expect(pr.requests[0]!.rejected).toBe("None");
  });

  it("PD2.13 the default stride covers the training tasks once over the rounds", async () => {
    const store = seeded();
    const ev = evaluator(() => 0.5, ["a", "b", "c", "d", "e"]);
    await runDream({ store, graph: GRAPH, settings: withRounds(paper, 2), ports: ports({ evaluator: ev }) });
    expect(ev.calls.filter((c) => c.startsWith("train")).map((c) => c.split(":")[2])).toEqual(["a,b,c", "d,e,a"]);
  });
});

describe("runDream: inputs and recovery", () => {
  const toTool = edits({ add_edges: [{ source: "Bridge_Extract", target: "First_Hop_Retrieve", relation: "LEADS_TO", condition: null, guidance: "Again.", pitfalls: "" }] });
  const support = () => Array.from({ length: 3 }, (_, i) => observed(`s${i}/t`, ["Bridge_Extract", "First_Hop_Retrieve"], null));

  it("PD2.15 a dream whose starting revision is gone cannot replay", async () => {
    const store = seeded();
    store.dreamLog.set(GRAPH, [{ kind: "started", dream: "d", head: revisionId(renamed()), overlay: 0, rejections: [], train: [], stride: 1 }]);
    await expect(runDream({ store, graph: GRAPH, settings: paper, ports: ports({}) })).rejects.toThrow(`the dream's starting revision ${revisionId(renamed())} is missing or does not parse`);
  });

  it("PD2.16 the refiner gets the task and tools given, or none; declared side-effect-free tools need no approval", async () => {
    const store = seeded();
    store.overlayLog.set(GRAPH, support());
    const r = refiner([{ edits: toTool, raw: "{}" }]);
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(harness, 1), ports: ports({ refiner: r }), sideEffectFree: ["first_hop_retrieve"], tools: ["first_hop_retrieve", "Scan_Index"] });
    expect(result).toMatchObject({ rounds: [{ outcome: "committed" }] });
    expect(r.requests[0]).toMatchObject({ task: "", tools: ["first_hop_retrieve", "Scan_Index"], consolidation: { overlayEntries: "None" } });
    const bare = refiner([]);
    await runDream({ store: seeded(), graph: GRAPH, settings: withRounds(harness, 1), ports: ports({ refiner: bare }) });
    expect(bare.requests[0]).toMatchObject({ task: "", tools: [], consolidation: { overlayEntries: "None", cautionedEdges: "None", rejectionReasons: "None" } });
    const noOverlay = refiner([]);
    await runDream({ store: seeded(), graph: GRAPH, settings: withRounds({ ...harness, overlay: false }, 1), ports: ports({ refiner: noOverlay }) });
    expect(noOverlay.requests[0]!.consolidation).toBeUndefined();
  });

  it("PD2.17 without an approver port a candidate needing approval is rejected", async () => {
    const store = seeded();
    store.overlayLog.set(GRAPH, support());
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(harness, 1), ports: ports({ refiner: refiner([{ edits: toTool, raw: "{}" }]) }), tools: ["first_hop_retrieve", "Scan_Index"] });
    expect(result).toMatchObject({ rounds: [{ outcome: "rejected", reason: "approval needed, and no approver is configured" }] });
    expect(store.dreamLog.get(GRAPH)![0]).toMatchObject({ train: [], stride: DEFAULT_SELECT, overlay: 3 });
  });

  it("PD2.18 only rejected records are remembered", async () => {
    const store = seeded();
    const doc = renamed();
    const structural = RevisionRecordSchema.parse({ id: revisionId(doc), graph: GRAPH, parents: [G0_ID], document: doc, edits: null, origin: "dream", evidence: {}, decision: { kind: "rejected-structure", diagnostics: [] }, at: 1 });
    store.records.set(structural.id, structural);
    await runDream({ store, graph: GRAPH, settings: withRounds(harness, 1), ports: ports({}) });
    expect(store.dreamLog.get(GRAPH)![0]).toMatchObject({ rejections: [structural.id] });
  });

  it("PD2.19 a resumed rebase finds its own event, not an earlier rebase onto another core", async () => {
    const store = seeded();
    const earlier: OverlayEvent = { kind: "rebased", core: G0_ID, absorbed: [], dropped: [], frozenAt: 0 };
    store.overlayLog.set(GRAPH, [earlier]);
    const absorb = edits({ add_edges: [{ source: "Scan_Index", target: "End", relation: "LEADS_TO", condition: null, guidance: "Answer directly.", pitfalls: "" }] });
    let crash = true;
    store.beforeDreamAppend = (appended) => {
      const [e] = appended as { event?: { kind: string } }[];
      if (crash && e?.event?.kind === "rebased") {
        crash = false;
        throw new Error("crash after rebase");
      }
    };
    const run = () => runDream({ store, graph: GRAPH, settings: withRounds({ ...harness, dream: { ...harness.dream, gate: ["structure"] } }, 1), ports: ports({ refiner: refiner([{ edits: absorb, raw: "{}" }]) }), tools: ["first_hop_retrieve", "Scan_Index"] });
    await expect(run()).rejects.toThrow();
    await run();
    const head = store.headOf.get(GRAPH)!.revision;
    const rebases = store.overlayLog.get(GRAPH)!.filter((e) => e.kind === "rebased");
    expect(rebases.map((e) => e.kind === "rebased" && e.core)).toEqual([G0_ID, head]);
    const events = store.dreamLog.get(GRAPH)!.map((e) => (e as { event?: { kind: string; event?: { core: string } } }).event);
    expect(events.at(-1)).toMatchObject({ kind: "rebased", event: { core: head } });
  });

  it("PD2.20 replay applies only the current dream's events", async () => {
    const store = seeded();
    const ev = evaluator(() => 0.5);
    const r = refiner([new Error("crash"), { error: "bad", raw: "" }]);
    await expect(runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev, refiner: r }), stride: 2 })).rejects.toThrow("crash");
    const log = store.dreamLog.get(GRAPH)!;
    // A foreign entry answering the pending refine must be ignored.
    log.push({ kind: "event", dream: "someone-else", event: { command: 2, at: 1, kind: "refined", result: { edits: addVerify, raw: "{}" } } });
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev, refiner: r }), stride: 2 });
    expect(result).toMatchObject({ status: "done", rounds: [{ outcome: "rejected", reason: "malformed: bad" }] });
    expect(r.requests).toHaveLength(2);
  });

  it("PD2.21 a lease lost between commands stops the dream before its next command", async () => {
    const store = seeded();
    let appended = 0;
    store.beforeDreamAppend = () => {
      appended += 1;
      if (appended === 2) void store.lease.acquire(GRAPH, "dream");
    };
    const ev = evaluator(() => 0.5);
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev }), stride: 2 });
    const dream = (store.dreamLog.get(GRAPH)![0] as { dream: string }).dream;
    expect(result).toEqual({ status: "lease-lost", dream });
    expect(ev.calls).toHaveLength(1);
  });
});

describe("runDream on the real stores", () => {
  const stores: [string, () => ProceduralStore][] = [
    ["MemoryProceduralStore", () => new MemoryProceduralStore()],
    ["SnapshotProceduralStore", () => new SnapshotProceduralStore(new MemoryStorage())],
  ];
  for (const [name, make] of stores) {
    it(`PD2.22 ${name}: a crashed dream resumes, commits by compare-and-set and rebases the overlay`, async () => {
      const store = make();
      await store.revisions.put(RevisionRecordSchema.parse({ id: G0_ID, graph: GRAPH, parents: [], document: G0, edits: null, origin: "seed", evidence: {}, decision: { kind: "head" }, at: 0 }));
      expect(await store.heads.set(GRAPH, undefined, G0_ID)).toBe(true);
      const shortcut = { kind: "edge", from: "Scan_Index", relation: "LEADS_TO", to: "End", condition: null, guidance: "Answer directly.", pitfalls: "" };
      await store.overlay(GRAPH).append([proposed(shortcut, ["a", "b", "c"]), status(idOf(shortcut), "active")]);
      const absorb = edits({ add_edges: [{ source: "Scan_Index", target: "End", relation: "LEADS_TO", condition: null, guidance: "Answer directly.", pitfalls: "" }] });
      const r = refiner([new Error("crash"), { edits: absorb, raw: "{}" }]);
      const run = () => runDream({ store, graph: GRAPH, settings: withRounds(harness, 1), ports: ports({ refiner: r }), tools: ["first_hop_retrieve", "Scan_Index"] });
      await expect(run()).rejects.toThrow("crash");
      const result = await run();
      expect(result).toMatchObject({ status: "done", rounds: [{ outcome: "committed" }] });
      const head = await store.heads.get(GRAPH);
      expect(head).toEqual({ revision: (result as { head: string }).head, history: [G0_ID] });
      expect((await store.revisions.get(head!.revision))?.decision).toEqual({ kind: "head" });
      const overlay = (await store.overlay(GRAPH).read(0)).map((e) => e.event);
      expect(overlay.at(-1)).toEqual({ kind: "rebased", core: head!.revision, absorbed: [idOf(shortcut)], dropped: [], frozenAt: 2 });
      expect(await store.lease.acquire(GRAPH, "someone-else")).toBeDefined();
    });
  }
});

describe("modelRefiner", () => {
  const answering = () => {
    const prompts: string[] = [];
    const calls: unknown[] = [];
    const model = new MockLanguageModelV4({
      modelId: "mock-refiner",
      doGenerate: async (options) => {
        calls.push(options);
        prompts.push(JSON.stringify(options.prompt));
        return { content: [{ type: "text", text: JSON.stringify({ add_nodes: [], delete_nodes: [], add_edges: [], delete_edges: [] }) }], finishReason: { unified: "stop", raw: undefined }, usage: usage(1, 1), warnings: [] };
      },
    });
    return { model, prompts, calls };
  };
  const request: DreamRefineRequest = { task: "T", mode: "static_incremental", tools: ["a"], attempts: "A", graphJson: "{}", rejected: "None" };

  it("PD2.14 uses the refiner prompt, or the dream prompt when there is consolidation, with the refiner's decoding", async () => {
    const { model, prompts, calls } = answering();
    const r = modelRefiner({ model, settings });
    expect(await r.refine(request)).toEqual({ edits: { add_nodes: [], delete_nodes: [], add_edges: [], delete_edges: [] }, raw: expect.any(String) });
    expect(prompts[0]).toContain("Previously rejected candidates: None");
    expect(prompts[0]).not.toContain("Consolidation.");
    await r.refine({ ...request, consolidation: { overlayEntries: "OE", cautionedEdges: "CE", rejectionReasons: "RR" } });
    expect(prompts[1]).toContain("Consolidation.");
    expect(prompts[1]).toContain("OE");
    expect(calls[0]).toMatchObject({ maxOutputTokens: settings.decoding.refinerMaxTokens, temperature: settings.decoding.temperature, topK: settings.decoding.topK });
  });
});

function renamed(): ProceduralGraph {
  const doc = hotpot();
  doc.edges[0] = { ...doc.edges[0]!, guidance: "Go." };
  return graphOf(doc);
}
