import { describe, expect, it } from "vitest";
import { CandidateDocumentSchema, GraphIdSchema, OverlayEventSchema, revisionId, RevisionRecordSchema, seedGraph } from "@harness/procedural";
import type { GraphId, OverlayEvent, Pin, ProceduralStore, RevisionRecord } from "@harness/procedural";

export interface ProceduralStoreFixture {
  readonly store: ProceduralStore;
  /** The store as a restarted process sees it. An in-memory store returns itself. */
  reopen(): ProceduralStore;
}

const graphA: GraphId = GraphIdSchema.parse("team/alpha");
const graphB: GraphId = GraphIdSchema.parse("team/beta");

/** A checked document: the seed plus `extra` steps chained between Start and End, carrying `text` wherever text goes. */
function documentWith(extra: readonly string[], text = "") {
  const chain = ["Start", ...extra, "End"];
  return {
    format: "harness.procedural-graph/v1",
    nodeTypes: ["ACTION", "REASONING", "STATUS"],
    relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
    nodes: chain.map((id) => ({ id, type: id === "Start" || id === "End" ? "STATUS" : "ACTION", description: `${text}${id}` })),
    edges: chain.slice(1).map((to, i) => ({
      from: chain[i],
      relation: "LEADS_TO",
      to,
      condition: i === 0 ? null : `${text}cond-${to}`,
      guidance: `${text}guide-${to}`,
      pitfalls: `${text}pit-${to}`,
    })),
  };
}

/** A revision record over `documentWith(extra)`, parsed so its id is the document's. */
function record(graph: GraphId, extra: readonly string[], overrides: Record<string, unknown> = {}, text = ""): RevisionRecord {
  const document = documentWith(extra, text);
  const parsed = RevisionRecordSchema.parse({
    graph,
    parents: [],
    document,
    edits: null,
    origin: "seed",
    evidence: {},
    decision: { kind: "head" },
    at: 1,
    ...overrides,
    id: revisionId(CandidateDocumentSchema.parse(document)),
  });
  return parsed;
}

const observed = (turn: number): OverlayEvent =>
  OverlayEventSchema.parse({ kind: "observed", turnKey: `s/${turn}`, path: ["Start", "End"], unmatched: [], score: null, exposure: [] });

const pin = (graph: GraphId, overlay: number, salt = "salt"): Pin => ({ graph, core: revisionId(seedGraph()), overlay, salt, at: 7 });

/**
 * The ProceduralStore contract (plan §4, ADR 0016). Every implementation runs this same
 * suite: revisions and compare-and-set heads, dense append logs per graph, pins, guidance
 * texts, leases with epochs, redaction, and durability across a reopen.
 */
export function proceduralStoreContract(label: string, make: () => Promise<ProceduralStoreFixture> | ProceduralStoreFixture): void {
  describe(`ProceduralStore contract: ${label}`, () => {
    it("PST1.1 an empty store has no revisions, heads, log entries, pins, guidance or lease holders", async () => {
      const { store } = await make();
      expect(await store.revisions.get(graphA, revisionId(seedGraph()))).toBeUndefined();
      expect(await store.revisions.list(graphA)).toEqual([]);
      expect(await store.heads.get(graphA)).toBeUndefined();
      expect(await store.overlay(graphA).head()).toBe(0);
      expect(await store.overlay(graphA).read(0)).toEqual([]);
      expect(await store.dreams(graphA).head()).toBe(0);
      expect(await store.pins.get("s1")).toBeUndefined();
      expect(await store.guidance.get("g1")).toBeUndefined();
      expect(await store.lease.acquire(graphA, "me")).toEqual({ epoch: 1 });
    });

    it("PST1.2 a put revision reads back by its graph and id and is listed under its graph only", async () => {
      const { store } = await make();
      const a = record(graphA, []);
      const b = record(graphB, ["Plan"]);
      await store.revisions.put(a);
      await store.revisions.put(b);
      expect(await store.revisions.get(graphA, a.id)).toEqual(a);
      expect(await store.revisions.get(graphB, b.id)).toEqual(b);
      expect(await store.revisions.get(graphB, a.id)).toBeUndefined();
      expect(await store.revisions.list(graphA)).toEqual([a]);
      expect(await store.revisions.list(graphB)).toEqual([b]);
    });

    it("PST1.3 revisions list in put order, and a put with a known graph and id replaces the record in place", async () => {
      const { store } = await make();
      const first = record(graphA, ["Plan"]);
      const second = record(graphA, ["Act"]);
      const third = record(graphA, []);
      for (const r of [first, second, third]) await store.revisions.put(r);
      const rejected = record(graphA, ["Act"], { decision: { kind: "rejected-gate", gate: "evidence", reason: "no support" } });
      await store.revisions.put(rejected);
      expect(await store.revisions.list(graphA)).toEqual([first, rejected, third]);
      expect(await store.revisions.get(graphA, second.id)).toEqual(rejected);
    });

    it("PST1.4 the first head is set only against an absent head, and starts with no history", async () => {
      const { store } = await make();
      const seed = record(graphA, []);
      expect(await store.heads.set(graphA, seed.id, seed.id)).toBe(false);
      expect(await store.heads.get(graphA)).toBeUndefined();
      expect(await store.heads.set(graphA, undefined, seed.id)).toBe(true);
      expect(await store.heads.get(graphA)).toEqual({ revision: seed.id, history: [] });
    });

    it("PST1.5 a head moves only from the expected revision, and its history is most recent first", async () => {
      const { store } = await make();
      const [r0, r1, r2] = [record(graphA, []), record(graphA, ["Plan"]), record(graphA, ["Plan", "Act"])];
      expect(await store.heads.set(graphA, undefined, r0.id)).toBe(true);
      expect(await store.heads.set(graphA, r0.id, r1.id)).toBe(true);
      expect(await store.heads.set(graphA, undefined, r2.id)).toBe(false);
      expect(await store.heads.set(graphA, r0.id, r2.id)).toBe(false);
      expect(await store.heads.get(graphA)).toEqual({ revision: r1.id, history: [r0.id] });
      expect(await store.heads.set(graphA, r1.id, r2.id)).toBe(true);
      expect(await store.heads.get(graphA)).toEqual({ revision: r2.id, history: [r1.id, r0.id] });
      // A revert is a move back to an earlier revision; it is recorded like any other move.
      expect(await store.heads.set(graphA, r2.id, r0.id)).toBe(true);
      expect(await store.heads.get(graphA)).toEqual({ revision: r0.id, history: [r2.id, r1.id, r0.id] });
    });

    it("PST1.6 setting a head to the revision it already names succeeds and adds no history", async () => {
      const { store } = await make();
      const [r0, r1] = [record(graphA, []), record(graphA, ["Plan"])];
      await store.heads.set(graphA, undefined, r0.id);
      await store.heads.set(graphA, r0.id, r1.id);
      expect(await store.heads.set(graphA, r1.id, r1.id)).toBe(true);
      expect(await store.heads.get(graphA)).toEqual({ revision: r1.id, history: [r0.id] });
    });

    it("PST1.7 heads are per graph", async () => {
      const { store } = await make();
      const [a, b] = [record(graphA, []), record(graphB, ["Plan"])];
      await store.heads.set(graphA, undefined, a.id);
      expect(await store.heads.get(graphB)).toBeUndefined();
      expect(await store.heads.set(graphB, undefined, b.id)).toBe(true);
      expect(await store.heads.get(graphA)).toEqual({ revision: a.id, history: [] });
      expect(await store.heads.get(graphB)).toEqual({ revision: b.id, history: [] });
    });

    it("PST1.8 of concurrent compare-and-sets from the same head, exactly one wins", async () => {
      const { store } = await make();
      const base = record(graphA, []);
      await store.heads.set(graphA, undefined, base.id);
      const candidates = ["A", "B", "C", "D"].map((n) => record(graphA, [n]));
      const results = await Promise.all(candidates.map((c) => store.heads.set(graphA, base.id, c.id)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = candidates[results.indexOf(true)];
      expect(await store.heads.get(graphA)).toEqual({ revision: winner?.id, history: [base.id] });
    });

    it("PST1.9 appends return the new head, and offsets are dense from 0", async () => {
      const { store } = await make();
      const log = store.overlay(graphA);
      expect(await log.append([observed(1), observed(2)])).toBe(2);
      expect(await log.append([observed(3)])).toBe(3);
      expect(await log.head()).toBe(3);
      expect(await log.read(0)).toEqual([
        { offset: 0, event: observed(1) },
        { offset: 1, event: observed(2) },
        { offset: 2, event: observed(3) },
      ]);
    });

    it("PST1.10 an empty append changes nothing and returns the head", async () => {
      const { store } = await make();
      const log = store.dreams(graphA);
      await log.append([{ n: 1 }]);
      expect(await log.append([])).toBe(1);
      expect(await log.head()).toBe(1);
    });

    it("PST1.11 read starts at its offset and returns at most its limit", async () => {
      const { store } = await make();
      const log = store.dreams(graphA);
      await log.append([0, 1, 2, 3, 4].map((n) => ({ n })));
      expect(await log.read(2)).toEqual([2, 3, 4].map((n) => ({ offset: n, event: { n } })));
      expect(await log.read(1, 2)).toEqual([1, 2].map((n) => ({ offset: n, event: { n } })));
      expect(await log.read(3, 10)).toEqual([3, 4].map((n) => ({ offset: n, event: { n } })));
      expect(await log.read(1, 0)).toEqual([]);
      expect(await log.read(5)).toEqual([]);
      expect(await log.read(9, 1)).toEqual([]);
    });

    it("PST1.12 a read from a negative or fractional offset, or with such a limit, is a RangeError", async () => {
      const { store } = await make();
      const log = store.overlay(graphA);
      await expect(log.read(-1)).rejects.toThrow(RangeError);
      await expect(log.read(0.5)).rejects.toThrow(RangeError);
      await expect(log.read(0, -1)).rejects.toThrow(RangeError);
      await expect(log.read(0, 1.5)).rejects.toThrow(RangeError);
    });

    it("PST1.13 each graph has its own overlay log and dream log, and every handle on one log shares it", async () => {
      const { store } = await make();
      await store.overlay(graphA).append([observed(1)]);
      await store.dreams(graphA).append([{ step: "start" }, { step: "select" }]);
      await store.overlay(graphB).append([observed(2), observed(3), observed(4)]);
      expect(await store.overlay(graphA).head()).toBe(1);
      expect(await store.dreams(graphA).head()).toBe(2);
      expect(await store.overlay(graphB).head()).toBe(3);
      expect(await store.dreams(graphB).head()).toBe(0);
      expect(await store.overlay(graphA).read(0)).toEqual([{ offset: 0, event: observed(1) }]);
      expect(await store.dreams(graphA).read(1)).toEqual([{ offset: 1, event: { step: "select" } }]);
    });

    it("PST1.14 concurrent appends neither lose nor duplicate events, and keep each batch contiguous", async () => {
      const { store } = await make();
      const log = store.dreams(graphA);
      const heads = await Promise.all([0, 1, 2, 3].map((b) => log.append([`${b}a`, `${b}b`])));
      expect([...heads].sort((x, y) => x - y)).toEqual([2, 4, 6, 8]);
      const events = (await log.read(0)).map((e) => e.event);
      expect(events).toHaveLength(8);
      for (const b of [0, 1, 2, 3]) expect(events.indexOf(`${b}b`)).toBe(events.indexOf(`${b}a`) + 1);
    });

    it("PST1.15 a session's pin reads back, a later pin replaces it, and pins are per session", async () => {
      const { store } = await make();
      await store.pins.set("s1", pin(graphA, 3));
      await store.pins.set("s2", pin(graphB, 5, "other"));
      expect(await store.pins.get("s1")).toEqual(pin(graphA, 3));
      await store.pins.set("s1", pin(graphA, 4));
      expect(await store.pins.get("s1")).toEqual(pin(graphA, 4));
      expect(await store.pins.get("s2")).toEqual(pin(graphB, 5, "other"));
    });

    it("PST1.16 guidance texts read back by id, and a later put replaces one", async () => {
      const { store } = await make();
      await store.guidance.put("g1", "Retrieve first.");
      await store.guidance.put("g2", "");
      expect(await store.guidance.get("g1")).toBe("Retrieve first.");
      expect(await store.guidance.get("g2")).toBe("");
      await store.guidance.put("g1", "Retrieve twice.");
      expect(await store.guidance.get("g1")).toBe("Retrieve twice.");
    });

    it("PST1.17 a held lease cannot be acquired by another holder; its holder re-acquires under a new epoch", async () => {
      const { store } = await make();
      const first = await store.lease.acquire(graphA, "dreamer-1");
      expect(first).toEqual({ epoch: 1 });
      expect(await store.lease.acquire(graphA, "dreamer-2")).toBeUndefined();
      const again = await store.lease.acquire(graphA, "dreamer-1");
      expect(again).toEqual({ epoch: 2 });
      expect(await store.lease.renew(graphA, "dreamer-1", 1)).toBe(false);
      expect(await store.lease.renew(graphA, "dreamer-1", 2)).toBe(true);
    });

    it("PST1.18 only the holder with the current epoch renews", async () => {
      const { store } = await make();
      const lease = await store.lease.acquire(graphA, "dreamer-1");
      expect(await store.lease.renew(graphA, "dreamer-1", lease?.epoch ?? -1)).toBe(true);
      expect(await store.lease.renew(graphA, "dreamer-1", 1)).toBe(true);
      expect(await store.lease.renew(graphA, "dreamer-2", 1)).toBe(false);
      expect(await store.lease.renew(graphA, "dreamer-1", 2)).toBe(false);
      expect(await store.lease.renew(graphA, "dreamer-1", 0)).toBe(false);
      expect(await store.lease.renew(graphB, "dreamer-1", 1)).toBe(false);
    });

    it("PST1.19 a release frees the lease only for its holder and current epoch, and a released epoch stays stale", async () => {
      const { store } = await make();
      await store.lease.acquire(graphA, "dreamer-1");
      expect(await store.lease.release(graphA, "dreamer-2", 1)).toBe(false);
      expect(await store.lease.release(graphA, "dreamer-1", 2)).toBe(false);
      expect(await store.lease.acquire(graphA, "dreamer-2")).toBeUndefined();
      expect(await store.lease.release(graphA, "dreamer-1", 1)).toBe(true);
      expect(await store.lease.release(graphA, "dreamer-1", 1)).toBe(false);
      expect(await store.lease.renew(graphA, "dreamer-1", 1)).toBe(false);
      expect(await store.lease.acquire(graphA, "dreamer-2")).toEqual({ epoch: 2 });
      expect(await store.lease.renew(graphA, "dreamer-1", 1)).toBe(false);
      expect(await store.lease.release(graphB, "dreamer-2", 2)).toBe(false);
    });

    it("PST1.20 leases are per graph", async () => {
      const { store } = await make();
      expect(await store.lease.acquire(graphA, "dreamer-1")).toEqual({ epoch: 1 });
      expect(await store.lease.acquire(graphB, "dreamer-2")).toEqual({ epoch: 1 });
      expect(await store.lease.renew(graphA, "dreamer-1", 1)).toBe(true);
      expect(await store.lease.renew(graphB, "dreamer-2", 1)).toBe(true);
    });

    it("PST1.21 of concurrent acquires by different holders, exactly one gets the lease", async () => {
      const { store } = await make();
      const results = await Promise.all(["h1", "h2", "h3"].map((h) => store.lease.acquire(graphA, h)));
      expect(results.filter((r) => r !== undefined)).toEqual([{ epoch: 1 }]);
    });

    it("PST1.22 redaction tombstones every text of a revision but keeps its ids, structure and numbers, and marks it redacted", async () => {
      const { store } = await make();
      const r = record(
        graphA,
        ["Plan"],
        {
          parents: [revisionId(seedGraph())],
          origin: "dream",
          dream: "dream-1",
          edits: {
            add_nodes: [{ id: "Plan", type: "ACTION", description: "secret-edit-node" }],
            delete_nodes: [],
            add_edges: [{ source: "Start", target: "Plan", relation: "LEADS_TO", condition: "secret-edit-cond", guidance: "secret-edit-guide", pitfalls: "secret-edit-pit" }],
            delete_edges: [{ source: "Start", target: "End" }],
          },
          evidence: { note: "secret-evidence", n: 3, flag: true, none: null, nested: { list: ["secret-list", 4] } },
          decision: { kind: "rejected-gate", gate: "evidence", reason: "secret-reason" },
        },
        "secret-",
      );
      await store.revisions.put(r);
      await store.redact(r.id);
      const redacted = await store.revisions.get(graphA, r.id);
      expect(JSON.stringify(redacted)).not.toContain("secret-");
      expect(redacted).toMatchObject({ id: r.id, graph: graphA, parents: r.parents, origin: "dream", dream: "dream-1", at: 1, redacted: true });
      expect(redacted?.decision).toMatchObject({ kind: "rejected-gate", gate: "evidence" });
      expect(redacted?.document.nodes.map((n) => [n.id, n.type])).toEqual(r.document.nodes.map((n) => [n.id, n.type]));
      expect(redacted?.document.edges.map((e) => [e.from, e.relation, e.to, e.condition === null])).toEqual(r.document.edges.map((e) => [e.from, e.relation, e.to, e.condition === null]));
      expect(redacted?.edits?.add_edges.map((e) => [e.source, e.target, e.relation])).toEqual([["Start", "Plan", "LEADS_TO"]]);
      expect(redacted?.edits?.add_nodes.map((n) => [n.id, n.type])).toEqual([["Plan", "ACTION"]]);
      expect(redacted?.edits?.delete_edges).toEqual([{ source: "Start", target: "End" }]);
      expect(redacted?.evidence).toMatchObject({ n: 3, flag: true, none: null, nested: { list: [expect.any(String), 4] } });
      expect(RevisionRecordSchema.safeParse(redacted).success).toBe(true);
      expect(await store.revisions.list(graphA)).toEqual([redacted]);
    });

    it("PST1.23 redaction tombstones a structural rejection's diagnostic messages but keeps their codes and places", async () => {
      const { store } = await make();
      const r = record(graphA, [], {
        edits: { add_nodes: [], delete_nodes: ["End"], add_edges: [], delete_edges: [] },
        decision: { kind: "rejected-structure", diagnostics: [{ code: "no-terminal", message: "secret-message", at: "Start" }, { code: "cycle", message: "secret-two" }] },
      });
      await store.revisions.put(r);
      await store.redact(r.id);
      const redacted = await store.revisions.get(graphA, r.id);
      expect(JSON.stringify(redacted)).not.toContain("secret-");
      expect(redacted?.decision).toEqual({
        kind: "rejected-structure",
        diagnostics: [{ code: "no-terminal", message: expect.any(String), at: "Start" }, { code: "cycle", message: expect.any(String) }],
      });
      expect(redacted?.edits).toEqual({ add_nodes: [], delete_nodes: ["End"], add_edges: [], delete_edges: [] });
    });

    it("PST1.24 redacting an unknown revision changes nothing", async () => {
      const { store } = await make();
      const r = record(graphA, []);
      await store.revisions.put(r);
      await store.redact(record(graphA, ["Plan"]).id);
      expect(await store.revisions.list(graphA)).toEqual([r]);
      // Nothing was redacted, so the id is not either: a record put under it later keeps its text.
      const later = record(graphB, ["Plan"]);
      await store.revisions.put(later);
      expect(await store.revisions.get(graphB, later.id)).toEqual(later);
    });

    it("PST1.25 a redacted revision stays redacted when the same id is put again", async () => {
      const { store } = await make();
      const r = record(graphA, ["Plan"], {}, "secret-");
      await store.revisions.put(r);
      await store.redact(r.id);
      await store.revisions.put(r);
      const again = await store.revisions.get(graphA, r.id);
      expect(again?.redacted).toBe(true);
      expect(JSON.stringify(again)).not.toContain("secret-");
    });

    it("PST1.26 revisions, heads, logs, pins, guidance, leases and redactions survive a reopen", async () => {
      const fixture = await make();
      const { store } = fixture;
      const [r0, r1] = [record(graphA, []), record(graphA, ["Plan"], {}, "secret-")];
      await store.revisions.put(r0);
      await store.revisions.put(r1);
      await store.redact(r1.id);
      await store.heads.set(graphA, undefined, r0.id);
      await store.heads.set(graphA, r0.id, r1.id);
      await store.overlay(graphA).append([observed(1), observed(2)]);
      await store.dreams(graphB).append([{ step: "start" }]);
      await store.pins.set("s1", pin(graphA, 2));
      await store.guidance.put("g1", "Retrieve first.");
      await store.lease.acquire(graphA, "dreamer-1");
      await store.lease.acquire(graphA, "dreamer-1");
      await store.lease.acquire(graphB, "dreamer-2");
      await store.lease.release(graphB, "dreamer-2", 1);
      const redacted = await store.revisions.get(graphA, r1.id);

      const reopened = fixture.reopen();
      expect(await reopened.revisions.list(graphA)).toEqual([r0, redacted]);
      expect((await reopened.revisions.get(graphA, r1.id))?.redacted).toBe(true);
      expect(await reopened.heads.get(graphA)).toEqual({ revision: r1.id, history: [r0.id] });
      expect(await reopened.overlay(graphA).read(0)).toEqual([{ offset: 0, event: observed(1) }, { offset: 1, event: observed(2) }]);
      expect(await reopened.dreams(graphB).read(0)).toEqual([{ offset: 0, event: { step: "start" } }]);
      expect(await reopened.pins.get("s1")).toEqual(pin(graphA, 2));
      expect(await reopened.guidance.get("g1")).toBe("Retrieve first.");
      expect(await reopened.lease.acquire(graphA, "dreamer-2")).toBeUndefined();
      expect(await reopened.lease.renew(graphA, "dreamer-1", 1)).toBe(false);
      expect(await reopened.lease.renew(graphA, "dreamer-1", 2)).toBe(true);
      expect(await reopened.lease.acquire(graphB, "dreamer-3")).toEqual({ epoch: 2 });
      expect(await reopened.overlay(graphA).append([observed(3)])).toBe(3);
    });

    it("PST1.49 records are keyed by graph and id: the same document in two graphs keeps a record per graph, and a reopen keeps both", async () => {
      const fixture = await make();
      const { store } = fixture;
      const inA = record(graphA, ["Plan"], { origin: "import" });
      const inB = record(graphB, ["Plan"], { origin: "dream", dream: "dream-1", decision: { kind: "rejected-gate", gate: "evidence", reason: "no support" } });
      expect(inB.id).toBe(inA.id);
      await store.revisions.put(inA);
      await store.revisions.put(inB);
      expect(await store.revisions.get(graphA, inA.id)).toEqual(inA);
      expect(await store.revisions.get(graphB, inA.id)).toEqual(inB);
      expect(await store.revisions.list(graphA)).toEqual([inA]);
      expect(await store.revisions.list(graphB)).toEqual([inB]);
      const replaced = record(graphA, ["Plan"], { origin: "dream", at: 9 });
      await store.revisions.put(replaced);
      expect(await store.revisions.get(graphA, inA.id)).toEqual(replaced);
      expect(await store.revisions.get(graphB, inA.id)).toEqual(inB);
      const reopened = fixture.reopen();
      expect(await reopened.revisions.list(graphA)).toEqual([replaced]);
      expect(await reopened.revisions.list(graphB)).toEqual([inB]);
    });

    it("PST1.50 redaction is by content: it tombstones every graph's record of the id, and the id stays redacted in any graph it is put under", async () => {
      const { store } = await make();
      const inA = record(graphA, ["Plan"], {}, "secret-");
      const inB = record(graphB, ["Plan"], { origin: "import" }, "secret-");
      const other = record(graphB, ["Act"], {}, "secret-");
      await store.revisions.put(inA);
      await store.revisions.put(inB);
      await store.revisions.put(other);
      await store.redact(inA.id);
      expect(await store.revisions.get(graphA, inA.id)).toMatchObject({ graph: graphA, redacted: true });
      expect(await store.revisions.get(graphB, inA.id)).toMatchObject({ graph: graphB, origin: "import", redacted: true });
      expect(JSON.stringify(await store.revisions.list(graphA))).not.toContain("secret-");
      expect(await store.revisions.get(graphB, other.id)).toEqual(other);
      const graphC = GraphIdSchema.parse("team/gamma");
      await store.revisions.put(record(graphC, ["Plan"], {}, "secret-"));
      expect(await store.revisions.get(graphC, inA.id)).toMatchObject({ graph: graphC, redacted: true });
      expect(JSON.stringify(await store.revisions.get(graphC, inA.id))).not.toContain("secret-");
    });
  });
}
