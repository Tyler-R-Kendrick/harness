import type { BehaviorGraph, SaeRows } from "@harness/behavior";

/**
 * A small character: calm by default, curious when the "question" feature fires,
 * and guarded — from anywhere — when the "threat" feature fires. Curious nests under
 * calm and inherits its steering.
 */
export const guide: BehaviorGraph = {
  version: 1,
  id: "guide",
  model: { id: "Qwen/Qwen3-1.7B", layer: 14 },
  initial: "calm",
  features: { threat: 0, question: 1, warmth: 2, caution: 3 },
  sensors: {
    threat: { feature: "threat", on: 2, off: 1, hold: 2 },
    asking: { feature: "question", on: 1.5, off: 0.5 },
  },
  states: {
    calm: { steer: { warmth: 2 } },
    curious: { parent: "calm", steer: { warmth: 1 } },
    guarded: { steer: { caution: 4, warmth: -1 } },
  },
  transitions: [
    { from: "calm", to: "curious", when: { sensor: "asking", is: "on" } },
    { from: "curious", to: "calm", when: { sensor: "asking", is: "off" } },
    { from: "*", to: "guarded", when: { sensor: "threat", is: "on" }, priority: 10 },
    { from: "guarded", to: "calm", when: { after: 3 } },
    { from: "*", to: "calm", when: { event: "reset" } },
  ],
};

/**
 * A toy SAE over a 4-d residual: feature i reads and writes axis i (unit rows,
 * zero bias, JumpReLU threshold 0.25), so a residual's components are the feature
 * activations directly.
 */
export function axisSae(dims = 4): SaeRows {
  const unit = (i: number) => Float32Array.from({ length: dims }, (_, j) => (j === i ? 1 : 0));
  return {
    dims,
    width: 16,
    encoder: (i) => ({ weights: unit(i), bias: 0, threshold: 0.25 }),
    decoder: (i) => unit(i),
  };
}

/** A residual whose feature activations (on the axis SAE) are the given values. */
export const r = (threat: number, question: number, a = 0, b = 0) => Float32Array.from([threat, question, a, b]);
