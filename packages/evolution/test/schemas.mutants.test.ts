import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSettings, SettingsSchema, StateSchema } from "@harness/evolution";
import { errorControlDifferences, TUNING_EXAMPLES } from "../src/schemas.ts";
import { measured } from "./helpers.ts";

const file = JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")) as Record<string, unknown>;

/** The shipped settings with sections replaced, and every issue the schema reports for them as {code, message, path}. */
const issues = (overrides: Record<string, unknown>) => {
  const result = SettingsSchema.safeParse({ ...structuredClone(file), ...overrides });
  if (result.success) throw new Error("expected the settings to be refused");
  return result.error.issues.map(({ code, message, path }) => ({ code, message, path }));
};

const select = (patch: Record<string, unknown>) => ({ ...(file["select"] as Record<string, unknown>), ...patch });
const oneRound = { rounds: 1, candidates: 1, explore: { window: 2, reserved: 0 } };

describe("settings refusals are custom issues at the setting they name", () => {
  it("RS23.1 an alpha of 0 is one custom issue at select.alpha", () => {
    expect(issues({ select: select({ alpha: 0 }) })).toEqual([{ code: "custom", message: "select.alpha: alpha must be above 0", path: ["select", "alpha"] }]);
  });

  it("RS23.2 a test level of 0.5 is one custom issue at select.alpha, stating the run, the tests and the level", () => {
    expect(issues({ ...oneRound, select: select({ alpha: 1 }) })).toEqual([
      {
        code: "custom",
        message: "select.alpha: with 1 round(s) and 2 tests a round, alpha 1 gives round 0's test a level of 0.5, which must lie in (0, 0.5): lower alpha or use more rounds or candidates",
        path: ["select", "alpha"],
      },
    ]);
  });

  it("RS23.3 a holdout query level of 0.5 or more is one custom issue at holdout.alpha, stating alpha, the budget and the level", () => {
    expect(issues({ holdout: { alpha: 0.9, budget: 1 } })).toEqual([
      {
        code: "custom",
        message: "holdout.alpha: alpha 0.9 with a budget of 1 queries gives each query a level of 0.9, which must lie in (0, 0.5): lower holdout.alpha or the budget",
        path: ["holdout", "alpha"],
      },
    ]);
  });

  it("RS23.4 too few resamples for the smallest round level is one custom issue at select.resamples, naming the round and the count needed", () => {
    expect(issues({ select: select({ resamples: 10 }) })).toEqual([
      {
        code: "custom",
        message: "select.resamples must be at least 600: round 0's test level needs that many resamples to be certified, not 10",
        path: ["select", "resamples"],
      },
    ]);
  });

  it("RS23.5 when the futility level is the smallest, the resamples message names it", () => {
    expect(issues({ select: select({ resamples: 100, futility: { fraction: 0.5, alpha: 0.0001 } }) })).toEqual([
      {
        code: "custom",
        message: "select.resamples must be at least 10000: the futility level needs that many resamples to be certified, not 100",
        path: ["select", "resamples"],
      },
    ]);
  });

  it("RS23.6 when the holdout's level is the smallest, the resamples message names the holdout's confirmation", () => {
    expect(issues({ holdout: { alpha: 0.1, budget: 10 }, select: select({ resamples: 100 }) })).toEqual([
      {
        code: "custom",
        message: "select.resamples must be at least 10230: the holdout's confirmation level needs that many resamples to be certified, not 100",
        path: ["select", "resamples"],
      },
    ]);
  });
});

describe("the cross-field refusals are custom issues at the field they name", () => {
  it("RS23.14 a budget whose minimum exceeds its maximum is one custom issue at budget", () => {
    expect(issues({ budget: { min: 5, max: 3 } })).toEqual([{ code: "custom", message: "budget.min must not exceed budget.max", path: ["budget"] }]);
  });

  it("RS23.15 more reserved slots than candidates is one custom issue at explore.reserved", () => {
    expect(issues({ explore: { window: 3, reserved: 3 } })).toEqual([{ code: "custom", message: "explore.reserved must not exceed candidates", path: ["explore", "reserved"] }]);
  });
});

describe("settings boundaries", () => {
  const holdoutIssue = (alpha: number, budget: number, level: number) => ({
    code: "custom",
    message: `holdout.alpha: alpha ${alpha} with a budget of ${budget} queries gives each query a level of ${level}, which must lie in (0, 0.5): lower holdout.alpha or the budget`,
    path: ["holdout", "alpha"],
  });

  it("RS23.9 a holdout query level of exactly 0.5 is refused", () => {
    expect(issues({ holdout: { alpha: 0.5, budget: 1 } })).toEqual([holdoutIssue(0.5, 1, 0.5)]);
  });

  it("RS23.10 a holdout budget so large that the query level underflows to 0 is refused, naming a level of 0", () => {
    expect(issues({ holdout: { alpha: 0.1, budget: 2000 } })).toEqual([holdoutIssue(0.1, 2000, 0)]);
  });

  it("RS23.11 an edit budget whose minimum equals its maximum is allowed", () => {
    expect(parseSettings({ ...structuredClone(file), budget: { min: 3, max: 3 } }).budget).toEqual({ min: 3, max: 3 });
  });

  it("RS23.12 as many reserved candidate slots as candidates is allowed", () => {
    expect(parseSettings({ ...structuredClone(file), explore: { window: 3, reserved: 2 } }).explore).toEqual({ window: 3, reserved: 2 });
  });

  it("RS23.13 settings that do not parse are refused as invalid evolution settings, with the reasons on the lines after", () => {
    expect(() => parseSettings({})).toThrow(/^invalid evolution settings\n./);
  });
});

describe("the loss counter in a saved state", () => {
  const m = measured(2, 1, () => 1);
  const saved = (drift: number) => ({ format: "harness.evolution/v1", round: 0, documents: {}, base: m, incumbent: [m], observed: m, best: 1, trajectory: [1], drift, mechanisms: [], records: [] });

  it("RS23.16 the loss counter is a CUSUM that is never negative: a positive or zero counter restores and a negative one is refused", () => {
    expect(StateSchema.parse(saved(0.25)).drift).toBe(0.25);
    expect(StateSchema.parse(saved(0)).drift).toBe(0);
    expect(StateSchema.safeParse(saved(-0.25)).success).toBe(false);
  });
});

describe("errorControlDifferences", () => {
  it("RS23.7 a setting the run has and the current settings lack is reported as absent now", () => {
    expect(errorControlDifferences({ rounds: 6, "select.alpha": 0.1 }, { rounds: 6 })).toEqual(["select.alpha was 0.1 and is now absent"]);
  });

  it("RS23.8 a setting the current settings have and the saved run lacks is reported as absent before", () => {
    expect(errorControlDifferences({ rounds: 6 }, { rounds: 6, "select.alpha": 0.1 })).toEqual(["select.alpha was absent and is now 0.1"]);
  });
});

describe("the proposer's tuning cap", () => {
  const optimize = (maxMetricCalls: number) => ({ proposer: { ...(file["proposer"] as Record<string, unknown>), optimize: { maxMetricCalls, seed: 0 } } });

  it("RS27.16 a cap above zero but below the optimizer's examples is one issue at proposer.optimize.maxMetricCalls, saying what Ax needs", () => {
    expect(issues(optimize(TUNING_EXAMPLES - 1))).toEqual([
      {
        code: "custom",
        message: `proposer.optimize.maxMetricCalls must be 0 (tuning off) or at least ${TUNING_EXAMPLES}: Ax's GEPA scores the ${TUNING_EXAMPLES} tuning examples once before it searches, and refuses a smaller cap`,
        path: ["proposer", "optimize", "maxMetricCalls"],
      },
    ]);
  });

  it("RS27.17 zero, exactly the examples' count, and more are allowed", () => {
    for (const calls of [0, TUNING_EXAMPLES, TUNING_EXAMPLES + 1, 200]) expect(parseSettings({ ...structuredClone(file), ...optimize(calls) }).proposer.optimize.maxMetricCalls).toBe(calls);
  });

  it("RS27.18 a negative cap is refused once, as a number below the minimum, not also as one the examples cannot fit", () => {
    const found = issues(optimize(-1));
    expect(found).toHaveLength(1);
    expect(found[0]!.code).toBe("too_small");
  });
});
