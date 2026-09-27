import { describe, expect, it } from "vitest";
import {
  entryId,
  exportGraph,
  foldAll,
  GraphIdSchema,
  graphHistory,
  importGraph,
  parseGraph,
  readGraph,
  revertGraph,
  revisionId,
  RevisionIdSchema,
  RevisionRecordSchema,
  seedGraph,
} from "@harness/procedural";
import type { CandidateDocument, RevisionId } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";
import { cautionOnCore, entry, proposed, shortcut, status, toVerify, verifyNode } from "./overlay-fixtures.ts";
import { FakeStore } from "./store-fake.ts";

const graph = GraphIdSchema.parse("team/search");
const clock = { now: () => 1_000 };
const doc = (edit?: (d: ReturnType<typeof hotpot>) => void): CandidateDocument => {
  const d = hotpot();
  edit?.(d);
  const parsed = parseGraph(d);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.graph;
};
const shorter = () => doc((d) => (d.edges[3]!.guidance = "Answer."));
const other = () => doc((d) => (d.nodes[2]!.description = "Scan the passages carefully."));

/** A store whose graph has had these documents as heads, in order (each imported, then moved by a dream-like commit). */
async function withHeads(...docs: CandidateDocument[]): Promise<FakeStore> {
  const store = new FakeStore();
  let previous: RevisionId | undefined;
  for (const [i, d] of docs.entries()) {
    const id = revisionId(d);
    await store.revisions.put(RevisionRecordSchema.parse({ id, graph, parents: previous ? [previous] : [], document: d, edits: null, origin: i === 0 ? "import" : "dream", evidence: { round: i }, decision: { kind: "head" }, at: i }));
    await store.heads.set(graph, previous, id);
    previous = id;
  }
  return store;
}

describe("importGraph", () => {
  it("PX2.9 into a graph with no head, the document becomes head as an import revision with no parents", async () => {
    const store = new FakeStore();
    const result = await importGraph({ store, graph, document: hotpot(), clock });
    const id = revisionId(doc());
    expect(result).toEqual({ status: "head", revision: id });
    expect(await store.heads.get(graph)).toEqual({ revision: id, history: [] });
    expect(store.records.get(id)).toEqual({ id, graph, parents: [], document: doc(), edits: null, origin: "import", evidence: {}, decision: { kind: "head" }, at: 1_000 });
  });

  it("PX2.10 without a document it imports the scratch skeleton (Start → End)", async () => {
    const store = new FakeStore();
    expect(await importGraph({ store, graph, clock })).toEqual({ status: "head", revision: revisionId(seedGraph()) });
    expect(store.records.get(revisionId(seedGraph()))?.document).toEqual(seedGraph());
  });

  it("PX2.11 an invalid document is diagnosed and nothing is written; cycles are checked under the given policy", async () => {
    const store = new FakeStore();
    const malformed = await importGraph({ store, graph, document: { format: "other" }, clock });
    expect(malformed.status).toBe("invalid");
    expect(malformed.status === "invalid" && malformed.diagnostics.every((d) => d.code === "malformed")).toBe(true);
    const cyclic = hotpot();
    cyclic.edges.push({ from: "Scan_Index", relation: "LEADS_TO", to: "Start", condition: "retry", guidance: "", pitfalls: "" });
    expect(await importGraph({ store, graph, document: cyclic, clock, cycles: "allowed" })).toMatchObject({ status: "head" });
    const fresh = new FakeStore();
    const refused = await importGraph({ store: fresh, graph, document: cyclic, clock, cycles: "forbidden" });
    expect(refused).toMatchObject({ status: "invalid", diagnostics: [{ code: "cycle" }] });
    expect(fresh.records.size).toBe(0);
    expect(fresh.headOf.size).toBe(0);
  });

  it("PX2.12 into a graph with a head, the document is proposed to dream: a pending-approval import on the head, which stays", async () => {
    const store = await withHeads(doc());
    const head = revisionId(doc());
    const result = await importGraph({ store, graph, document: shorter(), clock });
    const id = revisionId(shorter());
    expect(result).toEqual({ status: "proposed", revision: id, head });
    expect(store.records.get(id)).toMatchObject({ origin: "import", parents: [head], edits: null, decision: { kind: "pending-approval" }, at: 1_000 });
    expect((await store.heads.get(graph))?.revision).toBe(head);
  });

  it("PX2.13 importing the head, or a revision the graph already recorded, is known and writes nothing", async () => {
    const store = await withHeads(doc(), shorter());
    const before = new Map(store.records);
    expect(await importGraph({ store, graph, document: shorter(), clock })).toEqual({ status: "known", revision: revisionId(shorter()), decision: { kind: "head" } });
    expect(await importGraph({ store, graph, document: doc(), clock })).toEqual({ status: "known", revision: revisionId(doc()), decision: { kind: "head" } });
    expect(store.records).toEqual(before);
  });

  it("PX2.14 a revision recorded under another graph is not known to this one", async () => {
    const store = await withHeads(doc());
    const elsewhere = GraphIdSchema.parse("elsewhere");
    await importGraph({ store, graph: elsewhere, document: other(), clock });
    expect(await importGraph({ store, graph, document: other(), clock })).toMatchObject({ status: "proposed" });
  });

  it("PX2.15 when another writer sets the head first, the import becomes a proposal on that head, or is known if it is the same revision", async () => {
    const store = new FakeStore();
    const theirs = revisionId(other());
    store.beforeSet = async () => void (await store.heads.set(graph, undefined, theirs));
    const result = await importGraph({ store, graph, document: hotpot(), clock });
    expect(result).toEqual({ status: "proposed", revision: revisionId(doc()), head: theirs });
    expect(store.records.get(revisionId(doc()))).toMatchObject({ parents: [theirs], decision: { kind: "pending-approval" } });

    const same = new FakeStore();
    same.beforeSet = async () => void (await same.heads.set(graph, undefined, revisionId(doc())));
    expect(await importGraph({ store: same, graph, document: hotpot(), clock })).toEqual({ status: "known", revision: revisionId(doc()), decision: { kind: "head" } });
  });
});

describe("readGraph and exportGraph", () => {
  it("PX2.16 reads the head with its overlay folded in: every entry that is not retired shows, probation included", async () => {
    const store = await withHeads(doc());
    const head = revisionId(doc());
    await store.overlay(graph).append([proposed(shortcut, ["s1"]), proposed(cautionOnCore, ["s1"]), status(entryId(entry(cautionOnCore)), "retired")]);
    const view = await readGraph({ store, graph });
    if (view.status !== "ok") throw new Error(view.reason);
    expect(view.head).toBe(head);
    expect(view.revision).toBe(head);
    expect(view.record.origin).toBe("import");
    expect(view.effective.overlay).toBe(3);
    expect(view.effective.edges.filter((e) => e.origin === "overlay")).toHaveLength(1);
    expect(view.effective.edges.every((e) => e.cautions.length === 0)).toBe(true);
  });

  it("PX2.17 a revision other than the head, an overlay left off, or an overlay on another base shows the core alone", async () => {
    const store = await withHeads(doc(), shorter());
    await store.overlay(graph).append([proposed(shortcut, ["s1"])]);
    const earlier = await readGraph({ store, graph, revision: revisionId(doc()) });
    expect(earlier).toMatchObject({ status: "ok", head: revisionId(shorter()), revision: revisionId(doc()), effective: { overlay: null } });
    expect(await readGraph({ store, graph, overlay: false })).toMatchObject({ status: "ok", effective: { overlay: null } });
    // The log starts on the first head; a head that moved on without a rebase has no overlay yet.
    expect(await readGraph({ store, graph })).toMatchObject({ status: "ok", effective: { overlay: null, core: revisionId(shorter()) } });
    await store.overlay(graph).append([{ kind: "rebased", core: revisionId(shorter()), absorbed: [], dropped: [], frozenAt: 1 }]);
    expect(await readGraph({ store, graph })).toMatchObject({ status: "ok", effective: { overlay: 2, core: revisionId(shorter()) } });
    await store.overlay(graph).append([{ kind: "rebased", core: revisionId(other()), absorbed: [], dropped: [], frozenAt: 2 }]);
    expect(await readGraph({ store, graph })).toMatchObject({ status: "ok", effective: { overlay: null, core: revisionId(shorter()) } });
  });

  it("PX2.18 a graph with no head, a revision it does not know, or a document that no longer parses is missing, with the reason", async () => {
    const store = await withHeads(doc());
    expect(await readGraph({ store, graph: GraphIdSchema.parse("none") })).toEqual({ status: "missing", reason: "graph none has no head" });
    const unknown = RevisionIdSchema.parse("a".repeat(64));
    expect(await readGraph({ store, graph, revision: unknown })).toEqual({ status: "missing", reason: `graph team/search has no revision ${unknown}` });
    await importGraph({ store, graph: GraphIdSchema.parse("elsewhere"), document: other(), clock });
    expect(await readGraph({ store, graph, revision: revisionId(other()) })).toEqual({ status: "missing", reason: `graph team/search has no revision ${revisionId(other())}` });
    await store.redact(revisionId(doc()));
    const broken = { ...store.records.get(revisionId(doc()))!, document: { ...doc(), nodes: [] } };
    store.records.set(broken.id, broken);
    expect(await readGraph({ store, graph })).toEqual({ status: "missing", reason: `revision ${revisionId(doc())} does not parse (it may be redacted)` });
  });

  it("PX2.19 exports JSON as the stored document, indented, with a trailing newline", async () => {
    const store = await withHeads(doc());
    const result = await exportGraph({ store, graph, format: "json" });
    expect(result).toEqual({ status: "ok", revision: revisionId(doc()), text: `${JSON.stringify(doc(), null, 2)}\n` });
  });

  it("PX2.20 exports Mermaid of the effective graph, overlay edges dashed", async () => {
    const store = await withHeads(doc());
    await store.overlay(graph).append([proposed(verifyNode, ["s1"]), proposed(toVerify, ["s1"])]);
    const result = await exportGraph({ store, graph, format: "mermaid" });
    expect(result.status === "ok" && result.text.startsWith("flowchart TD\n")).toBe(true);
    expect(result.status === "ok" && result.text).toContain('  n3 -.->|"LEADS_TO<br/>learned (provisional)"| n5');
    expect(result.status === "ok" && result.text.endsWith("\n")).toBe(true);
    expect(await exportGraph({ store, graph, format: "mermaid", overlay: false })).toMatchObject({ status: "ok", text: expect.not.stringContaining("n5") });
    expect(await exportGraph({ store, graph: GraphIdSchema.parse("none"), format: "json" })).toEqual({ status: "missing", reason: "graph none has no head" });
    expect(await exportGraph({ store, graph: GraphIdSchema.parse("none"), format: "mermaid" })).toEqual({ status: "missing", reason: "graph none has no head" });
  });
});

describe("graphHistory", () => {
  it("PX2.21 lists the head, the heads most recent first, and the graph's revisions by time without their documents", async () => {
    const store = await withHeads(doc(), shorter());
    await importGraph({ store, graph, document: other(), clock });
    const history = await graphHistory({ store, graph });
    expect(history.head).toBe(revisionId(shorter()));
    expect(history.heads).toEqual([revisionId(shorter()), revisionId(doc())]);
    expect(history.revisions.map((r) => [r.id, r.origin, r.at])).toEqual([
      [revisionId(doc()), "import", 0],
      [revisionId(shorter()), "dream", 1],
      [revisionId(other()), "import", 1_000],
    ]);
    expect(history.revisions[1]).toStrictEqual({ id: revisionId(shorter()), origin: "dream", parents: [revisionId(doc())], decision: { kind: "head" }, at: 1 });
    expect(await graphHistory({ store, graph: GraphIdSchema.parse("none") })).toStrictEqual({ heads: [], revisions: [] });
  });

  it("PX2.39 revisions are listed by time whatever order the store keeps them in", async () => {
    const store = new FakeStore();
    for (const [d, at] of [[other(), 30], [doc(), 10], [shorter(), 20]] as const) {
      await store.revisions.put(RevisionRecordSchema.parse({ id: revisionId(d), graph, parents: [], document: d, edits: null, origin: "import", evidence: {}, decision: { kind: "pending-approval" }, at }));
    }
    expect((await graphHistory({ store, graph })).revisions.map((r) => r.at)).toEqual([10, 20, 30]);
  });

  it("PX2.22 a revision's dream, edits and redaction show when it has them", async () => {
    const store = await withHeads(doc());
    const id = revisionId(doc());
    const edits = { add_nodes: [], delete_nodes: [], add_edges: [], delete_edges: [{ source: "Scan_Index", target: "Bridge_Extract" }] };
    store.records.set(id, RevisionRecordSchema.parse({ ...store.records.get(id)!, dream: "d1", edits, redacted: true }));
    const [summary] = (await graphHistory({ store, graph })).revisions;
    expect(summary).toMatchObject({ dream: "d1", edits, redacted: true });
  });
});

describe("revertGraph", () => {
  it("PX2.23 moves the head back to the previous head as a revert revision that keeps what it replaced, and rebases the overlay onto it", async () => {
    const store = await withHeads(doc(), shorter());
    const from = revisionId(shorter());
    const to = revisionId(doc());
    await store.overlay(graph).append([proposed(shortcut, ["s1"])]);
    const result = await revertGraph({ store, graph, clock });
    expect(result).toEqual({ status: "reverted", from, to });
    expect(await store.heads.get(graph)).toEqual({ revision: to, history: [from, to] });
    expect(store.records.get(to)).toEqual({
      id: to,
      graph,
      parents: [from],
      document: doc(),
      edits: null,
      origin: "revert",
      evidence: { reverted: from, replaces: { origin: "import", parents: [], edits: null, evidence: { round: 0 }, decision: { kind: "head" }, at: 0 } },
      decision: { kind: "head" },
      at: 1_000,
    });
    const events = (await store.overlay(graph).read(0)).map((e) => e.event);
    expect(events.at(-1)).toEqual({ kind: "rebased", core: to, absorbed: [], dropped: [], frozenAt: 1 });
    expect(foldAll(from, events).base).toBe(to);
  });

  it("PX2.24 reverts to any earlier head named by `to`, dropping overlay entries whose anchors that core lacks", async () => {
    const withVerify = doc((d) => {
      d.nodes.push({ id: "Verify", type: "REASONING", description: "Check." });
      d.edges.push({ from: "Bridge_Extract", relation: "LEADS_TO", to: "Verify", condition: null, guidance: "", pitfalls: "" });
    });
    const store = await withHeads(doc(), shorter(), withVerify);
    const note = { kind: "note", on: { from: "Bridge_Extract", to: "Verify" }, text: "Check twice." };
    await store.overlay(graph).append([proposed(note, ["s1"])]);
    const result = await revertGraph({ store, graph, to: revisionId(doc()), clock });
    expect(result).toEqual({ status: "reverted", from: revisionId(withVerify), to: revisionId(doc()) });
    const events = (await store.overlay(graph).read(0)).map((e) => e.event);
    expect(events.at(-1)).toEqual({ kind: "rebased", core: revisionId(doc()), absorbed: [], dropped: [entryId(entry(note))], frozenAt: 1 });
  });

  it("PX2.25 refuses without a head, without an earlier head, or for a revision that was never an earlier head of the graph", async () => {
    expect(await revertGraph({ store: new FakeStore(), graph, clock })).toEqual({ status: "refused", reason: "graph team/search has no head" });
    const single = await withHeads(doc());
    expect(await revertGraph({ store: single, graph, clock })).toEqual({ status: "refused", reason: "graph team/search has no earlier head" });
    const store = await withHeads(doc(), shorter());
    expect(await revertGraph({ store, graph, to: revisionId(shorter()), clock })).toEqual({ status: "refused", reason: `${revisionId(shorter())} is already the head of graph team/search` });
    expect(await revertGraph({ store, graph, to: revisionId(other()), clock })).toEqual({ status: "refused", reason: `${revisionId(other())} is not an earlier head of graph team/search` });
    expect((await store.heads.get(graph))?.revision).toBe(revisionId(shorter()));
  });

  it("PX2.26 refuses a target whose record is gone or redacted, since sessions cannot be guided by it", async () => {
    const store = await withHeads(doc(), shorter());
    await store.redact(revisionId(doc()));
    expect(await revertGraph({ store, graph, clock })).toEqual({ status: "refused", reason: `revision ${revisionId(doc())} is redacted` });
    store.records.delete(revisionId(doc()));
    expect(await revertGraph({ store, graph, clock })).toEqual({ status: "refused", reason: `revision ${revisionId(doc())} is not recorded` });
  });

  it("PX2.27 when the head moves during a revert, it is refused and the replaced record is put back", async () => {
    const store = await withHeads(doc(), shorter());
    const original = store.records.get(revisionId(doc()));
    store.beforeSet = async () => void (await store.heads.set(graph, revisionId(shorter()), revisionId(other())));
    expect(await revertGraph({ store, graph, clock })).toEqual({ status: "refused", reason: "the head of graph team/search moved; try again" });
    expect(store.records.get(revisionId(doc()))).toEqual(original);
    expect(await store.overlay(graph).head()).toBe(0);
  });
});
