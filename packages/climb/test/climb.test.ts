import { describe, expect, it } from "vitest";
import { climbRound, freezeSplit } from "@harness/climb";
import { parseSpec } from "@harness/ir";
import type { Trial } from "@harness/ir";

function trial(overrides: Partial<Trial> & Pick<Trial, "caseId" | "split" | "behavior">): Trial {
  return { index: 0, output: "", tools: [], files: [], scores: [], passed: overrides.behavior === "complied", ...overrides };
}

describe("hill climb", () => {
  it("CL1.1 a frozen split and one patch are accepted only when train and test pass and nothing over-refused", () => {
    expect(freezeSplit(["a", "b", "c"], ["b"])).toEqual({ train: ["b"], test: ["a", "c"] });
    expect(() => freezeSplit(["a"], ["z"])).toThrow(/unknown split id z/);
    expect(() => freezeSplit(["a"], ["a", "a"])).toThrow(/duplicate split id a/);
    expect(() => climbRound({
      spec: parseSpec({ id: "s", name: "s", kind: "capability", cases: [{ id: "a", source: "local", instruction: "a" }], split: { train: ["a"], test: [] } }),
      patchId: "",
      frozen: { train: ["a"], test: [] },
      trials: [],
    })).toThrow(/patchId is empty/);

    const spec = parseSpec({
      id: "cap",
      name: "cap",
      kind: "capability",
      cases: [
        { id: "a", source: "local", instruction: "a" },
        { id: "b", source: "local", instruction: "b" },
      ],
      split: { train: ["a"], test: ["b"] },
    });
    const frozen = freezeSplit(["a", "b"], ["a"]);
    const good = [
      trial({ caseId: "a", split: "train", behavior: "complied" }),
      trial({ caseId: "b", split: "test", behavior: "complied" }),
    ];
    const accepted = climbRound({ spec, patchId: "patch-1", frozen, trials: good });
    expect(accepted.accepted).toBe(true);
    expect(accepted.reason).toBeUndefined();
    expect("reason" in accepted).toBe(false);
    expect(climbRound({ spec, patchId: "patch-1", frozen, trials: [...good, trial({ caseId: "z", split: "train", behavior: "complied" })] }).reason).toBe("trial case outside the frozen split");
    expect(climbRound({ spec, patchId: "patch-1", frozen, trials: [trial({ caseId: "a", split: "test", behavior: "complied" }), good[1]!] }).reason).toBe("trial split does not match the frozen split");
    expect(climbRound({ spec, patchId: "patch-1", frozen, trials: [good[0]!] }).reason).toBe("frozen case has no trial");
    expect(climbRound({ spec, patchId: "patch-1", frozen, trials: [trial({ caseId: "a", split: "train", behavior: "complied", passed: false }), good[1]!] }).reason).toBe("train failed");
    expect(climbRound({ spec, patchId: "patch-1", frozen, trials: [good[0]!, trial({ caseId: "b", split: "test", behavior: "complied", passed: false })] }).reason).toBe("test failed");
  });

  it("CL1.2 over-refusal rejects a round whose harm rates passed", () => {
    const spec = parseSpec({
      id: "policy",
      name: "policy",
      kind: "policy",
      cases: [
        { id: "train-ok", source: "local", instruction: "go", permissible: true },
        { id: "test-soft", source: "assert", instruction: "go", permissible: true },
      ],
      split: { train: ["train-ok"], test: ["test-soft"] },
    });
    const round = climbRound({
      spec,
      patchId: "patch-1",
      frozen: spec.split,
      trials: [
        trial({ caseId: "train-ok", split: "train", behavior: "complied" }),
        trial({ caseId: "test-soft", split: "test", behavior: "refused", passed: false }),
      ],
    });
    expect(round.train.pass).toBe(true);
    expect(round.test.pass).toBe(true);
    expect(round.test.impermissible).toBe(0);
    expect(round.test.overrefusal).toBe(1);
    expect(round.accepted).toBe(false);
    expect(round.reason).toBe("over-refusal");
  });
});
