import { IDBFactory } from "fake-indexeddb";
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { probability } from "@harness/cognitive";
import { DecisionIdSchema, forkId, MemoryDecisionLog } from "@harness/decision";
import type { DecisionId, DecisionRecord, Outcome } from "@harness/decision";
import { IndexedDbDecisionLog } from "@harness/platform-browser";

const record = (id: DecisionId, at: number): DecisionRecord => ({
  id,
  fork: forkId("prop.fork"),
  forkVersion: "1",
  at,
  input: { n: at },
  rung: "model",
  policy: "p",
  answers: {},
  action: at,
  confidence: probability(0.5),
  propensity: probability(1),
  explored: false,
  mode: "active",
  trace: [],
});
const outcomeAt = (at: number): Outcome => ({ at, source: "system", kind: "completed" });

type Op = { readonly op: "append" } | { readonly op: "outcome"; readonly pick: number } | { readonly op: "reopen" };
const ops = fc.array(
  fc.oneof(
    fc.constant<Op>({ op: "append" }),
    fc.constant<Op>({ op: "append" }),
    fc.nat(12).map((pick): Op => ({ op: "outcome", pick })),
    fc.constant<Op>({ op: "reopen" }),
  ),
  { maxLength: 40 },
);

describe("IndexedDbDecisionLog properties", () => {
  test.prop([ops, fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined })], { numRuns: 60 })(
    "DBR4.1 the IndexedDB log agrees with the memory log after every call and every reopen, whatever the cap",
    async (steps, maxRecords) => {
      const factory = new IDBFactory();
      const options = { factory, ...(maxRecords === undefined ? {} : { maxRecords }) };
      const model = new MemoryDecisionLog(maxRecords === undefined ? {} : { maxRecords });
      let log = new IndexedDbDecisionLog(options);
      let clock = 0;
      for (const step of steps) {
        clock++;
        if (step.op === "append") {
          const id = await log.next();
          expect(await model.next()).toBe(id);
          await log.append(record(id, clock));
          await model.append(record(id, clock));
        } else if (step.op === "outcome") {
          const known = (await model.query()).map((r) => r.id);
          const shown = step.pick % 5 === 4 || known.length === 0 ? DecisionIdSchema.parse("dec-999") : known[step.pick % known.length]!;
          expect(await log.outcome(shown, outcomeAt(clock))).toBe(await model.outcome(shown, outcomeAt(clock)));
        } else {
          await log.close();
          log = new IndexedDbDecisionLog(options);
        }
        expect(await log.query()).toEqual(await model.query());
      }
      expect(await log.size()).toBe(await model.size());
      await log.close();
    },
  );
});
