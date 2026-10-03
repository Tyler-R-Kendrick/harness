import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { probability } from "@harness/cognitive";
import { DecisionIdSchema, forkId, MemoryDecisionLog } from "@harness/decision";
import type { DecisionId, DecisionLog, DecisionRecord, Outcome } from "@harness/decision";
import { FileDecisionLog } from "@harness/platform-native";

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

describe("FileDecisionLog properties", () => {
  test.prop([ops, fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }), fc.constantFrom(1, 2, 4)], { numRuns: 60 })(
    "DHK8.1 the file log agrees with the memory log after every call and after every restart, whatever the cap and the compaction ratio",
    async (steps, maxRecords, compactRatio) => {
      const dir = await mkdtemp(join(tmpdir(), "harness-decision-prop-"));
      try {
        const file = join(dir, "decisions.jsonl");
        const options = { ...(maxRecords === undefined ? {} : { maxRecords }), compactRatio };
        const model = new MemoryDecisionLog(maxRecords === undefined ? {} : { maxRecords });
        let log: DecisionLog = await FileDecisionLog.open(file, options);
        let clock = 0;
        for (const step of steps) {
          clock++;
          if (step.op === "append") {
            const id = await log.next();
            expect(await model.next()).toBe(id);
            await log.append(record(id, clock));
            await model.append(record(id, clock));
          } else if (step.op === "outcome") {
            const ids = (await model.query()).map((r) => r.id);
            const shown = step.pick % 5 === 4 || ids.length === 0 ? DecisionIdSchema.parse("dec-999") : ids[step.pick % ids.length]!;
            expect(await log.outcome(shown, outcomeAt(clock))).toBe(await model.outcome(shown, outcomeAt(clock)));
          } else {
            log = await FileDecisionLog.open(file, options);
          }
          expect(await log.query()).toEqual(await model.query());
        }
        const final = await FileDecisionLog.open(file, options);
        expect(await final.query()).toEqual(await model.query());
        expect(await final.size()).toBe(await model.size());
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.prop([fc.integer({ min: 1, max: 30 }), fc.integer({ min: 0, max: 8 })], { numRuns: 30 })(
    "DHK8.2 ids are issued in increasing order across restarts and never repeat an appended id",
    async (count, restartEvery) => {
      const dir = await mkdtemp(join(tmpdir(), "harness-decision-prop-"));
      try {
        const file = join(dir, "decisions.jsonl");
        let log = await FileDecisionLog.open(file);
        const seen: number[] = [];
        for (let i = 0; i < count; i++) {
          const id = await log.next();
          seen.push(Number(id.slice(4)));
          await log.append(record(id, i));
          if (restartEvery > 0 && i % restartEvery === 0) log = await FileDecisionLog.open(file);
        }
        expect(seen).toEqual([...seen].sort((a, b) => a - b));
        expect(new Set(seen).size).toBe(seen.length);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
