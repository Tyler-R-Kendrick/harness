import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { usage } from "@harness/cognitive";
import { ManualClock, MemoryStorage, SeededEntropy } from "@harness/testkit";
import { applyEdits, compilePath, DEFAULT_SELECT, DreamIdSchema, DreamLogEntrySchema, foldAll, MemoryProceduralStore, NodeNameSchema, ProceduralGraphSchema, ScoredTrajectorySchema, SnapshotProceduralStore, StagingLibrary, modelRefiner, presetOf, revisionId, RevisionRecordSchema, runDream, workflowBinding } from "@harness/procedural";
import { chain, chainDoc, observed as observedTurn, PATH, RUNS, settings as compositionSettings, SPECS, turn } from "./compose-fixtures.ts";
import type { ProceduralStore, DreamPorts, DreamRefineRequest, Evaluator, OverlayEvent, Preset, ProceduralGraph, RefineResult, RevisionRecord, ScoredTrajectory } from "@harness/procedural";
import { addVerify, core, edits, GRAPH, graphOf, renameGuidance, settings, toGhost } from "./dream-fixtures.ts";
import { edge, hotpot } from "./fixtures.ts";
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

  it("PD2.32 with an approvals inbox and no approver, a candidate needing approval is stored pending-approval and announced, and the dream moves on", async () => {
    const store = seeded();
    store.overlayLog.set(GRAPH, support());
    const announced: unknown[] = [];
    const inbox = { pending: async (request: unknown) => void announced.push(request) };
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(harness, 2), ports: ports({ refiner: refiner([{ edits: toTool, raw: "{}" }, { edits: toTool, raw: "{}" }]), inbox }), tools: ["first_hop_retrieve", "Scan_Index"] });
    const id = revisionId(applyEdits(G0, toTool));
    expect(result).toMatchObject({ status: "done", head: G0_ID, rounds: [{ round: 1, outcome: "pending-approval", revision: id, gate: "approval-for-side-effects" }, { round: 2, outcome: "pending-approval", revision: id }] });
    expect(store.records.get(id)).toMatchObject({ graph: GRAPH, parents: [G0_ID], origin: "dream", decision: { kind: "pending-approval" }, evidence: { approval: { gate: "approval-for-side-effects", tools: ["first_hop_retrieve"] } } });
    // Announced once: round 2 proposed the same candidate, which was already waiting.
    expect(announced).toEqual([{ graph: GRAPH, candidate: store.records.get(id), tools: ["first_hop_retrieve"] }]);
    expect(store.headOf.get(GRAPH)!.revision).toBe(G0_ID);
  });

  it("PD2.33 a proposal never replaces a record that is not a rejection: a head's, or an import already waiting, stays and is not announced again; a rejection is replaced", async () => {
    const id = revisionId(applyEdits(G0, toTool));
    const run = async (existing: RevisionRecord) => {
      const store = seeded();
      store.overlayLog.set(GRAPH, support());
      store.records.set(id, existing);
      const announced: unknown[] = [];
      await runDream({ store, graph: GRAPH, settings: withRounds({ ...harness, dream: { ...harness.dream, rejections: { ...harness.dream.rejections, dedupe: false } } }, 1), ports: ports({ refiner: refiner([{ edits: toTool, raw: "{}" }]), inbox: { pending: async (r) => void announced.push(r) } }), tools: ["first_hop_retrieve", "Scan_Index"] });
      return { record: store.records.get(id), announced };
    };
    const base = { id, graph: GRAPH, parents: [G0_ID], document: applyEdits(G0, toTool), edits: null, evidence: {}, at: 1 };
    const imported = RevisionRecordSchema.parse({ ...base, origin: "import", decision: { kind: "pending-approval" } });
    expect(await run(imported)).toEqual({ record: imported, announced: [] });
    const head = RevisionRecordSchema.parse({ ...base, origin: "dream", decision: { kind: "head" } });
    expect(await run(head)).toEqual({ record: head, announced: [] });
    const rejected = RevisionRecordSchema.parse({ ...base, origin: "dream", decision: { kind: "rejected-gate", gate: "approval", reason: "no" } });
    const replaced = await run(rejected);
    expect(replaced.record).toMatchObject({ decision: { kind: "pending-approval" }, edits: toTool });
    expect(replaced.announced).toHaveLength(1);
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
      expect((await store.revisions.get(GRAPH, head!.revision))?.decision).toEqual({ kind: "head" });
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

describe("runDream: records, stride, tokens and composition", () => {
  /** G₀ with Verify before End, recorded as an earlier head (an import). */
  const verified = () => ProceduralGraphSchema.parse(applyEdits(G0, addVerify));
  const earlierHead = () => RevisionRecordSchema.parse({ id: revisionId(verified()), graph: GRAPH, parents: [], document: verified(), edits: null, origin: "import", evidence: {}, decision: { kind: "head" }, at: 1 });

  it("PD2.22 a rejected candidate equal to an older head keeps that head's record; a rejection replaces an older rejection", async () => {
    const store = seeded();
    store.records.set(earlierHead().id, earlierHead());
    // The paper preset evaluates the candidate lower than G₀, so it is rejected.
    const ev = evaluator((g) => (g.nodes.length > 5 ? 0 : 0.5));
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev, refiner: refiner([{ edits: addVerify, raw: "{}" }]) }), stride: 2 });
    expect(result).toMatchObject({ rounds: [{ outcome: "rejected", revision: earlierHead().id }] });
    expect(store.records.get(earlierHead().id)).toEqual(earlierHead());
    const again = seeded();
    const older = { ...earlierHead(), decision: { kind: "rejected-gate" as const, gate: "g", reason: "older" } };
    again.records.set(older.id, older);
    await runDream({ store: again, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: ev, refiner: refiner([{ edits: addVerify, raw: "{}" }]) }), stride: 2 });
    expect(again.records.get(older.id)?.decision).toMatchObject({ kind: "rejected-gate", gate: "evaluator-at-least-retained" });
  });

  it("PD2.23 a commit that loses the head race restores the record it replaced when that record is not the dream's own", async () => {
    const store = seeded();
    store.records.set(earlierHead().id, earlierHead());
    store.beforeHeadSet = () => store.headOf.set(GRAPH, { revision: revisionId(renamed()), history: [G0_ID] });
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: evaluator(() => 1), refiner: refiner([{ edits: addVerify, raw: "{}" }]) }), stride: 2 });
    expect(result).toMatchObject({ rounds: [{ outcome: "conflict" }] });
    expect(store.records.get(earlierHead().id)).toEqual(earlierHead());
    // A re-issued commit whose record is the dream's own (put before a crash) is marked rejected when the race is lost.
    const again = seeded();
    let calls = 0;
    again.beforeHeadSet = () => {
      calls += 1;
      if (calls === 1) throw new Error("crash before the compare-and-set");
      again.headOf.set(GRAPH, { revision: revisionId(renamed()), history: [G0_ID] });
    };
    const run = () => runDream({ store: again, graph: GRAPH, settings: withRounds(paper, 1), ports: ports({ evaluator: evaluator(() => 1), refiner: refiner([{ edits: addVerify, raw: "{}" }]) }), stride: 2 });
    await expect(run()).rejects.toThrow("crash before the compare-and-set");
    expect(again.records.get(earlierHead().id)?.decision).toEqual({ kind: "head" });
    expect(await run()).toMatchObject({ rounds: [{ outcome: "conflict" }] });
    expect(again.records.get(earlierHead().id)?.decision).toEqual({ kind: "rejected-gate", gate: "head", reason: "the head moved during the dream" });
  });

  it("PD2.24 the stride is dream settings data (a run's option overrides it), and a tokenizer counts the context", async () => {
    const store = seeded();
    const strided: Preset = { ...paper, dream: { ...paper.dream, rounds: 1, stride: 1 } };
    const ev = evaluator(() => 0.5, ["a", "b", "c"]);
    const r = refiner([]);
    const chars = { encode: (text: string) => Array.from(text, (c) => c.codePointAt(0)!), decode: (ids: readonly number[]) => String.fromCodePoint(...ids) };
    await runDream({ store, graph: GRAPH, settings: { ...strided, dream: { ...strided.dream, contextTokens: 5 } }, ports: ports({ evaluator: ev, refiner: r }), tokenizer: chars });
    expect(ev.calls.filter((c) => c.startsWith("train")).map((c) => c.split(":")[2])).toEqual(["a"]);
    expect(store.dreamLog.get(GRAPH)![0]).toMatchObject({ stride: 1 });
    expect(r.requests[0]!.attempts).toBe(": q a");
    const overridden = seeded();
    await runDream({ store: overridden, graph: GRAPH, settings: strided, ports: ports({ evaluator: ev }), stride: 2 });
    expect(overridden.dreamLog.get(GRAPH)![0]).toMatchObject({ stride: 2 });
  });

  it("PD2.30 a dream resumed after a remembered rejection's record is gone runs without it", async () => {
    const store = seeded();
    const gone = revisionId(renamed());
    store.dreamLog.set(GRAPH, [{ kind: "started", dream: "d", head: G0_ID, overlay: 0, rejections: [gone], train: [], stride: 1 }]);
    const r = refiner([]);
    expect(await runDream({ store, graph: GRAPH, settings: withRounds(harness, 1), ports: ports({ refiner: r }) })).toMatchObject({ status: "done", dream: "d" });
    expect(r.requests[0]!.rejected).toBe("None");
  });

  it("PD2.34 a dream's started entry records the clock's time, which a schedule reads; an entry from before it still replays", async () => {
    const store = seeded();
    const clock = new ManualClock(4_200);
    await runDream({ store, graph: GRAPH, settings: withRounds(harness, 1), ports: ports({ clock }) });
    expect(store.dreamLog.get(GRAPH)![0]).toMatchObject({ kind: "started", at: 4_200 });
    expect(DreamLogEntrySchema.parse(store.dreamLog.get(GRAPH)![0])).toMatchObject({ kind: "started", at: 4_200 });
    expect(DreamLogEntrySchema.parse(store.dreamLog.get(GRAPH)![1])).toMatchObject({ kind: "event", event: { at: 4_200 } });
    // PD2.30's entry has no time, as logs written before it do.
    expect(DreamLogEntrySchema.parse({ kind: "started", dream: "d", head: G0_ID, overlay: 0, rejections: [], train: [], stride: 1 })).not.toHaveProperty("at");
    expect(() => DreamLogEntrySchema.parse({ kind: "started", dream: "d", head: G0_ID, overlay: 0, rejections: [], train: [], stride: 1, at: -1 })).toThrow();
  });

  it("PD2.35 a dream that throws releases its lease, so another holder may resume it from the log", async () => {
    const store = seeded();
    await expect(runDream({ store, graph: GRAPH, settings: withRounds(harness, 1), ports: ports({ refiner: refiner([new Error("model down")]) }), holder: "a" })).rejects.toThrow("model down");
    expect(store.leases.get(GRAPH)).toEqual({ holder: null, epoch: 1 });
    const result = await runDream({ store, graph: GRAPH, settings: withRounds(harness, 1), ports: ports({}), holder: "b" });
    expect(result).toMatchObject({ status: "done", rounds: [{ outcome: "rejected" }] });
    expect(store.dreamLog.get(GRAPH)!.filter((e) => (e as { kind: string }).kind === "started")).toHaveLength(1);
    // A throw after the lease was lost leaves the new holder's lease alone.
    const taken = seeded();
    const thief: DreamPorts["refiner"] = {
      async refine() {
        await taken.lease.acquire(GRAPH, "a");
        throw new Error("late");
      },
    };
    await expect(runDream({ store: taken, graph: GRAPH, settings: withRounds(harness, 1), ports: ports({ refiner: thief }), holder: "a" })).rejects.toThrow("late");
    expect(taken.leases.get(GRAPH)).toEqual({ holder: "a", epoch: 2 });
  });

  describe("composition", () => {
    const g = chain();
    const gId = revisionId(g);
    const TOOLS = ["search", "fetch", "summarize", "review"];
    const seededChain = (): FakeStore => {
      const store = new FakeStore();
      store.records.set(gId, RevisionRecordSchema.parse({ id: gId, graph: GRAPH, parents: [], document: g, edits: null, origin: "seed", evidence: {}, decision: { kind: "head" }, at: 0 }));
      store.headOf.set(GRAPH, { revision: gId, history: [] });
      store.overlayLog.set(GRAPH, [observedTurn("s1/t1", [...PATH], 0.9), observedTurn("s2/t1", [...PATH], 0.8), observedTurn("s3/t1", [...PATH, "End"], 1)]);
      return store;
    };
    const runs = { select: async () => [turn(g, "s1", RUNS[0]!), turn(g, "s2", RUNS[1]!)] };
    const composing: Preset = { ...harness, dream: { ...harness.dream, rounds: 1 } };
    const approver = { approve: async () => true };
    const composer = (staging = new StagingLibrary()) => ({ settings: compositionSettings(), toolSpecs: SPECS, staging });

    it("PD2.25 with a composer, a dream ends with a composition round: the path compiles, is staged, and the head binds it", async () => {
      const store = seededChain();
      const staging = new StagingLibrary();
      const result = await runDream({ store, graph: GRAPH, settings: composing, ports: ports({ trajectories: runs, approver, composer: composer(staging) }), tools: TOOLS });
      expect(result).toMatchObject({ status: "done", rounds: [{ round: 1, outcome: "rejected" }, { round: 2, outcome: "committed" }] });
      const head = store.records.get(store.headOf.get(GRAPH)!.revision)!;
      const node = head.document.nodes.find((n) => n.binding?.kind === "workflow")!;
      const staged = await staging.get(node.binding!.name);
      expect(node.binding).toEqual(workflowBinding(staged!));
      expect(head.evidence).toMatchObject({ composition: { path: [...PATH], support: 3 } });
      expect(store.dreamLog.get(GRAPH)!.map((e) => (e as { event?: { kind: string } }).event?.kind)).toContain("composed");
      // Compiling reads DEFAULT_SELECT recorded trajectories under the head, or the composer's `runs`.
      const limits: number[] = [];
      const counted = { select: async ({ limit }: { limit: number }) => (limits.push(limit), runs.select()) };
      await runDream({ store: seededChain(), graph: GRAPH, settings: composing, ports: ports({ trajectories: counted, composer: composer() }), tools: TOOLS, stride: 3 });
      await runDream({ store: seededChain(), graph: GRAPH, settings: composing, ports: ports({ trajectories: counted, composer: { ...composer(), runs: 7 } }), tools: TOOLS, stride: 3 });
      expect(limits).toEqual([3, DEFAULT_SELECT, 3, 7]);
      // Without the settings' `compose`, or without a composer, there is no composition round.
      const off = await runDream({ store: seededChain(), graph: GRAPH, settings: { ...composing, dream: { ...composing.dream, compose: false } }, ports: ports({ trajectories: runs, approver, composer: composer() }), tools: TOOLS });
      expect(off).toMatchObject({ rounds: [{ round: 1 }] });
      const none = await runDream({ store: seededChain(), graph: GRAPH, settings: composing, ports: ports({ trajectories: runs, approver }), tools: TOOLS });
      expect(none).toMatchObject({ rounds: [{ round: 1 }] });
    });

    it("PD2.26 no composition: no qualifying path, or each path fails to compile, compose, stage or is a known rejection, and the reasons say which", async () => {
      const bare = seededChain();
      bare.overlayLog.set(GRAPH, []);
      expect(await runDream({ store: bare, graph: GRAPH, settings: composing, ports: ports({ trajectories: runs, composer: composer() }), tools: TOOLS })).toMatchObject({
        rounds: [{ round: 1 }, { round: 2, outcome: "no-composition", reason: "no path has the support and score to compile" }],
      });
      const noRuns = await runDream({ store: seededChain(), graph: GRAPH, settings: composing, ports: ports({ composer: composer() }), tools: TOOLS });
      expect(noRuns).toMatchObject({ rounds: [{ round: 1 }, { outcome: "no-composition", reason: "search → Fetch_Page → summarize: no recorded runs of the path" }] });
      const conflicting = new StagingLibrary();
      const first = await runDream({ store: seededChain(), graph: GRAPH, settings: composing, ports: ports({ trajectories: runs, composer: composer(conflicting) }), tools: TOOLS });
      expect(first).toMatchObject({ rounds: [{ round: 1 }, { outcome: "rejected", reason: "approval needed, and no approver is configured" }] });
      // The candidate is now a known rejection.
      const known = seededChain();
      for (const [id, r] of (await (async () => {
        const s = seededChain();
        await runDream({ store: s, graph: GRAPH, settings: composing, ports: ports({ trajectories: runs, composer: composer() }), tools: TOOLS });
        return s.records;
      })()).entries()) known.records.set(id, r);
      expect(await runDream({ store: known, graph: GRAPH, settings: composing, ports: ports({ trajectories: runs, composer: composer() }), tools: TOOLS })).toMatchObject({
        rounds: [{ round: 1 }, { outcome: "no-composition", reason: "search → Fetch_Page → summarize: its candidate was rejected before" }],
      });
      // Other runs compile to other code under the same name, which staging refuses.
      const otherRuns = { select: async () => [turn(g, "s1", RUNS[1]!), turn(g, "s3", RUNS[1]!.map((c) => ({ ...c, arguments: { ...c.arguments, extra: 1 } })))] };
      expect(await runDream({ store: seededChain(), graph: GRAPH, settings: composing, ports: ports({ trajectories: otherRuns, composer: composer(conflicting) }), tools: TOOLS })).toMatchObject({
        rounds: [{ round: 1 }, { outcome: "no-composition", reason: expect.stringMatching(/^search → Fetch_Page → summarize: staged workflow [a-z0-9-]+ is immutable/) }],
      });
      // Every path that fails is named, in rank order.
      const two = seededChain();
      two.overlayLog.set(GRAPH, ["a", "b", "c"].flatMap((s) => [observedTurn(`${s}/t1`, ["search", "Fetch_Page"], 0.9), observedTurn(`${s}/t2`, ["Fetch_Page", "summarize"], 0.6)]));
      expect(await runDream({ store: two, graph: GRAPH, settings: composing, ports: ports({ composer: composer() }), tools: TOOLS })).toMatchObject({
        rounds: [{ round: 1 }, { outcome: "no-composition", reason: "search → Fetch_Page: no recorded runs of the path; Fetch_Page → summarize: no recorded runs of the path" }],
      });
      // A staging library that fails for any reason is a reason too.
      const full = { ...composer(), staging: { stage: async () => Promise.reject("the library is full") } };
      expect(await runDream({ store: seededChain(), graph: GRAPH, settings: composing, ports: ports({ trajectories: runs, composer: full }), tools: TOOLS })).toMatchObject({
        rounds: [{ round: 1 }, { outcome: "no-composition", reason: "search → Fetch_Page → summarize: the library is full" }],
      });
      // A core that already has the workflow's node cannot take it again.
      const compiled = compilePath([...PATH].map((n) => NodeNameSchema.parse(n)), RUNS, SPECS);
      if (!compiled.ok) throw new Error(compiled.error);
      const doc = chainDoc();
      doc.nodes.push({ id: compiled.workflow.name, type: "ACTION", description: "Taken." });
      doc.edges.push(edge("Start", compiled.workflow.name));
      const taken = graphOf(doc);
      const store = seededChain();
      store.records.set(revisionId(taken), RevisionRecordSchema.parse({ id: revisionId(taken), graph: GRAPH, parents: [], document: taken, edits: null, origin: "seed", evidence: {}, decision: { kind: "head" }, at: 0 }));
      store.headOf.set(GRAPH, { revision: revisionId(taken), history: [] });
      const tools = { select: async () => [turn(taken, "s1", RUNS[0]!), turn(taken, "s2", RUNS[1]!)] };
      expect(await runDream({ store, graph: GRAPH, settings: composing, ports: ports({ trajectories: tools, composer: composer() }), tools: [...TOOLS, compiled.workflow.name] })).toMatchObject({
        rounds: [{ round: 1 }, { outcome: "no-composition", reason: `search → Fetch_Page → summarize: the core already has a node ${compiled.workflow.name}` }],
      });
    });
  });
});

function renamed(): ProceduralGraph {
  const doc = hotpot();
  doc.edges[0] = { ...doc.edges[0]!, guidance: "Go." };
  return graphOf(doc);
}
