import { describe, expect, it } from "vitest";
import { advance, calibratedDecision, Evolution, StateSchema } from "@harness/evolution";
import type { CalibratedRule, Measured } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { scripted, settings, toggle, world } from "./world.ts";

const RULE: CalibratedRule = { rule: "calibrated", alpha: 0.1, resamples: 1000, margin: 0.01, saving: 0.05, beta0: 0.1, beta1: 40 };

const step = (kind: Measured["kind"], gain: number, lower: number, costChange?: number): Measured => ({
  label: "X",
  kind,
  score: 0.5 + gain,
  gain,
  lower,
  upper: lower + 0.01,
  ...(costChange === undefined ? {} : { costChange, costLower: costChange, costUpper: costChange }),
  components: ["prompt"],
  guards: [],
});

describe("the loss counter is a CUSUM of the lower bounds of accepted steps", () => {
  it("RS19.12 a saving of -0.0098 followed by a supported gain of 0.00001 (lower bound) repeated is refused from the second cycle on", () => {
    let account = { drift: 0, certified: 0 };
    const accepted: string[] = [];
    let refusal = "";
    for (let cycle = 0; cycle < 10; cycle++) {
      const save = step("change", -0.0098, -0.0098, -0.2);
      const saved = calibratedDecision(save, RULE, { ...account, anchor: {} });
      if (saved.admissible) {
        accepted.push(`save${cycle}`);
        account = advance(account, save.lower);
      } else if (!refusal) refusal = saved.reason;
      const gain = step("change", 0.0002, 0.00001, 0);
      const gained = calibratedDecision(gain, RULE, { ...account, anchor: {} });
      expect(gained.admissible).toBe(true);
      account = advance(account, gain.lower);
    }
    expect(accepted).toEqual(["save0"]);
    expect(refusal).toMatch(/accumulated losses 0\.0196 \(a running total of the accepted steps' lower bounds\) would exceed the margin 0\.0100/);
    // Ten cycles later the account has been paid down by ten times 0.00001 only.
    expect(account.drift).toBeCloseTo(0.0098 - 10 * 0.00001, 12);
    expect(account.certified).toBeCloseTo(-0.0098 + 10 * 0.00001, 12);
  });

  it("RS19.13 ten removals whose lower bounds are -0.0099 (each with a point gain of +0.001) are not all accepted: the second is refused", () => {
    let account = { drift: 0, certified: 0 };
    const accepted: number[] = [];
    for (let i = 0; i < 10; i++) {
      const removal = step("prune", 0.001, -0.0099);
      if (calibratedDecision(removal, RULE, { ...account, anchor: {} }).admissible) {
        accepted.push(i);
        account = advance(account, removal.lower);
      }
    }
    expect(accepted).toEqual([0]);
  });

  it("RS19.14 the counter never goes below zero and a step with a lower bound above zero pays it down by exactly that much", () => {
    expect(advance({ drift: 0.003, certified: 0 }, 0.001).drift).toBeCloseTo(0.002, 12);
    expect(advance({ drift: 0.003, certified: 0 }, 0.5).drift).toBe(0);
    expect(advance({ drift: 0, certified: 0 }, -0.004).drift).toBeCloseTo(0.004, 12);
  });

  it("RS19.15 a step exactly at the margin in total is accepted, one beyond it is refused, whichever kind of step it is", () => {
    const at = (drift: number, lower: number) => calibratedDecision(step("prune", 0, lower), RULE, { drift, certified: 0, anchor: {} }).admissible;
    expect(at(0.005, -0.0049)).toBe(true);
    expect(at(0.005, -0.005)).toBe(true); // exactly the margin in total
    expect(at(0.005, -0.0051)).toBe(false);
  });
});

describe("the loss counter and the certified total in a run", () => {
  it("RS19.16 an accepted step adds its lower bound to `certified` and lowers the counter by it; a round that accepts nothing changes neither", async () => {
    const w = world({ n: 40, base: () => 0, effects: { verify: (i) => (i < 20 ? 1 : 0) } });
    const e = await Evolution.start({ surface: w.surface, settings: settings(), split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } });
    expect(e.save()).toMatchObject({ drift: 0, certified: 0 });
    const { propose } = scripted((r) => (r.candidate === "A" && r.round === 0 ? toggle("verify") : toggle(`noop${r.round}${r.candidate}`)));
    const report = await e.round({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(2) });
    expect(report.accepted).toBe("A");
    const lower = report.records.find((r) => r.candidate === "A")!.measured!.lower;
    expect(lower).toBeGreaterThan(0);
    expect(e.save()).toMatchObject({ drift: 0, certified: lower });
    // The next round accepts nothing (the ablation of verify would lose half the score; the null changes gain nothing).
    const next = await e.round({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(3) });
    expect(next.accepted).toBeUndefined();
    expect(e.save()).toMatchObject({ drift: 0, certified: lower });
  });

  it("RS19.17 a state saved before `certified` existed still parses and reads 0", () => {
    const w = world({ n: 40, base: () => 0 });
    return Evolution.start({ surface: w.surface, settings: settings(), split: w.split, documents: w.documents, ports: { evaluate: w.evaluate, entropy: new SeededEntropy(1) } }).then((e) => {
      const old = JSON.parse(JSON.stringify(e.save())) as Record<string, unknown>;
      delete old["certified"];
      expect(StateSchema.parse(old).certified).toBe(0);
      expect((new Evolution({ surface: w.surface, settings: settings(), split: w.split, saved: old }).save() as { certified: number }).certified).toBe(0);
    });
  });
});
