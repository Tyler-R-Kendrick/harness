import { describe, expect, it } from "vitest";
import { componentYield, paperStall, parseRecord, render, stalled, tried, verdictOf } from "@harness/evolution";
import type { LedgerRecord } from "@harness/evolution";

const rec = (round: number, components: string[], outcome: LedgerRecord["outcome"], gain?: number, extra: Partial<LedgerRecord> = {}): LedgerRecord =>
  parseRecord({
    round,
    candidate: "A",
    kind: "change",
    edits: components.map((c, i) => ({ id: `e${i}`, hypothesis: `h${round}${c}`, targets: "t", components: [c], footprint: 1, predicted: [] })),
    outcome,
    reason: outcome,
    ...(gain === undefined ? {} : { measured: { score: 0.5, gain, lower: gain - 0.01, upper: gain + 0.01, alpha: 0.05, verdict: verdictOf({ lower: gain - 0.01, upper: gain + 0.01 }), hits: [], misses: [] } }),
    ...extra,
  });

describe("the ledger of measured edits", () => {
  it("RS7.1 a verdict is three-valued: a gain whose interval holds zero is inconclusive, which is not evidence against it", () => {
    expect(verdictOf({ lower: 0.001, upper: 0.03 })).toBe("supported");
    expect(verdictOf({ lower: -0.03, upper: -0.001 })).toBe("refuted");
    expect(verdictOf({ lower: -0.01, upper: 0.02 })).toBe("inconclusive");
    expect(verdictOf({ lower: 0, upper: 0.02 })).toBe("inconclusive");
    expect(verdictOf({ lower: -0.02, upper: 0 })).toBe("inconclusive");
  });

  it("RS7.2 tried components are those with a measured edit; screened candidates are not evidence", () => {
    const records = [rec(0, ["prompt"], "accepted", 0.03), rec(1, ["skill", "memory"], "rejected", -0.02), rec(2, ["config"], "screened"), rec(2, ["subagent"], "screened", undefined, { kind: "prune" })];
    expect([...tried(records)].sort()).toEqual(["memory", "prompt", "skill"]);
    expect([...tried([rec(0, ["config"], "accepted", 0.03, { kind: "prune" })])]).toEqual([]);
  });

  it("RS7.3 a run is stalled when no supported change was accepted in the last w rounds", () => {
    const records = [rec(0, ["prompt"], "accepted", 0.03), rec(1, ["prompt"], "accepted", 0.005), rec(2, ["prompt"], "rejected", 0.04)];
    expect(stalled(records, 2, 3)).toBe(false); // not enough rounds yet
    expect(stalled(records, 3, 3)).toBe(false); // round 0's supported acceptance is in the window
    expect(stalled(records, 4, 3)).toBe(true); // round 1's acceptance was inconclusive; round 2's gain was not accepted
    expect(stalled([...records, rec(3, ["prompt"], "accepted", 0.03, { kind: "prune" })], 4, 3)).toBe(true);
  });

  it("RS7.4 the paper's stall flag compares the trajectory w rounds apart with delta", () => {
    const traj = [0.5, 0.53, 0.53, 0.535, 0.6];
    expect(paperStall(traj, 3, 3, 0.02)).toBe(false);
    expect(paperStall(traj, 3, 2, 0.02)).toBe(true);
    expect(paperStall(traj, 4, 2, 0.02)).toBe(false);
    expect(paperStall(traj, 1, 3, 0.02)).toBe(false);
    expect(paperStall(traj, 5, 2, 0.02)).toBe(false);
    expect(paperStall(traj, 2, 2, 0.04)).toBe(true);
  });

  it("RS7.5 the paper's recent yield g_t(l) is the best measured gain of a component in the window, -inf with nothing recent", () => {
    const records = [rec(0, ["prompt"], "accepted", 0.03), rec(1, ["prompt"], "rejected", -0.01), rec(1, ["skill", "memory"], "rejected", -0.02)];
    expect(componentYield(records, 3, 4)).toEqual({ prompt: 0.03, skill: -0.02, memory: -0.02 });
    expect(componentYield(records, 5, 4)).toEqual({ prompt: -0.01, skill: -0.02, memory: -0.02 });
    expect(componentYield(records, 6, 4)).toEqual({ prompt: Number.NEGATIVE_INFINITY, skill: Number.NEGATIVE_INFINITY, memory: Number.NEGATIVE_INFINITY });
  });

  it("RS7.6 the proposer's view keeps measured records and only the last few screened ones, with verdicts spelled out", () => {
    const screened = Array.from({ length: 6 }, (_, i) => rec(1, ["config"], "screened", undefined, { candidate: `S${i}`, reason: `leak ${i}` }));
    const rows = render([rec(0, ["prompt"], "accepted", 0.03, { reason: "admissible: supported" }), ...screened], 10);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ round: 0, candidate: "A", kind: "change", outcome: "accepted", reason: "admissible: supported", edits: [{ hypothesis: "h0prompt", components: ["prompt"] }], verdict: "supported", gain: 0.03, interval: [expect.closeTo(0.02, 12), expect.closeTo(0.04, 12)] });
    expect(rows.slice(1).map((r) => r.candidate)).toEqual(["S2", "S3", "S4", "S5"]);
    expect(render([rec(0, ["prompt"], "accepted", 0.03), rec(1, ["prompt"], "rejected", 0.01)], 1).map((r) => r.round)).toEqual([1]);
    expect(render([rec(0, ["prompt"], "accepted", 0.03, { measured: { score: 0.5, gain: 0.03, lower: 0.02, upper: 0.04, alpha: 0.05, verdict: "supported", costChange: 0.1, hits: ["t1"], misses: ["t2"] } })], 1)[0]).toMatchObject({ costChange: 0.1, predicted: { hit: ["t1"], missed: ["t2"] } });
  });

  it("RS7.7 records are parsed", () => {
    expect(() => parseRecord({ round: -1 })).toThrow(/invalid ledger record/);
  });
});
