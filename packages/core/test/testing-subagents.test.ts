import { describe, expect, it } from "vitest";
import { SubagentTree, parseTestingRoster, planTesting, reviewTesting, spawnTestingSubagents } from "@harness/core";
import type { Grant, TestSubject, TestingEvidence } from "@harness/core";

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

function document(over: Record<string, unknown> = {}) {
  return {
    fuzzMinTrials: 100,
    mutationBreak: 90,
    maxCrap: 30,
    agents: AGENTS,
    ...over,
  };
}

const roster = parseTestingRoster(document());

const library: TestSubject = { name: "core", boundaries: [], ui: false, layout: false };
const bordered: TestSubject = { name: "storage", boundaries: [{ name: "disk", contract: "storage" }], ui: false, layout: false };
const screen: TestSubject = { name: "playground", boundaries: [], ui: true, layout: true };
const both: TestSubject = { name: "page", boundaries: [{ name: "disk", contract: "storage" }], ui: true, layout: true };

function omit<K extends keyof TestingEvidence>(value: TestingEvidence, key: K): TestingEvidence {
  const next = { ...value };
  delete next[key];
  return next;
}

function evidence(over: Partial<TestingEvidence> = {}): TestingEvidence {
  return {
    fuzz: { trials: 100, seed: "1", counterexample: false },
    mutation: { score: 90, threshold: 90 },
    crap: { units: [{ name: "parse", complexity: 2, coverage: 1 }] },
    contracts: [{ name: "storage", cases: [{ id: "SC1", passed: true }] }],
    atomic: { tests: [{ id: "TA1.1", behaviors: 1 }] },
    bdd: { scenarios: [{ name: "reloads the record", boundary: "disk", contractCase: "SC1" }] },
    ux: { exercised: true, empty: "checked", error: "absent", viewports: ["desktop", "mobile"] },
    evals: {
      kind: "capability",
      patchId: "patch-1",
      frozen: true,
      accepted: true,
      impermissible: 0,
      overrefusal: 0,
      passAtK: 1,
      trials: 2,
      requiredTrials: 2,
      graders: ["schema", "regex"],
      failureClasses: [],
      modelSpend: 0,
    },
    ...over,
  };
}

describe("built-in testing sub-agents", () => {
  it("TA1.1 a roster that names an unknown discipline or repeats an agent is refused", () => {
    const agents = AGENTS.map((agent) => ({ ...agent }));
    agents[0] = { ...agents[0]!, name: "chaos", title: "Chaos", instructions: "No.", applies: "always" };
    expect(() => parseTestingRoster(document({ agents }))).toThrow(/fuzz/);
    expect(() => parseTestingRoster(document({ agents: [...AGENTS, AGENTS[0]] }))).toThrow(/fuzz/);
    expect(() => parseTestingRoster(document({ fuzzMinTrials: 0 }))).toThrow(/fuzzMinTrials/);
    expect(() => parseTestingRoster(document({ mutationBreak: 90.5 }))).toThrow(/mutationBreak/);
    expect(() => parseTestingRoster(document({ maxCrap: 0 }))).toThrow(/maxCrap/);
  });

  it("TA1.2 a library subject is planned and passed by the six agents that always apply", () => {
    expect(planTesting(roster, library).map((agent) => agent.name)).toEqual(["fuzz", "mutation", "crap", "contract", "atomic", "evals"]);
    const report = reviewTesting(roster, library, evidence());
    expect(report.status).toBe("pass");
    expect(report.verdicts.map((verdict) => verdict.agent)).toEqual(["fuzz", "mutation", "crap", "contract", "atomic", "evals"]);
  });

  it("TA1.3 a user-facing subject with a boundary is planned for all eight agents", () => {
    expect(planTesting(roster, both).map((agent) => agent.name)).toEqual(["fuzz", "mutation", "crap", "contract", "atomic", "evals", "bdd", "ux"]);
    expect(reviewTesting(roster, both, evidence()).status).toBe("pass");
  });

  it("TA1.4 a user-facing subject without a boundary omits the BDD agent", () => {
    const names = planTesting(roster, screen).map((agent) => agent.name);
    expect(names).toContain("ux");
    expect(names).not.toContain("bdd");
    expect(reviewTesting(roster, screen, omit(evidence(), "bdd")).status).toBe("pass");
  });

  it("TA1.5 a boundary without a user-facing surface omits the UX agent", () => {
    const names = planTesting(roster, bordered).map((agent) => agent.name);
    expect(names).toContain("bdd");
    expect(names).not.toContain("ux");
    expect(reviewTesting(roster, bordered, omit(evidence(), "ux")).status).toBe("pass");
  });

  it("TA1.6 fuzz fails without a seed, under the trial floor, or with a counterexample", () => {
    expect(reviewTesting(roster, library, omit(evidence(), "fuzz")).verdicts[0]?.reason).toMatch(/missing/);
    expect(reviewTesting(roster, library, evidence({ fuzz: { trials: 99, seed: "1", counterexample: false } })).verdicts[0]?.reason).toMatch(/99/);
    expect(reviewTesting(roster, library, evidence({ fuzz: { trials: 100, seed: "", counterexample: false } })).verdicts[0]?.reason).toMatch(/seed/);
    expect(reviewTesting(roster, library, evidence({ fuzz: { trials: 100, seed: "1", counterexample: true } })).verdicts[0]?.reason).toMatch(/counterexample/);
    expect(reviewTesting(roster, library, evidence()).verdicts[0]?.status).toBe("pass");
  });

  it("TA1.7 mutation fails under its threshold, and a threshold under the floor fails", () => {
    expect(reviewTesting(roster, library, evidence({ mutation: { score: 89, threshold: 90 } })).verdicts[1]?.reason).toMatch(/89/);
    expect(reviewTesting(roster, library, evidence({ mutation: { score: 100, threshold: 89 } })).verdicts[1]?.reason).toMatch(/floor/);
    expect(reviewTesting(roster, library, evidence({ mutation: { score: 90, threshold: 90 } })).verdicts[1]?.status).toBe("pass");
  });

  it("TA1.8 a unit whose CRAP score is over the bound fails, and a score on the bound passes", () => {
    const over = reviewTesting(roster, library, evidence({ crap: { units: [{ name: "parse", complexity: 6, coverage: 0 }] } }));
    expect(over.verdicts[2]?.reason).toMatch(/42/);
    const onBound = reviewTesting(roster, library, evidence({ crap: { units: [{ name: "parse", complexity: 30, coverage: 1 }] } }));
    expect(onBound.verdicts[2]?.status).toBe("pass");
    expect(reviewTesting(roster, library, evidence({ crap: { units: [] } })).verdicts[2]?.reason).toMatch(/unit/);
  });

  it("TA1.9 a boundary whose contract is missing or has a failing case fails", () => {
    const missing = reviewTesting(roster, bordered, evidence({ contracts: [{ name: "other", cases: [{ id: "X1", passed: true }] }] }));
    expect(missing.status).toBe("fail");
    expect(missing.verdicts.find((verdict) => verdict.agent === "contract")?.reason).toMatch(/storage/);
    const failed = reviewTesting(roster, library, evidence({ contracts: [{ name: "storage", cases: [{ id: "SC1", passed: false }] }] }));
    expect(failed.verdicts.find((verdict) => verdict.agent === "contract")?.reason).toMatch(/SC1/);
  });

  it("TA1.10 an assertion that covers two behaviors fails, and one behavior passes", () => {
    expect(reviewTesting(roster, library, evidence({ atomic: { tests: [{ id: "TA1.1", behaviors: 2 }] } })).verdicts[4]?.reason).toMatch(/2/);
    expect(reviewTesting(roster, library, evidence({ atomic: { tests: [{ id: "not an id", behaviors: 1 }] } })).verdicts[4]?.reason).toMatch(/not an id/);
    expect(reviewTesting(roster, library, evidence({ atomic: { tests: [] } })).verdicts[4]?.reason).toMatch(/test/);
    expect(reviewTesting(roster, library, evidence()).verdicts[4]?.status).toBe("pass");
  });

  it("TA1.11 a boundary needs a scenario that cites one of its passing contract cases", () => {
    const none = reviewTesting(roster, bordered, evidence({ bdd: { scenarios: [] } }));
    expect(none.verdicts.find((verdict) => verdict.agent === "bdd")?.reason).toMatch(/disk/);
    const other = reviewTesting(roster, bordered, evidence({
      bdd: { scenarios: [{ name: "reloads", boundary: "other", contractCase: "SC1" }] },
    }));
    expect(other.verdicts.find((verdict) => verdict.agent === "bdd")?.reason).toMatch(/disk/);
    const dead = reviewTesting(roster, bordered, evidence({
      contracts: [{ name: "storage", cases: [{ id: "SC1", passed: false }] }],
      bdd: { scenarios: [{ name: "reloads", boundary: "disk", contractCase: "SC1" }] },
    }));
    expect(dead.verdicts.find((verdict) => verdict.agent === "bdd")?.reason).toMatch(/SC1/);
  });

  it("TA1.12 UX fails when the surface was not exercised, and a layout change needs both viewports", () => {
    const idle = reviewTesting(roster, screen, evidence({ ux: { exercised: false, empty: "checked", error: "absent", viewports: ["desktop", "mobile"] } }));
    expect(idle.verdicts.find((verdict) => verdict.agent === "ux")?.reason).toMatch(/exercised/);
    const one = reviewTesting(roster, screen, evidence({ ux: { exercised: true, empty: "absent", error: "absent", viewports: ["desktop"] } }));
    expect(one.verdicts.find((verdict) => verdict.agent === "ux")?.reason).toMatch(/viewports/);
    const quiet = reviewTesting(roster, { ...screen, layout: false }, evidence({ ux: { exercised: true, empty: "absent", error: "checked", viewports: [] } }));
    expect(quiet.verdicts.find((verdict) => verdict.agent === "ux")?.status).toBe("pass");
  });

  it("TA1.13 the planned agents spawn as observe nodes, and a parent without the cap spawns none", () => {
    const plan = planTesting(roster, both);
    const grants: Grant[] = ["spawn", "observe", ...plan.map((agent): Grant => `cap:test:${agent.name}`)];
    const tree = new SubagentTree();
    tree.createRoot("root", "agent", grants);
    const spawned = spawnTestingSubagents(tree, "root", plan);
    expect(spawned.ok).toBe(true);
    if (spawned.ok) expect(spawned.value).toEqual(plan.map((agent) => `test-${agent.name}`));
    expect(tree.children("root")).toEqual(plan.map((agent) => `test-${agent.name}`));
    expect(tree.hasGrant("test-ux", "observe")).toBe(true);
    expect(tree.hasGrant("test-ux", "spawn")).toBe(false);
    const bare = new SubagentTree();
    bare.createRoot("root", "agent", ["spawn", "observe"]);
    const refused = spawnTestingSubagents(bare, "root", plan);
    expect(refused.ok).toBe(false);
    expect(bare.children("root")).toEqual([]);
  });

  it("TA1.14 evals accepts one frozen patch with pass@k 1, zero policy rates, and no model spend", () => {
    const verdict = (over: Partial<NonNullable<TestingEvidence["evals"]>>) =>
      reviewTesting(roster, library, evidence({ evals: { ...evidence().evals!, ...over } })).verdicts.find((item) => item.agent === "evals");
    expect(reviewTesting(roster, library, omit(evidence(), "evals")).verdicts.find((item) => item.agent === "evals")?.reason).toMatch(/missing/);
    expect(verdict({ patchId: "" })?.reason).toMatch(/patchId/);
    expect(verdict({ frozen: false })?.reason).toMatch(/frozen/);
    expect(verdict({ trials: 1 })?.reason).toMatch(/trials/);
    expect(verdict({ modelSpend: 1 })?.reason).toMatch(/spend/);
    expect(verdict({ failureClasses: ["panic"] })?.reason).toMatch(/failure class panic/);
    expect(verdict({ graders: ["judge", "schema"] })?.reason).toMatch(/order/);
    expect(verdict({ graders: [] })?.reason).toMatch(/grader/);
    expect(verdict({ graders: ["schema", "schema"] })?.reason).toMatch(/duplicated/);
    expect(verdict({ accepted: false, reason: "train failed" })?.reason).toMatch(/train failed/);
    expect(verdict({ accepted: false })?.reason).toMatch(/not accepted/);
    expect(verdict({ accepted: false, reason: "" })?.reason).toMatch(/not accepted/);
    expect(verdict({ impermissible: 0.5 })?.reason).toMatch(/impermissible/);
    expect(verdict({ overrefusal: 0.25 })?.reason).toMatch(/over-refusal/);
    expect(verdict({ passAtK: 0.5 })?.reason).toMatch(/pass@k/);
    expect(verdict({ impermissible: 2 })?.reason).toMatch(/fraction/);
    expect(verdict({ kind: "nope" as "policy" })?.reason).toMatch(/kind/);
    expect(verdict({ requiredTrials: 0, trials: 0 })?.reason).toMatch(/count/);
    expect(verdict({ graders: [""] })?.reason).toMatch(/empty/);
    expect(verdict({ graders: ["fixture"] })?.status).toBe("pass");
    expect(verdict({ kind: "policy", graders: ["schema", "fixture", "judge"], failureClasses: ["genuine"] })?.status).toBe("pass");
  });
});
