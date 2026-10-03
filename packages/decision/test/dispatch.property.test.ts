import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dispatchFork, parseDispatchSettings, switchPlan } from "../src/dispatch.ts";
import type { Prices, SwitchRequest } from "../src/dispatch.ts";
import { cost } from "../src/types.ts";
import { lazy, levels } from "./loops-fixtures.ts";

const shipped = lazy(() => parseDispatchSettings(JSON.parse(readFileSync(new URL("../data/dispatch.json", import.meta.url), "utf8"))));

/**
 * Prices in which the small tier is the large one scaled down (by at most half) and output
 * costs at least four times input, as every provider prices it: each token of stretch the
 * small tier writes then saves more than the uncached read it costs at the return.
 */
const pricesArb = fc
  .record({
    input: fc.double({ min: 0.1, max: 20, noNaN: true }),
    cached: fc.double({ min: 0.01, max: 0.5, noNaN: true }),
    write: fc.double({ min: 0, max: 0.25, noNaN: true }),
    output: fc.double({ min: 4, max: 10, noNaN: true }),
    scale: fc.double({ min: 0.02, max: 0.5, noNaN: true }),
  })
  .map((p): Prices => {
    const large = { input: cost(p.input), cachedInput: cost(p.input * p.cached), cacheWrite: cost(p.input * p.write), output: cost(p.input * p.output) };
    const small = { input: cost(large.input * p.scale), cachedInput: cost(large.cachedInput * p.scale), cacheWrite: cost(large.cacheWrite * p.scale), output: cost(large.output * p.scale) };
    return { large, small };
  });

const requestArb = fc.record({
  context: fc.integer({ min: 1000, max: 2_000_000 }),
  newOutput: fc.integer({ min: 1, max: 5000 }),
  prices: pricesArb,
  hysteresis: fc.double({ min: 0, max: 0.9, noNaN: true }),
});
const plan = (r: { context: number; newOutput: number; prices: Prices; hysteresis: number }, expectedStretch: number, extra: Partial<SwitchRequest> = {}) => switchPlan({ ...r, expectedStretch, from: "large", to: "small", ...extra });

describe("dispatch properties", () => {
  test.prop([requestArb, fc.integer({ min: 0, max: 200_000 }), fc.integer({ min: 0, max: 200_000 })])("DSP4.1 the savings never fall as the stretch grows, so a switch that pays keeps paying", (r, a, b) => {
    const [short, long] = a <= b ? [a, b] : [b, a];
    const p = plan(r, short);
    const q = plan(r, long);
    expect(q.stayCost - q.switchCost).toBeGreaterThanOrEqual(p.stayCost - p.switchCost - 1e-9);
    if (p.switch) expect(q.switch).toBe(true);
  });

  test.prop([requestArb, fc.double({ min: 0.05, max: 20, noNaN: true })])("DSP4.2 it switches exactly when the stretch is past the break-even", (r, factor) => {
    const even = plan(r, 1).breakEvenStretch;
    fc.pre(Number.isFinite(even) && even > 0 && even < 1e9);
    const stretch = even * factor;
    fc.pre(Math.abs(factor - 1) > 0.05);
    expect(plan(r, stretch).switch).toBe(stretch > even);
  });

  test.prop([requestArb, fc.integer({ min: 0, max: 200_000 }), fc.double({ min: 0, max: 0.9, noNaN: true })])("DSP4.3 more hysteresis never switches where less does not", (r, stretch, extra) => {
    const looser = plan(r, stretch);
    const tighter = plan({ ...r, hysteresis: Math.min(0.99, r.hysteresis + extra) }, stretch);
    if (tighter.switch) expect(looser.switch).toBe(true);
    expect(tighter.breakEvenStretch).toBeGreaterThanOrEqual(looser.breakEvenStretch - 1e-9);
  });

  test.prop([fc.array(fc.double({ min: 0.001, max: 1, noNaN: true }), { minLength: 4, maxLength: 4 }), fc.integer({ min: 0, max: 1_000_000 }), fc.constantFrom("large" as const, "small" as const), fc.boolean()])(
    "DSP4.4 the fork's action is always one on offer, with a confidence that is a probability",
    (weights, context, current, irreversible) => {
      const fork = dispatchFork(shipped);
      const input = { context, current, task: "t", facts: { irreversible } };
      const verdict = fork.interpret({ routine: levels(weights) }, input);
      expect(verdict).toBeDefined();
      expect(fork.actions!(input)).toContain(verdict!.action);
      expect(verdict!.confidence).toBeGreaterThanOrEqual(0);
      expect(verdict!.confidence).toBeLessThanOrEqual(1);
      const floor = fork.floor!(input);
      expect(floor === undefined ? true : fork.actions!(input).includes(floor)).toBe(true);
      expect(floor !== undefined).toBe(irreversible);
    },
  );
});
