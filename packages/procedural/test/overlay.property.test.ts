import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { coreView, effectiveGraph, EntryIdSchema, entryId, exposed, foldAll, OverlayEntrySchema, OverlayEventSchema, rebaseOverlay, revisionId, sha256Hex } from "@harness/procedural";
import type { EntryId, OverlayEntry, OverlayEvent } from "@harness/procedural";
import { core } from "./overlay-fixtures.ts";

const g = core();
const base = revisionId(g);
/** Core nodes, overlay-only nodes and names no entry ever defines, so anchors both hold and dangle. */
const NODES = [...g.nodes.map((n) => n.id), "Verify", "Retry", "Ghost"];
const node = fc.constantFrom(...NODES);
const text = fc.constantFrom("a", "b", "Check first.", "");
const relation = fc.constantFrom("LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO");

/** Any overlay entry over those names, including ones that try to shadow the core. */
const overlayEntry: fc.Arbitrary<OverlayEntry> = fc
  .oneof(
    fc.record({ kind: fc.constant("edge"), from: node, relation, to: node, condition: fc.option(text, { nil: null }), guidance: text, pitfalls: text }),
    fc.record({ kind: fc.constant("node"), id: node, type: fc.constantFrom("ACTION", "REASONING", "STATUS"), description: text }),
    fc.record({ kind: fc.constantFrom("note", "caution"), on: fc.record({ from: node, to: node }), text: fc.constantFrom("x", "y") }),
  )
  .map((e) => OverlayEntrySchema.parse(e));

const session = fc.constantFrom("s1", "s2", "s3", "s4");

/** A log over a small pool of entries: turns, proposals and status moves (and, when asked, rebases onto the core). */
const log = (withRebase: boolean) =>
  fc.uniqueArray(overlayEntry, { minLength: 1, maxLength: 8, selector: (e) => entryId(e) }).chain((pool) => {
    const ids = pool.map(entryId);
    const observed = fc.record({
      kind: fc.constant("observed"),
      turnKey: fc.tuple(session, fc.integer({ min: 1, max: 6 })).map(([s, t]) => `${s}/${t}`),
      path: fc.array(node, { maxLength: 5 }),
      unmatched: fc.constant([]),
      score: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
      exposure: fc.subarray(ids),
    });
    const proposed = fc.record({ kind: fc.constant("proposed"), entry: fc.constantFrom(...pool), source: fc.record({ sessions: fc.subarray(["s1", "s2", "s3", "s4"]), by: fc.constantFrom("stats", "reflection") }) });
    const status = fc.record({ kind: fc.constant("status"), entry: fc.constantFrom(...ids), to: fc.constantFrom("active", "retired"), reason: fc.constant("test") });
    const rebased = fc.record({ kind: fc.constant("rebased"), core: fc.constant(base), absorbed: fc.subarray(ids), dropped: fc.subarray(ids), frozenAt: fc.nat(20) });
    const kinds = withRebase ? [observed, proposed, status, rebased] : [observed, proposed, status];
    return fc.array(fc.oneof(...kinds), { maxLength: 30 }).map((events) => events.map((e) => OverlayEventSchema.parse(e)));
  });

const salt = fc.string({ maxLength: 12 });
const share = fc.double({ min: 0, max: 1, noNaN: true });

describe("overlay invariants", () => {
  test.prop([log(true), salt, share])("PO1.P1 I2: the effective graph contains every core node and edge with its core attributes, for any overlay and salt", (events, s, p) => {
    const eff = effectiveGraph(g, foldAll(base, events), { salt: s, probationShare: p });
    const coreItems = coreView(g);
    expect(eff.nodes.slice(0, g.nodes.length)).toEqual(coreItems.nodes);
    expect(eff.nodes.filter((n) => n.origin === "core")).toHaveLength(g.nodes.length);
    expect(new Set(eff.nodes.map((n) => n.id)).size).toBe(eff.nodes.length);
    const strip = ({ notes: _n, cautions: _c, ...rest }: (typeof eff.edges)[number]) => rest;
    expect(eff.edges.slice(0, g.edges.length).map(strip)).toEqual(coreItems.edges.map(strip));
    expect(eff.edges.filter((e) => e.origin === "core")).toHaveLength(g.edges.length);
  });

  test.prop([log(false), fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 10 })])(
    "PO1.P2 I4: a log with observed and proposed events redelivered later folds to the same state as without them",
    (events, redeliveries) => {
      const withDuplicates: OverlayEvent[] = [...events];
      for (const [pick, at] of redeliveries) {
        const candidates = events.filter((e) => e.kind === "observed" || e.kind === "proposed");
        if (candidates.length === 0) break;
        const original = candidates[pick % candidates.length]!;
        const first = withDuplicates.indexOf(original);
        withDuplicates.splice(first + 1 + (at % (withDuplicates.length - first)), 0, original);
      }
      expect(foldAll(base, withDuplicates)).toEqual(foldAll(base, events));
      expect(foldAll(base, events)).toEqual(foldAll(base, events));
    },
  );

  test.prop([log(true), salt, share])("PO1.P3 I6: the effective graph never shows an entry whose anchors are missing", (events, s, p) => {
    const eff = effectiveGraph(g, foldAll(base, events), { salt: s, probationShare: p });
    const ids = new Set(eff.nodes.map((n) => n.id));
    for (const e of eff.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    // Every note and caution sits on an edge between its own endpoints, from a live entry.
    const live = Object.values(foldAll(base, events).entries).filter((r) => r.status !== "retired");
    for (const edge of eff.edges) {
      for (const [kind, items] of [["note", edge.notes], ["caution", edge.cautions]] as const) {
        for (const item of items) {
          expect(live.some(({ entry: e, status }) => e.kind === kind && e.text === item.text && status === item.status && e.on.from === edge.from && e.on.to === edge.to)).toBe(true);
        }
      }
    }
    expect(eff.nodes.some((n) => n.status === "retired") || eff.edges.some((x) => x.status === "retired")).toBe(false);
  });

  test.prop([log(false)])("PO1.P4 I6: after a rebase onto the core, every remaining entry is anchored by the core or a live entry", (events) => {
    const state = foldAll(base, events);
    const { state: after, event } = rebaseOverlay(state, g, []);
    const live = Object.values(after.entries).filter((r) => r.status !== "retired").map((r) => r.entry);
    const nodes = new Set<string>([...g.nodes.map((n) => n.id), ...live.flatMap((e) => (e.kind === "node" ? [e.id] : []))]);
    const pairs = new Set([...g.edges, ...live.flatMap((e) => (e.kind === "edge" && nodes.has(e.from) && nodes.has(e.to) ? [e] : []))].map((e) => `${e.from}→${e.to}`));
    for (const { entry: e } of Object.values(after.entries)) {
      if (e.kind === "edge") expect(nodes.has(e.from) && nodes.has(e.to)).toBe(true);
      if (e.kind === "note" || e.kind === "caution") expect(pairs.has(`${e.on.from}→${e.on.to}`)).toBe(true);
    }
    expect(event.kind === "rebased" && event.dropped.every((id) => state.entries[id] !== undefined && after.entries[id] === undefined)).toBe(true);
    expect(Object.keys(after.entries).length + (event.kind === "rebased" ? event.dropped.length : 0)).toBe(Object.keys(state.entries).length);
  });
});

describe("exposure", () => {
  const id: fc.Arbitrary<EntryId> = fc.stringMatching(/^[0-9a-f]{64}$/).map((h) => EntryIdSchema.parse(h));

  test.prop([salt, id, share])("PO1.P5 exposure is deterministic and monotone in the share", (s, i, p) => {
    expect(exposed(s, i, p)).toBe(exposed(s, i, p));
    expect(exposed(s, i, p)).toBe(Number.parseInt(sha256Hex(s + i).slice(0, 8), 16) / 2 ** 32 < p);
    if (exposed(s, i, p)) expect(exposed(s, i, Math.min(1, p + 0.1))).toBe(true);
  });

  test.prop([id, fc.double({ min: 0, max: 1, noNaN: true })], { numRuns: 20 })("PO1.P6 over many salts the exposed rate approaches the share", (i, p) => {
    const n = 4000;
    let shown = 0;
    for (let k = 0; k < n; k += 1) if (exposed(`session-${k}`, i, p)) shown += 1;
    // Five standard deviations of a binomial rate at its widest (p = 0.5).
    expect(Math.abs(shown / n - p)).toBeLessThan(5 * Math.sqrt(0.25 / n));
  });
});
