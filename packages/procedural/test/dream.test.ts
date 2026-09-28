import { describe, expect, it } from "vitest";
import {
  absorbedEntries,
  canonicalJson,
  composeCandidate,
  dreamStart,
  dreamStep,
  entryId,
  foldAll,
  NodeNameSchema,
  OverlayEntrySchema,
  revisionId,
  RevisionRecordSchema,
  ScoredTrajectorySchema,
  seedGraph,
  tailTokens,
} from "@harness/procedural";
import { parseWorkflow } from "@harness/workflows";
import type { DreamInput, DreamState, DreamStep, OverlayEvent, RevisionRecord } from "@harness/procedural";
import { addVerify, answer, core, DREAM, edits, GRAPH, graphOf, harnessDream, harnessLive, input, paperDream, pending, renameGuidance, scores, toGhost } from "./dream-fixtures.ts";
import { edge, hotpot } from "./fixtures.ts";
import { cautionOnCore, idOf, noteOnCore, observed, proposed, status } from "./overlay-fixtures.ts";

const G0 = core();
const G0_ID = revisionId(G0);
const rolled = (values: readonly number[]) => ({ kind: "rolled-out" as const, results: values.map((score, i) => ({ task: `t${i}`, score, query: `q${i}`, steps: [{ role: "assistant" as const, content: `think ${i}`, call: { name: "first_hop_retrieve", arguments: { q: i } } }, { role: "tool" as const, content: `observed ${i}` }] })) });
const validation = (values: readonly number[], seed = "seed") => ({ kind: "evaluated" as const, scores: scores(values), seed });

/** Starts the paper preset and answers S₀ with the given validation scores. */
function paperAfterS0(s0: readonly number[] = [0.5, 0.5], overrides: Partial<DreamInput> = {}): DreamState {
  return answer(dreamStart(input(overrides)), validation(s0)).state;
}

/** Rolls out and refines the current round with `result`. */
function refineWith(state: DreamState, result: { edits: unknown; raw: string } | { error: string; raw: string }, at = 1000): DreamStep {
  const afterRollout = answer(state, rolled([1, 0])).state;
  const r = "edits" in result ? { edits: edits(result.edits), raw: result.raw } : result;
  return answer(afterRollout, { kind: "refined", result: r }, at);
}

describe("Algorithm 1 (the paper preset)", () => {
  it("PD1.30 a dream starts by evaluating S₀ = Evaluate(G₀, D_val) once", () => {
    const start = dreamStart(input());
    expect(start.pending).toEqual([{ id: 0, kind: "evaluate", revision: G0_ID, graph: G0, tasks: "validation" }]);
    expect(start.round).toBe(0);
  });

  it("PD1.31 each round rolls out a stride of training tasks under the retained graph", () => {
    const s = paperAfterS0();
    expect(s.pending).toEqual([{ id: 1, kind: "rollout", revision: G0_ID, graph: G0, batch: ["t0", "t1"] }]);
    expect(s.retained.mean).toBe(0.5);
    expect(s.anchor).toEqual(scores([0.5, 0.5]));
  });

  it("PD1.32 strides wrap around the training tasks in order", () => {
    let s = paperAfterS0([0.5], { settings: { ...paperDream, rounds: 4 } });
    const batches: string[][] = [];
    for (let k = 0; k < 4; k += 1) {
      batches.push([...pending(s, "rollout").batch]);
      s = refineWith(s, { error: "not JSON", raw: "?" }).state;
    }
    expect(batches).toEqual([
      ["t0", "t1"],
      ["t2", "t3"],
      ["t4", "t0"],
      ["t1", "t2"],
    ]);
    const wide = paperAfterS0([0.5], { stride: 9 });
    expect(pending(wide, "rollout").batch).toEqual(["t0", "t1", "t2", "t3", "t4"]);
  });

  it("PD1.33 the refiner sees the tail of the concatenated trajectories, their scores, the graph and the mode", () => {
    const s = paperAfterS0();
    const request = pending(answer(s, rolled([1, 0])).state, "refine").request;
    expect(request).toEqual({
      task: "Answer multi-hop questions.",
      mode: "static_incremental",
      tools: ["first_hop_retrieve", "Scan_Index"],
      attempts: [
        "Trajectory t0 (score: 1.00)",
        "Query: q0",
        "Thought: think 0",
        'Action: first_hop_retrieve(q=0)',
        "Observation: observed 0",
        "",
        "Trajectory t1 (score: 0.00)",
        "Query: q1",
        "Thought: think 1",
        'Action: first_hop_retrieve(q=1)',
        "Observation: observed 1",
      ].join("\n"),
      graphJson: JSON.stringify({ format: G0.format, nodeTypes: G0.nodeTypes, relations: G0.relations, nodes: G0.nodes, edges: G0.edges }, null, 2),
      rejected: "None",
    });
    // L_max keeps the end of the concatenation.
    const tight = paperAfterS0([0.5], { settings: { ...paperDream, contextTokens: 5 } });
    expect(pending(answer(tight, rolled([1, 0])).state, "refine").request.attempts).toBe("Action: first_hop_retrieve(q=1)\nObservation: observed 1");
  });

  it("PD1.34 a scratch graph refines in the scratch mode; a rollout with no trace renders its query alone", () => {
    const s = answer(dreamStart(input({ head: seedGraph() })), validation([0])).state;
    const refine = pending(answer(s, { kind: "rolled-out", results: [{ task: "t0", score: 1 }, { task: "t1", score: 0, query: "q" }] }).state, "refine").request;
    expect(refine.mode).toBe("scratch_incremental");
    expect(refine.attempts).toBe("Trajectory t0 (score: 1.00)\n\nTrajectory t1 (score: 0.00)\nQuery: q");
  });

  it("PD1.35 tailTokens keeps the end of a text and leaves shorter texts unchanged", () => {
    expect(tailTokens("  one two\nthree  four ", 2)).toBe("three  four ");
    expect(tailTokens("  one two", 2)).toBe("  one two");
    expect(tailTokens("one two", 0)).toBe("");
    expect(tailTokens("", 3)).toBe("");
  });

  it("PD1.36 a structural failure goes to the rejection memory with no validation rollout", () => {
    const s = paperAfterS0();
    const { state, commands } = refineWith(s, { edits: toGhost, raw: "{}" }, 2000);
    const reject = pending(state, "reject");
    expect(commands).toEqual([reject]);
    expect(reject.record).toMatchObject({ graph: GRAPH, parents: [G0_ID], origin: "dream", dream: DREAM, edits: toGhost, at: 2000, decision: { kind: "rejected-structure", diagnostics: [expect.objectContaining({ code: "missing-endpoint" })] } });
    expect(RevisionRecordSchema.parse(reject.record)).toEqual(reject.record);
    expect(state.rejections).toHaveLength(1);
    expect(state.rounds).toEqual([{ round: 1, outcome: "rejected", revision: reject.record.id, gate: "structure", reason: expect.stringMatching(/^missing-endpoint at /) }]);
    const next = answer(state, { kind: "recorded" }).state;
    expect(pending(next, "rollout")).toMatchObject({ revision: G0_ID, batch: ["t2", "t3"] });
  });

  it("PD1.37 an answer that is not an edit set is remembered as a structural failure, with no record", () => {
    const { state } = refineWith(paperAfterS0(), { error: "the refiner's answer is not JSON", raw: "nope" });
    expect(state.rejections).toEqual([{ id: null, parent: G0_ID, round: 1, edits: null, document: null, decision: { kind: "rejected-structure", diagnostics: [{ code: "malformed", message: "the refiner's answer is not JSON" }] }, score: null }]);
    expect(state.rounds).toEqual([{ round: 1, outcome: "rejected", revision: null, gate: "structure", reason: "malformed: the refiner's answer is not JSON" }]);
    expect(pending(state, "rollout").batch).toEqual(["t2", "t3"]);
  });

  it("PD1.38 a valid candidate is evaluated on validation, and a tie is accepted and committed", () => {
    const { state } = refineWith(paperAfterS0([0.5, 0.5]), { edits: addVerify, raw: "{}" });
    const evaluate = pending(state, "evaluate");
    const candidate = evaluate.graph;
    expect(evaluate).toMatchObject({ kind: "evaluate", tasks: "validation", revision: revisionId(candidate) });
    const committed = answer(state, validation([1, 0]), 3000).state;
    const commit = pending(committed, "commit");
    expect(commit.expected).toBe(G0_ID);
    expect(commit.record).toMatchObject({ id: revisionId(candidate), graph: GRAPH, parents: [G0_ID], edits: addVerify, origin: "dream", dream: DREAM, decision: { kind: "head" }, at: 3000 });
    expect(commit.record.evidence).toMatchObject({ round: 1, score: 0.5, retained: 0.5, validation: scores([1, 0]), trajectories: [{ id: "t0", score: 1 }, { id: "t1", score: 0 }], gates: [{ gate: "evaluator-at-least-retained", pass: true, reason: "validation 0.5000 ≥ retained 0.5000" }] });
    expect(RevisionRecordSchema.parse(commit.record)).toEqual(commit.record);
    const next = answer(committed, { kind: "committed", ok: true }).state;
    expect(next.rounds).toEqual([{ round: 1, outcome: "committed", revision: revisionId(candidate), score: 0.5 }]);
    expect(next.retained).toEqual({ graph: candidate, revision: revisionId(candidate), scores: scores([1, 0]), mean: 0.5 });
    // The next round rolls out under the accepted graph.
    expect(pending(next, "rollout")).toMatchObject({ revision: revisionId(candidate), graph: candidate, batch: ["t2", "t3"] });
  });

  it("PD1.39 a lower validation score rejects the candidate; the next round starts from the retained graph and sees the rejection", () => {
    const { state } = refineWith(paperAfterS0([0.5, 0.5]), { edits: addVerify, raw: "{}" });
    const candidateId = pending(state, "evaluate").revision;
    const rejected = answer(state, validation([0, 0.5]), 4000).state;
    const reject = pending(rejected, "reject");
    expect(reject.record).toMatchObject({ id: candidateId, decision: { kind: "rejected-gate", gate: "evaluator-at-least-retained", reason: "validation 0.2500 < retained 0.5000" }, at: 4000 });
    expect(reject.record.evidence).toMatchObject({ score: 0.25, retained: 0.5 });
    const next = answer(rejected, { kind: "recorded" }).state;
    expect(pending(next, "rollout")).toMatchObject({ revision: G0_ID, graph: G0 });
    expect(next.retained.mean).toBe(0.5);
    const request = pending(answer(next, rolled([1])).state, "refine").request;
    expect(request.rejected).toBe(
      [
        "Candidate 1 (round 1): rejected by evaluator-at-least-retained, validation score 0.2500: validation 0.2500 < retained 0.5000",
        `Edits: ${JSON.stringify(addVerify)}`,
        `Graph: ${JSON.stringify(reject.record.document)}`,
      ].join("\n"),
    );
    expect(request.graphJson).toContain('"Bridge_Extract"');
    expect(request.graphJson).not.toContain('"Verify"');
  });

  it("PD1.40 the rejected block lists structural failures with their diagnostics, and unparsed answers without a graph", () => {
    let s = refineWith(paperAfterS0(), { error: "not JSON", raw: "?" }).state;
    s = refineWith(s, { edits: toGhost, raw: "{}" }).state;
    s = answer(s, { kind: "recorded" }).state;
    const block = pending(answer(s, rolled([1])).state, "refine").request.rejected;
    const [first, second] = block.split("\n\n");
    expect(first).toBe("Candidate 1 (round 1): structural failure: malformed: not JSON\nEdits: none (the answer was not an edit set)");
    expect(second).toMatch(/^Candidate 2 \(round 2\): structural failure: missing-endpoint at edges\[4\]\.to: edge 4 ends at Ghost, which is not a node\nEdits: \{"add_nodes":\[\],.*\nGraph: \{"format"/);
  });

  it("PD1.41 after the last round the dream is done with each round's outcome", () => {
    let s = paperAfterS0([0.5], { settings: { ...paperDream, rounds: 2 } });
    s = refineWith(s, { edits: addVerify, raw: "{}" }).state;
    s = answer(s, { kind: "evaluated", scores: scores([0.75]), seed: "x" }).state;
    const id = pending(s, "commit").record.id;
    s = answer(s, { kind: "committed", ok: true }).state;
    s = refineWith(s, { error: "bad", raw: "" }).state;
    const done = pending(s, "done");
    expect(done.result).toEqual({
      dream: DREAM,
      graph: GRAPH,
      initial: G0_ID,
      head: id,
      score: 0.75,
      rounds: [
        { round: 1, outcome: "committed", revision: id, score: 0.75 },
        { round: 2, outcome: "rejected", revision: null, gate: "structure", reason: "malformed: bad" },
      ],
    });
  });

  it("PD1.42 an event for no pending command is ignored; an event of the wrong kind is an error", () => {
    const s = paperAfterS0();
    expect(dreamStep(s, { command: 99, at: 1, kind: "recorded" })).toEqual({ state: s, commands: [] });
    expect(dreamStep(s, { command: 0, at: 1, kind: "evaluated", scores: [], seed: "" })).toEqual({ state: s, commands: [] });
    expect(() => dreamStep(s, { command: 1, at: 1, kind: "recorded" })).toThrow(RangeError);
    let done = paperAfterS0([0.5], { settings: { ...paperDream, rounds: 1 } });
    done = refineWith(done, { error: "bad", raw: "" }).state;
    const finished = pending(done, "done");
    expect(() => dreamStep(done, { command: finished.id, at: 1, kind: "recorded" })).toThrow(RangeError);
  });

  it("PD1.43 an accepted candidate identical to the retained graph updates the cached score and commits nothing", () => {
    const { state } = refineWith(paperAfterS0([0.5, 0.5]), { edits: {}, raw: "{}" });
    expect(pending(state, "evaluate").revision).toBe(G0_ID);
    const next = answer(state, validation([1, 1])).state;
    expect(next.rounds).toEqual([{ round: 1, outcome: "unchanged", score: 1 }]);
    expect(next.retained).toMatchObject({ revision: G0_ID, mean: 1, scores: scores([1, 1]) });
    expect(pending(next, "rollout").revision).toBe(G0_ID);
    // Rejected, it stays in the memory but is never stored over the head's record.
    const worse = answer(state, validation([0, 0])).state;
    expect(worse.rejections.at(-1)).toMatchObject({ id: G0_ID, score: 0 });
    expect(pending(worse, "rollout").revision).toBe(G0_ID);
  });

  it("PD1.44 onetime: one ungated round over every training task, with no S₀", () => {
    const start = dreamStart(input({ settings: { ...paperDream, mode: "onetime" } }));
    expect(pending(start, "rollout")).toMatchObject({ batch: ["t0", "t1", "t2", "t3", "t4"], revision: G0_ID });
    const refined = answer(answer(start, rolled([1, 0, 1, 0, 1])).state, { kind: "refined", result: { edits: addVerify, raw: "{}" } });
    expect(pending(refined.state, "commit").record).toMatchObject({ decision: { kind: "head" }, evidence: { score: null, retained: null, gates: [] } });
    const done = answer(refined.state, { kind: "committed", ok: true }).state;
    expect(pending(done, "done").result.rounds).toHaveLength(1);
    expect(pending(answer(start, rolled([1])).state, "refine").request.mode).toBe("static_onetime");
  });

  it("PD1.45 a commit that loses the compare-and-set ends the dream as a conflict", () => {
    const { state } = refineWith(paperAfterS0([0.5]), { edits: addVerify, raw: "{}" });
    const committing = answer(state, validation([0.5])).state;
    const id = pending(committing, "commit").record.id;
    const out = answer(committing, { kind: "committed", ok: false }).state;
    expect(pending(out, "done").result).toMatchObject({ head: G0_ID, rounds: [{ round: 1, outcome: "conflict", revision: id }] });
  });
});

describe("gates beyond the paper", () => {
  const harness = (overrides: Partial<DreamInput> = {}): DreamInput =>
    input({ settings: harnessDream, evaluator: false, overlay: { state: foldAll(G0_ID, []), live: harnessLive }, tools: ["first_hop_retrieve", "Scan_Index", "Verify"], ...overrides });
  const selected = (n: number) => ({
    kind: "selected" as const,
    trajectories: Array.from({ length: n }, (_, i) => ({
      id: `tr${i}`,
      graph: GRAPH,
      core: G0_ID,
      overlay: 0,
      session: `s${i}`,
      turn: "t",
      query: `query ${i}`,
      steps: [{ role: "assistant" as const, content: `step ${i} of a long line of reasoning here` }, { role: "tool" as const, content: `tool output ${i}` }],
      score: i === n - 1 ? null : i / n,
      scoreSource: "metric" as const,
      localization: { matched: 1, fallback: 0, inert: 0 },
      usage: { steps: 2, inputTokens: 1, outputTokens: 1, guidanceTokens: 0 },
    })) as never,
  });

  it("PD1.46 without an evaluator a round selects trajectories under the retained head", () => {
    const start = dreamStart(harness());
    expect(start.pending).toEqual([{ id: 0, kind: "select", revision: G0_ID, limit: 2 }]);
  });

  it("PD1.47 per-trajectory context: balanced from the highest and lowest scores, each trajectory keeping its own tail", () => {
    const s = answer(dreamStart(harness({ settings: { ...harnessDream, contextTokens: 20 } })), selected(4)).state;
    const attempts = pending(s, "refine").request.attempts;
    expect(attempts.split("\n\n").map((t) => t.split("\n")[0])).toEqual(["Trajectory tr2 (score: 0.50)", "Trajectory tr0 (score: 0.00)", "Trajectory tr1 (score: 0.25)", "Trajectory tr3 (score: unscored)"]);
    // Twenty tokens over four trajectories: five tokens of each body.
    expect(attempts.split("\n\n")[0]).toBe("Trajectory tr2 (score: 0.50)\nhere\nObservation: tool output 2");
  });

  it("PD1.48 the dream prompt's consolidation lists live entries, cautioned edges and rejection reasons", () => {
    const overlay = foldAll(G0_ID, [
      proposed(noteOnCore, ["a", "b"]),
      status(idOf(noteOnCore), "active"),
      proposed(cautionOnCore, ["a"]),
      observed("a/1", ["Bridge_Extract", "End"], 0.2),
      proposed({ ...noteOnCore, text: "Gone." }, ["z"]),
      status(idOf({ ...noteOnCore, text: "Gone." }), "retired"),
    ]);
    const s = answer(dreamStart(harness({ overlay: { state: overlay, live: harnessLive } })), selected(1)).state;
    const { consolidation, rejected } = pending(s, "refine").request;
    expect(consolidation).toEqual({
      overlayEntries: [
        `- [active] ${canonicalJson(noteOnCore)} (support 2 sessions; exposed 0 turns, unscored; unexposed 0 turns, unscored)`,
        `- [probation] ${canonicalJson(cautionOnCore)} (support 1 sessions; exposed 0 turns, unscored; unexposed 1 turns, mean 0.20)`,
      ].join("\n"),
      cautionedEdges: "- Bridge_Extract → End: 1 traversals, 1 scored, mean 0.20, 1 sessions; caution: This edge preceded failures.",
      rejectionReasons: "None",
    });
    expect(rejected).toBe("None");
    const empty = answer(dreamStart(harness()), selected(1)).state;
    expect(pending(empty, "refine").request.consolidation).toEqual({ overlayEntries: "None", cautionedEdges: "None", rejectionReasons: "None" });
  });

  it("PD1.49 edges with poor statistics are listed for pruning even without a caution", () => {
    const events: OverlayEvent[] = [
      ...Array.from({ length: 40 }, (_, i) => observed(`bad${i}/t`, ["Bridge_Extract", "End"], 0)),
      ...Array.from({ length: 40 }, (_, i) => observed(`good${i}/t`, ["Start", "First_Hop_Retrieve"], 1)),
    ];
    const s = answer(dreamStart(harness({ overlay: { state: foldAll(G0_ID, events), live: harnessLive } })), selected(1)).state;
    expect(pending(s, "refine").request.consolidation?.cautionedEdges).toBe("- Bridge_Extract → End: 40 traversals, 40 scored, mean 0.00, 40 sessions");
  });

  it("PD1.50 the harness preset prepares with the tool catalog and the edit filter; the paper preset with neither", () => {
    const newTool = edits({ add_nodes: [{ id: "send_email", type: "ACTION", description: "Send." }], add_edges: [{ source: "Bridge_Extract", target: "send_email", relation: "LEADS_TO", condition: null, guidance: "tool output 0 was here in the text", pitfalls: "" }] });
    const h = answer(answer(dreamStart(harness()), selected(1)).state, { kind: "refined", result: { edits: newTool, raw: "{}" } }).state;
    expect(pending(h, "reject").record.decision).toMatchObject({ kind: "rejected-structure", diagnostics: [expect.objectContaining({ code: "tool-not-in-catalog" })] });
    const filtered = edits({ add_edges: [{ source: "Scan_Index", target: "End", relation: "LEADS_TO", condition: null, guidance: "visit https://example.com now", pitfalls: "" }] });
    const f = answer(answer(dreamStart(harness()), selected(1)).state, { kind: "refined", result: { edits: filtered, raw: "{}" } }).state;
    expect(pending(f, "reject").record.decision).toMatchObject({ kind: "rejected-structure", diagnostics: [expect.objectContaining({ code: "filtered" })] });
    const p = refineWith(paperAfterS0(), { edits: newTool, raw: "{}" }).state;
    expect(pending(p, "evaluate")).toBeDefined();
    const cyclic = edits({ add_edges: [{ source: "Scan_Index", target: "Start", relation: "LEADS_TO", condition: null, guidance: "again", pitfalls: "" }] });
    const repaired = refineWith(paperAfterS0([0.5], { settings: { ...paperDream, cycles: "forbidden" } }), { edits: cyclic, raw: "{}" }).state;
    expect(pending(repaired, "evaluate").graph.edges.some((e) => e.to === "Start")).toBe(false);
  });

  it("PD1.81 a dream given no tool catalog has none to enforce: action nodes pass structure, and the refiner is shown no tools", () => {
    const { tools: _unknown, ...noCatalog } = harness();
    const selecting = answer(dreamStart(noCatalog), selected(1)).state;
    expect(pending(selecting, "refine").request.tools).toEqual([]);
    const h = answer(selecting, { kind: "refined", result: { edits: addVerify, raw: "{}" } }).state;
    // It passes structure, and the evidence gate decides.
    expect(pending(h, "reject").record.decision).toMatchObject({ kind: "rejected-gate", gate: "evidence" });
    // An empty catalog given is still a catalog: every action node is outside it.
    const empty = answer(answer(dreamStart(harness({ tools: [] })), selected(1)).state, { kind: "refined", result: { edits: addVerify, raw: "{}" } }).state;
    expect(pending(empty, "reject").record.decision).toMatchObject({ kind: "rejected-structure", diagnostics: expect.arrayContaining([expect.objectContaining({ code: "tool-not-in-catalog" })]) });
  });

  it("PD1.51 the evidence gate rejects a change live traffic does not support, before any evaluation", () => {
    const s = answer(answer(dreamStart(harness()), selected(1)).state, { kind: "refined", result: { edits: addVerify, raw: "{}" } }).state;
    const reject = pending(s, "reject");
    expect(reject.record.decision).toEqual({ kind: "rejected-gate", gate: "evidence", reason: expect.stringMatching(/^no evidence for: removed edge Bridge_Extract → End/) });
    expect(reject.record.evidence).toMatchObject({ gates: [{ gate: "evidence", pass: false }] });
    const noOverlay = answer(answer(dreamStart(harness({ overlay: undefined } as never)), selected(1)).state, { kind: "refined", result: { edits: renameGuidance("Go."), raw: "{}" } }).state;
    expect(pending(noOverlay, "reject").record.decision).toEqual({ kind: "rejected-gate", gate: "evidence", reason: "no live evidence: the preset has no overlay" });
  });

  it("PD1.52 approval for side effects: a candidate routing into a side-effecting tool asks the approver", () => {
    const toTool = edits({ add_edges: [{ source: "Bridge_Extract", target: "First_Hop_Retrieve", relation: "LEADS_TO", condition: null, guidance: "Retrieve again.", pitfalls: "" }] });
    const support = foldAll(G0_ID, Array.from({ length: 3 }, (_, i) => observed(`s${i}/t`, ["Bridge_Extract", "First_Hop_Retrieve"], null)));
    const withApprover = harness({ approver: true, overlay: { state: support, live: harnessLive }, settings: { ...harnessDream, cycles: "allowed" } });
    const s = answer(answer(dreamStart(withApprover), selected(1)).state, { kind: "refined", result: { edits: toTool, raw: "{}" } }).state;
    const approve = pending(s, "approve");
    expect(approve.tools).toEqual(["first_hop_retrieve"]);
    expect(approve.candidate).toMatchObject({ decision: { kind: "pending-approval" }, parents: [G0_ID] });
    expect(pending(answer(s, { kind: "approved", approved: true }).state, "commit").record.evidence).toMatchObject({ gates: [{ gate: "evidence", pass: true }, { gate: "approval-for-side-effects", pass: true, reason: "approved" }] });
    expect(pending(answer(s, { kind: "approved", approved: false }).state, "reject").record.decision).toEqual({ kind: "rejected-gate", gate: "approval-for-side-effects", reason: "declined by the approver" });
    const noApprover = answer(answer(dreamStart({ ...withApprover, approver: false }), selected(1)).state, { kind: "refined", result: { edits: toTool, raw: "{}" } }).state;
    expect(pending(noApprover, "reject").record.decision).toEqual({ kind: "rejected-gate", gate: "approval-for-side-effects", reason: "approval needed, and no approver is configured" });
    const free = answer(answer(dreamStart({ ...withApprover, sideEffectFree: ["first_hop_retrieve"] }), selected(1)).state, { kind: "refined", result: { edits: toTool, raw: "{}" } }).state;
    expect(pending(free, "commit")).toBeDefined();
  });

  it("PD1.53 a listed approval gate asks for approval of every candidate", () => {
    const s = refineWith(paperAfterS0([0.5], { approver: true, settings: { ...paperDream, gate: ["evaluator-at-least-retained", "approval"] } }), { edits: renameGuidance("Go."), raw: "{}" }).state;
    const approving = answer(s, validation([0.5])).state;
    expect(pending(approving, "approve").tools).toEqual(["first_hop_retrieve"]);
  });

  it("PD1.54 the anchored gate evaluates S₀ and each candidate, deciding with the logged seed", () => {
    const withEvaluator = harness({ evaluator: true, settings: { ...harnessDream, gate: ["structure", "evaluator-anchored-noninferiority?"] } });
    const start = dreamStart(withEvaluator);
    expect(pending(start, "evaluate").revision).toBe(G0_ID);
    const s0 = Array.from({ length: 200 }, (_, i) => (i < 120 ? 1 : 0));
    let s = answer(start, validation(s0)).state;
    s = answer(s, rolled([1])).state;
    s = answer(s, { kind: "refined", result: { edits: renameGuidance("Go."), raw: "{}" } }).state;
    const same = answer(s, validation(s0)).state;
    expect(pending(same, "commit").record.evidence).toMatchObject({ gates: [{ gate: "evaluator-anchored-noninferiority", pass: true, reason: expect.stringMatching(/^non-inferior and smaller/) }] });
    const worse = answer(s, validation(s0.map((x, i) => (i < 60 ? 1 : 0)))).state;
    expect(pending(worse, "reject").record.decision).toMatchObject({ gate: "evaluator-anchored-noninferiority" });
  });

  it("PD1.55 an evaluator gate listed without `?` fails when the graph has no evaluator", () => {
    const s = answer(answer(dreamStart(harness({ settings: { ...harnessDream, gate: ["evaluator-at-least-retained"] } })), selected(1)).state, { kind: "refined", result: { edits: renameGuidance("Go."), raw: "{}" } }).state;
    expect(pending(s, "reject").record.decision).toEqual({ kind: "rejected-gate", gate: "evaluator-at-least-retained", reason: "the gate needs an evaluator, and the graph has none" });
  });

  it("PD1.56 a commit rebases the overlay: absorbed entries retire, and the next round's consolidation no longer lists them", () => {
    const shortcut = { kind: "edge", from: "Scan_Index", relation: "LEADS_TO", to: "End", condition: null, guidance: "Answer directly.", pitfalls: "" };
    const overlay = foldAll(G0_ID, [proposed(shortcut, ["a", "b", "c"]), status(idOf(shortcut), "active")]);
    const absorb = edits({ add_edges: [{ source: "Scan_Index", target: "End", relation: "LEADS_TO", condition: null, guidance: "Answer directly.", pitfalls: "" }] });
    let s = dreamStart(harness({ overlay: { state: overlay, live: harnessLive }, settings: { ...harnessDream, rounds: 2 } }));
    s = answer(s, selected(1)).state;
    s = answer(s, { kind: "refined", result: { edits: absorb, raw: "{}" } }).state;
    const commit = pending(s, "commit");
    s = answer(s, { kind: "committed", ok: true }).state;
    const rebase = pending(s, "rebase");
    expect(rebase.absorbed).toEqual([idOf(shortcut)]);
    expect(revisionId(rebase.core)).toBe(commit.record.id);
    s = answer(s, { kind: "rebased", event: { kind: "rebased", core: commit.record.id, absorbed: [idOf(shortcut)], dropped: [], frozenAt: 2 } }).state;
    expect(s.overlay?.state.entries[idOf(shortcut)]?.status).toBe("retired");
    s = answer(s, selected(1)).state;
    expect(pending(s, "refine").request.consolidation?.overlayEntries).toBe("None");
  });

  it("PD1.57 with dedupe a known rejection is never evaluated again, and an unchanged candidate is skipped", () => {
    const known = RevisionRecordSchema.parse({
      id: revisionId(graphOf(hotpotWith((d) => d.edges.push(edge("Scan_Index", "End"))))),
      graph: GRAPH,
      parents: [G0_ID],
      document: graphOf(hotpotWith((d) => d.edges.push(edge("Scan_Index", "End")))),
      edits: null,
      origin: "dream",
      evidence: { score: 0.1 },
      decision: { kind: "rejected-gate", gate: "evidence", reason: "no" },
      at: 1,
    });
    const shortcut = edits({ add_edges: [{ source: "Scan_Index", target: "End", relation: "LEADS_TO", condition: null, guidance: "After Scan_Index, go to End.", pitfalls: "Do not skip End." }] });
    const s = answer(answer(dreamStart(harness({ rejections: [known] })), selected(1)).state, { kind: "refined", result: { edits: shortcut, raw: "{}" } }).state;
    expect(s.rounds).toEqual([{ round: 1, outcome: "known-rejection", revision: known.id }]);
    expect(pending(s, "select").revision).toBe(G0_ID);
    const unchanged = answer(answer(dreamStart(harness()), selected(1)).state, { kind: "refined", result: { edits: edits({}), raw: "{}" } }).state;
    expect(unchanged.rounds).toEqual([{ round: 1, outcome: "unchanged", score: null }]);
    // The memory from earlier dreams is shown with its score.
    const shown = pending(answer(dreamStart(harness({ rejections: [known] })), selected(1)).state, "refine").request;
    expect(shown.rejected).toMatch(/^Candidate 1: rejected by evidence, validation score 0\.1000: no\nEdits: none/);
    expect(shown.consolidation?.rejectionReasons).toBe(`- ${known.id.slice(0, 12)}: rejected by evidence, validation score 0.1000: no`);
  });

  it("PD1.58 recent-and-similar shows at most `limit` rejections, those against the retained head first, then the most recent", () => {
    const record = (guidance: string, parent: string, i: number): RevisionRecord => {
      const document = graphOf(hotpotWith((d) => (d.edges[0] = { ...d.edges[0]!, guidance })));
      return RevisionRecordSchema.parse({ id: revisionId(document), graph: GRAPH, parents: [parent], document, edits: null, origin: "dream", evidence: {}, decision: { kind: "rejected-gate", gate: "g", reason: `r${i}` }, at: i });
    };
    const other = revisionId(seedGraph());
    const records = [record("a", G0_ID, 1), record("b", other, 2), record("c", other, 3), record("d", G0_ID, 4), record("d", G0_ID, 5)];
    const s = answer(dreamStart(harness({ rejections: records, settings: { ...harnessDream, rejections: { dedupe: true, show: "recent-and-similar", limit: 3 } } })), selected(1)).state;
    expect(pending(s, "refine").request.consolidation?.rejectionReasons.split("\n").map((l) => l.split(": ").at(-1))).toEqual(["r5", "r1", "r3"]);
    // Rejections from store records never include accepted or pending ones.
    const head = RevisionRecordSchema.parse({ ...records[0]!, decision: { kind: "head" } });
    const pendingApproval = RevisionRecordSchema.parse({ ...records[0]!, decision: { kind: "pending-approval" } });
    expect(dreamStart(harness({ rejections: [head, pendingApproval] })).rejections).toEqual([]);
  });

  it("PD1.59 absorbedEntries: edges and nodes the candidate has, notes its text includes, cautions on edges it pruned; never retired ones", () => {
    const base = G0;
    const candidateDoc = hotpotWith((d) => {
      d.edges = d.edges.filter((e) => !(e.from === "Bridge_Extract" && e.to === "End"));
      d.nodes.push({ id: "Verify", type: "REASONING", description: "Check." });
      d.edges.push(edge("Bridge_Extract", "Verify"), edge("Verify", "End"));
      d.edges[0] = { ...d.edges[0]!, pitfalls: "Retrieve before reasoning." };
    });
    const candidate = graphOf(candidateDoc);
    const entries = [
      noteOnCore,
      cautionOnCore,
      { kind: "node", id: "Verify", type: "REASONING", description: "Check." },
      { kind: "edge", from: "Verify", relation: "LEADS_TO", to: "End", condition: null, guidance: "x", pitfalls: "" },
      { kind: "edge", from: "Verify", relation: "TRIGGERS", to: "End", condition: null, guidance: "x", pitfalls: "" },
      { kind: "note", on: { from: "Scan_Index", to: "Bridge_Extract" }, text: "Unrelated." },
      { kind: "caution", on: { from: "Start", to: "First_Hop_Retrieve" }, text: "Still there." },
      { kind: "node", id: "Other", type: "REASONING", description: "No." },
    ];
    const overlay = foldAll(G0_ID, [...entries.map((e) => proposed(e, ["a"])), status(idOf(entries[3]), "retired")]);
    expect(absorbedEntries(overlay, base, candidate)).toEqual([noteOnCore, cautionOnCore, entries[2]].map((e) => entryId(OverlayEntrySchema.parse(e))));
    const more = [
      { kind: "edge", from: "Bridge_Extract", relation: "LEADS_TO", to: "Verify", condition: null, guidance: "y", pitfalls: "" },
      { kind: "edge", from: "Start", relation: "LEADS_TO", to: "End", condition: null, guidance: "y", pitfalls: "" },
      { kind: "edge", from: "Verify", relation: "LEADS_TO", to: "Bridge_Extract", condition: null, guidance: "y", pitfalls: "" },
      { kind: "note", on: { from: "Start", to: "Scan_Index" }, text: "Retrieve before reasoning." },
      { kind: "note", on: { from: "Scan_Index", to: "First_Hop_Retrieve" }, text: "Retrieve before reasoning." },
    ];
    expect(absorbedEntries(foldAll(G0_ID, more.map((e) => proposed(e, ["a"]))), base, candidate)).toEqual([idOf(more[0])]);
  });

  it("PD1.66 the memory keeps every unparsed answer, and consolidation names them", () => {
    let s = dreamStart(harness({ settings: { ...harnessDream, rounds: 3 } }));
    for (let i = 0; i < 2; i += 1) s = answer(answer(s, selected(1)).state, { kind: "refined", result: { error: `bad ${i}`, raw: "" } }).state;
    const request = pending(answer(s, selected(1)).state, "refine").request;
    expect(request.consolidation?.rejectionReasons).toBe("- unparsed answer: structural failure: malformed: bad 1\n- unparsed answer: structural failure: malformed: bad 0");
  });

  it("PD1.67 cautioned edges: once per pair, with their traversals or none, and only their own cautions", () => {
    const doc = hotpot();
    doc.edges.push(edge("Bridge_Extract", "End", "TRIGGERS"));
    const head = graphOf(doc);
    const overlay = foldAll(revisionId(head), [
      proposed(cautionOnCore, ["a"]),
      proposed({ kind: "note", on: { from: "Bridge_Extract", to: "End" }, text: "A note." }, ["a"]),
      proposed({ kind: "caution", on: { from: "Scan_Index", to: "Bridge_Extract" }, text: "Other." }, ["a"]),
      proposed({ kind: "caution", on: { from: "Bridge_Extract", to: "Scan_Index" }, text: "Ghost pair." }, ["a"]),
      observed("a/1", ["Scan_Index", "Bridge_Extract"], null),
    ]);
    const s = answer(dreamStart(harness({ head, overlay: { state: overlay, live: harnessLive } })), selected(1)).state;
    expect(pending(s, "refine").request.consolidation?.cautionedEdges).toBe(
      ["- Scan_Index → Bridge_Extract: 1 traversals, 0 scored, unscored, 1 sessions; caution: Other.", "- Bridge_Extract → End: no traversals, 0 sessions; caution: This edge preceded failures."].join("\n"),
    );
    const scored = foldAll(G0_ID, [proposed(cautionOnCore, ["a"]), observed("a/1", ["Bridge_Extract", "End"], 0.2), observed("b/1", ["Bridge_Extract", "End"], 0.6)]);
    const t = answer(dreamStart(harness({ overlay: { state: scored, live: harnessLive } })), selected(1)).state;
    const { consolidation } = pending(t, "refine").request;
    expect(consolidation?.cautionedEdges).toBe("- Bridge_Extract → End: 2 traversals, 2 scored, mean 0.40, 2 sessions; caution: This edge preceded failures.");
    expect(consolidation?.overlayEntries).toContain("unexposed 2 turns, mean 0.40");
    // Several cautions on one edge are all listed, each after its own separator.
    const two = foldAll(G0_ID, [proposed(cautionOnCore, ["a"]), proposed({ ...cautionOnCore, text: "Also slow." }, ["b"])]);
    const u = answer(dreamStart(harness({ overlay: { state: two, live: harnessLive } })), selected(1)).state;
    expect(pending(u, "refine").request.consolidation?.cautionedEdges).toBe("- Bridge_Extract → End: no traversals, 0 sessions; caution: This edge preceded failures.; caution: Also slow.");
  });

  it("PD1.68 a gate rejection without a score shows only its gate and reason; a stored structural rejection is remembered", () => {
    const structural = RevisionRecordSchema.parse({ id: revisionId(graphOf(hotpotWith((d) => d.edges.push(edge("Start", "End"))))), graph: GRAPH, parents: [G0_ID], document: graphOf(hotpotWith((d) => d.edges.push(edge("Start", "End")))), edits: null, origin: "dream", evidence: {}, decision: { kind: "rejected-structure", diagnostics: [{ code: "cycle", message: "loop" }] }, at: 1 });
    let s = dreamStart(harness({ rejections: [structural], settings: { ...harnessDream, rounds: 2 } }));
    s = answer(answer(s, selected(1)).state, { kind: "refined", result: { edits: addVerify, raw: "{}" } }).state;
    const reject = pending(s, "reject");
    expect(reject.record.evidence).toEqual({ round: 1, trajectories: [{ id: "tr0", score: null }], score: null, retained: null, gates: [{ gate: "evidence", pass: false, reason: expect.any(String) }], repaired: [] });
    s = answer(s, { kind: "recorded" }).state;
    const reasons = pending(answer(s, selected(1)).state, "refine").request.consolidation?.rejectionReasons.split("\n");
    expect(reasons?.[0]).toMatch(/^- [0-9a-f]{12}: rejected by evidence: no evidence for: /);
    expect(reasons?.[1]).toBe(`- ${structural.id.slice(0, 12)}: structural failure: cycle: loop`);
  });

  it("PD1.69 the edit filter compares with tool observations, not with the agent's own words", () => {
    const quoted = "the quick brown fox jumps over the lazy dog today";
    const withTexts = (assistant: string, tool: string) => ({
      kind: "selected" as const,
      trajectories: [ScoredTrajectorySchema.parse({ id: "tr", graph: GRAPH, core: G0_ID, overlay: 0, session: "s", turn: "t", query: "q", steps: [{ role: "assistant", content: assistant }, { role: "tool", content: tool }, { role: "observation", content: "an observation that is long enough to share eight words here" }], score: null, scoreSource: null, localization: { matched: 0, fallback: 0, inert: 0 }, usage: { steps: 0, inputTokens: 0, outputTokens: 0, guidanceTokens: 0 } })],
    });
    const echo = (guidance: string) => edits({ add_edges: [{ source: "Scan_Index", target: "End", relation: "LEADS_TO", condition: null, guidance, pitfalls: "" }] });
    const run = (assistant: string, tool: string, guidance: string) => answer(answer(dreamStart(harness({ settings: { ...harnessDream, gate: ["structure"] } })), withTexts(assistant, tool)).state, { kind: "refined", result: { edits: echo(guidance), raw: "{}" } }).state.pending[0]!.kind;
    expect(run("x", quoted, quoted)).toBe("reject");
    expect(run(quoted, "y", quoted)).toBe("commit");
    expect(run("x", "y", "an observation that is long enough to share eight words here")).toBe("reject");
  });

  it("PD1.70 a rejected candidate equal to G₀ or to a commit of this dream is kept in memory, never stored over it", () => {
    const committedC1 = (rounds: number) => {
      let s = paperAfterS0([0.5], { settings: { ...paperDream, rounds } });
      s = refineWith(s, { edits: addVerify, raw: "{}" }).state;
      s = answer(s, validation([0.6])).state;
      return answer(s, { kind: "committed", ok: true }).state;
    };
    const undo = edits({ delete_nodes: ["Verify"], add_edges: [{ source: "Bridge_Extract", target: "End", relation: "CONVERGES_TO", condition: null, guidance: "After Bridge_Extract, go to End.", pitfalls: "Do not skip End." }] });
    let s = refineWith(committedC1(2), { edits: undo, raw: "{}" }).state;
    expect(pending(s, "evaluate").revision).toBe(G0_ID);
    s = answer(s, validation([0.1])).state;
    expect(s.rejections.at(-1)?.id).toBe(G0_ID);
    expect(pending(s, "done")).toBeDefined();
    // Commit C1, then C2; a candidate that returns to C1 is rejected and not stored.
    let t = committedC1(3);
    const c1 = t.retained.revision;
    t = refineWith(t, { edits: renameGuidance("Go."), raw: "{}" }).state;
    t = answer(answer(t, validation([0.7])).state, { kind: "committed", ok: true }).state;
    const restore = edits({ delete_edges: [{ source: "Start", target: "First_Hop_Retrieve" }], add_edges: [{ source: "Start", target: "First_Hop_Retrieve", relation: "LEADS_TO", condition: null, guidance: "After Start, go to First_Hop_Retrieve.", pitfalls: "Do not skip First_Hop_Retrieve." }] });
    t = refineWith(t, { edits: restore, raw: "{}" }).state;
    expect(pending(t, "evaluate").revision).toBe(c1);
    t = answer(t, validation([0.1])).state;
    expect(t.rejections.at(-1)?.id).toBe(c1);
    expect(pending(t, "done")).toBeDefined();
  });

  it("PD1.71 with dedupe a different earlier rejection does not stop evaluation, and an unchanged candidate is not evaluated", () => {
    const other = RevisionRecordSchema.parse({ id: revisionId(graphOf(hotpotWith((d) => d.edges.push(edge("Start", "End"))))), graph: GRAPH, parents: [G0_ID], document: graphOf(hotpotWith((d) => d.edges.push(edge("Start", "End")))), edits: null, origin: "dream", evidence: {}, decision: { kind: "rejected-gate", gate: "g", reason: "r" }, at: 1 });
    const withEvaluator = harness({ evaluator: true, rejections: [other], settings: { ...harnessDream, gate: ["structure", "evaluator-anchored-noninferiority?"] } });
    let s = answer(dreamStart(withEvaluator), validation([0.5, 0.5])).state;
    s = answer(s, rolled([1])).state;
    expect(pending(answer(s, { kind: "refined", result: { edits: renameGuidance("Go."), raw: "{}" } }).state, "evaluate")).toBeDefined();
    const unchanged = answer(s, { kind: "refined", result: { edits: edits({}), raw: "{}" } }).state;
    expect(unchanged.rounds).toEqual([{ round: 1, outcome: "unchanged", score: 0.5 }]);
    expect(pending(unchanged, "rollout")).toBeDefined();
  });

  it("PD1.72 approval listed alone asks for every candidate, even one that routes into no tool; a missing evaluator is a failed gate", () => {
    const s = answer(answer(dreamStart(harness({ approver: true, settings: { ...harnessDream, gate: ["approval"] } })), selected(1)).state, { kind: "refined", result: { edits: addVerify, raw: "{}" } }).state;
    expect(pending(s, "approve").tools).toEqual([]);
    const noEval = answer(answer(dreamStart(harness({ settings: { ...harnessDream, gate: ["evaluator-at-least-retained"] } })), selected(1)).state, { kind: "refined", result: { edits: renameGuidance("Go."), raw: "{}" } }).state;
    expect(pending(noEval, "reject").record.evidence).toMatchObject({ gates: [{ gate: "evaluator-at-least-retained", pass: false }] });
    expect(() => dreamStep(s, { command: pending(s, "approve").id, at: 1, kind: "recorded" })).toThrow("command 2 (approve) cannot finish with a recorded event");
  });
});

describe("composition in dream (plan §7.6)", () => {
  const PATH = ["First_Hop_Retrieve", "Scan_Index"] as const;
  const workflow = parseWorkflow({ name: "first-hop-retrieve-scan-index-0badf00d", description: "Runs First_Hop_Retrieve → Scan_Index in one call.", inputs: {}, code: "return {};" });
  const composition = () => {
    const c = composeCandidate(G0, PATH.map((n) => NodeNameSchema.parse(n)), workflow);
    if (!c.ok) throw new Error(c.error);
    return c;
  };
  const composed = (support = 3) => {
    const c = composition();
    return { kind: "composed" as const, result: { path: PATH.map((n) => NodeNameSchema.parse(n)), support, node: c.node, binding: c.binding, edits: c.edits } };
  };
  const composing = (overrides: Partial<DreamInput> = {}): DreamInput =>
    input({ settings: { ...harnessDream, rounds: 1 }, evaluator: false, approver: true, compose: true, overlay: { state: foldAll(G0_ID, []), live: harnessLive }, tools: ["first_hop_retrieve", "Scan_Index"], ...overrides });
  /** Runs the one refine round to an unchanged candidate, so the next command is the composition round's. */
  const toCompose = (overrides: Partial<DreamInput> = {}): DreamState => {
    const selected = { kind: "selected" as const, trajectories: [] };
    return answer(answer(dreamStart(composing(overrides)), selected).state, { kind: "refined", result: { edits: edits({}), raw: "{}" } }).state;
  };

  it("PD1.74 after the last round a composing dream asks for a composition of the retained graph, naming the rejections it knows", () => {
    const s = toCompose();
    expect(s.rounds).toEqual([{ round: 1, outcome: "unchanged", score: null }]);
    expect(pending(s, "compose")).toMatchObject({ kind: "compose", revision: G0_ID, graph: G0, known: [] });
    expect(s.round).toBe(2);
    // Without `compose` (every preset the runner gives no composer) the dream ends after its rounds.
    expect(pending(toCompose({ compose: false }), "done").result.rounds).toHaveLength(1);
    // An unparsed answer is remembered without an id, so it is no known candidate.
    const unparsed = answer(answer(dreamStart(composing()), { kind: "selected", trajectories: [] }).state, { kind: "refined", result: { error: "not JSON", raw: "?" } }).state;
    expect(pending(unparsed, "compose").known).toEqual([]);
  });

  it("PD1.75 a composition is gated as any candidate: its path's support is its evidence, approval covers the workflow it routes into, and the commit binds it", () => {
    let s = answer(toCompose(), composed(), 2000).state;
    const approve = pending(s, "approve");
    expect(approve.tools).toEqual([workflow.name]);
    expect(approve.candidate.document.nodes.find((n) => n.id === workflow.name)?.binding).toEqual(composition().binding);
    s = answer(s, { kind: "approved", approved: true }).state;
    const commit = pending(s, "commit");
    expect(commit.record).toMatchObject({
      id: revisionId(composition().document),
      document: composition().document,
      edits: composition().edits,
      parents: [G0_ID],
      decision: { kind: "head" },
      evidence: { round: 2, composition: { path: [...PATH], node: workflow.name, support: 3 }, gates: [{ gate: "evidence", pass: true }, { gate: "approval-for-side-effects", pass: true }] },
    });
    s = answer(s, { kind: "committed", ok: true }).state;
    // The retained graph, which the overlay rebases onto, is the bound document.
    expect(pending(s, "rebase").core).toEqual(composition().document);
    expect(s.retained.graph.nodes.find((n) => n.id === workflow.name)?.binding).toEqual(composition().binding);
    s = answer(s, { kind: "rebased", event: { kind: "rebased", core: commit.record.id, absorbed: [], dropped: [], frozenAt: 0 } }).state;
    expect(pending(s, "done").result).toMatchObject({ head: commit.record.id, rounds: [{ round: 1, outcome: "unchanged" }, { round: 2, outcome: "committed", revision: commit.record.id }] });
  });

  it("PD1.76 a composition without enough support fails the evidence gate; one declined is rejected; none to compose ends the dream", () => {
    const weak = answer(toCompose(), composed(2)).state;
    expect(pending(weak, "reject").record).toMatchObject({ document: composition().document, decision: { kind: "rejected-gate", gate: "evidence" }, evidence: { composition: { support: 2 } } });
    const declined = answer(answer(toCompose(), composed()).state, { kind: "approved", approved: false }).state;
    expect(pending(declined, "reject").record.decision).toEqual({ kind: "rejected-gate", gate: "approval-for-side-effects", reason: "declined by the approver" });
    const none = answer(toCompose(), { kind: "composed", result: { none: "no path has the support" } }).state;
    expect(pending(none, "done").result.rounds).toEqual([
      { round: 1, outcome: "unchanged", score: null },
      { round: 2, outcome: "no-composition", reason: "no path has the support" },
    ]);
  });

  it("PD1.77 a composed candidate passes the structural checks, the catalog and the filter: a known rejection is not gated again, a filtered one is a structural rejection", () => {
    const known = RevisionRecordSchema.parse({ id: revisionId(composition().document), graph: GRAPH, parents: [G0_ID], document: composition().document, edits: composition().edits, origin: "dream", evidence: {}, decision: { kind: "rejected-gate", gate: "approval", reason: "no" }, at: 1 });
    const s = toCompose({ rejections: [known] });
    expect(pending(s, "compose").known).toEqual([known.id]);
    expect(answer(s, composed()).state.rounds.at(-1)).toEqual({ round: 2, outcome: "known-rejection", revision: known.id });
    const leaky = composed();
    const tainted = { ...leaky, result: { ...leaky.result, edits: { ...leaky.result.edits, add_nodes: [{ ...leaky.result.edits.add_nodes[0]!, description: "Runs it; see https://evil.example/x" }] } } };
    const rejected = answer(toCompose(), tainted).state;
    expect(pending(rejected, "reject").record.decision).toMatchObject({ kind: "rejected-structure", diagnostics: [{ code: "filtered", at: "edits.add_nodes[0].description" }] });
    expect(pending(rejected, "reject").record.document.nodes.find((n) => n.id === workflow.name)?.binding).toEqual(composition().binding);
    const dangling = { ...leaky, result: { ...leaky.result, edits: { ...leaky.result.edits, add_edges: [...leaky.result.edits.add_edges, { ...leaky.result.edits.add_edges[0]!, target: NodeNameSchema.parse("Ghost") }] } } };
    expect(pending(answer(toCompose(), dangling).state, "reject").record.decision).toMatchObject({ kind: "rejected-structure", diagnostics: [{ code: "missing-endpoint" }] });
  });

  it("PD1.78 with a tokenizer the context keeps the last contextTokens tokens it counts, not whitespace words", () => {
    const chars = { encode: (text: string) => Array.from(text, (c) => c.codePointAt(0)!), decode: (ids: readonly number[]) => String.fromCodePoint(...ids) };
    expect(tailTokens("one two three", 5, chars)).toBe("three");
    expect(tailTokens("one two three", 13, chars)).toBe("one two three");
    expect(tailTokens("one two three", 2)).toBe("two three");
    // A text within the limit is kept as it is, never decoded again.
    const lossy = { ...chars, decode: (ids: readonly number[]) => `~${String.fromCodePoint(...ids)}` };
    expect([tailTokens("one two three", 13, lossy), tailTokens("one two three", 14, lossy), tailTokens("one two three", 5, lossy)]).toEqual(["one two three", "one two three", "~three"]);
    const s = answer(dreamStart(input({ settings: { ...paperDream, contextTokens: 6 }, tokenizer: chars })), validation([0.5])).state;
    const refining = answer(s, rolled([1])).state;
    expect(pending(refining, "refine").request.attempts).toBe("rved 0");
  });
});

function hotpotWith(change: (d: ReturnType<typeof hotpot>) => void): ReturnType<typeof hotpot> {
  const d = hotpot();
  change(d);
  return d;
}
