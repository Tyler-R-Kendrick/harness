import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { evaluateCondition } from "../src/condition.ts";
import { correctActionOf, examplesToJsonl, holdoutSplit, induceRules, mineDisagreements, parseExamplesJsonl, stableJson, toExamples } from "../src/distill.ts";
import type { InduceOptions } from "../src/distill.ts";
import type { DecisionRecord, Json } from "../src/types.ts";
import { chose, outcome, record, yes } from "./loops-fixtures.ts";

const TOOLS = ["bash", "read", "edit", "fetch"];
const USERS = ["alice", "bob"];
const COMMANDS = ["git status", "git log -n 3", "git diff", "rm -rf build", "rm -rf dist", "npm test", "ls -l"];

const inputArb: fc.Arbitrary<Json> = fc.record({
  tool: fc.constantFrom(...TOOLS),
  user: fc.constantFrom(...USERS),
  command: fc.constantFrom(...COMMANDS),
  retries: fc.integer({ min: 0, max: 2 }),
  dry: fc.boolean(),
  id: fc.uuid(),
});
const actionArb = fc.constantFrom("allow", "ask", "deny");
const recordsArb = fc.array(fc.tuple(inputArb, actionArb), { maxLength: 60 }).map((pairs) => pairs.map(([input, action], i) => record({ id: i, input, action, outcome: outcome("correct") })));
const optionsArb: fc.Arbitrary<InduceOptions> = fc.record({
  minSupport: fc.integer({ min: 1, max: 6 }),
  minPurity: fc.constantFrom(0.5, 0.7, 0.9, 1),
  maxRules: fc.integer({ min: 0, max: 8 }),
  maxConditions: fc.constantFrom(1 as const, 2 as const),
});

describe("distillation properties", () => {
  test.prop([recordsArb, optionsArb])("DST8.1 a rule's support and purity are really what its condition gives on the records, and meet the options", (records, options) => {
    const rules = induceRules(records, options);
    expect(rules.length).toBeLessThanOrEqual(options.maxRules);
    for (const rule of rules) {
      const covered = records.filter((r) => evaluateCondition(rule.when, r.input));
      const agreeing = covered.filter((r) => stableJson(correctActionOf(r)!) === stableJson(rule.action));
      expect(rule.support).toBe(covered.length);
      expect(rule.purity).toBe(agreeing.length / covered.length);
      expect(rule.support).toBeGreaterThanOrEqual(options.minSupport);
      expect(rule.purity).toBeGreaterThanOrEqual(options.minPurity);
      expect("all" in rule.when ? rule.when.all.length : 1).toBeLessThanOrEqual(options.maxConditions);
    }
  });

  test.prop([recordsArb, optionsArb, fc.infiniteStream(fc.nat())])("DST8.2 the rules do not depend on the order of the records, and their ids are distinct and come from the condition", (records, options, stream) => {
    const shuffled = [...records];
    const picks = stream[Symbol.iterator]();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = picks.next().value % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const a = induceRules(records, options);
    expect(induceRules(shuffled, options)).toEqual(a);
    expect(new Set(a.map((r) => r.id)).size).toBe(a.length);
    for (const r of a) expect(induceRules(records, { ...options, maxRules: 100 }).find((x) => stableJson(x.when as unknown as Json) === stableJson(r.when as unknown as Json))?.id).toBe(r.id);
  });

  test.prop([recordsArb, optionsArb])("DST8.3 no rule tests a value that occurs in only one record, so a field unique to each record is never used", (records, options) => {
    const rules = induceRules(records, options);
    const atoms = (c: (typeof rules)[number]["when"]): (typeof rules)[number]["when"][] => ("all" in c ? c.all.flatMap(atoms) : [c]);
    for (const rule of rules) {
      for (const atom of atoms(rule.when)) {
        expect(JSON.stringify(atom)).not.toContain('"id"');
        if ("eq" in atom) {
          const [path, value] = atom.eq;
          expect(records.filter((r) => (r.input as Record<string, Json>)[path] === value).length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  test.prop([recordsArb])("DST8.4 a record that no outcome or later rung has judged is never a rule's evidence", (records) => {
    const unknown = records.map((r) => ({ ...r, outcome: undefined })) as unknown as DecisionRecord[];
    const stripped = unknown.map(({ outcome: _o, ...rest }) => rest as DecisionRecord);
    expect(induceRules(stripped, { minSupport: 1, minPurity: 0, maxRules: 50, maxConditions: 2 })).toEqual([]);
  });

  test.prop([fc.integer({ min: 0, max: 100 }), fc.string()])("DST8.5 the holdout is about the share asked for, whatever the salt", (percent, salt) => {
    const share = percent / 100;
    const n = 3000;
    let held = 0;
    for (let i = 0; i < n; i++) if (holdoutSplit(`dec-${i}`, share, salt) === "holdout") held += 1;
    expect(Math.abs(held / n - share)).toBeLessThan(0.04);
  });

  test.prop([recordsArb, fc.double({ min: 0, max: 1, noNaN: true })])("DST8.6 examples survive a round trip through JSON lines, and the split is by decision", (records, holdout) => {
    const examples = toExamples(
      records.map((r, i) => ({ ...r, answers: { q: yes(0.7), c: chose({ a: 1, b: 2 }) }, ...(i % 2 === 0 ? {} : { outcome: undefined }) }) as DecisionRecord),
      { labelOf: (_r, q) => (q === "q" ? "true" : "b"), holdout },
    );
    expect(parseExamplesJsonl(examplesToJsonl(examples))).toEqual({ examples, bad: [] });
    for (const e of examples) expect(e.split).toBe(holdoutSplit(e.provenance.decision, holdout));
  });

  test.prop([recordsArb, fc.nat()])("DST8.7 a cut at any point loses only the line it cuts: the lines before it are kept and it is reported", (records, at) => {
    const text = examplesToJsonl(toExamples(records.map((r) => ({ ...r, answers: { q: yes(0.7) } })), { labelOf: () => "true", holdout: 0.5 }));
    fc.pre(text.length > 0);
    const cut = text.slice(0, at % text.length);
    const parsed = parseExamplesJsonl(cut);
    const whole = cut.split("\n").slice(0, -1).length;
    expect(parsed.examples.length).toBeGreaterThanOrEqual(whole);
    expect(parsed.examples.length).toBeLessThanOrEqual(whole + 1);
    expect(parsed.bad.length).toBeLessThanOrEqual(1);
    for (const b of parsed.bad) expect(b.line).toBe(whole + 1);
  });

  test.prop([recordsArb, fc.array(fc.option(actionArb, { nil: undefined }), { minLength: 60, maxLength: 60 })])("DST8.8 disagreements are records the outcome overruled, in the records' order", (records, labels) => {
    const judged = records.map((r, i) => ({ ...r, outcome: outcome("incorrect", labels[i] === undefined ? {} : { label: labels[i]! }) }) as DecisionRecord);
    const found = mineDisagreements(judged);
    const expected = judged.filter((r) => r.outcome?.label !== undefined && r.outcome.label !== r.action);
    expect(found.map((d) => d.record.id)).toEqual(expected.map((r) => r.id));
    for (const d of found) expect(d.label).toBe(d.record.outcome!.label);
  });
});
