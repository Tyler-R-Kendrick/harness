import { describe, expect, it } from "vitest";
import { BehaviorEngine, compilePack, replay } from "@harness/behavior";
import { axisSae, guide, r } from "./fixtures.ts";

const engine = () => new BehaviorEngine(compilePack(guide, axisSae()));
const vec = (v: Float32Array | undefined) => (v ? Array.from(v) : undefined);

describe("behavior engine", () => {
  it("BE1.1 starts in the initial state and steers with that state's vector", () => {
    const e = engine();
    expect(e.state).toBe("calm");
    expect(vec(e.steering())).toEqual([0, 0, 2, 0]);
  });

  it("BE1.2 feature activations use the SAE threshold (JumpReLU): below it a feature is silent", () => {
    const e = engine();
    expect(e.step(r(0.2, 3)).activations).toEqual({ threat: 0, question: 3 });
  });

  it("BE1.3 a sensor turns on at its on-threshold and stays on until it falls to its off-threshold (hysteresis)", () => {
    const e = engine();
    expect(e.step(r(0, 1.4)).state).toBe("calm"); // below on (1.5)
    expect(e.step(r(0, 1.6)).state).toBe("curious"); // on
    expect(e.step(r(0, 1.0)).state).toBe("curious"); // between off and on: still on
    expect(e.step(r(0, 0.4)).state).toBe("calm"); // at/below off (0.5): off
  });

  it("BE1.4 a sensor with a hold time must stay past its threshold that many tokens before flipping", () => {
    const e = engine();
    expect(e.step(r(3, 0)).state).toBe("calm"); // threat on for 1 token (hold 2)
    expect(e.step(r(0.3, 0)).state).toBe("calm"); // dropped: counter resets
    expect(e.step(r(3, 0)).state).toBe("calm");
    const t = e.step(r(3, 0)); // 2 consecutive tokens
    expect(t.state).toBe("guarded");
    expect(t.transition).toEqual({ from: "calm", to: "guarded", cause: "sensor threat on" });
  });

  it("BE1.5 a higher-priority transition wins; '*' transitions interrupt from any state", () => {
    const e = engine();
    e.step(r(0, 2)); // curious
    e.step(r(3, 2));
    const t = e.step(r(3, 2)); // threat (priority 10, from "*") beats curious->calm? both sensors on: guarded wins
    expect(t.state).toBe("guarded");
  });

  it("BE1.6 a child state inherits its parent's steering (summed) and its parent's transitions", () => {
    const e = engine();
    e.step(r(0, 2));
    expect(e.state).toBe("curious");
    expect(vec(e.steering())).toEqual([0, 0, 3, 0]); // calm warmth 2 + curious warmth 1
  });

  it("BE1.7 time in a state triggers 'after' transitions, counted in tokens", () => {
    const e = engine();
    e.step(r(3, 0));
    e.step(r(3, 0)); // guarded
    expect(vec(e.steering())).toEqual([0, 0, -1, 4]);
    expect(e.step(r(0, 0)).state).toBe("guarded"); // 1 token in guarded
    expect(e.step(r(0, 0)).state).toBe("guarded"); // 2
    const back = e.step(r(0, 0)); // 3
    expect(back.state).toBe("calm");
    expect(back.transition?.cause).toBe("after 3 tokens");
  });

  it("BE1.8 host events trigger event transitions immediately; unknown events do nothing", () => {
    const e = engine();
    e.step(r(3, 0));
    e.step(r(3, 0));
    expect(e.event("wave")).toBeUndefined();
    expect(e.event("reset")).toEqual({ from: "guarded", to: "calm", cause: "event reset" });
    expect(e.state).toBe("calm");
  });

  it("BE1.9 a transition never targets the state it is already in", () => {
    const e = engine();
    expect(e.event("reset")).toBeUndefined();
    expect(e.state).toBe("calm");
  });

  it("BE1.10 a snapshot restores the exact behaviour mid-stream", () => {
    const a = engine();
    const inputs = [r(3, 0), r(0, 2), r(0, 2), r(0, 0.4), r(3, 2), r(3, 2), r(0, 0)];
    for (const x of inputs.slice(0, 3)) a.step(x);
    const b = new BehaviorEngine(compilePack(guide, axisSae()), a.snapshot());
    for (const x of inputs.slice(3)) expect(b.step(x)).toEqual(a.step(x));
  });

  it("BE1.11 a snapshot for another graph, or naming an unknown state, is refused", () => {
    const pack = compilePack(guide, axisSae());
    expect(() => new BehaviorEngine(pack, { graph: "other", state: "calm", tokensInState: 0, sensors: {} })).toThrow(/other/);
    expect(() => new BehaviorEngine(pack, { graph: "guide", state: "asleep", tokensInState: 0, sensors: {} })).toThrow(/asleep/);
  });

  it("BE1.12 the residual must match the pack's width", () => {
    expect(() => engine().step(new Float32Array(3))).toThrow(/4/);
  });

  it("BE2.1 replay turns a recorded transcript into a state timeline, with host events between tokens", () => {
    const timeline = replay(compilePack(guide, axisSae()), [
      { residual: r(0, 2) },
      { event: "reset" },
      { residual: r(3, 0) },
      { residual: r(3, 0) },
    ]);
    expect(timeline).toEqual([
      { at: 0, state: "curious", transition: { from: "calm", to: "curious", cause: "sensor asking on" } },
      { at: 1, state: "calm", transition: { from: "curious", to: "calm", cause: "event reset" } },
      { at: 2, state: "calm" },
      { at: 3, state: "guarded", transition: { from: "calm", to: "guarded", cause: "sensor threat on" } },
    ]);
  });
});
