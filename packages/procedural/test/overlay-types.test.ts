import { describe, expect, it } from "vitest";
import { coreView, EntryIdSchema, EntryStatusSchema, OverlayEntrySchema, OverlayEventSchema, parseGraph, revisionId, seedGraph, sha256Hex } from "@harness/procedural";
import type { EffectiveGraph, OverlayState } from "@harness/procedural";
import { hotpot } from "./fixtures.ts";

const entries = {
  edge: { kind: "edge", from: "Scan_Index", relation: "LEADS_TO", to: "End", condition: null, guidance: "Observed after Scan_Index in 3 sessions.", pitfalls: "" },
  node: { kind: "node", id: "Verify", type: "REASONING", description: "Check the answer." },
  note: { kind: "note", on: { from: "Start", to: "First_Hop_Retrieve" }, text: "Retrieve before reasoning." },
  caution: { kind: "caution", on: { from: "Bridge_Extract", to: "End" }, text: "This edge preceded failures." },
};
const id = EntryIdSchema.parse(sha256Hex("entry"));
const rev = revisionId(seedGraph());

describe("overlay entries and events", () => {
  it("PGR1.29 an overlay entry is an edge, a node, a note or a caution, and never carries a binding", () => {
    for (const entry of Object.values(entries)) expect(OverlayEntrySchema.parse(entry)).toEqual(entry);
    const refused = [
      { ...entries.node, binding: { kind: "tool", name: "rm" } },
      { ...entries.edge, binding: { kind: "tool", name: "rm" } },
      { ...entries.note, text: "" },
      { ...entries.caution, on: { from: "Start" } },
      { ...entries.edge, relation: "next" },
      { kind: "delete", id: "Start" },
    ];
    expect(refused.map((e) => OverlayEntrySchema.safeParse(e).success)).toEqual(refused.map(() => false));
    expect(EntryStatusSchema.options).toEqual(["probation", "active", "retired"]);
  });

  it("PGR1.30 overlay events are observed, proposed, status and rebased, with a turn key of session and turn", () => {
    const events = [
      { kind: "observed", turnKey: "s1/t1", path: ["Start", "First_Hop_Retrieve"], unmatched: ["grep"], score: 0.75, exposure: [id] },
      { kind: "observed", turnKey: "s1/t2", path: [], unmatched: [], score: null, exposure: [] },
      { kind: "proposed", entry: entries.edge, source: { sessions: ["s1", "s2", "s3"], by: "stats" } },
      { kind: "proposed", entry: entries.note, source: { sessions: ["s1"], by: "reflection" } },
      { kind: "status", entry: id, to: "active", reason: "non-inferior at 0.9" },
      { kind: "status", entry: id, to: "retired", reason: "absorbed" },
      { kind: "rebased", core: rev, absorbed: [id], dropped: [], frozenAt: 12 },
    ];
    expect(events.map((e) => OverlayEventSchema.parse(e))).toEqual(events);
    const refused = [
      { ...events[0], turnKey: "no-slash" },
      { ...events[0], turnKey: "/t1" },
      { ...events[0], turnKey: "s1/" },
      { ...events[0], turnKey: "/s1/t1" },
      { ...events[0], turnKey: "s1/t1\nforged" },
      { ...events[0], score: 1.5 },
      { ...events[0], path: ["not a node"] },
      { ...events[2], source: { sessions: ["s1"], by: "model" } },
      { ...events[4], to: "probation" },
      { ...events[4], entry: "short" },
      { ...events[6], frozenAt: -1 },
      { ...events[6], frozenAt: 0.5 },
      { kind: "deleted", entry: id },
    ];
    expect(refused.map((e) => OverlayEventSchema.safeParse(e).success)).toEqual(refused.map(() => false));
    expect(OverlayEventSchema.safeParse(refused[0]).error?.issues[0]?.message).toBe("a turn key <sessionId>/<turnId>");
  });
});

describe("the core view", () => {
  it("PGR1.31 coreView is the core alone: no overlay version, every item from the core, no notes or cautions", () => {
    const parsed = parseGraph(hotpot());
    if (!parsed.ok) throw new Error("fixture");
    const g = parsed.graph;
    const view: EffectiveGraph = coreView(g);
    expect(view.core).toBe(revisionId(g));
    expect(view.overlay).toBeNull();
    expect(view.nodes).toEqual(g.nodes.map((n) => ({ ...n, origin: "core" })));
    expect(view.edges).toEqual(g.edges.map((e) => ({ ...e, origin: "core", notes: [], cautions: [] })));
    expect(view.nodes.some((n) => "status" in n) || view.edges.some((e) => "status" in e)).toBe(false);
  });

  it("PGR1.32 overlay state is a plain record keyed by entry id and edge (a type other phases fold into)", () => {
    const state: OverlayState = {
      base: rev,
      version: 1,
      entries: { [id]: { entry: OverlayEntrySchema.parse(entries.note), status: "probation", evidence: { exposed: { n: 1, scored: 1, scoreSum: 0.5 }, unexposed: { n: 0, scored: 0, scoreSum: 0 }, support: ["s1"], firstSeen: 1, lastSeen: 1 } } },
      stats: { "Start→First_Hop_Retrieve": { traversals: 1, scored: 1, scoreSum: 0.5, lastSeen: 1 } },
      transitions: { "Scan_Index→End": { sessions: ["s1"], scored: 0, scoreSum: 0 } },
      turns: ["s1/t1"],
    };
    expect(state.entries[id]?.status).toBe("probation");
  });
});
