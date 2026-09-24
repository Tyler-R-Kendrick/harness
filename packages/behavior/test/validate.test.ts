import { describe, expect, it } from "vitest";
import { validateGraph } from "@harness/behavior";
import type { BehaviorGraph } from "@harness/behavior";
import { guide } from "./fixtures.ts";

const problems = (g: BehaviorGraph) => {
  const r = validateGraph(g);
  return r.ok ? [] : r.problems;
};
const edit = (patch: (g: BehaviorGraph & Record<string, unknown>) => void): BehaviorGraph => {
  const g = structuredClone(guide) as BehaviorGraph & Record<string, unknown>;
  patch(g);
  return g;
};

describe("behavior graph validation", () => {
  it("BV1.1 the example graph is valid", () => {
    expect(validateGraph(guide)).toEqual({ ok: true });
  });

  it("BV1.2 the initial state, parents and transition ends must exist, and parents must not loop", () => {
    expect(problems(edit((g) => ((g as { initial: string }).initial = "asleep")))).toContainEqual(expect.stringMatching(/initial state asleep/));
    expect(problems(edit((g) => ((g.states as Record<string, unknown>)["x"] = { parent: "nope" })))).toContainEqual(expect.stringMatching(/parent nope/));
    expect(
      problems(
        edit((g) => {
          (g.states as Record<string, unknown>)["a"] = { parent: "b" };
          (g.states as Record<string, unknown>)["b"] = { parent: "a" };
        }),
      ),
    ).toContainEqual(expect.stringMatching(/parent cycle/));
    expect(problems(edit((g) => (g as unknown as { transitions: unknown[] }).transitions.push({ from: "calm", to: "nowhere", when: { event: "x" } })))).toContainEqual(expect.stringMatching(/nowhere/));
    expect(problems(edit((g) => (g as unknown as { transitions: unknown[] }).transitions.push({ from: "ghost", to: "calm", when: { event: "x" } })))).toContainEqual(expect.stringMatching(/ghost/));
  });

  it("BV1.3 sensors need a known feature and a hysteresis gap (on above off)", () => {
    expect(problems(edit((g) => ((g.sensors as Record<string, unknown>)["s"] = { feature: "unknown", on: 2, off: 1 })))).toContainEqual(expect.stringMatching(/feature unknown/));
    expect(problems(edit((g) => ((g.sensors as Record<string, unknown>)["s"] = { feature: "threat", on: 1, off: 1 })))).toContainEqual(expect.stringMatching(/on must be greater than off/));
    expect(problems(edit((g) => ((g.sensors as Record<string, unknown>)["s"] = { feature: "threat", on: 2, off: 1, hold: 0.5 })))).toContainEqual(expect.stringMatching(/hold/));
  });

  it("BV1.4 triggers must name a known sensor, a positive token count, or an event", () => {
    const withTrigger = (when: unknown) => edit((g) => (g as unknown as { transitions: unknown[] }).transitions.push({ from: "calm", to: "guarded", when }));
    expect(problems(withTrigger({ sensor: "missing", is: "on" }))).toContainEqual(expect.stringMatching(/sensor missing/));
    expect(problems(withTrigger({ sensor: "threat", is: "maybe" }))).toContainEqual(expect.stringMatching(/on or off/));
    expect(problems(withTrigger({ after: 0 }))).toContainEqual(expect.stringMatching(/after/));
    expect(problems(withTrigger({ event: "" }))).toContainEqual(expect.stringMatching(/event/));
    expect(problems(withTrigger({ nonsense: true }))).toContainEqual(expect.stringMatching(/trigger/));
  });

  it("BV1.5 steering uses known features within the strength bound", () => {
    expect(problems(edit((g) => ((g.states as Record<string, { steer?: unknown }>)["calm"]!.steer = { mystery: 1 })))).toContainEqual(expect.stringMatching(/feature mystery/));
    expect(problems(edit((g) => ((g.states as Record<string, { steer?: unknown }>)["calm"]!.steer = { warmth: 9 })))).toContainEqual(expect.stringMatching(/strength 9.*8/));
    expect(problems(edit((g) => ((g.states as Record<string, { steer?: unknown }>)["calm"]!.steer = { warmth: Number.NaN })))).toContainEqual(expect.stringMatching(/strength/));
    expect(problems(edit((g) => ((g as { maxStrength?: number }).maxStrength = 10, ((g.states as Record<string, { steer?: unknown }>)["calm"]!.steer = { warmth: 9 }))))).toEqual([]);
  });

  it("BV1.6 feature indexes are distinct non-negative integers", () => {
    expect(problems(edit((g) => ((g as { features: Record<string, number> }).features["dup"] = 0)))).toContainEqual(expect.stringMatching(/index 0/));
    expect(problems(edit((g) => ((g as { features: Record<string, number> }).features["neg"] = -1)))).toContainEqual(expect.stringMatching(/neg/));
  });

  it("BV1.7 every state must be reachable from the initial state", () => {
    expect(problems(edit((g) => ((g.states as Record<string, unknown>)["island"] = {})))).toContainEqual(expect.stringMatching(/island is unreachable/));
    // Reaching a parent's transition counts for its children: curious inherits calm's "reset"-free edges.
    expect(validateGraph(guide).ok).toBe(true);
  });

  it("BV1.8 the version, id and model layer are checked; a non-object is refused", () => {
    expect(problems(edit((g) => ((g as { version: number }).version = 2)))).toContainEqual(expect.stringMatching(/version/));
    expect(problems(edit((g) => ((g as { id: string }).id = "")))).toContainEqual(expect.stringMatching(/id/));
    expect(problems(edit((g) => ((g as { model: { layer: number } }).model.layer = -1)))).toContainEqual(expect.stringMatching(/layer/));
    expect(validateGraph("nope" as unknown as BehaviorGraph)).toEqual({ ok: false, problems: [expect.stringMatching(/object/)] });
  });
});
