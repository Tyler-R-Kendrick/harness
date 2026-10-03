import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { probability } from "@harness/cognitive";
import { decodeRecords, encodeRecords, MemoryDecisionLog } from "../src/records.ts";
import { DecisionRecordSchema, forkId, RUNGS } from "../src/types.ts";
import type { DecisionId, DecisionRecord, Json } from "../src/types.ts";

const leaf = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
const json: fc.Arbitrary<Json> = fc.letrec<{ tree: Json }>((tie) => ({
  tree: fc.oneof({ maxDepth: 3 }, leaf, fc.array(tie("tree"), { maxLength: 3 }), fc.dictionary(fc.stringMatching(/^[a-z]{1,4}$/), tie("tree"), { maxKeys: 3 })),
})).tree;
const prob = fc.double({ min: 0, max: 1, noNaN: true }).map((x) => probability(x));

/** A valid record for the id. */
const recordFor = (id: DecisionId): fc.Arbitrary<DecisionRecord> =>
  fc.record({
    id: fc.constant(id),
    fork: fc.constantFrom(forkId("a.fork"), forkId("b-fork")),
    forkVersion: fc.string(),
    at: fc.nat(1_000_000),
    input: json,
    rung: fc.constantFrom(...RUNGS),
    policy: fc.string(),
    answers: fc.constant({}),
    action: json,
    confidence: prob,
    propensity: prob,
    explored: fc.boolean(),
    mode: fc.constantFrom("active" as const, "shadow" as const),
    trace: fc.array(fc.record({ rung: fc.constantFrom(...RUNGS), outcome: fc.string() }), { maxLength: 3 }),
  });

const records = fc.integer({ min: 0, max: 8 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => recordFor(`dec-${i}`))));

const operation = fc.oneof(
  fc.record({ kind: fc.constant("append" as const), body: recordFor("dec-0") }),
  fc.record({ kind: fc.constant("outcome" as const), target: fc.nat(30) }),
  fc.record({ kind: fc.constant("skip" as const) }),
);

describe("decision log properties", () => {
  test.prop([records])("DLG10.1 records decode from what they encode to, in order, with no errors", (rs) => {
    const decoded = decodeRecords(encodeRecords(rs));
    expect(decoded.errors).toEqual([]);
    expect(decoded.records).toEqual(rs);
    for (const r of decoded.records) expect(DecisionRecordSchema.safeParse(r).success).toBe(true);
  });

  test.prop([records, fc.nat(100000)])("DLG10.2 a file cut anywhere decodes to a prefix of its records and at most one error", (rs, cutAt) => {
    const text = encodeRecords(rs);
    const cut = text.slice(0, cutAt % (text.length + 1));
    const decoded = decodeRecords(cut);
    expect(decoded.errors.length).toBeLessThanOrEqual(1);
    expect(decoded.records).toEqual(rs.slice(0, decoded.records.length));
    const whole = cut.split("\n").length - 1;
    expect(decoded.records.length).toBeGreaterThanOrEqual(whole);
  });

  test.prop([fc.string()])("DLG10.3 decoding text that is not records never throws, and every line is either a record or an error", (text) => {
    const decoded = decodeRecords(text);
    const lines = text.split("\n").filter((l) => l.replace(/\r$/, "").trim() !== "").length;
    expect(decoded.records.length + decoded.errors.length).toBe(lines);
  });

  test.prop([fc.array(operation, { maxLength: 40 }), fc.integer({ min: 1, max: 6 })])("DLG10.4 with a cap the log never exceeds it, keeps the newest record, and drops a labelled record only when every other one is labelled", async (ops, cap) => {
    const log = new MemoryDecisionLog({ maxRecords: cap });
    for (const op of ops) {
      if (op.kind === "skip") await log.next();
      else if (op.kind === "outcome") await log.outcome(`dec-${op.target}`, { at: 1, source: "system", kind: "completed" });
      else {
        const before = await log.query();
        const id = await log.next();
        await log.append({ ...op.body, id });
        const after = await log.query();
        expect(after.length).toBeLessThanOrEqual(cap);
        expect(after.map((r) => r.id)).toContain(id);
        const kept = new Set(after.map((r) => r.id));
        const dropped = before.filter((r) => !kept.has(r.id));
        if (dropped.some((r) => r.outcome !== undefined)) expect(after.filter((r) => r.id !== id).every((r) => r.outcome !== undefined)).toBe(true);
      }
    }
  });

  test.prop([fc.array(operation, { maxLength: 30 })])("DLG10.5 ids issued are strictly increasing, and a snapshot restores to an equal log", async (ops) => {
    const log = new MemoryDecisionLog();
    let last = -1;
    for (const op of ops) {
      const id = await log.next();
      const n = Number(id.slice(4));
      expect(n).toBeGreaterThan(last);
      last = n;
      if (op.kind === "append") await log.append({ ...op.body, id });
      if (op.kind === "outcome") await log.outcome(`dec-${op.target % (n + 1)}`, { at: 1, source: "system", kind: "completed" });
    }
    const copy = new MemoryDecisionLog();
    copy.restore(log.snapshot());
    expect(await copy.query()).toEqual(await log.query());
    expect(await copy.next()).toBe(await log.next());
  });

  test.prop([fc.shuffledSubarray([0, 1, 2, 3, 4, 5], { minLength: 6, maxLength: 6 }), recordFor("dec-0")])("DLG10.6 whatever order records are appended in, queries return them in id order", async (order, body) => {
    const log = new MemoryDecisionLog();
    for (let i = 0; i < 6; i++) await log.next();
    for (const n of order) await log.append({ ...body, id: `dec-${n}` });
    expect((await log.query()).map((r) => r.id)).toEqual(["dec-0", "dec-1", "dec-2", "dec-3", "dec-4", "dec-5"]);
  });
});
