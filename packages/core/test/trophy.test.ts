import { describe, expect, it } from "vitest";
import { parseTestingRoster, reviewTesting, runTaskVerification, selectTrophy, taskVerificationWorkflow } from "@harness/core";
import type { TestSubject, TestingAgent, TrophyRequest } from "@harness/core";

const AGENTS = [
  { name: "fuzz", title: "Fuzz", instructions: "Generate inputs from a seed and keep a counterexample.", applies: "always" },
  { name: "mutation", title: "Mutation", instructions: "Refuse a score under the threshold, and a threshold under the floor.", applies: "always" },
  { name: "crap", title: "CRAP", instructions: "Score each unit and refuse one over the bound.", applies: "always" },
  { name: "contract", title: "Contract", instructions: "Every named contract's cases pass, including each integration boundary.", applies: "always" },
  { name: "atomic", title: "Atomic", instructions: "Each assertion id covers one behavior.", applies: "always" },
  { name: "evals", title: "Evals", instructions: "Judge a frozen one-patch climb. Impermissible and over-refusal stay separate. Pass@k must be 1. Spend no model budget.", applies: "always" },
  { name: "bdd", title: "BDD", instructions: "Each boundary has a scenario that cites a passing contract case.", applies: "boundary" },
  { name: "ux", title: "UX", instructions: "Exercise a user-facing surface, including both viewports when the layout changed.", applies: "ui" },
];

const roster = parseTestingRoster({ fuzzMinTrials: 100, mutationBreak: 90, maxCrap: 30, agents: AGENTS });

const library: TestSubject = { name: "core", boundaries: [], ui: false, layout: false };
const bordered: TestSubject = { name: "storage", boundaries: [{ name: "disk", contract: "storage" }], ui: false, layout: false };
const screen: TestSubject = { name: "playground", boundaries: [], ui: true, layout: true };
const both: TestSubject = { name: "page", boundaries: [{ name: "disk", contract: "storage" }], ui: true, layout: true };

const OPTIONS = [
  { name: "static", description: "Static analysis only, the base of the trophy." },
  { name: "unit", description: "Static analysis and a few unit tests." },
  { name: "integration", description: "Static analysis, a few unit tests, and integration tests." },
  { name: "e2e", description: "The trophy through a few end-to-end tests." },
  { name: "amplify", description: "Integration tests plus fuzzing and mutation." },
];

const INTEGRATION = ["crap", "contract", "atomic"];

function answer(choice: string, probabilities?: Readonly<Record<string, number>>) {
  return probabilities === undefined ? { choice, complicated: false } : { choice, complicated: false, probabilities };
}

async function names(subject: TestSubject, choice: string, probabilities?: Readonly<Record<string, number>>): Promise<readonly string[]> {
  const picked = await selectTrophy({
    roster,
    subject,
    work: "rename the parser",
    decide: () => answer(choice, probabilities),
  });
  return picked.map((agent) => agent.name);
}

describe("testing trophy", () => {
  it("TT1.1 the integration band keeps static analysis, unit tests, and the integration agents that apply", async () => {
    const picked = await selectTrophy({ roster, subject: library, work: "rename the parser", decide: () => answer("integration") });
    const keep = new Set(["crap", "contract", "atomic"]);
    expect(picked).toEqual(roster.agents.filter((agent: TestingAgent) => keep.has(agent.name)));
    expect(await names(bordered, "integration")).toEqual([...INTEGRATION, "bdd"]);
    expect(await names(screen, "integration")).toEqual(INTEGRATION);
    expect(await names(both, "integration")).toEqual([...INTEGRATION, "bdd"]);
  });

  it("TT1.2 the static band is only the cheap base, including for a user-facing subject", async () => {
    const picked = await selectTrophy({
      roster,
      subject: both,
      work: "rename the parser",
      decide: async () => answer("static"),
    });
    expect(picked.map((agent) => agent.name)).toEqual(["crap"]);
  });

  it("TT1.3 the unit band adds a few unit tests and does not add interface or boundary agents", async () => {
    expect(await names(both, "unit")).toEqual(["crap", "atomic"]);
  });

  it("TT1.4 end to end on a library adds the evals tip and not the slow agents", async () => {
    expect(await names(library, "e2e")).toEqual([...INTEGRATION, "evals"]);
  });

  it("TT1.5 amplify on a library adds fuzz and mutation and not the end to end tip", async () => {
    expect(await names(library, "amplify")).toEqual(["fuzz", "mutation", ...INTEGRATION]);
  });

  it("TT1.6 the end to end tip adds UX only for a user-facing subject and BDD only for a boundary", async () => {
    expect(await names(screen, "e2e")).toEqual([...INTEGRATION, "evals", "ux"]);
    expect(await names(bordered, "e2e")).toEqual([...INTEGRATION, "evals", "bdd"]);
    expect(await names(both, "e2e")).toEqual([...INTEGRATION, "evals", "bdd", "ux"]);
  });

  it("TT1.7 amplify adds BDD for a boundary and never adds UX or evals", async () => {
    expect(await names(screen, "amplify")).toEqual(["fuzz", "mutation", ...INTEGRATION]);
    expect(await names(bordered, "amplify")).toEqual(["fuzz", "mutation", ...INTEGRATION, "bdd"]);
    expect(await names(both, "amplify")).toEqual(["fuzz", "mutation", ...INTEGRATION, "bdd"]);
  });

  it("TT1.8 a complicated, unknown, thrown, or non-finite decision falls back to integration", async () => {
    const fallback = async (decide: () => unknown) => namesFrom(decide);
    expect(await fallback(() => { throw new Error("unavailable"); })).toEqual(INTEGRATION);
    expect(await fallback(() => ({ choice: "amplify", complicated: true }))).toEqual(INTEGRATION);
    expect(await fallback(() => ({ choice: "pyramid", complicated: false }))).toEqual(INTEGRATION);
    expect(await fallback(() => ({ choice: "static", complicated: false, probabilities: { static: Number.NaN } }))).toEqual(INTEGRATION);
    expect(await fallback(() => ({ choice: "static", complicated: false, probabilities: { e2e: Number.POSITIVE_INFINITY } }))).toEqual(INTEGRATION);
    expect(await fallback(() => null)).toEqual(INTEGRATION);
    expect(await fallback(() => ({ choice: "static" }))).toEqual(INTEGRATION);
    expect(await fallback(() => ({ choice: "static", complicated: false, probabilities: [] }))).toEqual(INTEGRATION);
  });

  it("TT1.9 a higher probability on another band does not change the choice", async () => {
    expect(await names(library, "static", { static: 0.1, e2e: 0.9 })).toEqual(["crap"]);
    expect(await names(library, "e2e", { e2e: 0 })).toEqual([...INTEGRATION, "evals"]);
  });

  it("TT1.10 one decision pass offers the five trophy bands", async () => {
    const requests: TrophyRequest[] = [];
    const decide = (request: TrophyRequest) => {
      requests.push(request);
      return answer("unit");
    };
    await selectTrophy({ roster, subject: library, work: "rename the parser", decide });
    await selectTrophy({ roster, subject: bordered, work: "flush the cache", decide });
    expect(requests).toEqual([
      { text: "rename the parser", context: "subject core; boundaries none; ui false; layout false", options: OPTIONS },
      { text: "flush the cache", context: "subject storage; boundaries disk; ui false; layout false", options: OPTIONS },
    ]);
  });

  it("TT1.11 empty work and a nameless subject are refused before the decision", async () => {
    let calls = 0;
    const decide = () => {
      calls += 1;
      return answer("static");
    };
    await expect(selectTrophy({ roster, subject: library, work: "", decide })).rejects.toThrow(/work must be a string/);
    await expect(selectTrophy({ roster, subject: { ...library, name: "" }, work: "fix the parser", decide })).rejects.toThrow(/subject name/);
    expect(calls).toBe(0);
  });

  it("TT1.12 a review of a selection judges those agents in that order and ignores the rest", () => {
    const report = reviewTesting(roster, library, {
      crap: { units: [{ name: "parse", complexity: 2, coverage: 1 }] },
      contracts: [{ name: "storage", cases: [{ id: "SC1", passed: true }] }],
      atomic: { tests: [{ id: "TT1.12", behaviors: 1 }] },
    }, ["atomic", "crap"]);
    expect(report.status).toBe("pass");
    expect(report.verdicts.map((verdict) => verdict.agent)).toEqual(["atomic", "crap"]);
  });

  it("TT1.13 an empty selection, a duplicate, or an agent outside the plan is refused", () => {
    const body = { crap: { units: [{ name: "parse", complexity: 2, coverage: 1 }] } };
    expect(() => reviewTesting(roster, library, body, [])).toThrow(/testing selection is empty/);
    expect(() => reviewTesting(roster, library, body, ["crap", "crap"])).toThrow(/testing agent crap is duplicated/);
    expect(() => reviewTesting(roster, library, body, ["ux"])).toThrow(/testing agent ux does not apply/);
    expect(() => reviewTesting(roster, library, body, ["nope"])).toThrow(/testing agent nope does not apply/);
  });

  it("TT1.14 the task workflow selects tests once and reviews that band without mutation evidence", async () => {
    let calls = 0;
    const report = await runTaskVerification({
      roster,
      subject: library,
      evidence: {
        crap: { units: [{ name: "parse", complexity: 2, coverage: 1 }] },
        contracts: [{ name: "storage", cases: [{ id: "SC1", passed: true }] }],
        atomic: { tests: [{ id: "TT1.14", behaviors: 1 }] },
      },
      work: "rename the parser",
      decide: () => {
        calls += 1;
        return answer("integration");
      },
    });
    expect(taskVerificationWorkflow.name).toBe("task-verification");
    expect(taskVerificationWorkflow.actions.flatMap((action) => action.kind === "InvokeFunctionTool" ? [action.functionName] : [])).toEqual(["select-tests", "review-tests"]);
    expect(calls).toBe(1);
    expect(report.status).toBe("pass");
    expect(report.agents).toEqual(INTEGRATION);
    expect(report.calls.map((call) => call.name)).toEqual(["select-tests", "review-tests"]);
    expect(report.calls[0]?.arguments).toEqual({ work: "rename the parser" });
    expect(report.calls[1]?.arguments).toEqual({ tests: INTEGRATION });
  });

  it("TT1.15 a failing agent in the selected band fails task verification", async () => {
    const report = await runTaskVerification({
      roster,
      subject: library,
      evidence: { crap: { units: [{ name: "parse", complexity: 6, coverage: 0 }] } },
      work: "rename the parser",
      decide: () => answer("static"),
    });
    expect(report.status).toBe("fail");
    expect(report.reason).toMatch(/42/);
    expect(report.agents).toEqual(["crap"]);
    expect(report.verdicts.map((verdict) => verdict.agent)).toEqual(["crap"]);
    expect(report.calls.map((call) => call.name)).toEqual(["select-tests", "review-tests"]);
  });
});

async function namesFrom(decide: () => unknown): Promise<readonly string[]> {
  const picked = await selectTrophy({ roster, subject: library, work: "rename the parser", decide });
  return picked.map((agent) => agent.name);
}
