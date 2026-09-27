import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { caseVerdict, questionVerdict } from "@harness/evals";

describe("questionVerdict", () => {
  it("EV2.1 expecting yes: pass at >= .8, fail at <= .5, inconclusive between", () => {
    const e = { type: "boolean" as const, expect: true };
    expect(questionVerdict(e, { type: "boolean", probability: probability(0.8) })).toBe("passed");
    expect(questionVerdict(e, { type: "boolean", probability: probability(0.79) })).toBe("inconclusive");
    expect(questionVerdict(e, { type: "boolean", probability: probability(0.51) })).toBe("inconclusive");
    expect(questionVerdict(e, { type: "boolean", probability: probability(0.5) })).toBe("failed");
  });

  it("EV2.2 expecting no mirrors the thresholds", () => {
    const e = { type: "boolean" as const, expect: false };
    expect(questionVerdict(e, { type: "boolean", probability: probability(0.2) })).toBe("passed");
    expect(questionVerdict(e, { type: "boolean", probability: probability(0.3) })).toBe("inconclusive");
    expect(questionVerdict(e, { type: "boolean", probability: probability(0.5) })).toBe("failed");
  });

  it("EV2.3 custom thresholds are honoured", () => {
    const e = { type: "boolean" as const, expect: true, pass: 0.95, fail: 0.7 };
    expect(questionVerdict(e, { type: "boolean", probability: probability(0.9) })).toBe("inconclusive");
    expect(questionVerdict(e, { type: "boolean", probability: probability(0.7) })).toBe("failed");
  });

  it("EV2.4 choice passes on the expected option with enough probability", () => {
    const e = { type: "choice" as const, expect: "billing" };
    expect(questionVerdict(e, { type: "choice", choice: "billing", probabilities: { billing: probability(0.9), tech: probability(0.1) } })).toBe("passed");
    expect(questionVerdict(e, { type: "choice", choice: "billing", probabilities: { billing: probability(0.55), tech: probability(0.45) } })).toBe("inconclusive");
    expect(questionVerdict(e, { type: "choice", choice: "billing" })).toBe("passed");
    expect(questionVerdict(e, { type: "choice", choice: "tech" })).toBe("failed");
  });

  it("EV2.5 score passes inside the bounds", () => {
    const e = { type: "score" as const, min: 1.5, max: 2 };
    expect(questionVerdict(e, { type: "score", score: 1.7 })).toBe("passed");
    expect(questionVerdict(e, { type: "score", score: 1.2 })).toBe("failed");
    expect(questionVerdict(e, { type: "score", score: 2.1 })).toBe("failed");
    expect(questionVerdict({ type: "score" as const }, { type: "score", score: 0 })).toBe("passed");
  });

  it("EV2.6 a missing or mistyped answer is inconclusive, never a pass", () => {
    expect(questionVerdict({ type: "boolean", expect: true }, undefined)).toBe("inconclusive");
    expect(questionVerdict({ type: "boolean", expect: true }, { type: "score", score: 1 })).toBe("inconclusive");
  });

  it("EV2.7 a case fails if any question fails, else is inconclusive if any is, else passes", () => {
    expect(caseVerdict(["passed", "passed"])).toBe("passed");
    expect(caseVerdict(["passed", "inconclusive"])).toBe("inconclusive");
    expect(caseVerdict(["inconclusive", "failed"])).toBe("failed");
    expect(caseVerdict([])).toBe("inconclusive");
  });
});
