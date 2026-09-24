import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { EffectLedger } from "@harness/core";

// A simulated external target and a driver that follows the ledger protocol while the
// world misbehaves: calls may apply or not, replies may be lost, the owner may crash.
type Step =
  | { t: "call"; effect: number; applies: boolean; replyLost: boolean }
  | { t: "crash" }
  | { t: "reconcile"; effect: number }
  | { t: "lateReply"; effect: number };

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant("call" as const), effect: fc.nat(3), applies: fc.boolean(), replyLost: fc.boolean() }) },
  { weight: 1, arbitrary: fc.constant({ t: "crash" as const }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("reconcile" as const), effect: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("lateReply" as const), effect: fc.nat(3) }) },
);

describe("EffectLedger under faults", () => {
  test.prop([fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), fc.array(step, { maxLength: 150 })])(
    "EF5.1 non-idempotent effects apply at most once; settled status always matches the target",
    (idempotentFlags, steps) => {
      const ledger = new EffectLedger();
      const applied = [0, 0, 0, 0];
      const lostReplies = new Map<number, { attemptId: string; applied: boolean }>();
      let epoch = 1;
      let attemptSeq = 0;
      idempotentFlags.forEach((idempotent, i) => ledger.intend({ effectId: `e${i}`, target: "t", intentKey: `k${i}`, idempotent, epoch }));

      for (const s of steps) {
        if (s.t === "crash") {
          epoch++;
          ledger.recover(epoch);
          continue;
        }
        const id = `e${s.effect}`;
        if (s.t === "reconcile") {
          if (ledger.get(id)?.status === "outcome_unknown") {
            // An idempotent target dedupes by effect id, so "applied" means applied at least once.
            ledger.reconcile(id, applied[s.effect]! > 0 ? "applied" : "not_applied", epoch);
          }
          continue;
        }
        if (s.t === "lateReply") {
          const lost = lostReplies.get(s.effect);
          if (lost && lost.applied) ledger.receipt(id, lost.attemptId, "succeeded", epoch);
          continue;
        }
        const attemptId = `a${attemptSeq++}`;
        if (!ledger.dispatch(id, attemptId, epoch).ok) continue;
        const idempotent = idempotentFlags[s.effect]!;
        const wouldApply = s.applies && !(idempotent && applied[s.effect]! > 0);
        if (s.applies) applied[s.effect]! += wouldApply ? 1 : 0;
        const outcomeApplied = s.applies || (idempotent && applied[s.effect]! > 0);
        if (s.replyLost) {
          lostReplies.set(s.effect, { attemptId, applied: outcomeApplied });
          epoch++;
          ledger.recover(epoch); // a lost reply is only discovered by the next owner
        } else {
          ledger.receipt(id, attemptId, outcomeApplied ? "succeeded" : "failed", epoch);
        }
      }

      idempotentFlags.forEach((idempotent, i) => {
        const record = ledger.get(`e${i}`)!;
        expect(applied[i]!).toBeLessThanOrEqual(1);
        if (record.status === "succeeded") expect(applied[i]!).toBe(1);
        if (!idempotent && record.status === "intended") expect(applied[i]!).toBe(0);
      });
    },
  );
});
