/**
 * Built-in testing sub-agents. The roster is data. A review plans the agents a
 * subject needs and judges the evidence they require. Evals judges a climb
 * round the host already computed. UX runs only for a user-facing subject.
 * BDD runs only when an integration boundary is named, and each scenario has
 * to cite a passing case of that boundary's contract.
 */

import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { Grant, SubagentTree, TreeError } from "./subagents.ts";

const ORDER = ["fuzz", "mutation", "crap", "contract", "atomic", "evals", "bdd", "ux"] as const;
export type TestingDiscipline = (typeof ORDER)[number];
export type TestingApplies = "always" | "boundary" | "ui";

const APPLIES: Readonly<Record<TestingDiscipline, TestingApplies>> = {
  fuzz: "always",
  mutation: "always",
  crap: "always",
  contract: "always",
  atomic: "always",
  evals: "always",
  bdd: "boundary",
  ux: "ui",
};

/** Names from the eval IR. An unknown grader may sit anywhere; these stay in this order. */
const KNOWN_GRADERS = ["schema", "regex", "files", "tools", "promptfoo", "judge", "foreign"];
const FAILURE_CLASSES = new Set(["refusal", "harness", "timeout", "genuine"]);

export interface TestingAgent {
  readonly name: TestingDiscipline;
  readonly title: string;
  readonly instructions: string;
  readonly applies: TestingApplies;
}

export interface TestingRoster {
  readonly fuzzMinTrials: number;
  readonly mutationBreak: number;
  readonly maxCrap: number;
  readonly agents: readonly TestingAgent[];
}

export interface TestBoundary {
  readonly name: string;
  readonly contract: string;
}

export interface TestSubject {
  readonly name: string;
  readonly boundaries: readonly TestBoundary[];
  readonly ui: boolean;
  readonly layout: boolean;
}

export interface TestingEvidence {
  readonly fuzz?: { readonly trials: number; readonly seed: string; readonly counterexample: boolean };
  readonly mutation?: { readonly score: number; readonly threshold: number };
  readonly crap?: { readonly units: readonly { readonly name: string; readonly complexity: number; readonly coverage: number }[] };
  readonly contracts?: readonly { readonly name: string; readonly cases: readonly { readonly id: string; readonly passed: boolean }[] }[];
  readonly atomic?: { readonly tests: readonly { readonly id: string; readonly behaviors: number }[] };
  readonly bdd?: { readonly scenarios: readonly { readonly name: string; readonly boundary: string; readonly contractCase: string }[] };
  readonly ux?: {
    readonly exercised: boolean;
    readonly empty: "checked" | "absent";
    readonly error: "checked" | "absent";
    readonly viewports: readonly ("desktop" | "mobile")[];
  };
  /** A climb round the host already computed. This agent does not run Promptfoo, Harbor, or ASSERT. */
  readonly evals?: {
    readonly kind: "policy" | "capability";
    readonly patchId: string;
    readonly frozen: boolean;
    readonly accepted: boolean;
    readonly reason?: string;
    readonly impermissible: number;
    readonly overrefusal: number;
    readonly passAtK: number;
    readonly trials: number;
    readonly requiredTrials: number;
    readonly graders: readonly string[];
    readonly failureClasses: readonly string[];
    readonly modelSpend: number;
  };
}

export interface TestingVerdict {
  readonly agent: TestingDiscipline;
  readonly status: "pass" | "fail";
  readonly reason?: string;
}

export interface TestingReport {
  readonly status: "pass" | "fail";
  readonly verdicts: readonly TestingVerdict[];
}

const ASSERTION_ID = /^[A-Z][A-Z0-9]*\d+(?:\.\d+)*$/;

function testCap(name: TestingDiscipline): Grant {
  switch (name) {
    case "fuzz": return "cap:test:fuzz";
    case "mutation": return "cap:test:mutation";
    case "crap": return "cap:test:crap";
    case "contract": return "cap:test:contract";
    case "atomic": return "cap:test:atomic";
    case "evals": return "cap:test:evals";
    case "bdd": return "cap:test:bdd";
    case "ux": return "cap:test:ux";
  }
}
const ROOT_KEYS = new Set(["$schema", "fuzzMinTrials", "mutationBreak", "maxCrap", "agents"]);
const AGENT_KEYS = new Set(["name", "title", "instructions", "applies"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function integer(value: unknown, name: string, min: number, max?: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new TypeError(`${name} must be an integer`);
  }
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a string`);
  return value;
}

function unknownKey(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`${label} has unexpected ${key}`);
  }
}

function parseAgent(value: unknown, name: TestingDiscipline): TestingAgent {
  if (!isRecord(value)) throw new TypeError(`agent ${name} must be an object`);
  unknownKey(value, AGENT_KEYS, `agent ${name}`);
  if (field(value, "name") !== name) throw new TypeError(`agent ${name} is missing`);
  const applies = APPLIES[name];
  if (field(value, "applies") !== applies) throw new TypeError(`agent ${name} applies to ${applies}`);
  return {
    name,
    title: text(field(value, "title"), `${name} title`),
    instructions: text(field(value, "instructions"), `${name} instructions`),
    applies,
  };
}

/** Parse the testing-subagent roster. The eight agents and where each applies are fixed. */
export function parseTestingRoster(input: unknown): TestingRoster {
  if (!isRecord(input)) throw new TypeError("testing roster must be an object");
  unknownKey(input, ROOT_KEYS, "testing roster");
  const listed = field(input, "agents");
  if (!Array.isArray(listed) || listed.length !== ORDER.length) {
    throw new TypeError("agents must be fuzz, mutation, crap, contract, atomic, evals, bdd, ux");
  }
  return {
    fuzzMinTrials: integer(field(input, "fuzzMinTrials"), "fuzzMinTrials", 1),
    mutationBreak: integer(field(input, "mutationBreak"), "mutationBreak", 0, 100),
    maxCrap: integer(field(input, "maxCrap"), "maxCrap", 1),
    agents: ORDER.map((name, index) => parseAgent(listed[index], name)),
  };
}

function boundary(value: unknown): TestBoundary {
  if (!isRecord(value)) throw new TypeError("a boundary needs a name and a contract");
  return { name: text(field(value, "name"), "boundary name"), contract: text(field(value, "contract"), "boundary contract") };
}

function subjectOf(subject: TestSubject): TestSubject {
  if (typeof subject.name !== "string" || subject.name.length === 0) throw new TypeError("subject name must be a string");
  if (!Array.isArray(subject.boundaries)) throw new TypeError("subject boundaries must be an array");
  if (typeof subject.ui !== "boolean" || typeof subject.layout !== "boolean") throw new TypeError("subject ui and layout must be booleans");
  if (subject.layout && !subject.ui) throw new TypeError("layout applies to a ui subject");
  const boundaries = subject.boundaries.map(boundary);
  const names = new Set<string>();
  for (const item of boundaries) {
    if (names.has(item.name)) throw new TypeError(`boundary ${item.name} is duplicated`);
    names.add(item.name);
  }
  return { name: subject.name, boundaries, ui: subject.ui, layout: subject.layout };
}

/** The agents that apply to this subject, in roster order. */
export function planTesting(roster: TestingRoster, subject: TestSubject): readonly TestingAgent[] {
  const checked = subjectOf(subject);
  return roster.agents.filter((agent) => {
    if (agent.applies === "always") return true;
    if (agent.applies === "boundary") return checked.boundaries.length > 0;
    return checked.ui;
  });
}

function pass(agent: TestingDiscipline): TestingVerdict {
  return { agent, status: "pass" };
}

function fail(agent: TestingDiscipline, reason: string): TestingVerdict {
  return { agent, status: "fail", reason };
}

function percentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** CRAP = complexity² × (1 − coverage)³ + complexity. Coverage is a fraction from 0 to 1. */
export function crapScore(complexity: number, coverage: number): number {
  const missed = 1 - coverage;
  return complexity * complexity * missed * missed * missed + complexity;
}

function judgeFuzz(roster: TestingRoster, evidence: TestingEvidence): TestingVerdict {
  const fuzz = evidence.fuzz;
  if (fuzz === undefined) return fail("fuzz", "fuzz evidence is missing");
  if (!Number.isInteger(fuzz.trials) || fuzz.trials < roster.fuzzMinTrials) {
    return fail("fuzz", `fuzz trials ${fuzz.trials} are below the floor ${roster.fuzzMinTrials}`);
  }
  if (fuzz.seed.length === 0) return fail("fuzz", "fuzz needs a seed");
  if (fuzz.counterexample) return fail("fuzz", "fuzz found a counterexample");
  return pass("fuzz");
}

function judgeMutation(roster: TestingRoster, evidence: TestingEvidence): TestingVerdict {
  const mutation = evidence.mutation;
  if (mutation === undefined) return fail("mutation", "mutation evidence is missing");
  if (!percentage(mutation.score) || !percentage(mutation.threshold)) return fail("mutation", "mutation score is not a percentage");
  if (mutation.threshold < roster.mutationBreak) {
    return fail("mutation", `mutation threshold ${mutation.threshold} is below the floor ${roster.mutationBreak}`);
  }
  if (mutation.score < mutation.threshold) {
    return fail("mutation", `mutation score ${mutation.score} is below the threshold ${mutation.threshold}`);
  }
  return pass("mutation");
}

function judgeCrap(roster: TestingRoster, evidence: TestingEvidence): TestingVerdict {
  const units = evidence.crap?.units;
  if (units === undefined || units.length === 0) return fail("crap", "crap needs a unit");
  for (const unit of units) {
    if (!Number.isInteger(unit.complexity) || unit.complexity < 1) {
      return fail("crap", `crap unit ${unit.name} has complexity ${unit.complexity}`);
    }
    if (typeof unit.coverage !== "number" || unit.coverage < 0 || unit.coverage > 1) {
      return fail("crap", `crap unit ${unit.name} has coverage ${unit.coverage}`);
    }
    const score = crapScore(unit.complexity, unit.coverage);
    if (score > roster.maxCrap) return fail("crap", `crap unit ${unit.name} scores ${score} above the bound ${roster.maxCrap}`);
  }
  return pass("crap");
}

function judgeContract(subject: TestSubject, evidence: TestingEvidence): TestingVerdict {
  const contracts = evidence.contracts;
  if (contracts === undefined || contracts.length === 0) return fail("contract", "contract evidence is missing");
  const byName = new Map<string, (typeof contracts)[number]>();
  for (const contract of contracts) {
    if (contract.cases.length === 0) return fail("contract", `contract ${contract.name} has no cases`);
    for (const item of contract.cases) {
      if (!item.passed) return fail("contract", `contract case ${item.id} failed`);
    }
    byName.set(contract.name, contract);
  }
  for (const item of subject.boundaries) {
    if (!byName.has(item.contract)) return fail("contract", `boundary ${item.name} has no contract ${item.contract}`);
  }
  return pass("contract");
}

function judgeAtomic(evidence: TestingEvidence): TestingVerdict {
  const tests = evidence.atomic?.tests;
  if (tests === undefined || tests.length === 0) return fail("atomic", "atomic needs a test");
  for (const test of tests) {
    if (!ASSERTION_ID.test(test.id)) return fail("atomic", `test id ${test.id} is not an assertion id`);
    if (test.behaviors !== 1) return fail("atomic", `test ${test.id} covers ${test.behaviors} behaviors`);
  }
  return pass("atomic");
}

function judgeBdd(subject: TestSubject, evidence: TestingEvidence): TestingVerdict {
  const scenarios = evidence.bdd?.scenarios;
  if (scenarios === undefined) return fail("bdd", "bdd evidence is missing");
  for (const item of subject.boundaries) {
    const cited = scenarios.filter((scenario) => scenario.boundary === item.name);
    if (cited.length === 0) return fail("bdd", `boundary ${item.name} has no scenario`);
    const contract = evidence.contracts?.find((candidate) => candidate.name === item.contract);
    for (const scenario of cited) {
      const found = contract?.cases.find((itemCase) => itemCase.id === scenario.contractCase && itemCase.passed);
      if (found === undefined) {
        return fail("bdd", `scenario ${scenario.name} cites contract case ${scenario.contractCase} which did not pass`);
      }
    }
  }
  return pass("bdd");
}

function judgeUx(subject: TestSubject, evidence: TestingEvidence): TestingVerdict {
  const ux = evidence.ux;
  if (ux === undefined) return fail("ux", "ux evidence is missing");
  if (!ux.exercised) return fail("ux", "the surface was not exercised");
  if (ux.empty !== "checked" && ux.empty !== "absent") return fail("ux", "ux empty state was not checked");
  if (ux.error !== "checked" && ux.error !== "absent") return fail("ux", "ux error state was not checked");
  if (subject.layout) {
    const ports = new Set(ux.viewports);
    if (!ports.has("desktop") || !ports.has("mobile")) return fail("ux", "ux needs both viewports");
  }
  return pass("ux");
}

function fraction(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * The host supplies a climb round. Known graders stay in the default order.
 * A grader this core does not know is allowed, so a new scorer does not need a core change.
 */
function judgeEvals(evidence: TestingEvidence): TestingVerdict {
  const evals = evidence.evals;
  if (evals === undefined) return fail("evals", "evals evidence is missing");
  if (evals.kind !== "policy" && evals.kind !== "capability") return fail("evals", "evals kind is missing");
  if (evals.patchId.length === 0) return fail("evals", "patchId is empty");
  if (!evals.frozen) return fail("evals", "split is not frozen");
  if (!Number.isInteger(evals.trials) || !Number.isInteger(evals.requiredTrials) || evals.requiredTrials < 1) {
    return fail("evals", "evals trials are not a count");
  }
  if (evals.trials < evals.requiredTrials) {
    return fail("evals", `evals recorded ${evals.trials} trials and needs ${evals.requiredTrials}`);
  }
  if (typeof evals.modelSpend !== "number" || evals.modelSpend !== 0) return fail("evals", "evals model spend is not zero");
  for (const name of evals.failureClasses) {
    if (!FAILURE_CLASSES.has(name)) return fail("evals", `failure class ${name}`);
  }
  if (evals.graders.length === 0) return fail("evals", "evals needs a grader");
  const seen = new Set<string>();
  let last = -1;
  for (const name of evals.graders) {
    if (name.length === 0) return fail("evals", "evals grader name is empty");
    if (seen.has(name)) return fail("evals", `evals grader ${name} is duplicated`);
    seen.add(name);
    const index = KNOWN_GRADERS.indexOf(name);
    if (index === -1) continue;
    if (index < last) return fail("evals", `evals grader ${name} is out of order`);
    last = index;
  }
  if (!fraction(evals.impermissible) || !fraction(evals.overrefusal) || !fraction(evals.passAtK)) {
    return fail("evals", "evals rate is not a fraction");
  }
  if (!evals.accepted) {
    const reason = evals.reason;
    return fail("evals", reason === undefined || reason.length === 0 ? "evals climb was not accepted" : `evals climb was not accepted: ${reason}`);
  }
  if (evals.impermissible !== 0) return fail("evals", "impermissible");
  if (evals.overrefusal !== 0) return fail("evals", "over-refusal");
  if (evals.passAtK !== 1) return fail("evals", "pass@k");
  return pass("evals");
}

function judge(roster: TestingRoster, subject: TestSubject, evidence: TestingEvidence, agent: TestingAgent): TestingVerdict {
  if (agent.name === "fuzz") return judgeFuzz(roster, evidence);
  if (agent.name === "mutation") return judgeMutation(roster, evidence);
  if (agent.name === "crap") return judgeCrap(roster, evidence);
  if (agent.name === "contract") return judgeContract(subject, evidence);
  if (agent.name === "atomic") return judgeAtomic(evidence);
  if (agent.name === "evals") return judgeEvals(evidence);
  if (agent.name === "bdd") return judgeBdd(subject, evidence);
  return judgeUx(subject, evidence);
}

function chosenAgents(planned: readonly TestingAgent[], selection: readonly string[]): readonly TestingAgent[] {
  if (selection.length === 0) throw new TypeError("testing selection is empty");
  const byName = new Map<string, TestingAgent>();
  for (const agent of planned) byName.set(agent.name, agent);
  const seen = new Set<string>();
  const agents: TestingAgent[] = [];
  for (const name of selection) {
    if (seen.has(name)) throw new TypeError(`testing agent ${name} is duplicated`);
    seen.add(name);
    const agent = byName.get(name);
    if (agent === undefined) throw new TypeError(`testing agent ${name} does not apply`);
    agents.push(agent);
  }
  return agents;
}

/** Judge the planned agents, or a selection of them. One failure fails the review. */
export function reviewTesting(
  roster: TestingRoster,
  subject: TestSubject,
  evidence: TestingEvidence,
  selection?: readonly string[],
): TestingReport {
  const checked = subjectOf(subject);
  const planned = planTesting(roster, checked);
  const agents = selection === undefined ? planned : chosenAgents(planned, selection);
  const verdicts = agents.map((agent) => judge(roster, checked, evidence, agent));
  return { status: verdicts.every((verdict) => verdict.status === "pass") ? "pass" : "fail", verdicts };
}

/** Spawn one observe node per planned agent. The parent must already hold each `cap:test:<name>` grant. */
export function spawnTestingSubagents(
  tree: SubagentTree,
  parentId: string,
  plan: readonly TestingAgent[],
): Result<readonly string[], TreeError> {
  if (tree.get(parentId) === undefined) return err("unknown_node", `no node ${parentId}`);
  if (!tree.hasGrant(parentId, "spawn")) return err("not_permitted", `${parentId} lacks the spawn grant`);
  if (!tree.hasGrant(parentId, "observe")) return err("grant_not_held", `${parentId} does not hold observe`);
  const caps = plan.map((agent) => testCap(agent.name));
  for (const cap of caps) {
    if (!tree.hasGrant(parentId, cap)) return err("grant_not_held", `${parentId} does not hold ${cap}`);
  }
  for (const agent of plan) {
    if (tree.get(`test-${agent.name}`) !== undefined) return err("duplicate_node", `node test-${agent.name} already exists`);
  }
  const ids: string[] = [];
  for (const agent of plan) {
    const id = `test-${agent.name}`;
    const spawned = tree.spawn(parentId, id, "agent", ["observe", testCap(agent.name)]);
    if (!spawned.ok) return spawned;
    ids.push(id);
  }
  return ok(ids);
}
