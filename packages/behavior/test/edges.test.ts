import { describe, expect, it } from "vitest";
import { BehaviorEngine, compilePack, lineage, parseGraph, parsePack, parseSaeRows, serializePack } from "@harness/behavior";
import type { BehaviorGraph, Transition } from "@harness/behavior";
import { axisSae, guide, guideSpec } from "./fixtures.ts";

/** A graph of unsteered states driven only by events, for transition tie-breaks. */
function plain(initial: string, states: Record<string, { parent?: string }>, transitions: Omit<Transition, never>[], extra: object = {}): BehaviorGraph {
  return parseGraph({ version: 1, id: "plain", model: { id: "m", layer: 0 }, initial, features: {}, sensors: {}, states, transitions, ...extra });
}
const residual = (...xs: number[]) => Float32Array.from(xs);

describe("behavior engine edges", () => {
  it("BE3.1 an activation exactly at the SAE threshold is silent; sensor thresholds are inclusive both ways", () => {
    const e = new BehaviorEngine(compilePack(guide, axisSae()));
    expect(e.step(residual(0.25, 0, 0, 0)).activations["threat"]).toBe(0);
    // asking: on at 1.5, off at 0.5, no hold
    expect(e.step(residual(0, 1.5, 0, 0)).state).toBe("curious");
    expect(e.step(residual(0, 0.5, 0, 0)).state).toBe("calm");
  });

  it("BE3.2 a restored snapshot keeps its time in state; the engine reports its layer and exact sensor state", () => {
    const pack = compilePack(guide, axisSae());
    const e = new BehaviorEngine(pack, { graph: "guide", state: "guarded", tokensInState: 2, sensors: { threat: { on: false, run: 0 }, asking: { on: false, run: 0 } } });
    expect(e.layer).toBe(14);
    expect(e.step(residual(0, 0, 0, 0)).transition).toEqual({ from: "guarded", to: "calm", cause: "after 3 tokens" });
    const fresh = new BehaviorEngine(pack);
    fresh.step(residual(3, 0, 0, 0));
    expect(fresh.snapshot().sensors).toEqual({ threat: { on: false, run: 1 }, asking: { on: false, run: 0 } });
  });

  it("BE3.3 ties break by priority (default 0, negatives lose), then the most specific source, then declaration order", () => {
    const states = { child: { parent: "root" }, root: {}, p: {}, q: {}, r: {} };
    const go = (transitions: Omit<Transition, "when">[]) => {
      const e = new BehaviorEngine(compilePack(plain("child", states, [...transitions.map((t) => ({ ...t, when: { event: "go" } })), ...["root", "p", "q", "r"].map((to) => ({ from: "*", to, when: { event: `reach-${to}` } }))]), axisSae()));
      return e.event("go")?.to;
    };
    expect(go([{ from: "child", to: "p", priority: -1 }, { from: "child", to: "q" }])).toBe("q");
    expect(go([{ from: "child", to: "p", priority: 1 }, { from: "child", to: "q", priority: 5 }])).toBe("q");
    expect(go([{ from: "child", to: "p", priority: 5 }, { from: "child", to: "q", priority: 1 }])).toBe("p");
    expect(go([{ from: "*", to: "p" }, { from: "root", to: "q" }, { from: "child", to: "r" }])).toBe("r");
    expect(go([{ from: "*", to: "p" }, { from: "root", to: "q" }])).toBe("q");
    expect(go([{ from: "root", to: "q" }, { from: "*", to: "p" }])).toBe("q");
    expect(go([{ from: "child", to: "p" }, { from: "child", to: "q" }])).toBe("p");
    expect(go([{ from: "child", to: "p" }, { from: "*", to: "q", priority: 1 }])).toBe("q");
  });

  it("BE3.4 lineage of a name that is not a state is just that name", () => {
    expect(lineage(guide, "nowhere")).toEqual(["nowhere"]);
  });
});

describe("behavior pack edges", () => {
  it("BP2.1 compile errors say exactly what is wrong with the SAE", () => {
    expect(() => compilePack(guide, { ...axisSae(), width: 3 })).toThrow("feature caution has index 3, beyond the SAE's width 3");
    expect(() => compilePack(guide, { ...axisSae(), dims: 3 })).toThrow("encoder row 0 has 4 values, expected 3");
  });

  it("BP2.2 unsteered states compile to no steering, serialized as null and parsed back", () => {
    const pack = compilePack(plain("a", { a: {}, b: {} }, [{ from: "a", to: "b", when: { event: "go" } }]), axisSae(1));
    expect(pack.steering).toEqual({ a: undefined, b: undefined });
    const json = JSON.parse(serializePack(pack)) as { format: string; steering: Record<string, unknown> };
    expect(json.format).toBe("harness.behavior-pack/v1");
    expect(json.steering).toEqual({ a: null, b: null });
    expect(parsePack(serializePack(pack)).steering).toEqual({ a: undefined, b: undefined });
    // a state missing from the steering map is unsteered too
    delete json.steering["b"];
    expect(parsePack(JSON.stringify(json)).steering["b"]).toBeUndefined();
    expect(parsePack(JSON.stringify(json)).dims).toBe(1);
  });

  it("BP2.3 floats survive base64 exactly, including the last byte, with standard padding", () => {
    const graph = parseGraph({ ...guideSpec, states: { ...guideSpec.states, calm: { steer: { caution: 3 } } } });
    const pack = compilePack(graph, axisSae());
    expect(Array.from(parsePack(serializePack(pack)).steering["calm"]!)).toEqual([0, 0, 0, 3]);
    const json = JSON.parse(serializePack(pack)) as { sense: { weights: string }[] };
    expect(json.sense[0]!.weights).toHaveLength(24);
    expect(json.sense[0]!.weights.endsWith("==")).toBe(true);
    expect(json.sense[0]!.weights).toBe("AACAPwAAAAAAAAAAAAAAAA==");
    // 12 bytes need no padding at all
    const sensed = plain("a", { a: {} }, [], { features: { f: 0 }, sensors: { s: { feature: "f", on: 2, off: 1 } } });
    expect((JSON.parse(serializePack(compilePack(sensed, axisSae(3)))) as { sense: { weights: string }[] }).sense[0]!.weights).toBe("AACAPwAAAAAAAAAA");
  });

  it("BP2.4 a parsed pack refuses bad dims, bad base64 and non-finite floats, naming the part", () => {
    const good = JSON.parse(serializePack(compilePack(guide, axisSae()))) as Record<string, unknown> & { sense: Record<string, unknown>[] };
    const tamper = (patch: (j: typeof good) => void) => {
      const j = structuredClone(good);
      patch(j);
      return JSON.stringify(j);
    };
    for (const dims of [0, 1.5, "4"]) expect(() => parsePack(tamper((j) => (j["dims"] = dims)))).toThrow(/at dims/);
    expect(() => parsePack(tamper((j) => (j.sense[0]!["weights"] = "AAAA=AAAAAAAAAAAAAAAAAAA")))).toThrow(/not valid base64\n  → at sense\[0\]\.weights/);
    const nan = btoa(String.fromCharCode(...new Uint8Array(Float32Array.from([Number.NaN, 1, 1, 1]).buffer)));
    expect(() => parsePack(tamper((j) => (j.sense[0]!["weights"] = nan)))).toThrow(/has non-finite values\n  → at sense\[0\]\.weights/);
    expect(() => parsePack(tamper((j) => (j.sense[0]!["weights"] = "AAAA")))).toThrow(/not a whole number of float32 values/);
    expect(() => parsePack(tamper((j) => (j.sense[0]!["weights"] = "AAAAAAAAAAA=")))).toThrow(/has 2 values, expected 4\n  → at sense\[0\]\.weights/);
    expect(() => parsePack(tamper((j) => j.sense.pop()))).toThrow(/sense must carry exactly the sensed features: threat, question/);
    expect(() => parsePack(tamper((j) => ((j["steering"] as Record<string, unknown>)["ghost"] = null)))).toThrow(/steering for state ghost, which is not in the graph/);
  });
});

describe("SAE rows edges", () => {
  const b64 = (xs: number[]) => btoa(String.fromCharCode(...new Uint8Array(Float32Array.from(xs).buffer)));
  const file = (extra: Record<string, unknown>) => JSON.stringify({ format: "harness.sae-rows/v1", dims: 1, width: 2, features: { 0: { encoder: b64([1]), bias: 0, threshold: 0, decoder: b64([1]) } }, ...extra });

  it("SR2.1 one-dimensional rows are fine; an overflowing bias and a non-object feature map are refused", () => {
    expect(parseSaeRows(file({})).dims).toBe(1);
    expect(() => parseSaeRows(file({ features: { 0: { encoder: b64([1]), bias: 1e999, threshold: 0, decoder: b64([1]) } } }))).toThrow(/at features\.0\.bias/);
    expect(() => parseSaeRows(file({ features: "x" }))).toThrow(/at features/);
  });
});
