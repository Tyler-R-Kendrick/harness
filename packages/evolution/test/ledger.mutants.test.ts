import { describe, expect, it } from "vitest";
import { paperStall, parseRecord, render, stalled, verdictOf } from "@harness/evolution";
import type { LedgerRecord } from "@harness/evolution";

const rec = (round: number, outcome: LedgerRecord["outcome"], measured?: Partial<NonNullable<LedgerRecord["measured"]>>): LedgerRecord =>
  parseRecord({
    round,
    candidate: "A",
    kind: "change",
    edits: [{ id: "e0", hypothesis: "h", targets: "t", components: ["prompt"], footprint: 1, predicted: [] }],
    outcome,
    reason: outcome,
    ...(measured === undefined ? {} : { measured: { score: 0.5, gain: 0.03, lower: 0.02, upper: 0.04, alpha: 0.05, verdict: verdictOf({ lower: 0.02, upper: 0.04 }), hits: [], misses: [], ...measured } }),
  });

describe("mutation hardening of the ledger", () => {
  it("RS21.1 an accepted change that was never measured is not a supported one: the run is stalled, not an error", () => {
    expect(stalled([rec(1, "accepted")], 3, 3)).toBe(true);
  });

  it("RS21.2 an acceptance in the round being asked about is not in the window before it", () => {
    const accepted = [rec(4, "accepted", {})];
    expect(stalled(accepted, 4, 3)).toBe(true);
    expect(stalled(accepted, 5, 3)).toBe(false);
  });

  it("RS21.3 an acceptance in a later round than the one asked about is not in the window either", () => {
    expect(stalled([rec(6, "accepted", {})], 4, 3)).toBe(true);
  });

  it("RS21.4 the paper's stall flag is true when the rise over the window equals delta exactly", () => {
    expect(paperStall([0.5, 0.75], 1, 1, 0.25)).toBe(true);
    expect(paperStall([0.5, 0.75], 1, 1, 0.24)).toBe(false);
  });

  it("RS21.5 a row has a cost change only when the measurement has one", () => {
    const row = render([rec(0, "accepted", {})], 1)[0]!;
    expect(Object.keys(row).sort()).toEqual(["candidate", "edits", "gain", "interval", "kind", "outcome", "reason", "round", "verdict"]);
    expect(render([rec(0, "accepted", { costChange: 0 })], 1)[0]).toHaveProperty("costChange", 0);
  });

  it("RS21.6 a row tells the predictions when only the hits, or only the misses, are present", () => {
    expect(render([rec(0, "accepted", { hits: ["t1"] })], 1)[0]!.predicted).toEqual({ hit: ["t1"], missed: [] });
    expect(render([rec(0, "accepted", { misses: ["t2"] })], 1)[0]!.predicted).toEqual({ hit: [], missed: ["t2"] });
    expect(render([rec(0, "accepted", {})], 1)[0]).not.toHaveProperty("predicted");
  });

  it("RS21.49 a record may say its candidate was admissible but not chosen", () => {
    for (const outcome of ["accepted", "admissible", "rejected", "screened"] as const) expect(rec(0, outcome).outcome).toBe(outcome);
  });
});
