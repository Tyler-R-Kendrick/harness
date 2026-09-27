import { describe, expect, it } from "vitest";
import { EffectLedger } from "@harness/core";

const intent = (over: Partial<Parameters<EffectLedger["intend"]>[0]> = {}) => ({
  effectId: "e1",
  target: "github:issue",
  intentKey: "create:#1",
  idempotent: false,
  epoch: 1,
  ...over,
});

describe("EffectLedger", () => {
  it("EF1.1 an effect starts as intended under the current epoch", () => {
    const l = new EffectLedger();
    expect(l.intend(intent())).toMatchObject({ ok: true, value: { effectId: "e1", status: "intended", attempts: [] } });
    expect(l.epoch()).toBe(1);
  });

  it("EF1.2 re-recording the same intent is idempotent", () => {
    const l = new EffectLedger();
    l.intend(intent());
    expect(l.intend(intent())).toMatchObject({ ok: true, value: { status: "intended" } });
    expect(l.list()).toHaveLength(1);
  });

  it("EF1.3 changed intent under the same effect id is rejected; it needs a new effect", () => {
    const l = new EffectLedger();
    l.intend(intent());
    expect(l.intend(intent({ intentKey: "create:#2" }))).toMatchObject({ ok: false, error: { code: "intent_changed" } });
    expect(l.intend(intent({ target: "linear:issue" }))).toMatchObject({ ok: false, error: { code: "intent_changed" } });
  });

  it("EF1.4 writers holding a stale epoch are fenced out", () => {
    const l = new EffectLedger();
    l.intend(intent());
    l.fence(2);
    expect(l.intend(intent({ effectId: "e2", epoch: 1 }))).toMatchObject({ ok: false, error: { code: "stale_epoch" } });
    expect(l.dispatch("e1", "a1", 1)).toMatchObject({ ok: false, error: { code: "stale_epoch" } });
    expect(l.dispatch("e1", "a1", 2).ok).toBe(true);
    expect(l.receipt("e1", "a1", "succeeded", 1)).toMatchObject({ ok: false, error: { code: "stale_epoch" } });
    expect(l.reconcile("e1", "applied", 1)).toMatchObject({ ok: false, error: { code: "stale_epoch" } });
  });

  it("EF1.5 the epoch only moves forward", () => {
    const l = new EffectLedger();
    l.fence(3);
    expect(() => l.fence(3)).toThrow(/forward/);
    expect(() => l.fence(2)).toThrow(/forward/);
  });

  it("EF2.1 dispatch opens an attempt and a second concurrent dispatch is refused", () => {
    const l = new EffectLedger();
    l.intend(intent());
    expect(l.dispatch("e1", "a1", 1)).toMatchObject({ ok: true, value: { attemptId: "a1", epoch: 1, status: "dispatched" } });
    expect(l.get("e1")?.status).toBe("dispatched");
    expect(l.dispatch("e1", "a2", 1)).toMatchObject({ ok: false, error: { code: "in_flight" } });
  });

  it("EF2.2 no dispatch without a recorded intent", () => {
    const l = new EffectLedger();
    expect(l.dispatch("ghost", "a1", 1)).toMatchObject({ ok: false, error: { code: "unknown_effect" } });
  });

  it("EF2.3 a receipt settles the effect; duplicates are harmless; contradictions are rejected", () => {
    const l = new EffectLedger();
    l.intend(intent());
    l.dispatch("e1", "a1", 1);
    expect(l.receipt("e1", "a1", "succeeded", 1)).toMatchObject({ ok: true, value: { status: "succeeded" } });
    expect(l.receipt("e1", "a1", "succeeded", 1)).toMatchObject({ ok: true, value: { status: "succeeded" } });
    expect(l.receipt("e1", "a1", "failed", 1)).toMatchObject({ ok: false, error: { code: "conflicting_receipt" } });
    expect(l.get("e1")?.attempts).toEqual([{ attemptId: "a1", epoch: 1, status: "succeeded" }]);
  });

  it("EF2.4 settled effects cannot be dispatched again", () => {
    const l = new EffectLedger();
    l.intend(intent());
    l.dispatch("e1", "a1", 1);
    l.receipt("e1", "a1", "failed", 1);
    expect(l.dispatch("e1", "a2", 1)).toMatchObject({ ok: false, error: { code: "already_settled" } });
  });

  it("EF2.5 receipts for unknown effects or attempts are rejected", () => {
    const l = new EffectLedger();
    l.intend(intent());
    expect(l.receipt("ghost", "a1", "succeeded", 1)).toMatchObject({ ok: false, error: { code: "unknown_effect" } });
    expect(l.receipt("e1", "a9", "succeeded", 1)).toMatchObject({ ok: false, error: { code: "unknown_attempt" } });
  });

  it("EF2.6 attempt ids are unique per effect", () => {
    const l = new EffectLedger();
    l.intend(intent({ idempotent: true }));
    l.dispatch("e1", "a1", 1);
    l.recover(2);
    expect(l.dispatch("e1", "a1", 2)).toMatchObject({ ok: false, error: { code: "duplicate_attempt" } });
  });

  it("EF3.1 recovery turns in-flight effects into outcome-unknown, never into absent", () => {
    const l = new EffectLedger();
    l.intend(intent());
    l.intend(intent({ effectId: "e2", intentKey: "create:#2" }));
    l.dispatch("e1", "a1", 1);
    const unknown = l.recover(2);
    expect(unknown.map((e) => e.effectId)).toEqual(["e1"]);
    expect(l.get("e1")).toMatchObject({ status: "outcome_unknown", attempts: [{ attemptId: "a1", status: "unknown" }] });
    expect(l.get("e2")?.status).toBe("intended");
    expect(l.epoch()).toBe(2);
  });

  it("EF3.2 a non-idempotent outcome-unknown effect must be reconciled before retrying", () => {
    const l = new EffectLedger();
    l.intend(intent());
    l.dispatch("e1", "a1", 1);
    l.recover(2);
    expect(l.dispatch("e1", "a2", 2)).toMatchObject({ ok: false, error: { code: "needs_reconciliation" } });
  });

  it("EF3.3 an idempotent outcome-unknown effect may be retried with a new attempt", () => {
    const l = new EffectLedger();
    l.intend(intent({ idempotent: true }));
    l.dispatch("e1", "a1", 1);
    l.recover(2);
    expect(l.dispatch("e1", "a2", 2)).toMatchObject({ ok: true, value: { attemptId: "a2", epoch: 2 } });
  });

  it("EF3.4 reconciliation that finds the effect applied settles it as succeeded", () => {
    const l = new EffectLedger();
    l.intend(intent());
    l.dispatch("e1", "a1", 1);
    l.recover(2);
    expect(l.reconcile("e1", "applied", 2)).toMatchObject({ ok: true, value: { status: "succeeded" } });
    expect(l.dispatch("e1", "a2", 2)).toMatchObject({ ok: false, error: { code: "already_settled" } });
  });

  it("EF3.5 reconciliation that finds nothing applied permits a retry", () => {
    const l = new EffectLedger();
    l.intend(intent());
    l.dispatch("e1", "a1", 1);
    l.recover(2);
    expect(l.reconcile("e1", "not_applied", 2)).toMatchObject({ ok: true, value: { status: "intended" } });
    expect(l.dispatch("e1", "a2", 2).ok).toBe(true);
  });

  it("EF3.6 reconciliation can observe a definitive failure", () => {
    const l = new EffectLedger();
    l.intend(intent());
    l.dispatch("e1", "a1", 1);
    l.recover(2);
    expect(l.reconcile("e1", "failed", 2)).toMatchObject({ ok: true, value: { status: "failed" } });
  });

  it("EF3.7 only outcome-unknown effects can be reconciled", () => {
    const l = new EffectLedger();
    l.intend(intent());
    expect(l.reconcile("e1", "applied", 1)).toMatchObject({ ok: false, error: { code: "not_unknown" } });
    expect(l.reconcile("ghost", "applied", 1)).toMatchObject({ ok: false, error: { code: "unknown_effect" } });
  });

  it("EF3.8 a lost reply that arrives late still settles an outcome-unknown effect", () => {
    const l = new EffectLedger();
    l.intend(intent());
    l.dispatch("e1", "a1", 1);
    l.recover(2);
    expect(l.receipt("e1", "a1", "succeeded", 2)).toMatchObject({ ok: true, value: { status: "succeeded" } });
  });

  it("EF3.9 recover requires a newer epoch", () => {
    const l = new EffectLedger();
    expect(() => l.recover(1)).toThrow(/forward/);
  });

  it("EF4.1 the ledger round-trips through plain data", () => {
    const l = new EffectLedger();
    l.intend(intent());
    l.dispatch("e1", "a1", 1);
    const copy = EffectLedger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())));
    expect(copy.epoch()).toBe(1);
    expect(copy.get("e1")).toEqual(l.get("e1"));
    expect(copy.dispatch("e1", "a2", 1)).toMatchObject({ ok: false, error: { code: "in_flight" } });
  });

  it("EF4.2 fromJSON rejects malformed data", () => {
    expect(() => EffectLedger.fromJSON(null)).toThrow(/invalid/);
    expect(() => EffectLedger.fromJSON({ epoch: 0, effects: [] })).toThrow(/invalid/);
    expect(() => EffectLedger.fromJSON({ epoch: 1, effects: {} })).toThrow(/invalid/);
  });

  it("EF4.3 get returns a copy that cannot mutate the ledger", () => {
    const l = new EffectLedger();
    l.intend(intent());
    const view = l.get("e1") as { status: string };
    view.status = "succeeded";
    expect(l.get("e1")?.status).toBe("intended");
  });
});
