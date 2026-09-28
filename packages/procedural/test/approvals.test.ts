import { describe, expect, it } from "vitest";
import {
  applyEdits,
  approvalInbox,
  approveCandidate,
  composeCandidate,
  declineCandidate,
  decidedNotice,
  foldAll,
  listApprovals,
  MemoryProceduralStore,
  NodeNameSchema,
  parseGraph,
  prepareCandidate,
  presetOf,
  rebaseOverlay,
  requestedNotice,
  revisionId,
  RevisionRecordSchema,
} from "@harness/procedural";
import type { ApprovalNotice, CandidateDocument, EditSet, OverlayEvent, Preset, ProceduralGraph, ProceduralStore, RevisionId, RevisionRecord } from "@harness/procedural";
import { parseWorkflow } from "@harness/workflows";
import { core, DREAM, edits, GRAPH, graphOf, renameGuidance, settings } from "./dream-fixtures.ts";
import { FakeStore } from "./dream-store.ts";
import { hotpot } from "./fixtures.ts";
import { observed } from "./overlay-fixtures.ts";

const G0 = core();
const G0_ID = revisionId(G0);
const harness = presetOf(settings, "harness");
const clock = { now: () => 5_000 };
/** Loops back from the bridge to retrieval: a new edge into a side-effecting tool. */
const toTool = edits({ add_edges: [{ source: "Bridge_Extract", target: "First_Hop_Retrieve", relation: "LEADS_TO", condition: null, guidance: "Retrieve again.", pitfalls: "" }] });
/** Three distinct sessions walked the loop: the evidence the gate needs for it. */
const support = (): OverlayEvent[] => Array.from({ length: 3 }, (_, i) => observed(`s${i}/t`, ["Bridge_Extract", "First_Hop_Retrieve"], null));
const H1 = graphOf({ ...hotpot(), edges: hotpot().edges.map((e, i) => (i === 0 ? { ...e, guidance: "Go." } : e)) });
/** A document known to parse, as a graph. */
const parsed = (doc: CandidateDocument): ProceduralGraph => {
  const p = parseGraph(doc);
  if (!p.ok) throw new Error(JSON.stringify(p.diagnostics));
  return p.graph;
};
/** An expert's document: the hotpot core with another description. */
const EXPERT = graphOf({ ...hotpot(), nodes: hotpot().nodes.map((n, i) => (i === 2 ? { ...n, description: "Scan every passage." } : n)) });

async function headed(store: ProceduralStore = new MemoryProceduralStore(), events: OverlayEvent[] = support()): Promise<ProceduralStore> {
  await store.revisions.put(RevisionRecordSchema.parse({ id: G0_ID, graph: GRAPH, parents: [], document: G0, edits: null, origin: "import", evidence: {}, decision: { kind: "head" }, at: 0 }));
  await store.heads.set(GRAPH, undefined, G0_ID);
  if (events.length > 0) await store.overlay(GRAPH).append(events);
  return store;
}

/** Move the head to `next` as a dream would: its record, the compare-and-set, the overlay rebased onto it. */
async function moveHead(store: ProceduralStore, next: ProceduralGraph): Promise<RevisionId> {
  const head = (await store.heads.get(GRAPH))!;
  const id = revisionId(next);
  await store.revisions.put(RevisionRecordSchema.parse({ id, graph: GRAPH, parents: [head.revision], document: next, edits: null, origin: "dream", evidence: {}, decision: { kind: "head" }, at: 1 }));
  await store.heads.set(GRAPH, head.revision, id);
  const log = store.overlay(GRAPH);
  await log.append([rebaseOverlay(foldAll(G0_ID, (await log.read(0)).map((e) => e.event)), next, []).event]);
  return id;
}

function proposal(fields: { edits?: EditSet; document?: CandidateDocument; at?: number; parent?: RevisionId; evidence?: Record<string, unknown>; origin?: "dream" | "import" } = {}): RevisionRecord {
  const document = fields.document ?? prepareCandidate(G0, fields.edits ?? toTool, { cycles: "allowed" }).document;
  const origin = fields.origin ?? "dream";
  return RevisionRecordSchema.parse({
    id: revisionId(document),
    graph: GRAPH,
    parents: [fields.parent ?? G0_ID],
    document,
    edits: origin === "import" ? null : (fields.edits ?? toTool),
    origin,
    ...(origin === "dream" ? { dream: DREAM } : {}),
    evidence: fields.evidence ?? (origin === "dream" ? { round: 1, approval: { gate: "approval-for-side-effects", tools: ["first_hop_retrieve"] } } : {}),
    decision: { kind: "pending-approval" },
    at: fields.at ?? 10,
  });
}

describe("the approvals inbox", () => {
  it("PX2.66 lists a graph's candidates waiting for approval, dream and import proposals alike, oldest first, with the gate and tools that asked and whether each is on the head", async () => {
    const store = await headed();
    const dreamt = proposal({ at: 20 });
    const imported = proposal({ document: EXPERT, origin: "import", at: 10 });
    await store.revisions.put(dreamt);
    await store.revisions.put(imported);
    await store.revisions.put({ ...proposal({ edits: renameGuidance("Hi.") }), decision: { kind: "rejected-gate", gate: "approval", reason: "no" } });
    await store.revisions.put({ ...proposal({ edits: renameGuidance("Yo.") }), graph: (await import("@harness/procedural")).GraphIdSchema.parse("other/graph") });
    expect(await listApprovals({ store, graph: GRAPH })).toStrictEqual({
      graph: GRAPH,
      head: G0_ID,
      approvals: [
        { candidate: imported.id, graph: GRAPH, origin: "import", parent: G0_ID, onHead: true, at: 10, edits: null, tools: [] },
        { candidate: dreamt.id, graph: GRAPH, origin: "dream", parent: G0_ID, onHead: true, dream: DREAM, at: 20, edits: toTool, gate: "approval-for-side-effects", tools: ["first_hop_retrieve"] },
      ],
    });
    await moveHead(store, H1);
    expect((await listApprovals({ store, graph: GRAPH })).approvals.map((a) => a.onHead)).toEqual([false, false]);
    expect(await listApprovals({ store: new MemoryProceduralStore(), graph: GRAPH })).toStrictEqual({ graph: GRAPH, approvals: [] });
    const orphan = RevisionRecordSchema.parse({ ...proposal(), parents: [] });
    const lone = new MemoryProceduralStore();
    await lone.revisions.put(orphan);
    expect((await listApprovals({ store: lone, graph: GRAPH })).approvals).toEqual([expect.objectContaining({ parent: null, onHead: false })]);
  });

  it("PX2.67 approving a candidate proposed on the head re-runs structure and evidence there, commits it by compare-and-set and rebases the overlay onto it", async () => {
    const store = await headed();
    const record = proposal();
    await store.revisions.put(record);
    expect(await approveCandidate({ store, record, preset: harness, clock })).toEqual({ status: "committed", graph: GRAPH, candidate: record.id, revision: record.id, previous: G0_ID });
    expect(await store.heads.get(GRAPH)).toEqual({ revision: record.id, history: [G0_ID] });
    expect(await store.revisions.get(record.id)).toMatchObject({
      parents: [G0_ID],
      origin: "dream",
      dream: DREAM,
      edits: toTool,
      decision: { kind: "head" },
      at: 5_000,
      evidence: { round: 1, approved: { candidate: record.id, on: G0_ID, gates: [{ gate: "structure", pass: true }, { gate: "evidence", pass: true }] } },
    });
    const events = (await store.overlay(GRAPH).read(0)).map((e) => e.event);
    expect(events.at(-1)).toMatchObject({ kind: "rebased", core: record.id, frozenAt: 3 });
    expect((await listApprovals({ store, graph: GRAPH })).approvals).toEqual([]);
  });

  it("PX2.68 a candidate proposed on an earlier head is its edits on the current head: that revision commits, carrying a composition's workflow binding, and the proposal is marked approved as it", async () => {
    const store = await headed();
    const record = proposal();
    await store.revisions.put(record);
    const h1 = await moveHead(store, H1);
    const result = await approveCandidate({ store, record, preset: harness, clock });
    const rebased = revisionId(applyEdits(H1, toTool));
    expect(result).toEqual({ status: "committed", graph: GRAPH, candidate: record.id, revision: rebased, previous: h1 });
    expect(rebased).not.toBe(record.id);
    expect(await store.revisions.get(rebased)).toMatchObject({ parents: [h1], decision: { kind: "head" }, evidence: { approved: { candidate: record.id, on: h1 } } });
    expect((await store.revisions.get(rebased))!.document.edges.find((e) => e.from === "Start")?.guidance).toBe("Go.");
    expect((await store.revisions.get(record.id))!.decision).toEqual({ kind: "approved", revision: rebased });

    // A composition: its workflow node keeps the binding the dream staged.
    const path = ["First_Hop_Retrieve", "Scan_Index"].map((n) => NodeNameSchema.parse(n));
    const workflow = parseWorkflow({ name: "first-hop-retrieve-scan-index-0badf00d", description: "Runs the path in one call.", inputs: {}, code: "return {};" });
    const composed = composeCandidate(G0, path, workflow);
    if (!composed.ok) throw new Error(composed.error);
    const composing = await headed(new MemoryProceduralStore(), []);
    const candidate = proposal({ edits: composed.edits, document: composed.document, evidence: { composition: { path, node: composed.node, support: 3 } } });
    await composing.revisions.put(candidate);
    await moveHead(composing, H1);
    const bound = await approveCandidate({ store: composing, record: candidate, preset: harness, clock });
    expect(bound).toMatchObject({ status: "committed" });
    const node = (await composing.revisions.get((bound as { revision: RevisionId }).revision))!.document.nodes.find((n) => n.id === composed.node);
    expect(node?.binding).toEqual(composed.binding);
  });

  it("PX2.69 the evidence gate reads the live overlay on the current head: without the evidence now, or with an overlay not yet on the head, the candidate is refused and keeps waiting", async () => {
    const bare = await headed(new MemoryProceduralStore(), []);
    const record = proposal();
    await bare.revisions.put(record);
    const refused = await approveCandidate({ store: bare, record, preset: harness, clock });
    expect(refused).toMatchObject({ status: "refused", graph: GRAPH, candidate: record.id, gate: "evidence", reason: expect.stringMatching(/^no evidence for: added edge Bridge_Extract → First_Hop_Retrieve/) });
    expect((await bare.revisions.get(record.id))!.decision).toEqual({ kind: "pending-approval" });
    expect(await bare.heads.get(GRAPH)).toEqual({ revision: G0_ID, history: [] });

    // The head moved and its rebase has not landed.
    const behind = await headed();
    await behind.revisions.put(record);
    const h1 = revisionId(H1);
    await behind.revisions.put(RevisionRecordSchema.parse({ id: h1, graph: GRAPH, parents: [G0_ID], document: H1, edits: null, origin: "dream", evidence: {}, decision: { kind: "head" }, at: 1 }));
    await behind.heads.set(GRAPH, G0_ID, h1);
    expect(await approveCandidate({ store: behind, record, preset: harness, clock })).toMatchObject({ status: "refused", gate: "evidence", reason: `no live evidence yet: the overlay is not rebased onto the head ${h1}` });

    // A preset without an overlay has no evidence to show; one that does not list the gate does not ask.
    expect(await approveCandidate({ store: await headed(), record, preset: { ...harness, overlay: false }, clock })).toMatchObject({ status: "refused", gate: "evidence", reason: "no live evidence: the preset has no overlay" });
    const noLive: Preset = { ...harness, live: undefined } as unknown as Preset;
    expect(await approveCandidate({ store: await headed(), record, preset: noLive, clock })).toMatchObject({ status: "refused", gate: "evidence" });
    const ungated: Preset = { ...harness, dream: { ...harness.dream, gate: ["structure", "approval"] } };
    expect(await approveCandidate({ store: await headed(new MemoryProceduralStore(), []), record, preset: ungated, clock })).toMatchObject({ status: "committed", revision: record.id });
    const onetime: Preset = { ...harness, dream: { ...harness.dream, mode: "onetime" } };
    expect(await approveCandidate({ store: await headed(new MemoryProceduralStore(), []), record, preset: onetime, clock })).toMatchObject({ status: "committed" });
  });

  it("PX2.70 the structure gate: edits that no longer apply to the current head are refused and keep waiting; an import is checked whole under the preset's cycle policy and needs no live evidence", async () => {
    const store = await headed();
    const record = proposal({ edits: edits({ delete_nodes: ["Bridge_Extract"], add_edges: [{ source: "Scan_Index", target: "End", relation: "LEADS_TO", condition: null, guidance: "Answer.", pitfalls: "" }] }) });
    await store.revisions.put(record);
    // The head dropped the node the candidate deletes.
    await moveHead(store, graphOf({ ...hotpot(), nodes: hotpot().nodes.filter((n) => n.id !== "Bridge_Extract"), edges: [...hotpot().edges.slice(0, 2), { ...hotpot().edges[3]!, from: "Scan_Index" }] }));
    expect(await approveCandidate({ store, record, preset: harness, clock })).toMatchObject({ status: "refused", gate: "structure", reason: expect.stringContaining("delete_nodes names Bridge_Extract, which is not a node") });
    expect((await store.revisions.get(record.id))!.decision).toEqual({ kind: "pending-approval" });

    const cyclic = applyEdits(G0, toTool);
    const imported = proposal({ document: cyclic, origin: "import" });
    const bare = await headed(new MemoryProceduralStore(), []);
    await bare.revisions.put(imported);
    const forbidding: Preset = { ...harness, dream: { ...harness.dream, cycles: "forbidden" } };
    expect(await approveCandidate({ store: bare, record: imported, preset: forbidding, clock })).toMatchObject({ status: "refused", gate: "structure", reason: expect.stringMatching(/cycle/) });
    expect(await approveCandidate({ store: bare, record: imported, preset: harness, clock })).toEqual({ status: "committed", graph: GRAPH, candidate: imported.id, revision: imported.id, previous: G0_ID });
    expect(await bare.revisions.get(imported.id)).toMatchObject({ origin: "import", edits: null, evidence: { approved: { gates: [{ gate: "structure", pass: true }] } } });
  });

  it("PX2.71 a lost compare-and-set refuses the approval, puts back what the revision id held, and the candidate keeps waiting", async () => {
    const store = (await headed(new FakeStore())) as FakeStore;
    const record = proposal();
    await store.revisions.put(record);
    const h1 = revisionId(H1);
    store.beforeHeadSet = () => {
      store.headOf.set(GRAPH, { revision: h1, history: [G0_ID] });
    };
    expect(await approveCandidate({ store, record, preset: harness, clock })).toEqual({ status: "refused", graph: GRAPH, candidate: record.id, gate: "head", reason: `the head of graph ${GRAPH} moved; try again` });
    expect(store.records.get(record.id)).toEqual(record);

    // Rebased onto a new head, the lost race leaves a record the id did not hold as the dream does: rejected by `head`.
    const moved = (await headed(new FakeStore())) as FakeStore;
    await moved.revisions.put(record);
    await moveHead(moved, H1);
    moved.beforeHeadSet = () => {
      moved.headOf.set(GRAPH, { revision: G0_ID, history: [] });
    };
    const rebased = revisionId(applyEdits(H1, toTool));
    expect(await approveCandidate({ store: moved, record, preset: harness, clock })).toMatchObject({ status: "refused", gate: "head" });
    expect(moved.records.get(rebased)!.decision).toEqual({ kind: "rejected-gate", gate: "head", reason: "the head moved during the approval" });
    expect(moved.records.get(record.id)).toEqual(record);
  });

  it("PX2.72 a candidate the head already has is unchanged and marked approved as the head; one not waiting, redacted, or on a graph without a readable head is refused", async () => {
    const store = await headed();
    const record = proposal();
    await store.revisions.put(record);
    // Another dream already made the candidate's change, on a head that moved.
    await moveHead(store, H1);
    const head = await moveHead(store, parsed(applyEdits(H1, toTool)));
    expect(await approveCandidate({ store, record, preset: harness, clock })).toEqual({ status: "unchanged", graph: GRAPH, candidate: record.id, head });
    expect((await store.revisions.get(record.id))!.decision).toEqual({ kind: "approved", revision: head });

    // A node and edges the head already has are not added twice; a rewrite (delete, then add) still applies.
    const onVerify = edits({
      add_nodes: [{ id: "Verify", type: "REASONING", description: "Check." }],
      delete_edges: [{ source: "Start", target: "First_Hop_Retrieve" }],
      add_edges: [
        { source: "Bridge_Extract", target: "Verify", relation: "LEADS_TO", condition: null, guidance: "Check.", pitfalls: "" },
        { source: "Verify", target: "End", relation: "LEADS_TO", condition: null, guidance: "Answer.", pitfalls: "" },
        { source: "Start", target: "First_Hop_Retrieve", relation: "LEADS_TO", condition: null, guidance: "Go.", pitfalls: "" },
      ],
    });
    const verifying = await headed(new MemoryProceduralStore(), []);
    const candidate = proposal({ edits: onVerify });
    await verifying.revisions.put(candidate);
    // The head already verifies (and describes a node otherwise); it lacks the rewrite.
    const had = await moveHead(verifying, parsed(applyEdits(EXPERT, { ...onVerify, delete_edges: [], add_edges: onVerify.add_edges.slice(0, 2) })));
    const ungated: Preset = { ...harness, dream: { ...harness.dream, gate: ["approval"] } };
    expect(await approveCandidate({ store: verifying, record: candidate, preset: ungated, clock })).toMatchObject({ status: "committed", previous: had });
    const committed = (await verifying.heads.get(GRAPH))!.revision;
    const doc = (await verifying.revisions.get(committed))!.document;
    expect(doc.nodes.filter((n) => n.id === "Verify")).toHaveLength(1);
    expect(doc.edges.filter((e) => e.to === "Verify" || e.from === "Verify")).toHaveLength(2);
    expect(doc.edges.filter((e) => e.from === "Start")).toEqual([expect.objectContaining({ guidance: "Go." })]);

    const decided = RevisionRecordSchema.parse({ ...record, decision: { kind: "head" } });
    expect(await approveCandidate({ store, record: decided, preset: harness, clock })).toStrictEqual({ status: "refused", graph: GRAPH, candidate: record.id, reason: `candidate ${record.id} is not waiting for approval (its decision is head)` });
    expect(await approveCandidate({ store, record: { ...record, redacted: true }, preset: harness, clock })).toMatchObject({ status: "refused", reason: `candidate ${record.id} is redacted` });
    expect(await approveCandidate({ store: new MemoryProceduralStore(), record, preset: harness, clock })).toMatchObject({ status: "refused", reason: `graph ${GRAPH} has no head` });
    const headless = new MemoryProceduralStore();
    await headless.heads.set(GRAPH, undefined, G0_ID);
    expect(await approveCandidate({ store: headless, record, preset: harness, clock })).toMatchObject({ status: "refused", reason: `the head ${G0_ID} of graph ${GRAPH} is missing or does not parse (it may be redacted)` });
  });

  it("PX2.73 declining rejects the candidate under the gate that asked (approval for an import), so dream remembers it; a candidate not waiting is refused", async () => {
    const store = await headed();
    const record = proposal();
    await store.revisions.put(record);
    expect(await declineCandidate({ store, record })).toEqual({ status: "declined", graph: GRAPH, candidate: record.id });
    expect((await store.revisions.get(record.id))!.decision).toEqual({ kind: "rejected-gate", gate: "approval-for-side-effects", reason: "declined by the approver" });
    const imported = proposal({ document: H1, origin: "import" });
    await store.revisions.put(imported);
    await declineCandidate({ store, record: imported });
    expect((await store.revisions.get(imported.id))!.decision).toEqual({ kind: "rejected-gate", gate: "approval", reason: "declined by the approver" });
    const decided = (await store.revisions.get(record.id))!;
    expect(await declineCandidate({ store, record: decided })).toStrictEqual({ status: "refused", graph: GRAPH, candidate: record.id, reason: `candidate ${record.id} is not waiting for approval (its decision is rejected-gate)` });
    expect(await store.heads.get(GRAPH)).toEqual({ revision: G0_ID, history: [] });
  });

  it("PX2.74 notices: a proposal is requested (what the inbox lists), a decision is decided with the revision it became; the dream's inbox port sends requested notices", async () => {
    const record = proposal();
    const requested: ApprovalNotice = { type: "procedural.approval.requested", payload: { graph: GRAPH, candidate: record.id, origin: "dream", parent: G0_ID, dream: DREAM, gate: "approval-for-side-effects", tools: ["first_hop_retrieve"] } };
    expect(requestedNotice(record)).toEqual(requested);
    expect(requestedNotice(proposal({ document: H1, origin: "import" }))).toStrictEqual({ type: "procedural.approval.requested", payload: { graph: GRAPH, candidate: revisionId(H1), origin: "import", parent: G0_ID, tools: [] } });
    const base = { graph: GRAPH, candidate: record.id };
    expect(decidedNotice({ status: "committed", ...base, revision: G0_ID, previous: G0_ID })).toEqual({ type: "procedural.approval.decided", payload: { ...base, decision: "approved", revision: G0_ID } });
    expect(decidedNotice({ status: "unchanged", ...base, head: G0_ID })).toEqual({ type: "procedural.approval.decided", payload: { ...base, decision: "approved", revision: G0_ID } });
    expect(decidedNotice({ status: "declined", ...base })).toStrictEqual({ type: "procedural.approval.decided", payload: { ...base, decision: "declined" } });
    expect(decidedNotice({ status: "refused", ...base, reason: "no" })).toBeUndefined();
    const sent: ApprovalNotice[] = [];
    await approvalInbox((n) => void sent.push(n)).pending({ graph: GRAPH, candidate: record, tools: ["first_hop_retrieve"] });
    expect(sent).toEqual([requested]);
  });

  describe("rebasing a candidate's edits", () => {
    /** G₀ with a Verify step between the bridge and the answer. */
    const verifying = () => parsed(applyEdits(G0, edits({
      add_nodes: [{ id: "Verify", type: "REASONING", description: "Check." }],
      add_edges: [
        { source: "Bridge_Extract", target: "Verify", relation: "LEADS_TO", condition: null, guidance: "Check.", pitfalls: "" },
        { source: "Verify", target: "End", relation: "LEADS_TO", condition: null, guidance: "Answer.", pitfalls: "" },
      ],
    })));

    it("PX2.80 what the edits delete and add back is not taken for something the head already has: re-adding it after the deletion is kept, so a head that already made the change is unchanged", async () => {
      const P = verifying();
      // Rebuild Verify with new texts, and rewrite Start's edge: deletions, then the same things added back.
      const rebuild = edits({
        delete_nodes: ["Verify"],
        delete_edges: [{ source: "Start", target: "First_Hop_Retrieve" }],
        add_nodes: [{ id: "Verify", type: "REASONING", description: "Check." }],
        add_edges: [
          { source: "Bridge_Extract", target: "Verify", relation: "LEADS_TO", condition: null, guidance: "Check the bridge.", pitfalls: "" },
          { source: "Verify", target: "End", relation: "LEADS_TO", condition: null, guidance: "Answer it.", pitfalls: "" },
          { source: "Start", target: "First_Hop_Retrieve", relation: "LEADS_TO", condition: null, guidance: "Go.", pitfalls: "" },
        ],
      });
      const store = await headed(new MemoryProceduralStore(), []);
      await moveHead(store, P);
      const record = RevisionRecordSchema.parse({ ...proposal({ edits: rebuild, document: applyEdits(P, rebuild), parent: revisionId(P) }) });
      await store.revisions.put(record);
      // The head made exactly that change, and also rewrote a description.
      const done = parsed({ ...applyEdits(P, rebuild), nodes: applyEdits(P, rebuild).nodes.map((n) => (n.id === "Scan_Index" ? { ...n, description: "Scan every passage." } : n)) });
      const head = await moveHead(store, done);
      const ungated: Preset = { ...harness, dream: { ...harness.dream, gate: ["approval"] } };
      expect(await approveCandidate({ store, record, preset: ungated, clock })).toEqual({ status: "unchanged", graph: GRAPH, candidate: record.id, head });
    });

    it("PX2.81 on the head it was proposed on, a candidate is its stored document exactly; an import on a later head is its document with the new head as parent; a rebase follows the preset's cycle policy", async () => {
      // An edit set that adds an edge G₀ already has: the dream's document holds it twice, and that is what commits.
      const twice = edits({ add_edges: [{ source: "Start", target: "First_Hop_Retrieve", relation: "LEADS_TO", condition: null, guidance: "After Start, go to First_Hop_Retrieve.", pitfalls: "Do not skip First_Hop_Retrieve." }] });
      const doubled = proposal({ edits: twice });
      expect(doubled.document.edges.filter((e) => e.from === "Start")).toHaveLength(2);
      const ungated: Preset = { ...harness, dream: { ...harness.dream, gate: ["approval"] } };
      const store = await headed(new MemoryProceduralStore(), []);
      await store.revisions.put(doubled);
      expect(await approveCandidate({ store, record: doubled, preset: ungated, clock })).toMatchObject({ status: "committed", revision: doubled.id });

      const imported = proposal({ document: EXPERT, origin: "import" });
      const later = await headed(new MemoryProceduralStore(), []);
      await later.revisions.put(imported);
      const h1 = await moveHead(later, H1);
      expect(await approveCandidate({ store: later, record: imported, preset: harness, clock })).toEqual({ status: "committed", graph: GRAPH, candidate: imported.id, revision: imported.id, previous: h1 });
      expect(await later.revisions.get(imported.id)).toMatchObject({ parents: [h1], origin: "import", document: EXPERT });

      // Rebased under forbidden cycles, the loop back to retrieval is repaired away: nothing is left to add.
      const loop = await headed();
      const record = proposal();
      await loop.revisions.put(record);
      const moved = await moveHead(loop, H1);
      const forbidding: Preset = { ...harness, dream: { ...harness.dream, cycles: "forbidden" } };
      expect(await approveCandidate({ store: loop, record, preset: forbidding, clock })).toEqual({ status: "unchanged", graph: GRAPH, candidate: record.id, head: moved });
    });
  });
});
