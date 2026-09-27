import { describe, expect, it } from "vitest";
import { SessionLog } from "@harness/core";

function filled(n: number): SessionLog<string> {
  const log = new SessionLog<string>();
  for (let i = 0; i < n; i++) log.append("update", `p${i}`, 100 + i);
  return log;
}

describe("SessionLog", () => {
  it("SL1.1 offsets start at 0 and increase by one", () => {
    const log = new SessionLog<string>();
    expect(log.append("a", "x", 1).offset).toBe(0);
    expect(log.append("b", "y", 2).offset).toBe(1);
    expect(log.head()).toBe(2);
    expect(log.base()).toBe(0);
  });

  it("SL1.2 read(from) returns the contiguous tail from that offset", () => {
    const r = filled(5).read(2);
    expect(r).toMatchObject({ kind: "entries", next: 5 });
    if (r.kind !== "entries") throw new Error("unreachable");
    expect(r.entries.map((e) => e.offset)).toEqual([2, 3, 4]);
    expect(r.entries.map((e) => e.payload)).toEqual(["p2", "p3", "p4"]);
  });

  it("SL1.3 a limited read returns the offset to resume from", () => {
    const r = filled(5).read(1, 2);
    if (r.kind !== "entries") throw new Error("expected entries");
    expect(r.entries.map((e) => e.offset)).toEqual([1, 2]);
    expect(r.next).toBe(3);
  });

  it("SL1.4 reading at head is empty and points at head", () => {
    expect(filled(3).read(3)).toEqual({ kind: "entries", entries: [], next: 3 });
  });

  it("SL1.5 reading past head or at a negative/fractional offset is out of range", () => {
    const log = filled(3);
    expect(log.read(4)).toEqual({ kind: "out-of-range", head: 3 });
    expect(log.read(-1)).toEqual({ kind: "out-of-range", head: 3 });
    expect(log.read(1.5)).toEqual({ kind: "out-of-range", head: 3 });
  });

  it("SL1.6 timestamps never go backwards even if the clock does", () => {
    const log = new SessionLog<string>();
    log.append("a", "x", 50);
    expect(log.append("b", "y", 40).at).toBe(50);
    expect(log.append("c", "z", 60).at).toBe(60);
  });

  it("SL1.7 entries record their kind", () => {
    const log = new SessionLog<string>();
    log.append("prompt", "x", 1);
    const r = log.read(0);
    if (r.kind !== "entries") throw new Error("expected entries");
    expect(r.entries[0]?.kind).toBe("prompt");
  });

  it("SL1.8 a limit of zero or less returns nothing and does not advance", () => {
    expect(filled(3).read(1, 0)).toEqual({ kind: "entries", entries: [], next: 1 });
  });

  it("SL2.1 compact drops entries below the cut and moves base", () => {
    const log = filled(5);
    log.compact(3, { state: "at-3" });
    expect(log.base()).toBe(3);
    expect(log.head()).toBe(5);
    const r = log.read(3);
    if (r.kind !== "entries") throw new Error("expected entries");
    expect(r.entries.map((e) => e.offset)).toEqual([3, 4]);
  });

  it("SL2.2 reading below base requires the snapshot", () => {
    const log = filled(5);
    log.compact(3, { state: "at-3" });
    expect(log.read(1)).toEqual({ kind: "snapshot-required", snapshot: { state: "at-3" }, snapshotOffset: 3 });
  });

  it("SL2.3 compact cannot pass head or move base backwards", () => {
    const log = filled(5);
    expect(() => log.compact(6, {})).toThrow(/beyond head/);
    log.compact(3, {});
    expect(() => log.compact(2, {})).toThrow(/behind base/);
  });

  it("SL2.4 appends after compaction keep counting offsets", () => {
    const log = filled(5);
    log.compact(5, {});
    expect(log.append("x", "later", 999).offset).toBe(5);
  });

  it("SL2.5 compacting to the current base with a newer snapshot replaces the snapshot", () => {
    const log = filled(4);
    log.compact(2, "old");
    log.compact(2, "new");
    expect(log.read(0)).toEqual({ kind: "snapshot-required", snapshot: "new", snapshotOffset: 2 });
  });

  it("SL3.1 a snapshot round-trips through plain data", () => {
    const log = filled(4);
    log.compact(1, "s1");
    const copy = SessionLog.fromJSON<string>(JSON.parse(JSON.stringify(log.toJSON())));
    expect(copy.head()).toBe(4);
    expect(copy.base()).toBe(1);
    expect(copy.read(0)).toEqual(log.read(0));
    expect(copy.read(1)).toEqual(log.read(1));
    expect(copy.append("z", "p4", 1).at).toBe(103);
  });

  it("SL3.2 fromJSON rejects non-contiguous or misaligned entries", () => {
    const data = filled(3).toJSON();
    const gap = { ...data, entries: [data.entries[0], data.entries[2]] };
    expect(() => SessionLog.fromJSON(gap)).toThrow(/contiguous/);
    const shifted = { ...data, base: 1 };
    expect(() => SessionLog.fromJSON(shifted)).toThrow(/contiguous/);
  });

  it("SL3.3 fromJSON rejects structurally invalid input", () => {
    expect(() => SessionLog.fromJSON(null)).toThrow(/invalid/);
    expect(() => SessionLog.fromJSON({ base: -1, entries: [] })).toThrow(/invalid/);
    expect(() => SessionLog.fromJSON({ base: 0, entries: "no" })).toThrow(/invalid/);
    expect(() => SessionLog.fromJSON({ base: 0.5, entries: [] })).toThrow(/invalid/);
  });

  it("SL3.4 an empty compacted log round-trips with its snapshot", () => {
    const log = filled(2);
    log.compact(2, "s");
    const copy = SessionLog.fromJSON<string>(log.toJSON());
    expect(copy.read(0)).toEqual({ kind: "snapshot-required", snapshot: "s", snapshotOffset: 2 });
    expect(copy.read(2)).toEqual({ kind: "entries", entries: [], next: 2 });
  });
});
