import { describe, expect, it } from "vitest";
import { GraphIdSchema, MemoryProceduralStore, redactRecord, RevisionRecordSchema, STORE_FORMAT, STORE_FORMAT_V1, TOMBSTONE } from "@harness/procedural";
import { graphA, record } from "./store-fixtures.ts";

describe("MemoryProceduralStore", () => {
  it("PST1.36 an empty store's document is empty, with the store format", () => {
    expect(new MemoryProceduralStore().document()).toEqual({
      format: STORE_FORMAT,
      revisions: [],
      heads: [],
      overlay: [],
      dreams: [],
      pins: [],
      guidance: [],
      leases: [],
    });
  });

  it("PST1.37 a document is a copy: later appends change neither it nor a store rebuilt from it", async () => {
    const store = new MemoryProceduralStore();
    await store.dreams(graphA).append([1]);
    const document = store.document();
    const rebuilt = new MemoryProceduralStore(document);
    await store.dreams(graphA).append([2]);
    await rebuilt.dreams(graphA).append([3]);
    expect(document.dreams).toEqual([{ graph: graphA, events: [1] }]);
    expect((await store.dreams(graphA).read(0)).map((e) => e.event)).toEqual([1, 2]);
    expect((await rebuilt.dreams(graphA).read(0)).map((e) => e.event)).toEqual([1, 3]);
  });

  it("PST1.57 graphs names every graph with a head, in the order each got its first, and a rebuilt store keeps it", async () => {
    const store = new MemoryProceduralStore();
    expect(await store.graphs()).toEqual([]);
    const r = record([]);
    const other = GraphIdSchema.parse("team/beta");
    await store.revisions.put(r);
    await store.overlay(GraphIdSchema.parse("team/gamma")).append([]);
    await store.heads.set(other, undefined, r.id);
    await store.heads.set(graphA, undefined, r.id);
    await store.heads.set(other, r.id, r.id);
    expect(await store.graphs()).toEqual([other, graphA]);
    expect(await new MemoryProceduralStore(store.document()).graphs()).toEqual([other, graphA]);
  });

  it("PST1.47 a bad read names the argument and its value", async () => {
    const log = new MemoryProceduralStore().overlay(graphA);
    await expect(log.read(-1)).rejects.toThrow("from must be a whole number of at least 0, not -1");
    await expect(log.read(0, 0.5)).rejects.toThrow("limit must be a whole number of at least 0, not 0.5");
  });

  it("PST1.38 reading a graph's log, or appending nothing to it, does not create it", async () => {
    const store = new MemoryProceduralStore();
    await store.overlay(graphA).read(0);
    await store.overlay(graphA).append([]);
    await store.dreams(graphA).head();
    expect(store.document().overlay).toEqual([]);
    expect(store.document().dreams).toEqual([]);
  });
});

describe("redactRecord", () => {
  it("PST1.55 a store rebuilt from a document keeps redaction sticky for the ids it redacted, and only those", async () => {
    const [kept, secret] = [record([]), record(["Plan"], {}, "secret")];
    const first = new MemoryProceduralStore();
    await first.revisions.put(kept);
    await first.revisions.put(secret);
    await first.redact(secret.id);
    const rebuilt = new MemoryProceduralStore(first.document());
    const graphB = GraphIdSchema.parse("team/beta");
    await rebuilt.revisions.put({ ...secret, graph: graphB });
    await rebuilt.revisions.put({ ...kept, graph: graphB });
    expect(await rebuilt.revisions.get(graphB, secret.id)).toMatchObject({ redacted: true });
    expect(JSON.stringify(await rebuilt.revisions.get(graphB, secret.id))).not.toContain("secret");
    expect(await rebuilt.revisions.get(graphB, kept.id)).toEqual({ ...kept, graph: graphB });
  });

  it("PST1.48 the tombstone and the store format are fixed strings", () => {
    expect(TOMBSTONE).toBe("[redacted]");
    expect(STORE_FORMAT).toBe("harness.procedural-store/v2");
    expect(STORE_FORMAT_V1).toBe("harness.procedural-store/v1");
  });

  it("PST1.39 texts become the tombstone, an unconditional edge stays unconditional, and absent edits stay absent", () => {
    const r = record(["Plan"], {}, "secret");
    const redacted = redactRecord(r);
    expect(redacted.document.nodes.map((n) => n.description)).toEqual([TOMBSTONE, TOMBSTONE, TOMBSTONE]);
    expect(redacted.document.edges.map((e) => [e.condition, e.guidance, e.pitfalls])).toEqual([
      [null, TOMBSTONE, TOMBSTONE],
      [TOMBSTONE, TOMBSTONE, TOMBSTONE],
    ]);
    expect(redacted.edits).toBeNull();
    expect(redacted.decision).toEqual({ kind: "head" });
    expect(redacted.redacted).toBe(true);
    expect(redacted.document.nodeTypes).toEqual(r.document.nodeTypes);
    expect(r.redacted).toBeUndefined();
  });

  it("PST1.40 edit texts are tombstoned, and an unconditional added edge stays unconditional", () => {
    const r = record([], {
      edits: {
        add_nodes: [{ id: "Plan", type: "ACTION", description: "secret" }],
        delete_nodes: ["Old"],
        add_edges: [
          { source: "Start", target: "Plan", relation: "LEADS_TO", condition: null, guidance: "secret", pitfalls: "secret" },
          { source: "Plan", target: "End", relation: "LEADS_TO", condition: "secret", guidance: "", pitfalls: "" },
        ],
        delete_edges: [],
      },
      decision: { kind: "pending-approval" },
    });
    const redacted = redactRecord(r);
    expect(redacted.edits).toEqual({
      add_nodes: [{ id: "Plan", type: "ACTION", description: TOMBSTONE }],
      delete_nodes: ["Old"],
      add_edges: [
        { source: "Start", target: "Plan", relation: "LEADS_TO", condition: null, guidance: TOMBSTONE, pitfalls: TOMBSTONE },
        { source: "Plan", target: "End", relation: "LEADS_TO", condition: TOMBSTONE, guidance: TOMBSTONE, pitfalls: TOMBSTONE },
      ],
      delete_edges: [],
    });
    expect(redacted.decision).toEqual({ kind: "pending-approval" });
    expect(RevisionRecordSchema.parse(redacted)).toEqual(redacted);
  });

  it("PST1.41 evidence keeps its keys, numbers, booleans, nulls and shape; its strings become the tombstone", () => {
    const r = record([], { evidence: { reason: "secret", scores: [0.5, "secret"], deep: { ok: true, none: null, text: "secret" } } });
    expect(redactRecord(r).evidence).toEqual({ reason: TOMBSTONE, scores: [0.5, TOMBSTONE], deep: { ok: true, none: null, text: TOMBSTONE } });
  });
});
