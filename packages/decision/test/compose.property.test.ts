import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { probability } from "@harness/cognitive";
import { ATTENTION_KINDS } from "../src/attention.ts";
import type { AttentionItem } from "../src/attention.ts";
import { AttentionInbox, standardLabelOf, withRules } from "../src/compose.ts";
import { RUNGS } from "../src/types.ts";
import type { DecisionRecord } from "../src/types.ts";
import { lazy, record, yes } from "./loops-fixtures.ts";
import { humanOutcome, put, rig, shippedSettings } from "./compose-fixtures.ts";
import { gate } from "./fork-fixtures.ts";
import { forkId } from "../src/types.ts";

const settings = lazy(() => shippedSettings());

const itemArb = fc
  .record({
    id: fc.constantFrom("a", "b", "c", "d", "e", "f"),
    session: fc.constantFrom("s1", "s2"),
    kind: fc.constantFrom(...ATTENTION_KINDS),
    since: fc.integer({ min: 0, max: 10_000_000 }),
    blocked: fc.boolean(),
  })
  .map((r): AttentionItem => r);
const items = fc.array(itemArb, { maxLength: 14 });

describe("inbox properties", () => {
  test.prop([items, fc.integer({ min: 0, max: 20_000_000 })])("DCO15.1 the ranking is a permutation of the items held, best first", (given, now) => {
    const box = new AttentionInbox(settings.attention);
    for (const item of given) box.add(item);
    const ranked = box.rank(now);
    expect(ranked.map((r) => r.item.id).sort()).toEqual(box.list().map((i) => i.id).sort());
    expect(ranked).toHaveLength(box.size);
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1]!.priority).toBeGreaterThanOrEqual(ranked[i]!.priority);
  });

  test.prop([items])("DCO15.2 adding the same items again changes nothing", (given) => {
    const box = new AttentionInbox(settings.attention);
    for (const item of given) box.add(item);
    const once = JSON.stringify(box.list());
    for (const item of given) box.add(item);
    expect(JSON.stringify(box.list())).toBe(once);
  });

  test.prop([items, fc.constantFrom("s1", "s2")])("DCO15.3 clearing a session leaves exactly the other sessions' items", (given, session) => {
    const box = new AttentionInbox(settings.attention);
    for (const item of given) box.add(item);
    const others = box.list().filter((i) => i.session !== session).map((i) => i.id);
    box.clearSession(session);
    expect(box.list().map((i) => i.id)).toEqual(others);
  });
});

const recordArb = fc.record({
  fork: fc.constantFrom("test.gate", "other.fork"),
  rung: fc.constantFrom(...RUNGS),
  mode: fc.constantFrom("active", "shadow" as const),
  explored: fc.boolean(),
  confidence: fc.integer({ min: 0, max: 100 }).map((n) => n / 100),
  outcome: fc.option(fc.constantFrom(undefined, true, false), { nil: undefined }),
  hasOutcome: fc.boolean(),
});

describe("report properties", () => {
  test.prop([fc.array(recordArb, { maxLength: 25 })])("DCO15.4 the counts of a report add up", async (rows) => {
    const r = rig();
    for (const row of rows) {
      await put(r.log, {
        fork: forkId(row.fork),
        rung: row.rung,
        mode: row.mode,
        explored: row.explored,
        confidence: probability(row.confidence),
        ...(row.hasOutcome ? { outcome: row.outcome === undefined ? humanOutcome("approved") : humanOutcome(row.outcome ? "correct" : "incorrect", { correct: row.outcome }) } : {}),
      });
    }
    const reports = await r.layer.report();
    expect(reports.reduce((n, report) => n + report.decisions, 0)).toBe(rows.length);
    for (const report of reports) {
      expect(Object.values(report.byRung).reduce((a, b) => a + b, 0)).toBe(report.decisions);
      expect(Object.values(report.byMode).reduce((a, b) => a + b, 0)).toBe(report.decisions);
      expect(report.explored).toBeLessThanOrEqual(report.decisions);
      expect(report.judged).toBeLessThanOrEqual(report.withOutcome);
      expect(report.withOutcome).toBeLessThanOrEqual(report.decisions);
      expect(report.calibrated).toBeLessThanOrEqual(report.judged);
      expect(report.reliability.reduce((a, bin) => a + bin.n, 0)).toBe(report.calibrated);
      if (report.accuracy !== null) expect(report.accuracy >= 0 && report.accuracy <= 1).toBe(true);
      if (report.ece !== null) expect(report.ece >= 0 && report.ece <= 1).toBe(true);
      expect(report.riskCoverage.length > 0).toBe(report.calibrated > 0);
      for (let i = 1; i < report.riskCoverage.length; i++) expect(report.riskCoverage[i]!.coverage).toBeGreaterThan(report.riskCoverage[i - 1]!.coverage);
    }
  });

  test.prop([fc.array(recordArb, { maxLength: 15 }), fc.constantFrom("test.gate", "other.fork")])("DCO15.5 a report for one fork is that fork's part of the report for all", async (rows, which) => {
    const r = rig();
    for (const row of rows) await put(r.log, { fork: forkId(row.fork), rung: row.rung, confidence: probability(row.confidence) });
    const all = (await r.layer.report()).find((report) => report.fork === which);
    const one = await r.layer.report(forkId(which));
    expect(one).toEqual(all === undefined ? [] : [all]);
  });
});

describe("label properties", () => {
  const outcomeArb = fc.constantFrom(undefined, true, false);

  test.prop([fc.integer({ min: 1, max: 99 }).map((n) => n / 100), outcomeArb])("DCO15.6 a standard label is one of the answer's options", (p, correct) => {
    const r: DecisionRecord = record({ answers: { q: yes(p) }, ...(correct === undefined ? {} : { outcome: humanOutcome(correct ? "correct" : "incorrect", { correct }) }) });
    const label = standardLabelOf(r, "q");
    if (label !== undefined) expect(Object.keys(r.answers["q"]!.distribution)).toContain(label);
    expect(label === undefined).toBe(correct === undefined);
  });

  test.prop([fc.boolean(), fc.constantFrom("allow", "deny", "maybe", undefined)])("DCO15.7 an induced rule answers only when the fork's own rule does not, and only with an action the fork lists", (ownDeny, induced) => {
    const fork = withRules(gate({ rule: () => (ownDeny ? "deny" : undefined), actions: () => ["allow", "deny"] }), () => induced);
    const result = fork.rule!({ text: "x" });
    if (ownDeny) expect(result).toBe("deny");
    else expect(result).toBe(induced === "allow" || induced === "deny" ? induced : undefined);
  });
});
