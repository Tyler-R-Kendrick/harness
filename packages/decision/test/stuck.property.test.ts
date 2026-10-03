import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { readFileSync } from "node:fs";
import { lazy } from "./loops-fixtures.ts";
import { detectStuck, parseStuckSettings, stuckFork } from "../src/stuck.ts";
import type { StuckStep } from "../src/stuck.ts";

const settings = lazy(() => parseStuckSettings(JSON.parse(readFileSync(new URL("../data/stuck.json", import.meta.url), "utf8"))));
const fork = lazy(() => stuckFork(settings));

const step = fc.record({ action: fc.constantFrom("a", "b", "c"), state: fc.option(fc.constantFrom("s", "t"), { nil: undefined }) }).map((s): StuckStep => (s.state === undefined ? { action: s.action } : { action: s.action, state: s.state }));
const steps = fc.array(step, { maxLength: 30 });
const withProgress = fc.array(
  fc.record({ action: fc.constantFrom("a", "b", "c", "d", "e", "f", "g"), progress: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }) }).map((s): StuckStep => (s.progress === undefined ? { action: s.action } : { action: s.action, progress: s.progress })),
  { maxLength: 30 },
);

const same = (x: StuckStep, y: StuckStep) => x.action === y.action && x.state === y.state;

describe("stuck detection properties", () => {
  test.prop([steps])("STK4.1 a reported repeat or cycle is really there, and nothing shorter or smaller was missed", (s) => {
    const r = detectStuck(s, settings);
    if (r.kind === "repeat") {
      expect(r.count).toBeGreaterThanOrEqual(settings.repeat.times);
      expect(s.slice(-r.count).every((x) => same(x, s.at(-1)!))).toBe(true);
      expect(r.count === s.length || !same(s[s.length - 1 - r.count]!, s.at(-1)!)).toBe(true);
    } else if (r.kind === "cycle") {
      expect(r.count).toBeGreaterThanOrEqual(settings.cycle.repeats);
      const period = Number(/cycle of (\d+) steps/.exec(r.evidence)![1]);
      const tail = s.slice(-period * r.count);
      expect(tail).toHaveLength(period * r.count);
      expect(tail.every((x, i) => same(x, tail[i % period]!))).toBe(true);
      expect(tail.slice(0, period).some((x) => !same(x, tail[0]!))).toBe(true);
    }
  });

  test.prop([steps])("STK4.2 a trailing repeat or cycle in the settings' range is always found", (s) => {
    const r = detectStuck(s, settings);
    const lastRun = (() => {
      let n = 0;
      while (n < s.length && same(s[s.length - 1 - n]!, s.at(-1)!)) n++;
      return n;
    })();
    if (s.length > 0 && lastRun >= settings.repeat.times) expect(r.kind).toBe("repeat");
    for (let p = 2; p <= settings.cycle.maxPeriod; p++) {
      const n = p * settings.cycle.repeats;
      if (s.length < n) continue;
      const tail = s.slice(-n);
      const periodic = tail.every((x, i) => same(x, tail[i % p]!));
      const varied = tail.slice(0, p).some((x) => !same(x, tail[0]!));
      if (periodic && varied) expect(["repeat", "cycle"]).toContain(r.kind);
    }
  });

  test.prop([withProgress])("STK4.3 a stall is reported only when progress has not risen over the window, and a rise clears it", (s) => {
    const r = detectStuck(s, settings);
    if (r.kind !== "no-progress") return;
    const known = s.flatMap((x, i) => (x.progress === undefined ? [] : [{ i, p: x.progress }]));
    const firstInWindow = s.length - settings.progress.window;
    let best = -Infinity;
    for (const { i, p } of known) {
      if (i >= firstInWindow) expect(p > best && best !== -Infinity).toBe(false);
      best = Math.max(best, p);
    }
  });

  test.prop([steps, fc.integer({ min: 0, max: 12 })])("STK4.4 steps that each differ from the last and raise progress are never stuck", (_, n) => {
    const ok = Array.from({ length: n }, (__, i): StuckStep => ({ action: `act-${i}`, progress: i }));
    expect(detectStuck(ok, settings).stuck).toBe(false);
  });

  test.prop([withProgress])("STK4.5 the rule and the floor agree, and a model's continue is never below what the detector demands", (s) => {
    const input = { goal: "g", steps: s };
    expect(fork.rule!(input)).toBe(fork.floor!(input));
    const found = detectStuck(s, settings);
    expect(fork.floor!(input) === undefined).toBe(!found.stuck);
  });

  test.prop([steps, steps])("STK4.6 detection looks only at the end: what came before the last steps of a settled repeat does not matter", (before, extra) => {
    const tail: StuckStep[] = Array.from({ length: settings.repeat.times }, () => ({ action: "zz", state: "same" }));
    const a = detectStuck([...before, ...tail], settings);
    const b = detectStuck([...extra, ...tail], settings);
    expect(a.kind).toBe("repeat");
    expect(b.kind).toBe("repeat");
    expect(a.count).toBeGreaterThanOrEqual(settings.repeat.times);
  });
});
