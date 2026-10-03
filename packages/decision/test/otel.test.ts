import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { toSpan } from "../src/otel.ts";
import type { DecisionRecord, Outcome } from "../src/types.ts";
import { forkId } from "../src/types.ts";

const p = probability;

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "dec-7",
    fork: forkId("permission.risk"),
    forkVersion: "f2",
    at: 1_700_000_000_123,
    session: "ses-1",
    correlation: "saga-42",
    input: { tool: "bash" },
    rung: "model",
    member: "risk-model",
    memberVersion: "2026-09",
    policy: "policy-1",
    answers: {},
    action: { verdict: "escalate", b: 1, a: [2] },
    confidence: p(0.93),
    propensity: p(0.75),
    explored: true,
    mode: "shadow",
    trace: [
      { rung: "model", member: "risk-model", outcome: "accepted", confidence: p(0.93) },
      { rung: "human", outcome: "a person is asked" },
    ],
    ...overrides,
  };
}

const outcome = (overrides: Partial<Outcome> = {}): Outcome => ({ at: 1_700_000_005_000, source: "human", kind: "approved", ...overrides });

describe("toSpan: identity and time", () => {
  it("OTL1.1 the span is named for the fork and linked by the decision id and the correlation", () => {
    const span = toSpan(record());
    expect(span.name).toBe("decision permission.risk");
    expect(span.spanId).toBe("dec-7");
    expect(span.traceId).toBe("saga-42");
    expect(span.kind).toBe("internal");
  });

  it("OTL1.2 without a correlation the trace id is the decision id: nothing is invented", () => {
    const { correlation: _drop, ...bare } = record();
    expect(toSpan(bare).traceId).toBe("dec-7");
  });

  it("OTL1.3 the span starts and ends when the decision was recorded, in nanoseconds as text", () => {
    const span = toSpan(record());
    expect(span.startTimeUnixNano).toBe("1700000000123000000");
    expect(span.endTimeUnixNano).toBe("1700000000123000000");
    expect(toSpan(record({ at: 0 })).startTimeUnixNano).toBe("0");
  });
});

describe("toSpan: attributes", () => {
  it("OTL2.1 the GenAI conventions name the operation and the model that answered", () => {
    const a = toSpan(record()).attributes;
    expect(a["gen_ai.operation.name"]).toBe("decision");
    expect(a["gen_ai.request.model"]).toBe("risk-model");
    expect(a["gen_ai.response.model"]).toBe("risk-model@2026-09");
    expect(a).not.toHaveProperty("gen_ai.agent.name");
  });

  it("OTL2.2 a decision no model made has no model attributes", () => {
    const { member: _m, memberVersion: _v, ...ruled } = record({ rung: "rule" });
    const a = toSpan(ruled).attributes;
    expect(a).not.toHaveProperty("gen_ai.request.model");
    expect(a).not.toHaveProperty("gen_ai.response.model");
    expect(a).not.toHaveProperty("harness.decision.member_version");
    expect(a["gen_ai.operation.name"]).toBe("decision");
  });

  it("OTL2.3 a member without a version is the response model as it is, and a version without a member is kept as its own attribute", () => {
    const { memberVersion: _v, ...noVersion } = record();
    expect(toSpan(noVersion).attributes["gen_ai.response.model"]).toBe("risk-model");
    const { member: _m, ...noMember } = record();
    const a = toSpan(noMember).attributes;
    expect(a).not.toHaveProperty("gen_ai.response.model");
    expect(a["harness.decision.member_version"]).toBe("2026-09");
  });

  it("OTL2.4 the harness attributes carry the decision", () => {
    const a = toSpan(record()).attributes;
    expect(a).toMatchObject({
      "harness.decision.id": "dec-7",
      "harness.decision.fork": "permission.risk",
      "harness.decision.fork_version": "f2",
      "harness.decision.rung": "model",
      "harness.decision.confidence": 0.93,
      "harness.decision.propensity": 0.75,
      "harness.decision.explored": true,
      "harness.decision.mode": "shadow",
      "harness.decision.policy": "policy-1",
      "harness.decision.member_version": "2026-09",
      "harness.decision.session": "ses-1",
      "harness.decision.correlation": "saga-42",
    });
  });

  it("OTL2.5 the action is a JSON string whatever the order its keys were written in", () => {
    const one = toSpan(record()).attributes["harness.decision.action"];
    const other = toSpan(record({ action: { a: [2], b: 1, verdict: "escalate" } })).attributes["harness.decision.action"];
    expect(one).toBe('{"a":[2],"b":1,"verdict":"escalate"}');
    expect(other).toBe(one);
    expect(toSpan(record({ action: "allow" })).attributes["harness.decision.action"]).toBe('"allow"');
  });

  it("OTL2.6 session and correlation are attributes only when the decision had them", () => {
    const { session: _s, correlation: _c, ...bare } = record();
    const a = toSpan(bare).attributes;
    expect(a).not.toHaveProperty("harness.decision.session");
    expect(a).not.toHaveProperty("harness.decision.correlation");
  });

  it("OTL2.7 every attribute value is a string, a number or a boolean", () => {
    for (const r of [record(), record({ outcome: outcome({ correct: true }) })]) {
      const span = toSpan(r);
      for (const value of [...Object.values(span.attributes), ...span.events.flatMap((e) => Object.values(e.attributes))]) expect(["string", "number", "boolean"]).toContain(typeof value);
    }
  });

  it("OTL2.8 the outcome's kind, source and correctness are attributes when there is an outcome", () => {
    const a = toSpan(record({ outcome: outcome({ correct: false, kind: "denied" }) })).attributes;
    expect(a).toMatchObject({ "harness.decision.outcome.kind": "denied", "harness.decision.outcome.source": "human", "harness.decision.outcome.correct": false });
    const b = toSpan(record({ outcome: outcome() })).attributes;
    expect(b).not.toHaveProperty("harness.decision.outcome.correct");
    expect(toSpan(record()).attributes).not.toHaveProperty("harness.decision.outcome.kind");
  });
});

describe("toSpan: events and status", () => {
  it("OTL3.1 each trace step is an event at the decision's time, in order", () => {
    const span = toSpan(record());
    expect(span.events).toEqual([
      {
        name: "harness.decision.step",
        timeUnixNano: "1700000000123000000",
        attributes: { "harness.step.rung": "model", "harness.step.member": "risk-model", "harness.step.outcome": "accepted", "harness.step.confidence": 0.93 },
      },
      { name: "harness.decision.step", timeUnixNano: "1700000000123000000", attributes: { "harness.step.rung": "human", "harness.step.outcome": "a person is asked" } },
    ]);
  });

  it("OTL3.2 an outcome is a last event at its own time", () => {
    const span = toSpan(record({ outcome: outcome({ by: "alice", correct: true }) }));
    expect(span.events.at(-1)).toEqual({
      name: "harness.decision.outcome",
      timeUnixNano: "1700000005000000000",
      attributes: { "harness.outcome.kind": "approved", "harness.outcome.source": "human", "harness.outcome.correct": true, "harness.outcome.by": "alice" },
    });
    expect(span.events).toHaveLength(3);
  });

  it("OTL3.3 an outcome event leaves out what the outcome did not say", () => {
    const span = toSpan(record({ outcome: outcome() }));
    expect(Object.keys(span.events.at(-1)!.attributes)).toEqual(["harness.outcome.kind", "harness.outcome.source"]);
  });

  it("OTL3.4 a decision with no outcome is ok", () => {
    expect(toSpan(record()).status).toEqual({ code: "ok" });
  });

  it("OTL3.5 an incorrect or failed outcome, or one that says it was not correct, is an error naming the kind", () => {
    for (const o of [outcome({ kind: "incorrect" }), outcome({ kind: "failed" }), outcome({ kind: "approved", correct: false })]) {
      expect(toSpan(record({ outcome: o })).status).toEqual({ code: "error", message: `outcome ${o.kind}` });
    }
  });

  it("OTL3.6 other outcomes are ok, denials and overrides included", () => {
    for (const kind of ["correct", "approved", "denied", "completed", "rated-good", "rated-bad", "overridden"] as const) {
      expect(toSpan(record({ outcome: outcome({ kind }) })).status).toEqual({ code: "ok" });
    }
    expect(toSpan(record({ outcome: outcome({ kind: "denied", correct: true }) })).status).toEqual({ code: "ok" });
  });

  it("OTL3.7 the same record always gives the same span", () => {
    const r = record({ outcome: outcome() });
    expect(toSpan(r)).toEqual(toSpan(r));
    expect(toSpan(r)).not.toBe(toSpan(r));
  });
});
