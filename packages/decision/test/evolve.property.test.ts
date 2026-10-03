import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { applyEdits, CriteriaArchive, criteriaFromFork, gainLowerBound, mulberry32, pairedSignFlipTest, screenEdits, standardNormalQuantile, withCriteria } from "../src/evolve.ts";
import type { CriteriaBook, Edit } from "../src/evolve.ts";
import { forkId } from "../src/types.ts";
import { gate, INSTRUCTIONS } from "./evolve-fixtures.ts";

/** Every sign pattern, counted outright: the share whose sum is at least the observed sum. */
function bruteForce(diffs: readonly number[]): number {
  const magnitudes = diffs.filter((d) => d !== 0).map(Math.abs);
  const observed = diffs.reduce((a, b) => a + b, 0);
  let atLeast = 0;
  for (let mask = 0; mask < 2 ** magnitudes.length; mask++) {
    let sum = 0;
    magnitudes.forEach((m, i) => {
      sum += (mask >> i) & 1 ? -m : m;
    });
    if (sum >= observed) atLeast += 1;
  }
  return atLeast / 2 ** magnitudes.length;
}

const smallInts = fc.array(fc.integer({ min: -6, max: 6 }), { maxLength: 12 });

describe("the sign-flip test", () => {
  test.prop([smallInts])("EVO12.1 the exact p-value is the brute-force count over every sign pattern", (diffs) => {
    expect(pairedSignFlipTest(diffs, { alpha: 0.05 }).pValue).toBe(bruteForce(diffs));
  });

  test.prop([fc.array(fc.integer({ min: -1, max: 1 }), { maxLength: 14 })])("EVO12.2 for the differences of two replays (-1, 0, 1) too", (diffs) => {
    expect(pairedSignFlipTest(diffs, { alpha: 0.05 }).pValue).toBe(bruteForce(diffs));
  });

  test.prop([smallInts])("EVO12.3 a p-value is a probability, at least one over the number of patterns", (diffs) => {
    const { pValue, n } = pairedSignFlipTest(diffs, { alpha: 0.05 });
    expect(pValue).toBeGreaterThan(0);
    expect(pValue).toBeLessThanOrEqual(1);
    expect(pValue).toBeGreaterThanOrEqual(2 ** -n);
  });

  test.prop([smallInts, fc.integer({ min: 1, max: 9 })])("EVO12.4 scaling every difference by a positive number does not change the p-value", (diffs, k) => {
    expect(pairedSignFlipTest(diffs.map((d) => d * k), { alpha: 0.05 }).pValue).toBe(pairedSignFlipTest(diffs, { alpha: 0.05 }).pValue);
  });

  test.prop([smallInts])("EVO12.5 the order of the differences does not matter", (diffs) => {
    const reversed = [...diffs].reverse();
    expect(pairedSignFlipTest(reversed, { alpha: 0.05 }).pValue).toBe(pairedSignFlipTest(diffs, { alpha: 0.05 }).pValue);
  });

  test.prop([smallInts, fc.integer({ min: 1, max: 6 })])("EVO12.6 raising one difference never raises the p-value", (diffs, bump) => {
    fc.pre(diffs.length > 0);
    const better = diffs.map((d, i) => (i === 0 ? d + bump : d));
    expect(pairedSignFlipTest(better, { alpha: 0.05 }).pValue).toBeLessThanOrEqual(pairedSignFlipTest(diffs, { alpha: 0.05 }).pValue + 1e-12);
  });

  test.prop([smallInts])("EVO12.7 the mean includes the zeros and the count excludes them", (diffs) => {
    const result = pairedSignFlipTest(diffs, { alpha: 0.05 });
    expect(result.n).toBe(diffs.filter((d) => d !== 0).length);
    expect(result.meanDiff).toBeCloseTo(diffs.length === 0 ? 0 : diffs.reduce((a, b) => a + b, 0) / diffs.length, 12);
  });

  test.prop([fc.array(fc.integer({ min: -1, max: 1 }), { minLength: 21, maxLength: 40 }).filter((d) => d.filter((x) => x !== 0).length > 20)])("EVO12.8 beyond the exact limit the sampled p-value is repeatable and within its bounds", (diffs) => {
    const first = pairedSignFlipTest(diffs, { alpha: 0.05, resamples: 300 });
    expect(pairedSignFlipTest(diffs, { alpha: 0.05, resamples: 300 })).toEqual(first);
    expect(first.exact).toBe(false);
    expect(first.pValue).toBeGreaterThanOrEqual(1 / 301);
    expect(first.pValue).toBeLessThanOrEqual(1);
  });
});

describe("the bound, the quantile and the generator", () => {
  test.prop([fc.array(fc.integer({ min: -1, max: 1 }), { minLength: 2, maxLength: 30 }), fc.double({ min: 0.001, max: 0.5, noNaN: true })])("EVO13.1 the lower bound is never above the mean", (diffs, alpha) => {
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    expect(gainLowerBound(diffs, alpha)!).toBeLessThanOrEqual(mean + 1e-12);
  });

  test.prop([fc.double({ min: 0.0001, max: 0.9999, noNaN: true }), fc.double({ min: 0.0001, max: 0.9999, noNaN: true })])("EVO13.2 the quantile rises with the probability and is odd about one half", (a, b) => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    expect(standardNormalQuantile(lo)).toBeLessThanOrEqual(standardNormalQuantile(hi) + 1e-12);
    expect(standardNormalQuantile(1 - a)).toBeCloseTo(-standardNormalQuantile(a), 6);
  });

  test.prop([fc.integer({ min: -(2 ** 31), max: 2 ** 32 })])("EVO13.3 the generator stays in [0, 1) and repeats from a seed", (seed) => {
    const a = mulberry32(seed);
    const b = mulberry32(seed);
    for (let i = 0; i < 20; i++) {
      const x = a();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      expect(b()).toBe(x);
    }
  });
});

// A function, not a value: a book that failed to build would fail this whole file as it loads, which a mutation run cannot count as a test failing.
const book = (): CriteriaBook => criteriaFromFork(gate(), { kind: "x" }, "v0");
const wordy = fc.string({ minLength: 1, maxLength: 30 });

describe("edits and the frozen layer", () => {
  test.prop([fc.array(fc.anything(), { maxLength: 8 })])("EVO14.1 whatever a proposer returns, what is kept is an edit of a question's text that the book can take, within the caps", (proposed) => {
    const screened = screenEdits(proposed, { book: book(), heldOut: [], maxEdits: 3, maxEditChars: 20, leakWords: 6 });
    expect(screened.kept.length).toBeLessThanOrEqual(3);
    expect(screened.kept.length + screened.rejected.length).toBe(proposed.length);
    for (const edit of screened.kept) {
      expect(Object.keys(edit).sort()).toEqual(["question", "target", "text"]);
      expect(edit.question).toBe("risky");
      expect(["instructions", "criteria:true", "criteria:false"]).toContain(edit.target);
      expect(edit.text.length).toBeLessThanOrEqual(20);
    }
    expect(() => applyEdits(book(), screened.kept, "v1")).not.toThrow();
  });

  test.prop([fc.array(fc.record({ question: fc.constantFrom("risky", "other"), target: fc.constantFrom("instructions", "criteria:true", "criteria:false", "criteria:maybe", "authority", "policy:act", "holdout"), text: wordy }), { maxLength: 8 })])(
    "EVO14.2 applying screened edits changes only the text of the questions' instructions and criteria: the book's shape, fork and questions are the same",
    (proposed) => {
      const { kept } = screenEdits(proposed, { book: book(), heldOut: [], maxEdits: 4, maxEditChars: 30, leakWords: 6 });
      const next = applyEdits(book(), kept, "v1");
      expect(next.fork).toBe(book().fork);
      expect(Object.keys(next.questions)).toEqual(Object.keys(book().questions));
      const q = next.questions["risky"]!;
      expect(q.type).toBe("boolean");
      expect(Object.keys(q).sort()).toEqual(["criteria", "instructions", "type"]);
      for (const key of Object.keys(q.criteria)) expect(["true", "false"]).toContain(key);
      // an edit was applied if and only if it is the last to name its target
      if (!kept.some((e) => e.target === "instructions")) expect(q.instructions).toBe(INSTRUCTIONS);
    },
  );

  test.prop([fc.array(fc.record({ question: fc.constant("risky"), target: fc.constantFrom("instructions", "criteria:true", "criteria:false"), text: wordy }), { maxLength: 6 })])("EVO14.3 the fork under edited criteria differs from the fork only in the questions' text, whatever the edits", (edits) => {
    const original = gate();
    const next = withCriteria(original, applyEdits(book(), edits as Edit[], "v1"));
    for (const key of ["id", "interpret", "describe", "fallback", "rule", "floor", "restrictiveness"] as const) expect(next[key]).toBe(original[key]);
    const asked = next.ask({ kind: "disk" });
    expect(asked.state).toEqual(original.ask({ kind: "disk" }).state);
    expect(Object.keys(asked.questions)).toEqual(["risky"]);
    expect(asked.questions["risky"]!.type).toBe("boolean");
  });

  test.prop([fc.array(wordy, { minLength: 1, maxLength: 5 }), fc.integer({ min: 2, max: 5 })])("EVO14.4 an edit that contains a run of words from a held-out input is never kept", (words, run) => {
    const input = words.join(" ");
    const tokens = input.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
    fc.pre(tokens.length >= run);
    const leaking = `see ${tokens.slice(0, run).join(" ")} here`;
    const screened = screenEdits([{ question: "risky", target: "instructions", text: leaking }], { book: book(), heldOut: [{ note: input }], maxEdits: 1, maxEditChars: 1000, leakWords: run });
    expect(screened.kept).toEqual([]);
  });
});

describe("the archive", () => {
  const id = forkId("evo.gate");
  const step = fc.record({ accept: fc.boolean(), text: wordy });

  test.prop([fc.array(step, { maxLength: 8 })])("EVO15.1 whatever is attempted, exactly one version is active, and a snapshot restores to the same archive", (steps) => {
    const archive = new CriteriaArchive();
    archive.seed(book());
    steps.forEach(({ accept, text }) => {
      const version = archive.nextVersion(id);
      const criteria = applyEdits(book(), [{ question: "risky", target: "instructions", text }], version);
      archive.attempt({ criteria, edits: [{ question: "risky", target: "instructions", text }], summary: { n: 10, incumbent: 0.5, candidate: 0.5, meanDiff: 0, lower: null, pValue: 1, accepted: accept, reason: "r" } });
      expect(archive.history(id).filter((e) => e.status === "active")).toHaveLength(1);
    });
    expect(archive.history(id)).toHaveLength(steps.length + 1);
    expect(new Set(archive.history(id).map((e) => e.version)).size).toBe(steps.length + 1);
    const copy = new CriteriaArchive();
    copy.restore(JSON.parse(JSON.stringify(archive.snapshot())));
    expect(copy.snapshot()).toEqual(archive.snapshot());
  });

  test.prop([fc.array(step, { minLength: 1, maxLength: 8 }), fc.nat()])("EVO15.2 every version that was ever active can be rolled back to, and then it is the only active one", (steps, pick) => {
    const archive = new CriteriaArchive();
    archive.seed(book());
    for (const { accept, text } of steps) {
      const version = archive.nextVersion(id);
      archive.attempt({ criteria: applyEdits(book(), [{ question: "risky", target: "instructions", text }], version), edits: [], summary: { n: 10, incumbent: 0.5, candidate: 0.5, meanDiff: 0, lower: null, pValue: 1, accepted: accept, reason: "r" } });
    }
    const everActive = archive.history(id).filter((e) => e.summary === undefined || e.summary.accepted);
    const target = everActive[pick % everActive.length]!;
    archive.rollback(id, target.version);
    expect(archive.active(id)?.version).toBe(target.version);
    expect(archive.history(id).filter((e) => e.status === "active")).toHaveLength(1);
  });
});
