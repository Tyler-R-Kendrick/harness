import { describe, expect, it } from "vitest";
import { canonicalJson, coreView, parseGraph, edgeKey, effectiveGraph, emptyOverlay, entryId, exposed, foldAll, foldOverlay, MAX_SESSIONS, MAX_TURNS, rebaseOverlay, revisionId, seedGraph, sha256Hex } from "@harness/procedural";
import type { OverlayState } from "@harness/procedural";
import { cautionOnCore, core, deepFreeze, entry, event, hexId, idOf, noteOnCore, noteOnShortcut, observed, proposed, saltWhere, shortcut, status, toVerify, verifyNode } from "./overlay-fixtures.ts";

const base = revisionId(core());
const fold = (...events: Parameters<typeof foldOverlay>[1][]): OverlayState => foldAll(base, events);
/** An overlay edge entry as the effective graph shows it. */
const shownEdge = (input: unknown, status: string) => {
  const { kind: _, ...edge } = entry(input);
  return { ...edge, origin: "overlay", status, notes: [], cautions: [] };
};
function graphOf(doc: unknown) {
  const parsed = parseGraph(JSON.parse(JSON.stringify(doc)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.graph;
}
const arm = (n: number, scored: number, scoreSum: number) => ({ n, scored, scoreSum });

describe("entry ids and the empty overlay", () => {
  it("PO1.1 an entry id is the sha256 of the entry's canonical JSON, whatever its key order", () => {
    const e = entry(shortcut);
    expect(entryId(e)).toBe(sha256Hex(canonicalJson(e)));
    const reordered = entry({ pitfalls: "", guidance: "Answer directly.", condition: null, to: "End", relation: "LEADS_TO", from: "Scan_Index", kind: "edge" });
    expect(entryId(reordered)).toBe(entryId(e));
    expect(entryId(entry({ ...shortcut, guidance: "Other." }))).not.toBe(entryId(e));
  });

  it("PO1.2 the empty overlay is on its base, at version 0, with nothing folded", () => {
    expect(emptyOverlay(base)).toEqual({ base, version: 0, entries: {}, stats: {}, transitions: {}, turns: [] });
    expect(edgeKey("Start", "End")).toBe("Start→End");
    expect([MAX_TURNS, MAX_SESSIONS]).toEqual([10_000, 64]);
  });
});

describe("folding observed turns", () => {
  it("PO1.3 an observed turn counts each consecutive pair of its path; a null score counts as a traversal only", () => {
    const s = fold(observed("s1/t1", ["Start", "First_Hop_Retrieve", "Scan_Index"], 0.5), observed("s2/t1", ["Start", "First_Hop_Retrieve"]));
    expect(s.version).toBe(2);
    expect(s.stats).toEqual({
      "Start→First_Hop_Retrieve": { traversals: 2, scored: 1, scoreSum: 0.5, lastSeen: 2 },
      "First_Hop_Retrieve→Scan_Index": { traversals: 1, scored: 1, scoreSum: 0.5, lastSeen: 1 },
    });
    expect(s.turns).toEqual(["s1/t1", "s2/t1"]);
    expect(fold(observed("s1/t1", ["Start"], 1)).stats).toEqual({});
  });

  it("PO1.4 every observed pair records its distinct sessions (at most 64) and its scores, whether or not the graph has the edge", () => {
    const events = [observed("s1/t1", ["Scan_Index", "End"], 0.25), observed("s1/t2", ["Scan_Index", "End"], 0.75), observed("s2/t1", ["Scan_Index", "End"])];
    expect(fold(...events).transitions).toEqual({ "Scan_Index→End": { sessions: ["s1", "s2"], scored: 2, scoreSum: 1 } });
    const many = Array.from({ length: 70 }, (_, i) => observed(`s${i}/t`, ["Start", "End"], 1));
    const t = fold(...many).transitions["Start→End"]!;
    expect(t.sessions).toEqual(Array.from({ length: 64 }, (_, i) => `s${i}`));
    expect([t.scored, t.scoreSum]).toEqual([70, 70]);
  });

  it("PO1.5 a repeated turn key changes nothing, not even the version (I4)", () => {
    const once = fold(observed("s1/t1", ["Start", "First_Hop_Retrieve"], 0.5));
    const again = foldOverlay(once, observed("s1/t1", ["Start", "First_Hop_Retrieve"], 0.5));
    expect(again).toBe(once);
    expect(foldOverlay(once, observed("s1/t1", ["Scan_Index", "End"], 1))).toBe(once);
  });

  it("PO1.6 the turn keys kept are bounded: past 10,000 the oldest is dropped", () => {
    let s = emptyOverlay(base);
    for (let i = 0; i <= MAX_TURNS; i += 1) s = foldOverlay(s, observed(`s/${i}`, []));
    expect(s.turns).toHaveLength(MAX_TURNS);
    expect(s.turns[0]).toBe("s/1");
    expect(s.turns.at(-1)).toBe(`s/${MAX_TURNS}`);
    expect(s.version).toBe(MAX_TURNS + 1);
  });

  it("PO1.7 an observed turn is evidence for every live entry whose anchor it reached: exposed when shown it, unexposed when not", () => {
    const [edge, node, note, caution] = [shortcut, verifyNode, noteOnCore, cautionOnCore].map(idOf);
    const proposals = [proposed(shortcut, ["s0"]), proposed(verifyNode, ["s0"]), proposed(noteOnCore, ["s0"]), proposed(cautionOnCore, ["s0"])];
    const s = fold(
      ...proposals,
      observed("s1/t1", ["Start", "First_Hop_Retrieve", "Scan_Index"], 0.5, [edge!, note!]),
      observed("s2/t1", ["Scan_Index", "Bridge_Extract"], 1),
      observed("s3/t1", ["Verify"], null, [node!]),
      observed("s4/t1", ["End"], 1, [edge!, caution!]),
    );
    expect(s.entries[edge!]!.evidence).toMatchObject({ exposed: arm(1, 1, 0.5), unexposed: arm(1, 1, 1), lastSeen: 6 });
    expect(s.entries[note!]!.evidence).toMatchObject({ exposed: arm(1, 1, 0.5), unexposed: arm(0, 0, 0), lastSeen: 5 });
    expect(s.entries[node!]!.evidence).toMatchObject({ exposed: arm(1, 0, 0), unexposed: arm(0, 0, 0), lastSeen: 7 });
    expect(s.entries[caution!]!.evidence).toMatchObject({ exposed: arm(0, 0, 0), unexposed: arm(1, 1, 1), lastSeen: 6 });
    const retired = fold(proposed(shortcut, ["s0"]), status(edge!, "retired"), observed("s1/t1", ["Scan_Index"], 1, [edge!]));
    expect(retired.entries[edge!]!.evidence).toMatchObject({ exposed: arm(0, 0, 0), unexposed: arm(0, 0, 0), lastSeen: 1 });
  });
});

describe("folding proposals and status", () => {
  it("PO1.8 a proposal adds a probationary entry with its distinct sessions as support", () => {
    const s = fold(observed("s9/t1", []), proposed(shortcut, ["s1", "s2", "s1"]));
    expect(s.entries[idOf(shortcut)]).toEqual({
      entry: entry(shortcut),
      status: "probation",
      evidence: { exposed: arm(0, 0, 0), unexposed: arm(0, 0, 0), support: ["s1", "s2"], firstSeen: 2, lastSeen: 2 },
    });
    expect(s.version).toBe(2);
  });

  it("PO1.9 a re-proposal adds only new support (at most 64 sessions); one with nothing new changes nothing (I4)", () => {
    const once = fold(proposed(shortcut, ["s1"]));
    expect(foldOverlay(once, proposed(shortcut, ["s1"], "reflection"))).toBe(once);
    const more = foldOverlay(foldOverlay(once, observed("x/t", [])), proposed(shortcut, ["s1", "s2"]));
    expect(more.entries[idOf(shortcut)]!.evidence).toMatchObject({ support: ["s1", "s2"], firstSeen: 1, lastSeen: 3 });
    expect(more.version).toBe(3);
    const full = fold(proposed(shortcut, Array.from({ length: 70 }, (_, i) => `s${i}`)));
    expect(full.entries[idOf(shortcut)]!.evidence.support).toHaveLength(64);
    expect(foldOverlay(full, proposed(shortcut, ["s99"]))).toBe(full);
  });

  it("PO1.10 a status event moves an entry; one naming an unknown entry or its current status changes nothing", () => {
    const id = idOf(shortcut);
    const s = fold(proposed(shortcut, ["s1"]), status(id, "active"));
    expect([s.entries[id]!.status, s.version]).toEqual(["active", 2]);
    expect(foldOverlay(s, status(id, "active"))).toBe(s);
    expect(foldOverlay(s, status(hexId("ab"), "retired"))).toBe(s);
    expect(foldOverlay(s, status(id, "retired")).entries[id]!.status).toBe("retired");
  });

  it("PO1.11 a rebased event moves the base, retires absorbed entries and removes dropped ones", () => {
    const next = revisionId(seedGraph());
    const [a, b, c] = [shortcut, noteOnCore, cautionOnCore].map(idOf);
    const s = fold(proposed(shortcut, ["s1"]), proposed(noteOnCore, ["s1"]), proposed(cautionOnCore, ["s1"]));
    const r = foldOverlay(s, event({ kind: "rebased", core: next, absorbed: [a, hexId("cd")], dropped: [b, hexId("ef")], frozenAt: 3 }));
    expect(r.base).toBe(next);
    expect(r.version).toBe(4);
    expect(Object.keys(r.entries)).toEqual([a, c]);
    expect([r.entries[a!]!.status, r.entries[c!]!.status]).toEqual(["retired", "probation"]);
  });

  it("PO1.12 folding never mutates its input, for any kind of event", () => {
    const id = idOf(shortcut);
    const s = deepFreeze(fold(proposed(shortcut, ["s1"]), observed("s1/t1", ["Scan_Index", "End"], 1, [id])));
    const events = [
      observed("s2/t1", ["Scan_Index", "End"], 0.5, [id]),
      proposed(shortcut, ["s2"]),
      proposed(noteOnCore, ["s2"]),
      status(id, "active"),
      event({ kind: "rebased", core: base, absorbed: [id], dropped: [], frozenAt: 2 }),
      event({ kind: "rebased", core: base, absorbed: [], dropped: [id], frozenAt: 2 }),
    ];
    for (const e of events) expect(() => foldOverlay(s, e)).not.toThrow();
    expect(s.version).toBe(2);
  });

  it("PO1.13 foldAll folds a log from the empty overlay", () => {
    const events = [proposed(shortcut, ["s1"]), observed("s1/t1", ["Scan_Index", "End"], 1)];
    expect(foldAll(base, events)).toEqual(foldOverlay(foldOverlay(emptyOverlay(base), events[0]!), events[1]!));
    expect(foldAll(base, [])).toEqual(emptyOverlay(base));
  });
});

describe("exposure", () => {
  it("PO1.14 exposure is the first 8 hex digits of sha256(salt + id) over 2^32, below the share", () => {
    const id = idOf(shortcut);
    const draw = Number.parseInt(sha256Hex(`salt${id}`).slice(0, 8), 16) / 2 ** 32;
    expect(exposed("salt", id, draw)).toBe(false);
    expect(exposed("salt", id, draw + 1e-9)).toBe(true);
    expect(exposed("salt", id, 0)).toBe(false);
    expect(exposed("salt", id, 1)).toBe(true);
  });
});

describe("the effective graph", () => {
  const g = core();
  const view = { salt: "session-1", probationShare: 0.2 };

  it("PO1.15 with nothing learned it is the core view at the overlay's version", () => {
    const s = fold(observed("s1/t1", ["Start"]));
    expect(effectiveGraph(g, s, view)).toEqual({ ...coreView(g), overlay: 1 });
  });

  it("PO1.16 active entries appear labeled with their status, retired never, probationary ones only when this session is exposed", () => {
    const [edge, node, toV] = [shortcut, verifyNode, toVerify].map(idOf);
    const s = fold(proposed(shortcut, ["s1"]), proposed(verifyNode, ["s1"]), proposed(toVerify, ["s1"]), status(node!, "active"), status(toV!, "active"));
    const shown = effectiveGraph(g, s, { salt: saltWhere(edge!, 0.2, true), probationShare: 0.2 });
    expect(shown.nodes.at(-1)).toEqual({ id: "Verify", type: "REASONING", description: "Check the answer.", origin: "overlay", status: "active" });
    expect(shown.edges.slice(-2)).toEqual([shownEdge(shortcut, "probation"), shownEdge(toVerify, "active")]);
    const hidden = effectiveGraph(g, s, { salt: saltWhere(edge!, 0.2, false), probationShare: 0.2 });
    expect(hidden.edges.map((e) => `${e.from}→${e.to}`)).not.toContain("Scan_Index→End");
    expect(hidden.edges.map((e) => `${e.from}→${e.to}`)).toContain("Bridge_Extract→Verify");
    const retired = foldOverlay(s, status(toV!, "retired"));
    expect(effectiveGraph(g, retired, view).edges.map((e) => `${e.from}→${e.to}`)).not.toContain("Bridge_Extract→Verify");
    expect(effectiveGraph(g, s, { ...view, probationShare: 0 }).edges).toHaveLength(g.edges.length + 1);
  });

  it("PO1.17 the overlay never replaces a core node or duplicates an edge (I2)", () => {
    const shadowNode = { kind: "node", id: "Scan_Index", type: "ACTION", description: "Rewritten." };
    const shadowEdge = { kind: "edge", from: "Start", relation: "LEADS_TO", to: "First_Hop_Retrieve", condition: "never", guidance: "Rewritten.", pitfalls: "" };
    const otherRelation = { ...shadowEdge, relation: "TRIGGERS" };
    const s = fold(...[shadowNode, shadowEdge, otherRelation].flatMap((e) => [proposed(e, ["s1"]), status(idOf(e), "active")]));
    const eff = effectiveGraph(g, s, view);
    expect(eff.nodes).toEqual(coreView(g).nodes);
    expect(eff.edges.slice(0, g.edges.length)).toEqual(coreView(g).edges);
    expect(eff.edges.slice(g.edges.length)).toEqual([shownEdge(otherRelation, "active")]);
  });

  it("PO1.18 notes and cautions attach to every edge between their endpoints; entries whose anchors are missing are skipped (I6)", () => {
    const parallel = { ...shortcut, relation: "TRIGGERS", guidance: "Also." };
    const dangling = { kind: "edge", from: "Scan_Index", relation: "LEADS_TO", to: "Nowhere", condition: null, guidance: "", pitfalls: "" };
    const loneNote = { kind: "note", on: { from: "End", to: "Start" }, text: "No such edge." };
    const all = [shortcut, parallel, noteOnShortcut, noteOnCore, cautionOnCore, dangling, loneNote, toVerify];
    const s = fold(...all.flatMap((e) => [proposed(e, ["s1"]), status(idOf(e), "active")]));
    const eff = effectiveGraph(g, s, view);
    expect(eff.edges.map((e) => `${e.from}→${e.to}:${e.relation}`)).toEqual([...g.edges.map((e) => `${e.from}→${e.to}:${e.relation}`), "Scan_Index→End:LEADS_TO", "Scan_Index→End:TRIGGERS"]);
    const on = (from: string, to: string) => eff.edges.filter((e) => e.from === from && e.to === to);
    expect(on("Scan_Index", "End").map((e) => e.notes)).toEqual([[{ text: noteOnShortcut.text, status: "active" }], [{ text: noteOnShortcut.text, status: "active" }]]);
    expect(on("Start", "First_Hop_Retrieve")[0]).toMatchObject({ origin: "core", notes: [{ text: noteOnCore.text, status: "active" }], cautions: [] });
    expect(on("Bridge_Extract", "End")[0]).toMatchObject({ origin: "core", notes: [], cautions: [{ text: cautionOnCore.text, status: "active" }] });
    expect(eff.core).toBe(base);
    expect(eff.overlay).toBe(s.version);
  });
});

describe("rebasing onto a new core", () => {
  it("PO1.19 absorbed entries retire, entries whose anchors are gone drop (cascading), the rest carry over, and the event replays", () => {
    // The new core drops Bridge_Extract: its caution loses its edge, the edge to Verify loses an endpoint, and so does a note on that edge.
    const doc = core();
    const parsed = { ...doc, nodes: doc.nodes.filter((n) => n.id !== "Bridge_Extract"), edges: [...doc.edges.filter((e) => e.from !== "Bridge_Extract" && e.to !== "Bridge_Extract"), { ...doc.edges[1]!, from: "Scan_Index", to: "End" }] };
    const noteOnVerify = { kind: "note", on: { from: "Bridge_Extract", to: "Verify" }, text: "Verify names." };
    const [edge, node, toV, note, caution, noteV, retiredNote] = [shortcut, verifyNode, toVerify, noteOnCore, cautionOnCore, noteOnVerify, { ...noteOnCore, text: "Old." }].map(idOf);
    const s = fold(
      ...[shortcut, verifyNode, toVerify, noteOnCore, cautionOnCore, noteOnVerify, { ...noteOnCore, text: "Old." }].map((e) => proposed(e, ["s1"])),
      status(retiredNote!, "retired"),
      observed("s1/t1", ["Start", "First_Hop_Retrieve"], 1),
    );
    const newCore = graphOf(parsed);
    const { state, event: rebased } = rebaseOverlay(s, newCore, [edge!]);
    expect(rebased).toEqual({ kind: "rebased", core: revisionId(newCore), absorbed: [edge], dropped: [toV, caution, noteV], frozenAt: s.version });
    expect(state).toEqual(foldOverlay(s, rebased));
    expect(Object.keys(state.entries)).toEqual([edge, node, note, retiredNote]);
    expect(state.entries[edge!]!.status).toBe("retired");
    expect(state.entries[note!]).toEqual(s.entries[note!]);
    expect(state.stats).toEqual(s.stats);
    expect(state.transitions).toEqual(s.transitions);
  });

  it("PO1.20 a retired entry never anchors another, and an absorbed node no longer in the core takes its edges with it", () => {
    const [node, toV, noteOld] = [verifyNode, toVerify, { ...noteOnCore, on: { from: "Bridge_Extract", to: "Verify" } }].map(idOf);
    const s = fold(proposed(verifyNode, ["s1"]), proposed(toVerify, ["s1"]), proposed({ ...noteOnCore, on: { from: "Bridge_Extract", to: "Verify" } }, ["s1"]), status(toV!, "retired"));
    expect(rebaseOverlay(s, core(), []).event).toMatchObject({ dropped: [noteOld] });
    expect(rebaseOverlay(s, core(), [node!]).event).toMatchObject({ absorbed: [node], dropped: [toV, noteOld] });
  });

  it("PO1.35 a note on a live overlay edge survives a rebase; notes on overlay edges missing either endpoint drop with them", () => {
    const fromGhost = { ...shortcut, from: "Ghost" };
    const toGhost = { ...shortcut, to: "Ghost" };
    const on = (e: { from: string; to: string }) => ({ kind: "note", on: { from: e.from, to: e.to }, text: "n" });
    const all = [shortcut, on(shortcut), fromGhost, on(fromGhost), toGhost, on(toGhost)];
    const s = fold(...all.map((e) => proposed(e, ["s1"])));
    const { event: rebased } = rebaseOverlay(s, core(), []);
    expect(rebased).toMatchObject({ dropped: [fromGhost, on(fromGhost), toGhost, on(toGhost)].map(idOf) });
  });
});

describe("the effective graph, edge cases", () => {
  const g = core();

  it("PO1.36 a retired entry is never shown, even when every session is exposed", () => {
    const s = fold(proposed(shortcut, ["s1"]), status(idOf(shortcut), "retired"));
    expect(effectiveGraph(g, s, { salt: "any", probationShare: 1 }).edges).toHaveLength(g.edges.length);
  });

  it("PO1.37 an overlay edge missing its source is skipped, one repeating an overlay triple shows once, and notes stay on their own edge", () => {
    const fromGhost = { ...shortcut, from: "Ghost" };
    const twin = { ...shortcut, guidance: "Twin." };
    const s = fold(...[fromGhost, shortcut, twin, noteOnShortcut].flatMap((e) => [proposed(e, ["s1"]), status(idOf(e), "active")]));
    const eff = effectiveGraph(g, s, { salt: "x", probationShare: 0 });
    expect(eff.edges.slice(g.edges.length)).toEqual([{ ...shownEdge(shortcut, "active"), notes: [{ text: noteOnShortcut.text, status: "active" }] }]);
    expect(eff.edges.filter((e) => e.notes.length > 0).map((e) => `${e.from}→${e.to}`)).toEqual(["Scan_Index→End"]);
  });
});
