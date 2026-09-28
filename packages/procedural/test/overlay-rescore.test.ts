import { describe, expect, it } from "vitest";
import { foldAll, foldOverlay, MAX_TURNS, OverlayEventSchema, revisionId } from "@harness/procedural";
import type { OverlayEvent, OverlayState } from "@harness/procedural";
import { core, event, idOf, noteOnCore, observed, proposed, shortcut } from "./overlay-fixtures.ts";

const base = revisionId(core());
const fold = (...events: OverlayEvent[]): OverlayState => foldAll(base, events);
const path = ["Start", "First_Hop_Retrieve", "Scan_Index"];
/** A feedback re-observation of `turnKey`: the new score, the one it replaces, and the version the original folded at. */
const rescored = (turnKey: string, score: number | null, previous: number | null, seq: number, observedAt: number, exposure: string[] = [], p: string[] = path): OverlayEvent =>
  event({ kind: "observed", turnKey, path: p, unmatched: [], score, exposure, rescore: { seq, previous, observedAt } });

describe("feedback re-observations (rescore)", () => {
  it("PLV1.1 an observed event may carry a rescore: a positive sequence number, the score it replaces and the version the turn folded at", () => {
    expect(OverlayEventSchema.safeParse({ kind: "observed", turnKey: "s1/t1", path, unmatched: [], score: 1, exposure: [], rescore: { seq: 1, previous: null, observedAt: 1 } }).success).toBe(true);
    const bad = [
      { seq: 0, previous: null, observedAt: 1 },
      { seq: 1.5, previous: null, observedAt: 1 },
      { seq: 1, previous: 2, observedAt: 1 },
      { seq: 1, previous: null, observedAt: 0 },
      { seq: 1, previous: null },
      { seq: 1, previous: null, observedAt: 1, extra: true },
    ];
    for (const rescore of bad) expect(OverlayEventSchema.safeParse({ kind: "observed", turnKey: "s1/t1", path, unmatched: [], score: 1, exposure: [], rescore }).success).toBe(false);
  });

  it("PLV1.2 a rescore swaps the turn's score on its edges and transitions: no new traversal, no new session", () => {
    const original = fold(observed("s1/t1", path, 0.25), observed("s2/t1", path, 0.5));
    const after = foldOverlay(original, rescored("s1/t1", 1, 0.25, 1, 1));
    expect(after.version).toBe(3);
    expect(after.stats["Start→First_Hop_Retrieve"]).toEqual({ traversals: 2, scored: 2, scoreSum: 1.5, lastSeen: 2 });
    expect(after.stats["First_Hop_Retrieve→Scan_Index"]).toEqual({ traversals: 2, scored: 2, scoreSum: 1.5, lastSeen: 2 });
    expect(after.transitions["Start→First_Hop_Retrieve"]).toEqual({ sessions: ["s1", "s2"], scored: 2, scoreSum: 1.5 });
  });

  it("PLV1.3 a rescore of an unscored turn adds a scored traversal, and one to null withdraws it", () => {
    const unscored = fold(observed("s1/t1", path));
    const scored = foldOverlay(unscored, rescored("s1/t1", 0.75, null, 1, 1));
    expect(scored.stats["Start→First_Hop_Retrieve"]).toEqual({ traversals: 1, scored: 1, scoreSum: 0.75, lastSeen: 1 });
    const withdrawn = foldOverlay(scored, rescored("s1/t1", null, 0.75, 2, 1));
    expect(withdrawn.stats["Start→First_Hop_Retrieve"]).toEqual({ traversals: 1, scored: 0, scoreSum: 0, lastSeen: 1 });
    expect(withdrawn.transitions["Start→First_Hop_Retrieve"]).toEqual({ sessions: ["s1"], scored: 0, scoreSum: 0 });
  });

  it("PLV1.4 a redelivered rescore (same turn and sequence) changes nothing; the next sequence applies", () => {
    const once = foldOverlay(fold(observed("s1/t1", path, 0.25)), rescored("s1/t1", 1, 0.25, 1, 1));
    expect(foldOverlay(once, rescored("s1/t1", 1, 0.25, 1, 1))).toBe(once);
    const twice = foldOverlay(once, rescored("s1/t1", 0.5, 1, 2, 1));
    expect(twice.version).toBe(3);
    expect(twice.stats["Start→First_Hop_Retrieve"]).toEqual({ traversals: 1, scored: 1, scoreSum: 0.5, lastSeen: 1 });
  });

  it("PLV1.5 a rescore's key never collides with a turn key, and a plain observation of a seen turn is still a duplicate", () => {
    const s = foldOverlay(fold(observed("s1/t1", path, 0.25)), rescored("s1/t1", 1, 0.25, 1, 1));
    expect(s.turns).toHaveLength(2);
    expect(s.turns[1]).toMatch(/^\//);
    expect(foldOverlay(s, observed("s1/t1", path, 0.25))).toBe(s);
  });

  it("PLV1.6 a rescore moves the score in the arm each entry counted the turn in, for entries that existed then and are not retired", () => {
    const early = idOf(noteOnCore);
    // The note exists before the turn (version 1); the shortcut is proposed after it (version 3).
    const s = fold(proposed(noteOnCore, ["s9"]), observed("s1/t1", ["Start", "First_Hop_Retrieve"], 0.25, [early]), proposed(shortcut, ["s9"]));
    expect(s.entries[early]!.evidence.exposed).toEqual({ n: 1, scored: 1, scoreSum: 0.25 });
    const after = foldOverlay(s, rescored("s1/t1", 1, 0.25, 1, 2, [early], ["Start", "First_Hop_Retrieve"]));
    expect(after.entries[early]!.evidence.exposed).toEqual({ n: 1, scored: 1, scoreSum: 1 });
    expect(after.entries[early]!.evidence.unexposed).toEqual({ n: 0, scored: 0, scoreSum: 0 });
    // The shortcut's anchor (Scan_Index) is not on this path, and it came later anyway.
    expect(after.entries[idOf(shortcut)]).toEqual(s.entries[idOf(shortcut)]);
  });

  it("PLV1.7 entries proposed after the turn folded, retired ones, and ones whose anchor the path missed are untouched", () => {
    const note = idOf(noteOnCore);
    const s = fold(observed("s1/t1", ["Start", "First_Hop_Retrieve"], 0.25), proposed(noteOnCore, ["s9"]));
    const after = foldOverlay(s, rescored("s1/t1", 1, 0.25, 1, 1, [], ["Start", "First_Hop_Retrieve"]));
    expect(after.entries[note]).toEqual(s.entries[note]);
    const retired = fold(proposed(noteOnCore, ["s9"]), observed("s1/t1", ["Start", "First_Hop_Retrieve"], 0.25), event({ kind: "status", entry: note, to: "retired", reason: "test" }));
    expect(foldOverlay(retired, rescored("s1/t1", 1, 0.25, 1, 2, [], ["Start", "First_Hop_Retrieve"])).entries[note]).toEqual(retired.entries[note]);
    const elsewhere = fold(proposed(noteOnCore, ["s9"]), observed("s1/t1", ["Scan_Index", "End"], 0.25));
    expect(foldOverlay(elsewhere, rescored("s1/t1", 1, 0.25, 1, 2, [], ["Scan_Index", "End"])).entries[note]).toEqual(elsewhere.entries[note]);
    // An entry proposed at the version the turn folded at (by that proposal) did not count the turn.
    const same = fold(proposed(noteOnCore, ["s9"]), observed("s1/t1", ["Start", "First_Hop_Retrieve"], 0.25));
    expect(foldOverlay(same, rescored("s1/t1", 1, 0.25, 1, 1, [], ["Start", "First_Hop_Retrieve"])).entries[note]).toEqual(same.entries[note]);
    // In the unexposed arm when the event does not name the entry.
    const unexposed = fold(proposed(noteOnCore, ["s9"]), observed("s1/t1", ["Start", "First_Hop_Retrieve"], 0.25));
    expect(foldOverlay(unexposed, rescored("s1/t1", 1, 0.25, 1, 2, [], ["Start", "First_Hop_Retrieve"])).entries[note]!.evidence.unexposed).toEqual({ n: 1, scored: 1, scoreSum: 1 });
  });

  it("PLV1.9 the keys kept stay bounded when a rescore is folded", () => {
    const full: OverlayState = { ...fold(observed("s1/t1", path, 0.25)), turns: Array.from({ length: MAX_TURNS }, (_, i) => `s${i}/t`) };
    const after = foldOverlay(full, rescored("s1/t1", 1, 0.25, 1, 1));
    expect(after.turns).toHaveLength(MAX_TURNS);
    expect([after.turns[0], after.turns.at(-1)]).toEqual(["s1/t", "/1/s1/t1"]);
  });

  it("PLV1.8 a rescore never creates statistics for a pair the state has not seen", () => {
    const s = fold(observed("s1/t1", ["Start"], 0.25));
    const after = foldOverlay(s, rescored("s1/t1", 1, 0.25, 1, 1, [], ["Start", "End"]));
    expect(after.stats).toEqual({});
    expect(after.transitions).toEqual({});
    expect(after.version).toBe(2);
  });
});
