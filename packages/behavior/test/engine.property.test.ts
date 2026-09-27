import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { BehaviorEngine, compilePack } from "@harness/behavior";
import { axisSae, guide } from "./fixtures.ts";

const residual = fc.tuple(fc.double({ min: 0, max: 4, noNaN: true }), fc.double({ min: 0, max: 4, noNaN: true })).map(([a, b]) => Float32Array.from([a, b, 0, 0]));
const run = (xs: readonly Float32Array[]) => {
  const e = new BehaviorEngine(compilePack(guide, axisSae()));
  return xs.map((x) => e.step(x));
};

describe("behavior engine properties", () => {
  test.prop([fc.array(residual, { maxLength: 60 })])("BE3.1 the same transcript always gives the same timeline, in a state of the graph", (xs) => {
    const a = run(xs);
    expect(run(xs)).toEqual(a);
    for (const s of a) expect(Object.keys(guide.states)).toContain(s.state);
  });

  test.prop([fc.array(residual, { maxLength: 60 })])("BE3.2 a held sensor never flips faster than its hold time (no flicker)", (xs) => {
    const e = new BehaviorEngine(compilePack(guide, axisSae()));
    let last = -Infinity;
    let prev = e.snapshot().sensors["threat"]?.on ?? false;
    xs.forEach((x, i) => {
      e.step(x);
      const now = e.snapshot().sensors["threat"]?.on ?? false;
      if (now !== prev) {
        expect(i - last).toBeGreaterThanOrEqual(2);
        last = i;
        prev = now;
      }
    });
  });

  test.prop([fc.array(residual, { maxLength: 40 }), fc.nat(40)])("BE3.3 restoring a snapshot at any point continues identically", (xs, cut) => {
    const pack = compilePack(guide, axisSae());
    const a = new BehaviorEngine(pack);
    const k = Math.min(cut, xs.length);
    for (const x of xs.slice(0, k)) a.step(x);
    const b = new BehaviorEngine(pack, JSON.parse(JSON.stringify(a.snapshot())));
    for (const x of xs.slice(k)) expect(b.step(x)).toEqual(a.step(x));
  });
});
