import { describe, expect, it } from "vitest";
import { GraphIdSchema, migrateStoreDocument, RevisionRecordSchema, SnapshotProceduralStore, STORE_FORMAT, STORE_FORMAT_V1 } from "@harness/procedural";
import type { ProceduralStoreDocumentV1 } from "@harness/procedural";
import { graphA, ProbeStorage, record } from "./store-fixtures.ts";

const graphB = GraphIdSchema.parse("team/beta");

/** A v1 saved store: records keyed by id alone, as stores saved them before records were keyed by graph. */
function v1(fields: Partial<Omit<ProceduralStoreDocumentV1, "format">> = {}): ProceduralStoreDocumentV1 {
  return { format: STORE_FORMAT_V1, revisions: [], heads: [], overlay: [], dreams: [], pins: [], guidance: [], leases: [], ...fields };
}

async function loaded(document: unknown) {
  const storage = new ProbeStorage();
  await storage.inner.save(document);
  return { storage, store: new SnapshotProceduralStore(storage) };
}

describe("migrating a v1 procedural store", () => {
  it("PS1.51 a v1 saved store loads with every record under its graph, and its first change saves it as v2", async () => {
    const [r0, r1] = [record([]), record(["Plan"], { origin: "dream", parents: [record([]).id] })];
    const pin = { graph: graphA, core: r1.id, overlay: 0, salt: "s", at: 1 };
    const saved = v1({
      revisions: [r0, r1],
      heads: [{ graph: graphA, revision: r1.id, history: [r0.id] }],
      dreams: [{ graph: graphA, events: [{ step: 1 }] }],
      pins: [{ session: "s1", pin }],
      guidance: [{ id: "g", text: "Retrieve first." }],
      leases: [{ graph: graphA, holder: null, epoch: 3 }],
    });
    const { storage, store } = await loaded(saved);
    expect(await store.revisions.list(graphA)).toEqual([r0, r1]);
    expect(await store.revisions.get(graphA, r1.id)).toEqual(r1);
    expect(await store.heads.get(graphA)).toEqual({ revision: r1.id, history: [r0.id] });
    expect(await store.pins.get("s1")).toEqual(pin);
    expect(await store.guidance.get("g")).toBe("Retrieve first.");
    expect(await store.dreams(graphA).read(0)).toEqual([{ offset: 0, event: { step: 1 } }]);
    expect(storage.saves).toBe(0);
    expect(await store.lease.acquire(graphA, "h")).toEqual({ epoch: 4 });
    expect(await storage.inner.load()).toMatchObject({ format: STORE_FORMAT, revisions: [r0, r1] });
    expect(migrateStoreDocument(saved)).toEqual({ ...saved, format: STORE_FORMAT });
  });

  it("PS1.52 a head or earlier head whose v1 record another graph wrote last gets a copy of it under its own graph", async () => {
    const shared = record(["Plan"], { graph: graphB, origin: "dream", decision: { kind: "rejected-gate", gate: "evidence", reason: "no support" } });
    const seed = record([]);
    const saved = v1({
      revisions: [seed, shared],
      heads: [
        { graph: graphA, revision: seed.id, history: [shared.id] },
        { graph: graphB, revision: shared.id, history: [] },
      ],
    });
    const { store } = await loaded(saved);
    expect(await store.revisions.get(graphB, shared.id)).toEqual(shared);
    expect(await store.revisions.get(graphA, shared.id)).toEqual({ ...shared, graph: graphA });
    expect(await store.revisions.list(graphA)).toEqual([seed, { ...shared, graph: graphA }]);
    // A head with no record anywhere stays without one.
    const missing = record(["Act"]).id;
    expect(migrateStoreDocument(v1({ heads: [{ graph: graphA, revision: missing, history: [] }] })).revisions).toEqual([]);
  });

  it("PS1.53 a v1 revert record is replaced by the record it replaced, through reverts of reverts; one whose replaced record no longer parses stays", () => {
    const original = record([], { origin: "import", evidence: { round: 0 }, at: 2 });
    const { id: _, graph: __, document: ___, ...replaced } = original;
    const firstRevert = RevisionRecordSchema.parse({ ...original, parents: [record(["Plan"]).id], origin: "revert", evidence: { reverted: record(["Plan"]).id, replaces: replaced }, at: 5 });
    const { id: _a, graph: _b, document: _c, ...replacedRevert } = firstRevert;
    const secondRevert = RevisionRecordSchema.parse({ ...original, parents: [record(["Act"]).id], origin: "revert", evidence: { reverted: record(["Act"]).id, replaces: replacedRevert }, at: 9 });
    expect(migrateStoreDocument(v1({ revisions: [secondRevert] })).revisions).toEqual([original]);
    const unparsable = RevisionRecordSchema.parse({ ...original, origin: "revert", evidence: { reverted: "x", replaces: { ...replaced, origin: "[redacted]" } } });
    const noEvidence = RevisionRecordSchema.parse({ ...original, id: record(["Act"]).id, document: record(["Act"]).document, origin: "revert", evidence: { reverted: "x" } });
    const notARecord = RevisionRecordSchema.parse({ ...noEvidence, evidence: { replaces: "text" } });
    expect(migrateStoreDocument(v1({ revisions: [unparsable] })).revisions).toEqual([unparsable]);
    expect(migrateStoreDocument(v1({ revisions: [noEvidence] })).revisions).toEqual([noEvidence]);
    expect(migrateStoreDocument(v1({ revisions: [notARecord] })).revisions).toEqual([notARecord]);
    // A dream record that happens to carry `replaces` evidence is not a revert, and stays.
    const dream = RevisionRecordSchema.parse({ ...original, origin: "dream", evidence: { replaces: replaced } });
    expect(migrateStoreDocument(v1({ revisions: [dream] })).revisions).toEqual([dream]);
  });

  it("PS1.54 a v1 store is checked like a v2 one: a malformed v1 store is rejected, never migrated or overwritten", async () => {
    const r = record([]);
    const bad = { ...v1(), revisions: [{ ...r, id: record(["Plan"]).id }] };
    const { storage, store } = await loaded(bad);
    await expect(store.revisions.list(graphA)).rejects.toThrow(/the saved procedural store is malformed/);
    await expect(store.guidance.put("g", "x")).rejects.toThrow(/malformed/);
    expect(storage.saves).toBe(0);
    expect(await storage.inner.load()).toEqual(bad);
  });
});
