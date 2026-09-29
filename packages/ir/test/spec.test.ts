import { describe, expect, it } from "vitest";
import { measureSplit, parseSpec, parseTrials } from "@harness/ir";
import type { Spec, Trial } from "@harness/ir";

function policyCase(id: string, permissible: boolean) {
  return { id, source: "local" as const, instruction: id, permissible };
}

function trial(overrides: Partial<Trial> & Pick<Trial, "caseId" | "split" | "behavior">): Trial {
  return {
    index: 0,
    output: "",
    tools: [],
    files: [],
    scores: [],
    passed: overrides.behavior === "complied",
    ...overrides,
  };
}

describe("eval IR", () => {
  it("IR1.1 a split that overlaps, drops, or invents an id is rejected", () => {
    const cases = [policyCase("a", true), policyCase("b", false)];
    expect(parseSpec({ id: "s", name: "s", kind: "policy", cases, split: { train: ["a"], test: ["b"] } }).id).toBe("s");
    expect(() => parseSpec({ id: "s", name: "s", kind: "policy", cases, split: { train: ["a"], test: ["a"] } })).toThrow(/split/);
    expect(() => parseSpec({ id: "s", name: "s", kind: "policy", cases, split: { train: ["a"], test: ["missing"] } })).toThrow(/split/);
    expect(() => parseSpec({ id: "s", name: "s", kind: "policy", cases, split: { train: ["a"], test: [] } })).toThrow(/split/);
    expect(() => parseSpec({ id: "s", name: "s", kind: "policy", cases: [policyCase("a", true), policyCase("a", true)], split: { train: ["a"], test: [] } })).toThrow(/split/);
    expect(() => parseSpec({ id: "s", name: "s", kind: "policy", cases: [{ id: "a", source: "local", instruction: "a" }], split: { train: ["a"], test: [] } })).toThrow(/permissible/);
    expect(() => parseSpec({ id: "s", name: "s", kind: "policy", cases, split: { train: ["a", "a"], test: ["b"] } })).toThrow(/train ids/);
    expect(() => parseSpec({ id: "s", name: "s", kind: "policy", cases, split: { train: ["a"], test: ["b", "b"] } })).toThrow(/test ids/);
    expect(() => parseSpec({ id: "s", name: "s", kind: "policy", cases, split: { train: ["missing"], test: ["a"] } })).toThrow(/train id/);
    expect(() => parseTrials([{ nope: true }])).toThrow();
  });

  it("IR1.2 impermissible and over-refusal stay apart", () => {
    const spec = parseSpec({
      id: "policy",
      name: "policy",
      kind: "policy",
      cases: [policyCase("harm", false), policyCase("boom", false), policyCase("soft", true), policyCase("ok", true)],
      split: { train: ["harm", "boom"], test: ["soft", "ok"] },
    });
    const trials = [
      trial({ caseId: "harm", split: "train", behavior: "complied" }),
      trial({ caseId: "boom", split: "train", behavior: "errored", failureClass: "harness", passed: false }),
      trial({ caseId: "soft", split: "test", behavior: "refused", passed: false }),
      trial({ caseId: "ok", split: "test", behavior: "complied" }),
    ];
    const train = measureSplit(spec, trials, "train");
    const test = measureSplit(spec, trials, "test");
    expect(train.impermissible).toBe(0.5);
    expect(train.overrefusal).toBe(0);
    expect(train.pass).toBe(false);
    expect(test.impermissible).toBe(0);
    expect(test.overrefusal).toBe(0.5);
    expect(test.pass).toBe(true);
    const orphan: Spec = {
      id: "policy",
      name: "policy",
      kind: "policy",
      cases: [policyCase("harm", false)],
      split: { train: ["missing"], test: [] },
    };
    expect(() => measureSplit(orphan, [], "train")).toThrow(/unknown split id missing/);
  });

  it("IR1.3 pass@k is cases passed over cases, and fewer than k trials fails closed", () => {
    const spec = parseSpec({
      id: "cap",
      name: "cap",
      kind: "capability",
      cases: [
        { id: "c1", source: "local", instruction: "c1", k: 2 },
        { id: "c2", source: "local", instruction: "c2" },
      ],
      split: { train: ["c1", "c2"], test: [] },
    });
    const both = measureSplit(spec, [
      trial({ caseId: "c1", split: "train", index: 0, behavior: "complied", passed: true }),
      trial({ caseId: "c1", split: "train", index: 1, behavior: "complied", passed: false }),
      trial({ caseId: "c2", split: "train", behavior: "complied", passed: false }),
    ], "train");
    expect(both.passAtK).toBe(0.5);
    expect(both.pass).toBe(false);
    expect(both.impermissible).toBe(0);
    expect(both.overrefusal).toBe(0);
    const short = measureSplit(spec, [
      trial({ caseId: "c1", split: "train", behavior: "complied", passed: true }),
      trial({ caseId: "c2", split: "train", behavior: "complied", passed: true }),
    ], "train");
    expect(short.passAtK).toBe(0.5);
    expect(short.pass).toBe(false);
    expect(measureSplit(spec, [], "test")).toEqual({ pass: true, impermissible: 0, overrefusal: 0, passAtK: 1 });
  });
});
