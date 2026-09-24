import { describe, expect, it } from "vitest";
import { defineGraph, parseGraph } from "@harness/behavior";
import { guide, guideSpec } from "./fixtures.ts";

type Draft = Record<string, unknown> & { states: Record<string, unknown>; sensors: Record<string, unknown>; features: Record<string, unknown>; transitions: unknown[] };
/** The guide as untrusted JSON, edited; parsing it either returns a graph or says every problem. */
const refuses = (patch: (g: Draft) => void) => {
  const g = structuredClone(guideSpec) as unknown as Draft;
  patch(g);
  return expect(() => parseGraph(g));
};

describe("behavior graph parsing", () => {
  it("BV1.1 the example graph parses, and a parsed graph is what the rest of the package takes", () => {
    expect(parseGraph(structuredClone(guideSpec))).toEqual(guide);
    expect(Object.isFrozen(guide.states)).toBe(true);
  });

  it("BV1.2 the initial state, parents and transition ends must exist, and parents must not loop", () => {
    refuses((g) => (g["initial"] = "asleep")).toThrow(/initial state asleep is not defined/);
    refuses((g) => (g.states["x"] = { parent: "nope" })).toThrow(/state x has parent nope, which is not defined/);
    refuses((g) => {
      g.states["a"] = { parent: "b" };
      g.states["b"] = { parent: "a" };
    }).toThrow(/state a is in a parent cycle/);
    refuses((g) => g.transitions.push({ from: "calm", to: "nowhere", when: { event: "x" } })).toThrow(/transition 5 goes to nowhere/);
    refuses((g) => g.transitions.push({ from: "ghost", to: "calm", when: { event: "x" } })).toThrow(/transition 5 starts at ghost/);
  });

  it("BV1.3 sensors need a known feature, a hysteresis gap (on above off) and a whole-token hold", () => {
    refuses((g) => (g.sensors["s"] = { feature: "unknown", on: 2, off: 1 })).toThrow(/sensor s reads feature unknown/);
    refuses((g) => (g.sensors["s"] = { feature: "threat", on: 1, off: 1 })).toThrow(/on must be greater than off[\s\S]*sensors\.s/);
    for (const hold of [0, 0.5]) refuses((g) => (g.sensors["s"] = { feature: "threat", on: 2, off: 1, hold })).toThrow(/at sensors\.s\.hold/);
    for (const bad of [{ feature: "threat", on: Number.NaN, off: 1 }, { feature: "threat", on: 2, off: Number.POSITIVE_INFINITY }]) refuses((g) => (g.sensors["s"] = bad)).toThrow(/at sensors\.s\.o(n|ff)/);
  });

  it("BV1.4 a trigger is a known sensor with on or off, an event name, or a positive token count", () => {
    const withTrigger = (when: unknown) => refuses((g) => g.transitions.push({ from: "calm", to: "guarded", when }));
    withTrigger({ sensor: "missing", is: "on" }).toThrow(/transition 5: sensor missing is not defined/);
    withTrigger({ sensor: 5, is: "on" }).toThrow(/at transitions\[5\]\.when/);
    withTrigger({ sensor: "threat", is: "maybe" }).toThrow(/at transitions\[5\]\.when/);
    withTrigger({ after: 0 }).toThrow(/at transitions\[5\]\.when/);
    withTrigger({ event: "" }).toThrow(/at transitions\[5\]\.when/);
    withTrigger({ nonsense: true }).toThrow(/at transitions\[5\]\.when/);
    withTrigger(5).toThrow(/at transitions\[5\]\.when/);
  });

  it("BV1.5 steering uses known features within the strength bound, which the graph may raise", () => {
    refuses((g) => ((g.states["calm"] as { steer: unknown }).steer = { mystery: 1 })).toThrow(/state calm steers with feature mystery/);
    refuses((g) => ((g.states["calm"] as { steer: unknown }).steer = { warmth: 9 })).toThrow(/strength 9 for warmth must be within ±8/);
    refuses((g) => ((g.states["calm"] as { steer: unknown }).steer = { warmth: Number.NaN })).toThrow(/at states\.calm\.steer\.warmth/);
    for (const warmth of [8, -8]) refuses((g) => ((g.states["calm"] as { steer: unknown }).steer = { warmth })).not.toThrow();
    refuses((g) => ((g["maxStrength"] = 10), ((g.states["calm"] as { steer: unknown }).steer = { warmth: 9 }))).not.toThrow();
  });

  it("BV1.6 feature indexes are distinct non-negative integers", () => {
    refuses((g) => (g.features["dup"] = 0)).toThrow(/features threat and dup share index 0/);
    refuses((g) => (g.features["neg"] = -1)).toThrow(/at features\.neg/);
  });

  it("BV1.7 every state must be reachable from the initial state, following transitions in any order", () => {
    refuses((g) => (g.states["island"] = {})).toThrow(/state island is unreachable from calm/);
    const chain = (transitions: unknown[]) => () =>
      parseGraph({ version: 1, id: "c", model: { id: "m", layer: 0 }, initial: "a", features: {}, sensors: {}, states: { a: {}, b: {}, c: {} }, transitions });
    const go = (from: string, to: string) => ({ from, to, when: { event: "x" } });
    expect(chain([go("b", "c"), go("a", "b")])).not.toThrow();
    expect(chain([go("a", "b")])).toThrow(/state c is unreachable/);
    expect(chain([go("c", "b")])).toThrow(/state b is unreachable[\s\S]*state c is unreachable/);
  });

  it("BV1.8 the envelope is exact: version, id, model layer, known keys, objects all the way down", () => {
    refuses((g) => (g["version"] = 2)).toThrow(/at version/);
    for (const id of ["", 5]) refuses((g) => (g["id"] = id)).toThrow(/at id/);
    refuses((g) => delete g["model"]).toThrow(/at model/);
    for (const layer of [-1, 1.5]) refuses((g) => ((g["model"] as { layer: number }).layer = layer)).toThrow(/at model\.layer/);
    refuses((g) => (g["wen"] = "typo")).toThrow(/wen/);
    refuses((g) => ((g as Record<string, unknown>)["transitions"] = "none")).toThrow(/at transitions/);
    for (const input of [null, [], "nope"]) expect(() => parseGraph(input)).toThrow(/expected object/);
    // a cross-reference problem is reported alone: reachability waits for a sound graph
    refuses((g) => ((g["id"] = ""), (g.states["island"] = {}))).toThrow(/^(?![\s\S]*unreachable)/);
  });

  it("BV1.9 names inherited from Object.prototype are not defined states, sensors or features", () => {
    refuses((g) => (g["initial"] = "constructor")).toThrow(/initial state constructor is not defined/);
    refuses((g) => g.transitions.push({ from: "toString", to: "calm", when: { event: "x" } })).toThrow(/starts at toString/);
    refuses((g) => g.transitions.push({ from: "calm", to: "valueOf", when: { event: "x" } })).toThrow(/goes to valueOf/);
    refuses((g) => g.transitions.push({ from: "calm", to: "guarded", when: { sensor: "hasOwnProperty", is: "on" } })).toThrow(/sensor hasOwnProperty is not defined/);
    refuses((g) => (g.sensors["s"] = { feature: "toString", on: 2, off: 1 })).toThrow(/reads feature toString/);
    refuses((g) => (g.states["x"] = { parent: "constructor" })).toThrow(/has parent constructor/);
    refuses((g) => ((g.states["calm"] as { steer: unknown }).steer = { constructor: 1 })).toThrow(/steers with feature constructor/);
  });

  it("BV2.1 in TypeScript, a name the graph does not define is a compile error", () => {
    const spec = { version: 1, id: "t", model: { id: "m", layer: 0 }, features: { f: 0 }, sensors: { s: { feature: "f", on: 2, off: 1 } } } as const;
    expect(() =>
      defineGraph({
        ...spec,
        initial: "a",
        states: { a: {}, b: {} },
        // @ts-expect-error "c" is not a state
        transitions: [{ from: "a", to: "c", when: { event: "x" } }],
      }),
    ).toThrow(/goes to c/);
    expect(() =>
      defineGraph({
        ...spec,
        // @ts-expect-error "z" is not a state
        initial: "z",
        states: { a: {} },
        transitions: [],
      }),
    ).toThrow(/initial state z/);
    expect(() =>
      defineGraph({
        ...spec,
        initial: "a",
        // @ts-expect-error "mystery" is not a feature
        states: { a: { steer: { mystery: 1 } } },
        transitions: [],
      }),
    ).toThrow(/feature mystery/);
    expect(() =>
      defineGraph({
        ...spec,
        initial: "a",
        states: { a: {}, b: {} },
        // @ts-expect-error "loud" is not a sensor
        transitions: [{ from: "a", to: "b", when: { sensor: "loud", is: "on" } }],
      }),
    ).toThrow(/sensor loud/);
  });
});
