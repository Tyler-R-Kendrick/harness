import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SettingsSchema } from "@harness/evolution";
import { errorControlDifferences } from "../src/schemas.ts";

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

describe("errorControlDifferences", () => {
  it("RS23.7 a setting the run has and the current settings lack is reported as absent now", () => {
    expect(errorControlDifferences({ rounds: 6, "select.alpha": 0.1 }, { rounds: 6 })).toEqual(["select.alpha was 0.1 and is now absent"]);
  });

  it("RS23.8 a setting the current settings have and the saved run lacks is reported as absent before", () => {
    expect(errorControlDifferences({ rounds: 6 }, { rounds: 6, "select.alpha": 0.1 })).toEqual(["select.alpha was absent and is now 0.1"]);
  });
});
