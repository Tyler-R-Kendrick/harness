import { describe, expect, it } from "vitest";
import {
  AnswerSchema,
  CalibratorSchema,
  DecisionMadeSchema,
  OutcomeSchema,
  StateSchema,
  TraceStepSchema,
  CalibrationBookSchema,
  cost,
  DecisionError,
  DecisionIdSchema,
  DecisionRecordSchema,
  DistributionSchema,
  forkId,
  ForkIdSchema,
  ForkPolicySchema,
  PolicySchema,
  RUNGS,
  temperature,
} from "@harness/decision";

const record = {
  id: "dec-0",
  fork: "permission.risk",
  forkVersion: "1",
  at: 5,
  input: { tool: "bash" },
  rung: "model",
  policy: "p1",
  answers: { risk: { type: "boolean", distribution: { true: 0.75, false: 0.25 }, top: "true" } },
  action: "review",
  confidence: 0.75,
  propensity: 1,
  explored: false,
  mode: "active",
  trace: [{ rung: "model", outcome: "0.75" }],
};

describe("decision types", () => {
  it("TYP1.1 fork ids are lower-case words joined by dots or dashes", () => {
    expect(forkId("permission.risk")).toBe("permission.risk");
    expect(forkId("attention-inbox")).toBe("attention-inbox");
    for (const bad of ["", "Permission", "a..b", "a.", ".a", "1a", "a b", "x".repeat(65)]) expect(() => forkId(bad)).toThrow(RangeError);
  });

  it("TYP1.2 decision ids are dec- and a non-negative integer, and nothing else", () => {
    expect(DecisionIdSchema.parse("dec-0")).toBe("dec-0");
    for (const bad of ["dec-", "dec--1", "dec-1.5", "dec-007", "d-1", "dec-x", 3]) expect(DecisionIdSchema.safeParse(bad).success).toBe(false);
  });

  it("TYP1.3 costs are finite and not negative, temperatures finite and positive", () => {
    expect(cost(0)).toBe(0);
    expect(() => cost(-1)).toThrow(RangeError);
    expect(() => cost(Infinity)).toThrow(RangeError);
    expect(temperature(0.5)).toBe(0.5);
    expect(() => temperature(0)).toThrow(RangeError);
    expect(() => temperature(NaN)).toThrow(RangeError);
  });

  it("TYP1.4 a distribution has at least two options and sums to 1", () => {
    expect(DistributionSchema.safeParse({ a: 0.5, b: 0.5 }).success).toBe(true);
    expect(DistributionSchema.safeParse({ a: 1 }).success).toBe(false);
    expect(DistributionSchema.safeParse({ a: 0.5, b: 0.4 }).success).toBe(false);
    expect(DistributionSchema.safeParse({ a: 1.5, b: -0.5 }).success).toBe(false);
    expect(DistributionSchema.safeParse({ a: 0.5, b: 0.5 + 5e-7 }).success).toBe(true);
  });

  it("TYP1.5 an answer names its type and top option, and a score may carry its expected level", () => {
    expect(AnswerSchema.parse({ type: "score", distribution: { "0": 0.25, "1": 0.75 }, top: "1", score: 0.75 }).score).toBe(0.75);
    expect(AnswerSchema.safeParse({ type: "other", distribution: { a: 0.5, b: 0.5 }, top: "a" }).success).toBe(false);
    expect(AnswerSchema.safeParse({ type: "choice", distribution: { a: 0.5, b: 0.5 }, top: "a", extra: 1 }).success).toBe(false);
  });

  it("TYP1.6 a fork's policy cannot verify above the level it acts at", () => {
    const ok = { act: 0.9, verify: 0.5, accept: 0.8, rotate: 1, explore: 0, mode: "active" };
    expect(ForkPolicySchema.safeParse(ok).success).toBe(true);
    expect(ForkPolicySchema.safeParse({ ...ok, verify: 0.95 }).success).toBe(false);
    expect(ForkPolicySchema.safeParse({ ...ok, rotate: 0 }).success).toBe(false);
    expect(ForkPolicySchema.safeParse({ ...ok, mode: "off" }).success).toBe(false);
  });

  it("TYP1.7 a policy overrides parts of the default per fork, and refuses unknown fields and bad fork ids", () => {
    const base = { version: "p1", default: { act: 0.9, verify: 0.5, accept: 0.8, rotate: 1, explore: 0, mode: "active" } };
    expect(PolicySchema.safeParse({ ...base, forks: { "permission.risk": { act: 0.99 } } }).success).toBe(true);
    expect(PolicySchema.safeParse({ ...base, forks: { "permission.risk": { bogus: 1 } } }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...base, forks: { Bad: {} } }).success).toBe(false);
  });

  it("TYP1.8 a decision record round-trips, with an outcome attached later", () => {
    const parsed = DecisionRecordSchema.parse(record);
    expect(DecisionRecordSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    const withOutcome = DecisionRecordSchema.parse({ ...record, outcome: { at: 9, source: "human", kind: "approved", correct: true } });
    expect(withOutcome.outcome?.kind).toBe("approved");
    expect(DecisionRecordSchema.safeParse({ ...record, propensity: 2 }).success).toBe(false);
    expect(DecisionRecordSchema.safeParse({ ...record, surprise: 1 }).success).toBe(false);
  });

  it("TYP1.9 a calibration book keeps entries by fork, member, version and question", () => {
    const entry = {
      fork: "permission.risk",
      member: "m",
      version: "1",
      question: "risk",
      calibrator: { kind: "temperature", temperature: 1.5 },
      fitted: { n: 10, at: 1, eceBefore: 0.2, eceAfter: 0.05, brierBefore: 0.3, brierAfter: 0.2 },
    };
    expect(CalibrationBookSchema.safeParse({ entries: [entry] }).success).toBe(true);
    expect(CalibrationBookSchema.safeParse({ entries: [{ ...entry, calibrator: { kind: "temperature", temperature: 0 } }] }).success).toBe(false);
    expect(CalibrationBookSchema.safeParse({ entries: [{ ...entry, calibrator: { kind: "platt", a: 1, b: 0 } }] }).success).toBe(true);
  });

  it("TYP1.10 the ladder runs cheapest first and errors carry a code", () => {
    expect(RUNGS).toEqual(["rule", "model", "judge", "generator", "human"]);
    const e = new DecisionError("unknown-fork", "no such fork");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("unknown-fork");
    expect(e.name).toBe("DecisionError");
  });

  it("TYP2.1 a fork id, cost and temperature refuse with a message that names what they are", () => {
    expect(() => forkId("Bad")).toThrow(/^RangeError: not a fork id: "Bad"|not a fork id: "Bad"/);
    expect(() => cost(-1)).toThrow(/not a cost: -1/);
    expect(() => temperature(0)).toThrow(/not a temperature: 0/);
  });

  it("TYP2.2b a refused fork id says what a fork id is", () => {
    const r = ForkIdSchema.safeParse("Bad");
    expect(r.success || r.error.issues.map((i) => i.message)).toEqual(["lower-case words joined by dots or dashes"]);
  });

  it("TYP2.2 fork ids allow single words and dotted or dashed groups, not empty groups or edges", () => {
    for (const ok of ["a", "abc", "a1", "a.b", "a-b", "a.b-c.d1", "permission.risk"]) expect(forkId(ok)).toBe(ok);
    for (const bad of ["a-", "-a", "a.-b", "a..b", "a b", "a_b", "A"]) expect(() => forkId(bad)).toThrow();
    expect(forkId("a".repeat(64))).toHaveLength(64);
  });

  it("TYP2.3 decision ids of any size are canonical", () => {
    for (const ok of ["dec-0", "dec-1", "dec-12", "dec-10", "dec-100", "dec-9007199254740991"]) expect(DecisionIdSchema.parse(ok)).toBe(ok);
    expect(DecisionIdSchema.safeParse("dec-007").success).toBe(false);
    const r = DecisionIdSchema.safeParse("dec-007");
    expect(r.success || r.error.issues.map((i) => i.message)).toEqual(["dec- and a whole number with no sign or leading zeros"]);
  });

  it("TYP2.4 a state is a string, a JSON object or a JSON array", () => {
    for (const ok of ["text", "", { a: 1 }, [1, "x", null], {}, []]) expect(StateSchema.safeParse(ok).success).toBe(true);
    for (const bad of [1, null, true, undefined]) expect(StateSchema.safeParse(bad).success).toBe(false);
  });

  it("TYP2.5 a distribution says why it is refused", () => {
    const messages = (d: unknown) => {
      const r = DistributionSchema.safeParse(d);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(messages({ a: 1 })).toContain("a question has at least two options");
    expect(messages({ a: 0.5, b: 0.4 })).toContain("probabilities sum to 1");
  });

  it("TYP2.6 answers are choices, scores or booleans", () => {
    expect(AnswerSchema.shape.type.options).toEqual(["choice", "score", "boolean"]);
    for (const type of ["choice", "score", "boolean"]) expect(AnswerSchema.safeParse({ type, distribution: { a: 0.5, b: 0.5 }, top: "a" }).success).toBe(true);
  });

  it("TYP2.7 calibrators are identity, temperature or platt, and each needs its own fields", () => {
    expect(CalibratorSchema.safeParse({ kind: "identity" }).success).toBe(true);
    expect(CalibratorSchema.safeParse({ kind: "identity", temperature: 1 }).success).toBe(false);
    expect(CalibratorSchema.safeParse({ kind: "temperature" }).success).toBe(false);
    expect(CalibratorSchema.safeParse({ kind: "temperature", temperature: 2 }).success).toBe(true);
    expect(CalibratorSchema.safeParse({ kind: "platt", a: 1 }).success).toBe(false);
    expect(CalibratorSchema.safeParse({ kind: "platt", a: 1, b: Infinity }).success).toBe(false);
    expect(CalibratorSchema.safeParse({ kind: "platt", a: -1, b: 2 }).success).toBe(true);
    expect(CalibratorSchema.safeParse({ kind: "other" }).success).toBe(false);
  });

  it("TYP2.13 each calibrator is parsed to itself, chosen by its kind; no kind, an unknown kind, or another variant's fields do not parse", () => {
    for (const calibrator of [{ kind: "identity" }, { kind: "temperature", temperature: 0.5 }, { kind: "platt", a: -1, b: 2 }]) expect(CalibratorSchema.parse(calibrator)).toEqual(calibrator);
    expect(CalibratorSchema.safeParse({}).success).toBe(false);
    expect(CalibratorSchema.safeParse({ temperature: 2 }).success).toBe(false);
    expect(CalibratorSchema.safeParse({ kind: "temperature", temperature: 0 }).success).toBe(false);
    expect(CalibratorSchema.safeParse({ kind: "temperature", temperature: 2, a: 1 }).success).toBe(false);
    expect(CalibratorSchema.safeParse({ kind: "platt", a: 1, b: 1, temperature: 2 }).success).toBe(false);
    expect(CalibratorSchema.safeParse({ kind: "platt", b: 1 }).success).toBe(false);
    expect(CalibratorSchema.safeParse("identity").success).toBe(false);
  });

  it("TYP2.8 a calibration entry names non-empty members, versions and questions, and bounded scores", () => {
    const entry = { fork: "f", member: "m", version: "v", question: "q", calibrator: { kind: "identity" }, fitted: { n: 0, at: 0, eceBefore: 0, eceAfter: 1, brierBefore: 0, brierAfter: 2 } };
    const ok = (e: object) => CalibrationBookSchema.safeParse({ entries: [e] }).success;
    expect(ok(entry)).toBe(true);
    expect(ok({ ...entry, member: "long member" })).toBe(true);
    expect(ok({ ...entry, version: "1.2.3" })).toBe(true);
    for (const field of ["member", "version", "question"]) expect(ok({ ...entry, [field]: "" })).toBe(false);
    expect(ok({ ...entry, fitted: { ...entry.fitted, eceBefore: 1.1 } })).toBe(false);
    expect(ok({ ...entry, fitted: { ...entry.fitted, brierAfter: 2.1 } })).toBe(false);
    expect(ok({ ...entry, fitted: { ...entry.fitted, n: -1 } })).toBe(false);
  });

  it("TYP2.9 a policy allows verify equal to act, and each field has its own range", () => {
    const base = { act: 0.5, verify: 0.5, accept: 0.5, rotate: 1, explore: 0, mode: "shadow" };
    const bad = (patch: object) => ForkPolicySchema.safeParse({ ...base, ...patch }).success;
    expect(bad({})).toBe(true);
    expect(bad({ rotate: 16 })).toBe(true);
    expect(bad({ rotate: 17 })).toBe(false);
    expect(bad({ rotate: 1.5 })).toBe(false);
    for (const field of ["act", "verify", "accept", "explore"]) {
      expect(bad({ [field]: 1.01 })).toBe(false);
      expect(bad({ [field]: -0.01 })).toBe(false);
    }
    const r = ForkPolicySchema.safeParse({ ...base, verify: 0.9 });
    expect(r.success || r.error.issues.map((i) => i.message)).toEqual(["verify must not be above act"]);
    expect(ForkPolicySchema.shape.mode.options).toEqual(["active", "shadow"]);
  });

  it("TYP2.10 a policy's fork overrides take each field on its own range", () => {
    const base = { version: "p", default: { act: 0.9, verify: 0.5, accept: 0.8, rotate: 1, explore: 0, mode: "active" } };
    const ok = (o: object) => PolicySchema.safeParse({ ...base, forks: { f: o } }).success;
    expect(ok({ mode: "shadow", rotate: 16, explore: 1, accept: 0, verify: 0, act: 1 })).toBe(true);
    for (const o of [{ mode: "off" }, { rotate: 0 }, { rotate: 17 }, { rotate: 1.5 }, { act: 2 }, { verify: -1 }, { accept: 2 }, { explore: 2 }]) expect(ok(o)).toBe(false);
    expect(PolicySchema.safeParse({ ...base, version: "", forks: {} }).success).toBe(false);
  });

  it("TYP2.11 an outcome comes from a known source with a known kind", () => {
    expect(OutcomeSchema.shape.source.options).toEqual(["human", "verifier", "judge", "system"]);
    expect(OutcomeSchema.shape.kind.options).toEqual(["correct", "incorrect", "approved", "denied", "completed", "failed", "rated-good", "rated-bad", "overridden"]);
    expect(OutcomeSchema.safeParse({ at: 1, source: "judge", kind: "rated-bad", label: { a: [1] }, by: "me" }).success).toBe(true);
    expect(OutcomeSchema.safeParse({ at: -1, source: "human", kind: "correct" }).success).toBe(false);
  });

  it("TYP2.12 a record and its announcement carry a mode, and a trace step a rung", () => {
    expect(DecisionMadeSchema.shape.mode.options).toEqual(["active", "shadow"]);
    expect(DecisionRecordSchema.shape.mode.options).toEqual(["active", "shadow"]);
    expect(TraceStepSchema.safeParse({ rung: "model", outcome: "x", member: "m", confidence: 0.5 }).success).toBe(true);
    expect(TraceStepSchema.safeParse({ rung: "oracle", outcome: "x" }).success).toBe(false);
    expect(DecisionMadeSchema.safeParse({ id: "dec-1", fork: "f", rung: "rule", action: null, confidence: 1, mode: "shadow" }).success).toBe(true);
    expect(DecisionMadeSchema.safeParse({ id: "dec-1", fork: "f", rung: "rule", action: null, confidence: 1, mode: "off" }).success).toBe(false);
  });
});
