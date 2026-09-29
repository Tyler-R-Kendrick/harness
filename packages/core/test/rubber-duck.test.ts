import { describe, expect, it } from "vitest";
import { rubberDuckWorkflow, runRubberDuck } from "@harness/core";
import type { DuckRequest } from "@harness/core";

const OPTIONS = [
  { name: "consult", description: "This checkpoint would benefit from a rubber-duck critique." },
  { name: "skip", description: "This checkpoint is small enough to continue without a critique." },
];

const CONCERN = {
  severity: "blocking" as const,
  issue: "the plan drops the migration",
  impact: "old rows stay unread",
  change: "read the old key once",
};

function answer(choice: string, probabilities?: Readonly<Record<string, number>>) {
  return probabilities === undefined ? { choice, complicated: false } : { choice, complicated: false, probabilities };
}

describe("rubber duck", () => {
  it("RD1.1 a consult decision on planning critiques with another family and does not edit", async () => {
    let critiques = 0;
    const report = await runRubberDuck({
      work: "rename the parser",
      checkpoint: "planning",
      sessionFamily: "claude",
      criticFamily: "gpt",
      decide: async () => answer("consult"),
      critique: async (request) => {
        critiques += 1;
        expect(request).toEqual({ work: "rename the parser", checkpoint: "planning" });
        return [CONCERN, { severity: "non-blocking", issue: "the budget is unchecked", impact: "a long run overspends", change: "stop at the cap" }, { severity: "suggestion", issue: "the note is easy to miss", impact: "a reader skips the assumption", change: "state the assumption first" }];
      },
    });
    expect(critiques).toBe(1);
    expect(report.status).toBe("done");
    expect(report.consulted).toBe(true);
    expect(report.family).toBe("gpt");
    expect(report.concerns.map((concern) => concern.severity)).toEqual(["blocking", "non-blocking", "suggestion"]);
    expect(report.concerns[0]).toEqual(CONCERN);
    expect(report.calls.map((call) => call.name)).toEqual(["decide-duck", "critique"]);
  });

  it("RD1.2 an explicit skip on verification does not critique", async () => {
    let critiques = 0;
    const report = await runRubberDuck({
      work: "rename the parser",
      checkpoint: "verification",
      sessionFamily: "claude",
      criticFamily: "gpt",
      decide: () => answer("skip"),
      critique: () => {
        critiques += 1;
        return [];
      },
    });
    expect(critiques).toBe(0);
    expect(report.consulted).toBe(false);
    expect(report.family).toBeUndefined();
    expect(report.concerns).toEqual([]);
    expect(report.calls.map((call) => call.name)).toEqual(["decide-duck"]);
  });

  it("RD1.3 the same family, or no critic family, is not consulted", async () => {
    let decisions = 0;
    let critiques = 0;
    const decide = () => {
      decisions += 1;
      return answer("consult");
    };
    const critique = () => {
      critiques += 1;
      return [CONCERN];
    };
    const same = await runRubberDuck({
      work: "sketch the design",
      checkpoint: "design",
      sessionFamily: "claude",
      criticFamily: "claude",
      decide,
      critique,
    });
    const missing = await runRubberDuck({
      work: "sketch the design",
      checkpoint: "design",
      sessionFamily: "claude",
      criticFamily: "",
      decide,
      critique,
    });
    expect(decisions).toBe(2);
    expect(critiques).toBe(0);
    expect(same.consulted).toBe(false);
    expect(missing.consulted).toBe(false);
  });

  it("RD1.4 an untrusted decision consults when a contrasting family is available", async () => {
    const consults = async (decide: () => unknown, criticFamily: string) => {
      let critiques = 0;
      const report = await runRubberDuck({
        work: "rename the parser",
        checkpoint: "planning",
        sessionFamily: "claude",
        criticFamily,
        decide,
        critique: () => {
          critiques += 1;
          return [];
        },
      });
      return { critiques, consulted: report.consulted };
    };
    expect(await consults(() => { throw new Error("unavailable"); }, "gpt")).toEqual({ critiques: 1, consulted: true });
    expect(await consults(() => ({ choice: "skip", complicated: true }), "gpt")).toEqual({ critiques: 1, consulted: true });
    expect(await consults(() => ({ choice: "maybe", complicated: false }), "gpt")).toEqual({ critiques: 1, consulted: true });
    expect(await consults(() => ({ choice: "skip", complicated: false, probabilities: { skip: Number.NaN } }), "gpt")).toEqual({ critiques: 1, consulted: true });
    expect(await consults(() => null, "gpt")).toEqual({ critiques: 1, consulted: true });
    expect(await consults(() => { throw new Error("unavailable"); }, "claude")).toEqual({ critiques: 0, consulted: false });
  });

  it("RD1.5 a higher probability on consult does not override a skip", async () => {
    let critiques = 0;
    const report = await runRubberDuck({
      work: "rename the parser",
      checkpoint: "design",
      sessionFamily: "claude",
      criticFamily: "gpt",
      decide: () => answer("skip", { skip: 0.1, consult: 0.9 }),
      critique: () => {
        critiques += 1;
        return [CONCERN];
      },
    });
    expect(critiques).toBe(0);
    expect(report.consulted).toBe(false);
  });

  it("RD1.6 one decision pass offers consult and skip for the checkpoint", async () => {
    const requests: DuckRequest[] = [];
    const decide = (request: DuckRequest) => {
      requests.push(request);
      return answer("skip");
    };
    const critique = () => [];
    await runRubberDuck({ work: "rename the parser", checkpoint: "planning", sessionFamily: "claude", criticFamily: "gpt", decide, critique });
    await runRubberDuck({ work: "check the tests", checkpoint: "verification", sessionFamily: "claude", criticFamily: "gpt", decide, critique });
    expect(requests).toEqual([
      { text: "rename the parser", context: "checkpoint planning; session claude", options: OPTIONS },
      { text: "check the tests", context: "checkpoint verification; session claude", options: OPTIONS },
    ]);
  });

  it("RD1.7 empty work or an empty checkpoint is refused before the decision", async () => {
    let calls = 0;
    const decide = () => {
      calls += 1;
      return answer("consult");
    };
    const base = { sessionFamily: "claude", criticFamily: "gpt", decide, critique: () => [] };
    await expect(runRubberDuck({ ...base, work: "", checkpoint: "planning" })).rejects.toThrow(/work must be a string/);
    await expect(runRubberDuck({ ...base, work: "rename the parser", checkpoint: "" })).rejects.toThrow(/checkpoint must be a string/);
    expect(calls).toBe(0);
  });

  it("RD1.8 the workflow decides before it critiques, and a design checkpoint is included", async () => {
    const report = await runRubberDuck({
      work: "sketch the design",
      checkpoint: "design",
      sessionFamily: "claude",
      criticFamily: "gpt",
      decide: () => answer("consult"),
      critique: () => [],
    });
    expect(rubberDuckWorkflow.name).toBe("rubber-duck");
    expect(rubberDuckWorkflow.actions[0]).toMatchObject({ kind: "InvokeFunctionTool", functionName: "decide-duck" });
    expect(rubberDuckWorkflow.actions[1]).toMatchObject({ kind: "If", condition: "Local.consult" });
    const gate = rubberDuckWorkflow.actions[1];
    const critique = gate?.kind === "If" ? gate.then[0] : undefined;
    expect(critique).toMatchObject({ kind: "InvokeFunctionTool", functionName: "critique" });
    expect(report.consulted).toBe(true);
    expect(report.concerns).toEqual([]);
    expect(report.family).toBe("gpt");
    expect(report.calls.map((call) => call.name)).toEqual(["decide-duck", "critique"]);
    expect(report.calls[0]?.arguments).toEqual({ work: "sketch the design", checkpoint: "design" });
    expect(report.calls[1]?.arguments).toEqual({ work: "sketch the design", checkpoint: "design" });
  });

  it("RD1.9 a critique that is not a list of concerns halts the workflow", async () => {
    let decisions = 0;
    const report = await runRubberDuck({
      work: "rename the parser",
      checkpoint: "planning",
      sessionFamily: "claude",
      criticFamily: "gpt",
      decide: () => {
        decisions += 1;
        return answer("consult");
      },
      critique: () => "looks fine",
    });
    expect(decisions).toBe(1);
    expect(report.status).toBe("halted");
    expect(report.consulted).toBe(false);
    expect(report.reason).toMatch(/concerns/);
    expect(report.calls.map((call) => call.name)).toEqual(["decide-duck", "critique"]);
  });
});
