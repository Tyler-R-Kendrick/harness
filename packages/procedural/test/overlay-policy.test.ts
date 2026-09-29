import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decayedSupport, differenceBounds, EntryIdSchema, foldAll, foldOverlay, parseGraph, parseSettings, presetOf, proposals, revisionId, statusChanges } from "@harness/procedural";
import type { EntryId, LiveSettings, OverlayEvent, OverlayState } from "@harness/procedural";
import { ScoreSchema } from "@harness/procedural";
import { cautionOnCore, core, entry, event, hexId, idOf, noteOnCore, noteOnShortcut, observed, proposed, shortcut, status, toVerify, verifyNode } from "./overlay-fixtures.ts";
import { hotpot } from "./fixtures.ts";

const g = core();
const base = revisionId(g);
const settingsFile: unknown = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8"));
const harness = presetOf(parseSettings(settingsFile), "harness").live!;
const live = (overrides: Partial<LiveSettings> = {}): LiveSettings => ({ ...harness, ...overrides });
const fold = (...events: OverlayEvent[]): OverlayState => foldAll(base, events);
/** `n` turns from distinct sessions along a path, all with one score. */
const turns = (prefix: string, n: number, path: string[], score: number | null) => Array.from({ length: n }, (_, i) => observed(`${prefix}${i}/t`, path, score));
/** Live settings at a confidence; at 0 the bounds are the difference itself. */
const exact = (confidence: number) => live({ promote: { confidence: ScoreSchema.parse(confidence) } });
const arm = (scored: number, mean: number) => ({ n: scored, scored, scoreSum: scored * mean });

describe("the statistic", () => {
  it("PO1.21 differenceBounds is the difference of means with a one-sided Hoeffding margin for scores in [0, 1]", () => {
    const b = differenceBounds(arm(100, 0.8), arm(100, 0.8), 0.9);
    const t = Math.sqrt((Math.log(10) * (1 / 100 + 1 / 100)) / 2);
    expect(b.difference).toBeCloseTo(0, 12);
    expect(b.lower).toBeCloseTo(-t, 12);
    expect(b.upper).toBeCloseTo(t, 12);
    const uneven = differenceBounds(arm(50, 0.9), arm(200, 0.6), 0.95);
    const u = Math.sqrt((Math.log(20) * (1 / 50 + 1 / 200)) / 2);
    expect([uneven.difference, uneven.lower, uneven.upper].map((x) => x.toFixed(10))).toEqual([0.3, 0.3 - u, 0.3 + u].map((x) => x.toFixed(10)));
    expect(differenceBounds(arm(4, 1), arm(4, 0), 0)).toEqual({ difference: 1, lower: 1, upper: 1 });
  });

  it("PO1.22 support decays by half every halfLifeDays overlay versions without evidence", () => {
    const evidence = { exposed: arm(0, 0), unexposed: arm(0, 0), support: ["a", "b", "c", "d"], firstSeen: 1, lastSeen: 10 };
    expect(decayedSupport(evidence, 10, 5)).toBe(4);
    expect(decayedSupport(evidence, 15, 5)).toBe(2);
    expect(decayedSupport(evidence, 25, 5)).toBe(0.5);
  });
});

describe("proposals from statistics", () => {
  it("PO1.23 a missing transition seen in minSupport distinct sessions becomes a templated probationary edge", () => {
    const below = fold(...turns("s", 2, ["Scan_Index", "End"], null), observed("s0/t2", ["Scan_Index", "End"], null));
    expect(proposals(below, g, live())).toEqual([]);
    const at = foldOverlay(below, observed("s2/t", ["Scan_Index", "End"], null));
    expect(proposals(at, g, live())).toEqual([
      event({ kind: "proposed", entry: { kind: "edge", from: "Scan_Index", relation: "LEADS_TO", to: "End", condition: null, guidance: "Observed after Scan_Index in 3 sessions.", pitfalls: "" }, source: { sessions: ["s0", "s1", "s2"], by: "stats" } }),
    ]);
    const scored = fold(...turns("s", 2, ["Scan_Index", "End"], 0.5), observed("s2/t", ["Scan_Index", "End"], 1), observed("s3/t", ["Scan_Index", "End"], null));
    expect(proposals(scored, g, live())[0]).toMatchObject({ entry: { guidance: "Observed after Scan_Index in 4 sessions, mean score 0.67." } });
  });

  it("PO1.24 no transition is proposed that the core or any overlay edge already has, or whose endpoints are missing", () => {
    const seen = turns("s", 3, ["Start", "First_Hop_Retrieve", "Scan_Index", "End"], null);
    expect(proposals(fold(...seen), g, live()).map((e) => e.kind === "proposed" && e.entry)).toEqual([expect.objectContaining({ from: "Scan_Index", to: "End" })]);
    const retiredEdge = { ...shortcut, guidance: "Some other text." };
    expect(proposals(fold(...seen, proposed(retiredEdge, ["x"]), status(idOf(retiredEdge), "retired")), g, live())).toEqual([]);
    const toGhost = turns("s", 3, ["Scan_Index", "Ghost"], null);
    expect(proposals(fold(...toGhost), g, live())).toEqual([]);
    const toNode = fold(...turns("s", 3, ["Verify", "End"], null), proposed(verifyNode, ["x"]));
    expect(proposals(toNode, g, live())).toMatchObject([{ entry: { from: "Verify", to: "End" } }]);
    expect(proposals(foldOverlay(toNode, status(idOf(verifyNode), "retired")), g, live())).toEqual([]);
  });

  it("PO1.25 a proposed edge uses LEADS_TO when the core has it, and otherwise the core's first relation", () => {
    const doc = hotpot();
    const other = parseGraph({ ...doc, relations: ["TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"], edges: doc.edges.map((e) => ({ ...e, relation: "TRIGGERS" })) });
    if (!other.ok) throw new Error("fixture");
    const s = foldAll(revisionId(other.graph), turns("s", 3, ["Scan_Index", "End"], null));
    expect(proposals(s, other.graph, live())).toMatchObject([{ entry: { relation: "TRIGGERS" } }]);
    const second = parseGraph({ ...doc, relations: ["TRIGGERS", "LEADS_TO"], edges: doc.edges.map((e) => ({ ...e, relation: "TRIGGERS" })) });
    if (!second.ok) throw new Error("fixture");
    expect(proposals(foldAll(revisionId(second.graph), turns("s", 3, ["Scan_Index", "End"], null)), second.graph, live())).toMatchObject([{ entry: { relation: "LEADS_TO" } }]);
    const bare = parseGraph({ ...doc, relations: [], nodes: doc.nodes.slice(0, 2), edges: [] });
    if (!bare.ok) throw new Error("fixture");
    const t = foldAll(revisionId(bare.graph), turns("s", 3, ["Start", "First_Hop_Retrieve"], null));
    expect(proposals(t, bare.graph, live())).toMatchObject([{ entry: { relation: "LEADS_TO" } }]);
  });

  it("PO1.26 an edge whose scored traversals fall confidently below the rest of the graph gets a probationary caution, once", () => {
    const good = turns("g", 40, ["Start", "First_Hop_Retrieve", "Scan_Index"], 0.9);
    const bad = turns("b", 40, ["Bridge_Extract", "End"], 0.2);
    const s = fold(...good, ...bad);
    expect(proposals(s, g, live())).toEqual([
      event({
        kind: "proposed",
        entry: { kind: "caution", on: { from: "Bridge_Extract", to: "End" }, text: "Preceded lower scores: mean 0.20 over 40 scored traversals, against 0.90 elsewhere in the graph." },
        source: { sessions: bad.map((_, i) => `b${i}`), by: "stats" },
      }),
    ]);
    const cautioned = foldAll(base, [...good, ...bad, ...proposals(s, g, live())]);
    expect(proposals(cautioned, g, live())).toEqual([]);
    const caution = { kind: "caution", on: { from: "Bridge_Extract", to: "End" }, text: "Preceded lower scores: mean 0.20 over 40 scored traversals, against 0.90 elsewhere in the graph." };
    expect(cautioned.entries[idOf(caution)]?.status).toBe("probation");
    expect(proposals(foldOverlay(cautioned, status(idOf(caution), "retired")), g, live())).toEqual([]);
  });

  it("PO1.27 no caution without minSupport scored traversals on the edge and elsewhere, or without a confident gap", () => {
    expect(proposals(fold(...turns("g", 40, ["Start", "First_Hop_Retrieve"], 0.9), ...turns("b", 2, ["Bridge_Extract", "End"], 0)), g, live())).toEqual([]);
    expect(proposals(fold(...turns("g", 2, ["Start", "First_Hop_Retrieve"], 1), ...turns("b", 40, ["Bridge_Extract", "End"], 0)), g, live())).toEqual([]);
    expect(proposals(fold(...turns("g", 5, ["Start", "First_Hop_Retrieve"], 0.9), ...turns("b", 5, ["Bridge_Extract", "End"], 0.6)), g, live())).toEqual([]);
    expect(proposals(fold(...turns("g", 40, ["Start", "First_Hop_Retrieve"], null), ...turns("b", 40, ["Bridge_Extract", "End"], null)), g, live())).toEqual([]);
  });

  it("PO1.28 overlay edges earn cautions too, and a caution's source falls back to no sessions when none were recorded", () => {
    const s = fold(proposed(shortcut, ["x"]), ...turns("g", 40, ["Start", "First_Hop_Retrieve"], 1), ...turns("b", 40, ["Scan_Index", "End"], 0));
    expect(proposals(s, g, live())).toMatchObject([{ entry: { kind: "caution", on: { from: "Scan_Index", to: "End" } } }]);
    const bare: OverlayState = { ...s, transitions: {} };
    expect(proposals(bare, g, live())).toMatchObject([{ source: { sessions: [], by: "stats" } }]);
    expect(proposals(foldOverlay(s, status(idOf(shortcut), "retired")), g, live())).toEqual([]);
  });
});

describe("promotion, retirement and displacement", () => {
  /** One entry with the given arms, proposed at version 1 by `sessions` and last seen at `lastSeen`. */
  function withArms(exposed: { scored: number; mean: number }, unexposed: { scored: number; mean: number }, lastSeen = 1, sessions = ["s1", "s2", "s3"]): OverlayState {
    const s = fold(proposed(shortcut, sessions));
    const id = idOf(shortcut);
    const recorded = s.entries[id]!;
    return { ...s, entries: { [id]: { ...recorded, evidence: { ...recorded.evidence, exposed: arm(exposed.scored, exposed.mean), unexposed: arm(unexposed.scored, unexposed.mean), lastSeen } } } };
  }
  const id = idOf(shortcut);

  it("PO1.29 an entry is promoted when exposed sessions are non-inferior to unexposed ones within the margin at promote.confidence", () => {
    const even = withArms({ scored: 100, mean: 0.8 }, { scored: 100, mean: 0.8 });
    expect(statusChanges(even, live())).toEqual([]);
    expect(statusChanges(even, live(), { margin: 0.2 })).toEqual([status(id, "active", "non-inferior: exposed − unexposed ≥ -0.152 at 0.9 (margin 0.2)")]);
    const better = withArms({ scored: 200, mean: 0.95 }, { scored: 200, mean: 0.7 });
    expect(statusChanges(better, live())).toMatchObject([{ kind: "status", entry: id, to: "active" }]);
    expect(statusChanges(even, live({ promote: { confidence: harness.promote.confidence } }), { margin: 0.15 })).toEqual([]);
  });

  it("PO1.30 an entry stays on probation until both arms have minSupport scored turns", () => {
    expect(statusChanges(withArms({ scored: 2, mean: 1 }, { scored: 400, mean: 0 }), live(), { margin: 0.5 })).toEqual([]);
    expect(statusChanges(withArms({ scored: 400, mean: 1 }, { scored: 2, mean: 0 }), live(), { margin: 0.5 })).toEqual([]);
    expect(statusChanges(withArms({ scored: 3, mean: 1 }, { scored: 3, mean: 0 }), live({ promote: { confidence: harness.promote.confidence } }), { margin: 0.5 })).toMatchObject([{ to: "active" }]);
  });

  it("PO1.31 an entry is retired when exposed sessions are confidently inferior beyond the margin, active or not", () => {
    const worse = withArms({ scored: 100, mean: 0.5 }, { scored: 100, mean: 0.8 });
    expect(statusChanges(worse, live())).toEqual([status(id, "retired", "inferior: exposed − unexposed ≤ -0.148 at 0.9 (margin 0)")]);
    expect(statusChanges(worse, live(), { margin: 0.15 })).toEqual([]);
    const active = foldOverlay(worse, status(id, "active"));
    expect(statusChanges({ ...active, version: 1 }, live())).toMatchObject([{ to: "retired" }]);
    expect(statusChanges(foldOverlay(worse, status(id, "retired")), live())).toEqual([]);
  });

  it("PO1.32 an entry whose decayed support falls below half a session is retired as stale", () => {
    const one = withArms({ scored: 0, mean: 0 }, { scored: 0, mean: 0 }, 1, ["s1"]);
    expect(statusChanges({ ...one, version: 31 }, live({ halfLifeDays: 30 }))).toEqual([]);
    expect(statusChanges({ ...one, version: 32 }, live({ halfLifeDays: 30 }))).toEqual([status(id, "retired", "stale: decayed support 0.49 below 0.5")]);
    const promotable = withArms({ scored: 200, mean: 0.95 }, { scored: 200, mean: 0.7 }, 1, ["s1"]);
    expect(statusChanges({ ...promotable, version: 40 }, live({ halfLifeDays: 30 }))).toMatchObject([{ to: "retired" }]);
  });

  it("PO1.33 beyond maxEntries the weakest live entries are displaced: probation before active, then by decayed support, recency and id", () => {
    const [a, b, c, d] = [shortcut, noteOnCore, cautionOnCore, toVerify].map(idOf);
    const s = fold(proposed(shortcut, ["s1"]), proposed(noteOnCore, ["s1", "s2", "s3"]), proposed(cautionOnCore, ["s1", "s2"]), proposed(toVerify, ["s1"]), proposed(verifyNode, ["s1"]), status(idOf(verifyNode), "retired"), status(a!, "active"));
    // a is active, so it is kept first; then b (3 sessions), c (2) and d (1).
    expect(statusChanges(s, live({ maxEntries: 3 }))).toEqual([status(d!, "retired", "displaced: more than 3 live entries")]);
    expect(statusChanges(s, live({ maxEntries: 1 }))).toEqual([b, c, d].map((x) => status(x!, "retired", "displaced: more than 1 live entries")));
    expect(statusChanges(s, live({ maxEntries: 4 }))).toEqual([]);
    const tiedEntries = [noteOnCore, cautionOnCore, noteOnShortcut, shortcut];
    const tie = fold(...tiedEntries.map((e) => proposed(e, ["s1"])));
    const tied: OverlayState = { ...tie, entries: Object.fromEntries(Object.entries(tie.entries).map(([k, r]) => [k, { ...r, evidence: { ...r.evidence, lastSeen: 4 } }])) };
    const byId = tiedEntries.map(idOf).sort();
    expect(statusChanges(tied, live({ maxEntries: 1 }))).toEqual(byId.slice(1).map((x) => status(EntryIdSchema.parse(x), "retired", "displaced: more than 1 live entries")));
  });

  it("PO1.34 entries retired in the same pass are not displaced again, and status events fold without effect twice", () => {
    const worse = withArms({ scored: 100, mean: 0.2 }, { scored: 100, mean: 0.8 });
    const two = fold(proposed(noteOnCore, ["s1"]));
    const s: OverlayState = { ...worse, entries: { ...worse.entries, ...two.entries } };
    const changes = statusChanges(s, live({ maxEntries: 1 }));
    expect(changes).toEqual([status(id, "retired", "inferior: exposed − unexposed ≤ -0.448 at 0.9 (margin 0)")]);
    const after = changes.reduce(foldOverlay, s);
    expect(changes.reduce(foldOverlay, after)).toBe(after);
    const unknown: EntryId = hexId("0f");
    expect(foldOverlay(after, status(unknown, "retired"))).toBe(after);
    expect(entry(noteOnCore)).toEqual(two.entries[idOf(noteOnCore)]!.entry);
  });

  it("PO1.38 at a bound exactly on the margin an entry is neither promoted nor retired", () => {
    // Confidence 0 makes the bounds the difference itself: 0.5 − 0.75 = −0.25, exactly −margin.
    expect(statusChanges(withArms({ scored: 4, mean: 0.5 }, { scored: 4, mean: 0.75 }), exact(0), { margin: 0.25 })).toEqual([]);
    expect(statusChanges(withArms({ scored: 4, mean: 0.5 }, { scored: 4, mean: 0.75 }), exact(0), { margin: 0.125 })).toMatchObject([{ to: "retired" }]);
    expect(statusChanges(withArms({ scored: 4, mean: 0.75 }, { scored: 4, mean: 0.75 }), exact(0), { margin: 0.125 })).toMatchObject([{ to: "active" }]);
  });

  it("PO1.39 an active entry is not promoted again", () => {
    const better = withArms({ scored: 200, mean: 0.95 }, { scored: 200, mean: 0.7 });
    expect(statusChanges(foldOverlay(better, status(id, "active")), live())).toEqual([]);
  });

  it("PO1.40 an entry promoted in the pass ranks as active for displacement, and recency breaks a tie in decayed support", () => {
    const promotable = withArms({ scored: 200, mean: 0.95 }, { scored: 200, mean: 0.7 }, 1, ["s1"]);
    const strong = fold(proposed(noteOnCore, ["a", "b", "c", "d"]));
    const s: OverlayState = { ...promotable, entries: { ...strong.entries, ...promotable.entries } };
    expect(statusChanges(s, live({ maxEntries: 1 }))).toMatchObject([
      { kind: "status", entry: id, to: "active", reason: expect.stringContaining("non-inferior") as unknown },
      { kind: "status", entry: idOf(noteOnCore), to: "retired", reason: "displaced: more than 1 live entries" },
    ]);
    // Two sessions a half-life ago weigh as much as one session now; the more recent is kept.
    const older = fold(proposed(noteOnCore, ["a", "b"]), proposed(cautionOnCore, ["c"]));
    const aged: OverlayState = { ...older, entries: Object.fromEntries(Object.entries(older.entries).map(([k, r]) => [k, { ...r, evidence: { ...r.evidence, lastSeen: k === idOf(noteOnCore) ? 1 : 2 } }])) };
    expect(statusChanges(aged, live({ maxEntries: 1, halfLifeDays: 1 }))).toEqual([status(idOf(noteOnCore), "retired", "displaced: more than 1 live entries")]);
    // An active entry proposed last, with the least support, is still kept first.
    const late = fold(proposed(noteOnCore, ["a", "b", "c"]), proposed(shortcut, ["a"]), status(id, "active"));
    expect(statusChanges(late, live({ maxEntries: 1 }))).toEqual([status(idOf(noteOnCore), "retired", "displaced: more than 1 live entries")]);
  });
});

describe("cautions, edge cases", () => {
  const good = (n: number) => turns("g", n, ["Start", "First_Hop_Retrieve"], 1);

  it("PO1.41 exactly minSupport scored traversals on the edge, or elsewhere, is enough for a caution", () => {
    expect(proposals(fold(...good(80), ...turns("b", 3, ["Bridge_Extract", "End"], 0)), g, live())).toMatchObject([{ entry: { kind: "caution" } }]);
    expect(proposals(fold(...good(3), ...turns("b", 80, ["Bridge_Extract", "End"], 0)), g, live())).toMatchObject([{ entry: { kind: "caution", on: { from: "Bridge_Extract" } } }]);
  });

  it("PO1.42 an upper bound of exactly 0 earns no caution", () => {
    expect(proposals(fold(...turns("g", 4, ["Start", "First_Hop_Retrieve"], 0.5), ...turns("b", 4, ["Bridge_Extract", "End"], 0.5)), g, exact(0))).toEqual([]);
  });

  it("PO1.43 an edge shown twice (a second relation between its endpoints) gets one caution; live overlay edges missing an endpoint get none", () => {
    const parallel = { kind: "edge", from: "Bridge_Extract", relation: "TRIGGERS", to: "End", condition: null, guidance: "g", pitfalls: "" };
    expect(proposals(fold(proposed(parallel, ["x"]), ...good(40), ...turns("b", 40, ["Bridge_Extract", "End"], 0)), g, live())).toHaveLength(1);
    for (const path of [["Ghost", "End"], ["Scan_Index", "Ghost"]]) {
      const dangling = { ...parallel, from: path[0], to: path[1] };
      expect(proposals(fold(proposed(dangling, ["x"]), ...good(40), ...turns("b", 40, path, 0)), g, live())).toEqual([]);
    }
  });

  it("PO1.44 a node named `undefined` is an ordinary name: its missing self-loop is proposed beside other entries", () => {
    const doc = hotpot();
    const named = parseGraph({ ...doc, nodes: [...doc.nodes, { id: "undefined", type: "ACTION", description: "A node." }], edges: [...doc.edges, { ...doc.edges[0]!, from: "undefined", to: "End" }] });
    if (!named.ok) throw new Error("fixture");
    const s = foldAll(revisionId(named.graph), [proposed(noteOnCore, ["x"]), ...turns("s", 3, ["undefined", "undefined"], null)]);
    expect(proposals(s, named.graph, live())).toMatchObject([{ entry: { kind: "edge", from: "undefined", to: "undefined" } }]);
  });
});
