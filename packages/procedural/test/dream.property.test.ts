import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { anchoredNonInferiority, applyEdits, dreamStart, dreamStep, effectiveGraph, entryId, foldAll, OverlayEntrySchema, parseGraph, prepareCandidate, rebaseOverlay, revisionId, tailTokens } from "@harness/procedural";
import type { DreamCommand, DreamEvent, DreamState, EditSet, OverlayEntry, OverlayEvent, OverlayState, ProceduralGraph, RevisionId } from "@harness/procedural";
import { core, edits, harnessDream, harnessLive, input, paperDream } from "./dream-fixtures.ts";

const G0 = core();
const G0_ID = revisionId(G0);

type Answer = { kind: "malformed" } | { kind: "ghost" } | { kind: "empty" } | { kind: "add" };

/** The refiner's answer in round k: a new node N_k on Start → N_k → End, and the failures. */
function editsFor(answer: Answer, round: number): EditSet | undefined {
  switch (answer.kind) {
    case "malformed":
      return undefined;
    case "ghost":
      return edits({ add_edges: [{ source: "Start", target: "Ghost", relation: "LEADS_TO", condition: null, guidance: "g", pitfalls: "" }] });
    case "empty":
      return edits({});
    case "add":
      return edits({
        add_nodes: [{ id: `N${round}`, type: "REASONING", description: `Step ${round}.` }],
        add_edges: [
          { source: "Start", target: `N${round}`, relation: "LEADS_TO", condition: null, guidance: `Go ${round}.`, pitfalls: "" },
          { source: `N${round}`, target: "End", relation: "LEADS_TO", condition: null, guidance: "End.", pitfalls: "" },
        ],
      });
  }
}

interface Trace {
  rollouts: [RevisionId, string[]][];
  refinedFrom: RevisionId[];
  evaluated: RevisionId[];
  head: RevisionId;
  score: number;
  rejected: number;
}

/** Algorithm 1 of App. B.6, written out directly. */
function algorithm1(K: number, train: string[], stride: number, answers: Answer[], validation: number[]): Trace {
  let evals = 0;
  const trace: Trace = { rollouts: [], refinedFrom: [], evaluated: [G0_ID], head: G0_ID, score: validation[evals++]!, rejected: 0 };
  let G: ProceduralGraph = G0;
  for (let k = 1; k <= K; k += 1) {
    const batch = stride >= train.length ? [...train] : Array.from({ length: stride }, (_, j) => train[((k - 1) * stride + j) % train.length]!);
    trace.rollouts.push([revisionId(G), batch]);
    trace.refinedFrom.push(revisionId(G));
    const delta = editsFor(answers[k - 1]!, k);
    if (delta === undefined) {
      trace.rejected += 1;
      continue;
    }
    const doc = applyEdits(G, delta);
    const parsed = parseGraph(doc);
    if (!parsed.ok) {
      trace.rejected += 1;
      continue;
    }
    const sCand = validation[evals++]!;
    trace.evaluated.push(revisionId(parsed.graph));
    if (sCand >= trace.score) {
      G = parsed.graph;
      trace.score = sCand;
      trace.head = revisionId(G);
    } else trace.rejected += 1;
  }
  return trace;
}

type Body = DreamEvent extends infer E ? (E extends DreamEvent ? Omit<E, "command" | "at"> : never) : never;

/** Drives the reducer with the same scripted refiner and evaluator, checking I1 at every step. */
function reducer(K: number, train: string[], stride: number, answers: Answer[], validation: number[]): Trace & { committedIds: RevisionId[]; rejectedIds: (RevisionId | null)[] } {
  let evals = 0;
  let state: DreamState = dreamStart(input({ settings: { ...paperDream, rounds: K }, train, stride }));
  const trace = { rollouts: [] as [RevisionId, string[]][], refinedFrom: [] as RevisionId[], evaluated: [] as RevisionId[], committedIds: [] as RevisionId[] };
  for (let guard = 0; guard < 1000; guard += 1) {
    const command: DreamCommand = state.pending[0]!;
    if (command.kind === "done") {
      expect(command.result.head).toBe(state.retained.revision);
      return { ...trace, head: state.retained.revision, score: state.retained.mean!, rejected: state.rejections.length, rejectedIds: state.rejections.filter((r) => r.id !== r.parent).map((r) => r.id) };
    }
    let body: Body;
    switch (command.kind) {
      case "evaluate":
        trace.evaluated.push(command.revision);
        body = { kind: "evaluated", scores: [{ task: "v", score: validation[evals++]! }], seed: "s" };
        break;
      case "rollout":
        trace.rollouts.push([command.revision, command.batch]);
        body = { kind: "rolled-out", results: command.batch.map((task) => ({ task, score: 0.5 })) };
        break;
      case "refine": {
        trace.refinedFrom.push(state.retained.revision);
        const delta = editsFor(answers[state.round - 1]!, state.round);
        body = { kind: "refined", result: delta === undefined ? { error: "not an edit set", raw: "" } : { edits: delta, raw: "{}" } };
        break;
      }
      case "commit":
        trace.committedIds.push(command.record.id);
        body = { kind: "committed", ok: true };
        break;
      case "reject":
        body = { kind: "recorded" };
        break;
      default:
        throw new Error(`the paper preset never issues ${command.kind}`);
    }
    const before = state.retained.revision;
    state = dreamStep(state, { ...body, command: command.id, at: guard } as DreamEvent).state;
    // I1: the retained core changes only when a commit is answered.
    if (state.retained.revision !== before) expect(command.kind).toBe("commit");
  }
  throw new Error("the dream did not finish");
}

const answer: fc.Arbitrary<Answer> = fc.constantFrom<Answer>({ kind: "malformed" }, { kind: "ghost" }, { kind: "empty" }, { kind: "add" });
const score = fc.constantFrom(0, 0.25, 0.5, 0.75, 1);

describe("PD1.M the paper preset's trace equals Algorithm 1", () => {
  test.prop([fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 4 }), fc.array(answer, { minLength: 6, maxLength: 6 }), fc.array(score, { minLength: 8, maxLength: 8 })])(
    "PD1.M for scripted refiner and evaluator sequences: same rollouts, evaluations, head, score and rejection memory; a rejected candidate never becomes head",
    (K, trainSize, stride, answers, validation) => {
      const train = Array.from({ length: trainSize }, (_, i) => `t${i}`);
      const expected = algorithm1(K, train, stride, answers, validation);
      const actual = reducer(K, train, stride, answers, validation);
      expect(actual.rollouts).toEqual(expected.rollouts);
      expect(actual.refinedFrom).toEqual(expected.refinedFrom);
      expect(actual.evaluated).toEqual(expected.evaluated);
      expect(actual.head).toBe(expected.head);
      expect(actual.score).toBe(expected.score);
      expect(actual.rejected).toBe(expected.rejected);
      // Node names are unique per round, so a rejected candidate (other than the retained graph itself) is never committed, and every rollout is under an accepted graph.
      for (const id of actual.rejectedIds) if (id !== null) expect(actual.committedIds).not.toContain(id);
      const accepted = new Set([G0_ID, ...actual.committedIds]);
      for (const [revision] of actual.rollouts) expect(accepted.has(revision)).toBe(true);
    },
  );
});

// ---- rebase keeps I2 and I6 --------------------------------------------------------------------

const NODES = [...G0.nodes.map((n) => n.id), "Verify", "Ghost"];
const node = fc.constantFrom(...NODES);
const overlayEntry: fc.Arbitrary<OverlayEntry> = fc
  .oneof(
    fc.record({ kind: fc.constant("edge"), from: node, relation: fc.constant("LEADS_TO"), to: node, condition: fc.constant(null), guidance: fc.constantFrom("a", "b"), pitfalls: fc.constant("") }),
    fc.record({ kind: fc.constant("node"), id: node, type: fc.constant("REASONING"), description: fc.constantFrom("c", "d") }),
    fc.record({ kind: fc.constantFrom("note", "caution"), on: fc.record({ from: node, to: node }), text: fc.constantFrom("x", "y") }),
  )
  .map((e) => OverlayEntrySchema.parse(e));
const deletable = fc.subarray(["First_Hop_Retrieve", "Scan_Index", "Bridge_Extract"]);

/** Every live entry references nodes that exist and edges that exist, in the core or the live overlay (I6). */
function anchored(state: OverlayState, g: ProceduralGraph): boolean {
  const live = Object.values(state.entries).filter((r) => r.status !== "retired").map((r) => r.entry);
  const nodes = new Set<string>([...g.nodes.map((n) => n.id), ...live.flatMap((e) => (e.kind === "node" ? [e.id] : []))]);
  const pairs = new Set([...g.edges.map((e) => `${e.from}→${e.to}`), ...live.flatMap((e) => (e.kind === "edge" && nodes.has(e.from) && nodes.has(e.to) ? [`${e.from}→${e.to}`] : []))]);
  return live.every((e) => (e.kind === "node" ? true : e.kind === "edge" ? nodes.has(e.from) && nodes.has(e.to) : pairs.has(`${e.on.from}→${e.on.to}`)));
}

describe("PD1.M rebase after a dream commit", () => {
  test.prop([fc.uniqueArray(overlayEntry, { maxLength: 8, selector: (e) => entryId(e) }), fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }), deletable])(
    "PD1.M keeps I2 (the effective graph holds the whole new core) and I6 (every live entry is anchored)",
    (entries, active, deleted) => {
      const events: OverlayEvent[] = entries.flatMap((entry, i) => [{ kind: "proposed", entry, source: { sessions: ["s"], by: "stats" } } as OverlayEvent, ...(active[i] ? [{ kind: "status", entry: entryId(entry), to: "active", reason: "t" } as OverlayEvent] : [])]);
      const overlay = foldAll(G0_ID, events);
      // Delete nodes, and bridge Start to End so the candidate stays valid.
      const delta = edits({ delete_nodes: deleted, add_edges: [{ source: "Start", target: "End", relation: "CONVERGES_TO", condition: null, guidance: "Done.", pitfalls: "" }] });
      const prepared = prepareCandidate(G0, delta, { cycles: "allowed" });
      if (prepared.graph === undefined) return;
      let state = dreamStart(input({ settings: { ...harnessDream, gate: ["structure"], rounds: 1 }, evaluator: false, overlay: { state: overlay, live: harnessLive } }));
      state = dreamStep(state, { command: state.pending[0]!.id, at: 1, kind: "selected", trajectories: [] }).state;
      state = dreamStep(state, { command: state.pending[0]!.id, at: 2, kind: "refined", result: { edits: delta, raw: "{}" } }).state;
      const commit = state.pending[0]!;
      if (commit.kind !== "commit") return; // an empty deletion leaves the graph unchanged
      state = dreamStep(state, { command: commit.id, at: 3, kind: "committed", ok: true }).state;
      const rebase = state.pending[0]!;
      if (rebase.kind !== "rebase") throw new Error("a commit with an overlay rebases");
      const { event } = rebaseOverlay(overlay, rebase.core, rebase.absorbed);
      state = dreamStep(state, { command: rebase.id, at: 4, kind: "rebased", event }).state;
      const newCore = state.retained.graph;
      expect(revisionId(newCore)).toBe(commit.record.id);
      const view = effectiveGraph(newCore, state.overlay!.state, { salt: "s", probationShare: 1 });
      for (const n of newCore.nodes) expect(view.nodes).toContainEqual({ ...n, origin: "core" });
      for (const e of newCore.edges) expect(view.edges).toContainEqual({ ...e, origin: "core", notes: expect.any(Array), cautions: expect.any(Array) });
      expect(anchored(state.overlay!.state, newCore)).toBe(true);
      for (const id of rebase.absorbed) expect(state.overlay!.state.entries[id]?.status).toBe("retired");
    },
  );
});

describe("PD1.P statistics and context", () => {
  test.prop([fc.integer({ min: 0, max: 2 ** 31 - 1 })], { numRuns: 20 })(
    "PD1.P1 the power-sized margin passes equal binary candidates about `power` of the time",
    (seed) => {
      // Simulate paired binary outcomes where both graphs succeed with the same chance, and count passes.
      let x = seed >>> 0;
      const next = (): number => {
        x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
        return x / 2 ** 32;
      };
      const trials = 60;
      let passes = 0;
      for (let t = 0; t < trials; t += 1) {
        const n = 200;
        const cand = Array.from({ length: n }, (_, i) => ({ task: `${i}`, score: next() < 0.6 ? 1 : 0 }));
        const ret = cand.map((c) => ({ task: c.task, score: next() < 0.3 ? (next() < 0.6 ? 1 : 0) : c.score }));
        const r = anchoredNonInferiority({ candidate: cand, retained: ret, anchor: cand, sizes: { candidate: { items: 1, chars: 0 }, retained: { items: 2, chars: 0 } }, totalLoss: 0.5, confidence: 0.95, power: 0.8, seed: `${seed}` });
        if (r.pass) passes += 1;
      }
      expect(passes / trials).toBeGreaterThanOrEqual(0.6);
    },
  );

  test.prop([fc.string({ maxLength: 60 }), fc.integer({ min: 0, max: 12 })])("PD1.P2 tailTokens returns a suffix of its input with at most `limit` tokens, or the input itself", (text, limit) => {
    const out = tailTokens(text, limit);
    expect(text.endsWith(out)).toBe(true);
    const tokens = (s: string) => s.match(/\S+/g)?.length ?? 0;
    if (out !== text) expect(tokens(out)).toBe(limit);
    else expect(tokens(text)).toBeLessThanOrEqual(limit);
  });
});
