import { describe, expect, it } from "vitest";
import { calibratedDecision, compare, editBudget, Evolution, MAX_FEEDBACK, measure, minimumGroups, score } from "@harness/evolution";
import type { CalibratedRule, EvolutionPorts, Split, TaskRun } from "@harness/evolution";
import { SeededEntropy } from "@harness/testkit";
import { measured } from "./helpers.ts";
import { scripted, settings, toggle, world } from "./world.ts";

type World = ReturnType<typeof world>;

const start = (w: World, s = settings(), split: Split = w.split, evaluate: EvolutionPorts["evaluate"] = w.evaluate) => Evolution.start({ surface: w.surface, settings: s, split, documents: w.documents, ports: { evaluate, entropy: new SeededEntropy(1) } });
const ports = (w: World, propose: EvolutionPorts["propose"], extra: Partial<EvolutionPorts> = {}): EvolutionPorts => ({ evaluate: w.evaluate, propose, entropy: new SeededEntropy(2), ...extra });
const trial = (reward: number) => ({ reward: score(reward) });

describe("group and weight come from the task set, not from what the evaluator says", () => {
  const ids = ["h", ...Array.from({ length: 20 }, (_, i) => `s${String(i).padStart(2, "0")}`)];
  const known = new Map(ids.map((id) => [id, { group: id === "h" ? "heavy" : "light", weight: id === "h" ? 100 : 1 }]));
  const runsWithout = (omit: string | undefined): TaskRun[] => ids.filter((id) => id !== omit).map((id) => ({ task: id, trials: [trial(id === "h" ? 0 : id < "s10" ? 1 : 0)] }));

  it("RS19.40 a task with no run keeps its weight and group from the task set: a crashed heavy task cannot shrink the denominator", () => {
    const failing = measure(runsWithout(undefined), ids, 1, known);
    const crashed = measure(runsWithout("h"), ids, 1, known);
    expect(failing.score).toBeCloseTo(10 / 120, 12);
    expect(crashed.score).toBeCloseTo(10 / 120, 12);
    expect(crashed.missing).toBe(1);
    expect(crashed.tasks.find((t) => t.task === "h")).toMatchObject({ group: "heavy", weight: 100, missing: 1, mean: 0 });
    // Without the task set the crashed task would weigh 1, not 100: the score would be inflated to 10 / 21.
    expect(measure(runsWithout("h"), ids, 1).score).toBeCloseTo(10 / 21, 12);
  });

  it("RS19.41 a run that says nothing of its group and weight takes the task set's; one that says otherwise is an error naming the task", () => {
    const m = measure(runsWithout(undefined), ids, 1, known);
    expect(m.tasks.find((t) => t.task === "h")).toMatchObject({ group: "heavy", weight: 100 });
    expect(m.tasks.find((t) => t.task === "s03")).toMatchObject({ group: "light", weight: 1 });
    const said = (extra: Record<string, unknown>) => () => measure([{ task: "h", ...extra, trials: [trial(1)] }], ["h"], 1, known);
    expect(said({ group: "heavy", weight: 100 })).not.toThrow();
    expect(said({ group: "other" })).toThrow('the evaluator reported group "other" for task h, but the task set says "heavy"');
    expect(said({ weight: 5 })).toThrow("the evaluator reported weight 5 for task h, but the task set says 100");
  });

  it("RS19.42 an evaluator that leaves out the group of its runs gives the same result as one that declares it", async () => {
    const one = async (strip: boolean) => {
      const w = world({ n: 40, base: () => 0, groups: 10, effects: { verify: (i) => (i < 20 ? 1 : 0) } });
      const evaluate: EvolutionPorts["evaluate"] = async (d, t, k) => (await w.evaluate(d, t, k)).map(({ group: _, ...run }) => (strip ? run : { ...run, ...(t.find((x) => x.id === run.task)!.group ? { group: t.find((x) => x.id === run.task)!.group! } : {}) }));
      const e = await start(w, settings(), w.split, evaluate);
      const { propose } = scripted((r) => (r.candidate === "A" ? toggle("verify") : toggle(`noop${r.candidate}`)));
      await e.round(ports(w, propose, { evaluate }));
      return e.save();
    };
    const declared = await one(false);
    const stripped = await one(true);
    expect(stripped).toEqual(declared);
    // and the groups were the split's: 10 groups of 4, so all-or-nothing flips need the whole group's gain.
    const records = (stripped as { records: { measured?: { lower: number } }[] }).records;
    expect(records.find((r) => r.measured)!.measured!.lower).toBeCloseTo(0.5, 12);
  });

  it("RS19.43 an evaluator whose runs disagree with the split's group or weight is refused, naming the task, before anything is kept", async () => {
    const w = world({ n: 40, base: () => 0, groups: 10 });
    const wrongGroup: EvolutionPorts["evaluate"] = async (d, t, k) => (await w.evaluate(d, t, k)).map((r) => (r.task === "e003" ? { ...r, group: "elsewhere" } : r));
    await expect(start(w, settings(), w.split, wrongGroup)).rejects.toThrow('the evaluator reported group "elsewhere" for task e003, but the task set says "g3"');
    const wrongWeight: EvolutionPorts["evaluate"] = async (d, t, k) => (await w.evaluate(d, t, k)).map((r) => (r.task === "e004" ? { ...r, weight: 3 } : r));
    await expect(start(w, settings(), w.split, wrongWeight)).rejects.toThrow("the evaluator reported weight 3 for task e004, but the task set says 1");
    // Midway through a run: the round fails and changes nothing.
    const e = await start(w);
    const before = JSON.stringify(e.save());
    const { propose } = scripted(() => toggle("x"));
    await expect(e.round(ports(w, propose, { evaluate: wrongGroup }))).rejects.toThrow(/for task e003/);
    expect(JSON.stringify(e.save())).toBe(before);
  });

  it("RS19.44 a task's weight in the split counts in every measurement, and a crashed run of a heavy task neither inflates a candidate's score nor its gain", async () => {
    // The heavy task e000 fails under every harness; a candidate that crashes on it has not improved anything.
    const w = world({ n: 40, base: (i) => (i === 0 ? 0 : 1), effects: { crash: () => 0 } });
    const heavy: Split = { evolve: w.split.evolve.map((t, i) => (i === 0 ? { ...t, weight: 100 } : t)) };
    const lossy: EvolutionPorts["evaluate"] = async (d, t, k) => (await w.evaluate(d, t, k)).filter((r) => !((d["policy"] as { rules: Record<string, boolean> }).rules["crash"] && r.task === "e000"));
    const e = await start(w, settings(), heavy, lossy);
    expect(e.incumbent!.score).toBeCloseTo(39 / 139, 12);
    expect(e.incumbent!.tasks[0]).toMatchObject({ task: "e000", weight: 100 });
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("crash") : toggle(`noop${r.candidate}`)));
    const report = await e.round(ports(w, propose, { evaluate: lossy }));
    const a = report.records.find((r) => r.candidate === "A")!;
    expect(a.measured!.score).toBeCloseTo(39 / 139, 12);
    expect(a.measured!.gain).toBeCloseTo(0, 12);
    expect(report.accepted).toBeUndefined();
  });

  it("RS19.45 a weight in the task set must be positive and finite", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    for (const weight of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad: Split = { evolve: w.split.evolve.map((t, i) => (i === 3 ? { ...t, weight } : t)) };
      await expect(start(w, settings(), bad)).rejects.toThrow(`the weight of task e003 must be positive and finite, not ${weight}`);
    }
    const twice: Split = { evolve: [...w.split.evolve, w.split.evolve[0]!] };
    await expect(start(w, settings(), twice)).rejects.toThrow("task e000 is in the task set twice");
  });
});

// ---- F: minor defects ---------------------------------------------------------------------

describe("the non-inferiority boundary is strict", () => {
  it("RS19.30 a candidate exactly `margin` worse on every task has a lower bound of exactly -margin, and is not non-inferior", () => {
    const inc = measured(20, 2, () => 0.5);
    const cand = measured(20, 2, () => 0);
    const c = compare(cand, inc, { alpha: 0.01, resamples: 2000, entropy: new SeededEntropy(1) });
    expect(c).toMatchObject({ gain: -0.5, lower: -0.5, upper: -0.5 });
    const rule: CalibratedRule = { rule: "calibrated", alpha: 0.1, resamples: 1000, margin: 0.5, saving: 0.05, beta0: 0.1, beta1: 35 };
    const measuredCand = { label: "S", kind: "change" as const, score: 0, gain: c.gain, lower: c.lower, upper: c.upper, costChange: -0.2, costLower: -0.2, costUpper: -0.2, components: [], guards: [] };
    expect(calibratedDecision(measuredCand, rule, { drift: 0, certified: 0, anchor: {} })).toMatchObject({ admissible: false, reason: expect.stringMatching(/by the margin or more: lower bound -0\.5000 <= -0\.5000/) });
    expect(calibratedDecision(measuredCand, { ...rule, margin: 0.5001 }, { drift: 0, certified: 0, anchor: {} }).admissible).toBe(true);
  });
});

describe("the randomization test is exact for up to 14 groups", () => {
  const noEntropy = { bytes: (): Uint8Array => { throw new Error("an exact test draws nothing"); } };
  /** Measurements of `diffs.length` tasks (k = 1) whose paired differences are `diffs`. */
  const pair = (diffs: readonly number[]) => ({ cand: measured(diffs.length, 1, (i) => diffs[i]!), inc: measured(diffs.length, 1, () => 0) });

  it("RS19.31 all 2^G sign vectors are enumerated: five tasks with differences 0.1..0.5 have the exact bounds 0.2 and 0.4 at level 0.1, and no entropy is drawn", () => {
    const { cand, inc } = pair([0.1, 0.2, 0.3, 0.4, 0.5]);
    const c = compare(cand, inc, { alpha: 0.1, resamples: 10, entropy: noEntropy });
    // 31 nonempty flip sets; p is not below 0.1 from the ceil(0.1 * 32) - 1 = 3rd smallest mean: 0.1, 0.15, 0.2, 0.2, ...
    expect(c.lower).toBeCloseTo(0.2, 12);
    expect(c.upper).toBeCloseTo(0.4, 12);
    expect(c.groups).toBe(5);
    expect(c.se).toBeGreaterThan(0);
  });

  it("RS19.32 the bounds are the exact quantiles of the randomization distribution: the p-value just below the lower bound is under alpha, and at it is not", () => {
    for (const G of [3, 5, 8, 11, 14])
      for (const alpha of [0.2, 0.1, 0.05, 0.01, 0.002]) {
        const diffs = Array.from({ length: G }, (_, i) => (((i * 7) % 13) + 1) / 20);
        const { cand, inc } = pair(diffs);
        const c = compare(cand, inc, { alpha, resamples: Math.ceil(1 / alpha), entropy: noEntropy });
        const N = 2 ** G;
        const means = Array.from({ length: N - 1 }, (_, m) => {
          const flipped = diffs.filter((_, g) => ((m + 1) >> g) & 1);
          return flipped.reduce((s, x) => s + x, 0) / flipped.length;
        });
        const p = (theta: number) => (1 + means.filter((x) => x <= theta + 1e-12).length) / N;
        if (alpha * N <= 1) {
          expect(c.lower).toBe(-1);
          expect(c.upper).toBe(1);
          continue;
        }
        expect(p(c.lower - 1e-9)).toBeLessThan(alpha);
        expect(p(c.lower)).toBeGreaterThanOrEqual(alpha);
        const mirror = (theta: number) => (1 + means.filter((x) => x >= theta - 1e-12).length) / N;
        expect(mirror(c.upper + 1e-9)).toBeLessThan(alpha);
        expect(mirror(c.upper)).toBeGreaterThanOrEqual(alpha);
      }
  });

  it("RS19.33 a group count of at least minimumGroups(level) certifies an all-positive gain every time, one fewer never does", () => {
    for (const alpha of [0.125, 0.1, 0.05, 0.01]) {
      const G = minimumGroups(alpha);
      const yes = pair(Array.from({ length: G }, () => 0.3));
      const no = pair(Array.from({ length: G - 1 }, () => 0.3));
      expect(compare(yes.cand, yes.inc, { alpha, resamples: Math.ceil(1 / alpha), entropy: noEntropy }).lower).toBeCloseTo(0.3, 12);
      expect(compare(no.cand, no.inc, { alpha, resamples: Math.ceil(1 / alpha), entropy: noEntropy }).lower).toBe(-1);
    }
  });

  it("RS19.34 above 14 groups the test is Monte Carlo again: it draws from the entropy port", () => {
    let drawn = 0;
    const counting = { bytes: (n: number) => (drawn++, new Uint8Array(n)) };
    const at = (G: number) => {
      const { cand, inc } = pair(Array.from({ length: G }, (_, i) => (i % 3) / 10));
      drawn = 0;
      compare(cand, inc, { alpha: 0.1, resamples: 100, entropy: counting });
      return drawn;
    };
    expect(at(14)).toBe(0);
    expect(at(15)).toBeGreaterThan(0);
    // Draws that flip nothing count against rejection: an entropy that never flips leaves the widest bounds.
    const never = { bytes: (n: number) => new Uint8Array(n).fill(255) };
    const { cand, inc } = pair(Array.from({ length: 20 }, () => 0.3));
    expect(compare(cand, inc, { alpha: 0.1, resamples: 100, entropy: never })).toMatchObject({ lower: -1, upper: 1, se: 0 });
  });

  it("RS19.35 a run whose evolve set has too few groups says that groups are counted as given: a group with no difference counts and certifies nothing", async () => {
    const w = world({ n: 6, base: () => 0.5 });
    await expect(start(w)).rejects.toThrow("the evolve set has 6 groups, and a run whose smallest test is at level 0.0056 needs at least 8 for any change to be certifiable: use more tasks, more groups, fewer rounds or candidates, or a larger alpha (groups are counted as given: a group on which the harnesses never differ counts here and certifies nothing)");
  });
});

describe("settings whose test levels cannot work are refused, naming the setting", () => {
  const select = { rule: "calibrated", alpha: 0.1, resamples: 1000, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 };
  const one = (overrides: Record<string, unknown>) => () => settings({ rounds: 1, candidates: 1, explore: { window: 2, reserved: 0 }, ...overrides });

  it("RS19.36 a test level of 0.5 or more is refused (alpha 1, one round, one candidate gives 0.5), and so is an alpha of 0", () => {
    expect(one({ select: { ...select, alpha: 1 } })).toThrow("select.alpha: with 1 round(s) and 2 tests a round, alpha 1 gives round 0's test a level of 0.5, which must lie in (0, 0.5)");
    expect(one({ select: { ...select, alpha: 0 } })).toThrow("select.alpha: alpha must be above 0");
    expect(one({ select: { ...select, alpha: 0.99 } })).not.toThrow();
    expect(one({ select: { ...select, alpha: 0.98 } })).not.toThrow();
    // Geometric spending on a single round is the same as uniform.
    expect(one({ select: { ...select, alpha: 1, spending: { kind: "geometric", ratio: 0.5 } } })).toThrow(/select\.alpha: .* level of 0\.5,/);
  });
});

describe("what a trial may say", () => {
  const one = (t: Record<string, unknown>) => () => measure([{ task: "a", trials: [trial(1), t as never] }], ["a"], 2);

  it("RS19.37 a reward outside [0, 1] or not a number, tokens negative or not finite, are refused with the task and trial", () => {
    expect(one({ reward: 1.5 })).toThrow("trial 1 of a is invalid: reward: ");
    expect(one({ reward: -0.1 })).toThrow(/trial 1 of a is invalid: reward/);
    expect(one({ reward: Number.NaN })).toThrow(/trial 1 of a is invalid: reward/);
    expect(one({ reward: 1, tokens: -5 })).toThrow(/trial 1 of a is invalid: tokens/);
    expect(one({ reward: 1, tokens: Number.NaN })).toThrow(/trial 1 of a is invalid: tokens/);
    expect(one({ reward: 1, tokens: Number.POSITIVE_INFINITY })).toThrow(/trial 1 of a is invalid: tokens/);
    expect(one({ reward: 1, tokens: 12, feedback: 7 })).toThrow(/trial 1 of a is invalid: feedback/);
    expect(one({ reward: 1, tokens: 0, feedback: "" })).not.toThrow();
    expect(() => measure([{ task: "a", group: "", trials: [trial(1)] }], ["a"], 1)).toThrow("the group of a must not be empty");
  });

  it("RS19.38 the feedback kept of a trial is cut at 2000 characters, never in the middle of a surrogate pair", () => {
    const worst = (feedback: string) => measure([{ task: "a", trials: [{ reward: score(0), feedback }, trial(1)] }], ["a"], 2).tasks[0]!.feedback!;
    expect(MAX_FEEDBACK).toBe(2000);
    expect(worst("x".repeat(3000))).toBe("x".repeat(2000));
    expect(worst("x".repeat(2000))).toBe("x".repeat(2000));
    expect(worst("short")).toBe("short");
    expect(worst(`${"x".repeat(1999)}😀tail`)).toBe("x".repeat(1999));
  });
});

describe("a failed round leaves nothing running", () => {
  it("RS19.39 round() waits for every evaluation to settle before it throws the first rejection, so a retry does not overlap", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    const e = await start(w);
    let running = 0;
    let slowFinished = false;
    const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => {
      running++;
      try {
        const rules = (documents["policy"] as { rules: Record<string, boolean> }).rules;
        if (rules["boom"]) throw new Error("evaluator crashed on A");
        if (rules["slow"]) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          slowFinished = true;
        }
        return await w.evaluate(documents, tasks, k);
      } finally {
        running--;
      }
    };
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("boom") : toggle("slow")));
    const before = JSON.stringify(e.save());
    await expect(e.round(ports(w, propose, { evaluate }))).rejects.toThrow("evaluator crashed on A");
    expect(slowFinished).toBe(true);
    expect(running).toBe(0);
    expect(JSON.stringify(e.save())).toBe(before);
  });
});

describe("the annealed edit budget reaches b_min in the last round", () => {
  it("RS19.47 b_t is round(b_min + (b_max - b_min)(1 + cos(pi t / (T - 1))) / 2): b_max first, exactly b_min last", () => {
    const table = Array.from({ length: 20 }, (_, t) => editBudget(t, 20, 1, 4));
    for (let t = 0; t < 20; t++) expect(table[t]).toBe(Math.round(1 + 3 * 0.5 * (1 + Math.cos((Math.PI * t) / 19))));
    expect(table).toEqual([4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1]);
    expect(editBudget(19, 20, 1, 4)).toBe(1);
    expect(editBudget(2, 3, 1, 2)).toBe(1);
    // A run of one round, or of none, keeps b_max; rounds outside the run are clamped.
    expect(editBudget(0, 1, 1, 4)).toBe(4);
    expect(editBudget(0, 0, 1, 4)).toBe(4);
    expect(editBudget(7, 1, 1, 4)).toBe(4);
    expect(editBudget(-3, 20, 1, 4)).toBe(4);
    expect(editBudget(25, 20, 1, 4)).toBe(1);
    expect(editBudget(3, 3, 1, 4)).toBe(1);
    // A tie rounds up, whatever floating point does to the cosine: b = 1.5 in the middle of a 3-round run.
    expect(editBudget(1, 3, 1, 2)).toBe(2);
  });
});

describe("documents are copies", () => {
  it("RS19.48 what a port does to the documents it is handed cannot corrupt the run: not the proposer's, not the evaluator's, not the getter's", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    const e = await start(w);
    const before = JSON.stringify(e.save());
    const seen: unknown[] = [];
    const propose: EvolutionPorts["propose"] = async (request) => {
      seen.push(JSON.parse(JSON.stringify(request.documents)));
      (request.documents["policy"] as { rules: Record<string, boolean> }).rules["planted"] = true;
      return toggle(`noop${request.candidate}`);
    };
    const evaluate: EvolutionPorts["evaluate"] = async (documents, tasks, k) => {
      (documents["policy"] as { prompt: { system: string } }).prompt.system = "vandalized";
      return w.evaluate(documents, tasks, k);
    };
    await e.round(ports(w, propose, { evaluate }));
    // Neither candidate saw the other's mutation, and the state's own documents are untouched.
    expect(seen).toEqual([w.documents, w.documents]);
    expect(e.documents).toEqual(w.documents);
    const got = e.documents as { policy: { rules: Record<string, boolean> } };
    got.policy.rules["hack"] = true;
    expect(e.documents).toEqual(w.documents);
    expect(JSON.stringify((e.save() as { documents: unknown }).documents)).toBe(JSON.stringify(JSON.parse(before).documents));
  });
});

// ---- E: alpha is tracked across resumes ----------------------------------------------------

describe("a run keeps the error-control settings it was made with", () => {
  const PAPER = { rule: "paper", delta: 0.01, beta0: 0.1, beta1: 35, ws: 1414, wc: 15, wn: 0.5, prune: 4 };
  const restore = (w: World, saved: unknown, s: ReturnType<typeof settings>) => () => new Evolution({ surface: w.surface, settings: s, split: w.split, saved });
  const CAL = { rule: "calibrated", alpha: 0.1, resamples: 400, margin: 0.02, saving: 0.05, beta0: 0.1, beta1: 35 };

  it("RS19.70 the state records the settings its alpha was paid for with: rounds, candidates, and the rule's alpha, spending, margin, saving, beta0, beta1, and the holdout's alpha and budget", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    const e = await start(w);
    expect((e.save() as { errorControl: unknown }).errorControl).toEqual({ rounds: 6, candidates: 2, "select.rule": "calibrated", "select.alpha": 0.1, "select.spending": "uniform", "select.margin": 0.02, "select.saving": 0.05, "select.beta0": 0.1, "select.beta1": 35, "holdout.alpha": 0.1, "holdout.budget": 2 });
    const geometric = await start(w, settings({ select: { ...CAL, spending: { kind: "geometric", ratio: 0.9 } } }));
    expect((geometric.save() as { errorControl: Record<string, unknown> }).errorControl["select.spending"]).toBe("geometric 0.9");
    const paper = await start(w, settings({ select: PAPER }));
    expect((paper.save() as { errorControl: unknown }).errorControl).toEqual({ rounds: 6, candidates: 2, "select.rule": "paper" });
  });

  it("RS19.71 a restore with different rounds (extending a run silently exceeds alpha), alpha, spending, margin, saving, beta or holdout settings is refused, naming each", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    const saved = JSON.parse(JSON.stringify((await start(w)).save()));
    expect(restore(w, saved, settings({ rounds: 12 }))).toThrow("the saved run was made with different error-control settings (rounds was 6 and is now 12): a run's alpha is spent against the levels of its tests, so these are kept to its end; start a new run to change them");
    expect(restore(w, saved, settings({ candidates: 3 }))).toThrow(/\(candidates was 2 and is now 3\)/);
    expect(restore(w, saved, settings({ select: { ...CAL, alpha: 0.2 }, holdout: { alpha: 0.1, budget: 3 } }))).toThrow(/\(holdout\.budget was 2 and is now 3; select\.alpha was 0\.1 and is now 0\.2\)/);
    expect(restore(w, saved, settings({ select: { ...CAL, spending: { kind: "geometric", ratio: 0.9 } } }))).toThrow(/select\.spending was uniform and is now geometric 0\.9/);
    expect(restore(w, saved, settings({ select: { ...CAL, margin: 0.03, saving: 0.06, beta0: 0.2, beta1: 30 } }))).toThrow(/select\.beta0 was 0\.1 and is now 0\.2; select\.beta1 was 35 and is now 30; select\.margin was 0\.02 and is now 0\.03; select\.saving was 0\.05 and is now 0\.06/);
    expect(restore(w, saved, settings({ holdout: { alpha: 0.2, budget: 2 } }))).toThrow(/holdout\.alpha was 0\.1 and is now 0\.2/);
    expect(restore(w, saved, settings({ select: PAPER }))).toThrow(/select\.rule was calibrated and is now paper/);
  });

  it("RS19.72 settings that only trade power or cost may change between resumes: resamples, futility, trials, the prompts", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    const saved = JSON.parse(JSON.stringify((await start(w)).save()));
    const changed = settings({ select: { ...CAL, resamples: 800, futility: { fraction: 0.5, alpha: 0.05 } }, trials: 3, proposer: { system: "Other.", maxTokens: 64 }, prune: { after: 2, every: 3 } });
    expect(restore(w, saved, changed)).not.toThrow();
  });

  it("RS19.75 a run made with the paper's rule cannot be restored with the calibrated one, and the state says what it lacks", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    const saved = JSON.parse(JSON.stringify((await start(w, settings({ select: PAPER }))).save()));
    expect(restore(w, saved, settings())).toThrow(/holdout\.alpha was absent and is now 0\.1;.*select\.rule was paper and is now calibrated/);
  });

  it("RS19.76 a state that is not an object is refused as an invalid saved evolution, not with a crash", () => {
    const w = world({ n: 40, base: () => 0.5 });
    for (const saved of [null, "state", 7, []]) expect(restore(w, saved, settings())).toThrow(/invalid saved evolution/);
  });

  it("RS19.73 a state saved before the settings were kept adopts the current ones, and holds them from then on", async () => {
    const w = world({ n: 40, base: () => 0.5 });
    const old = JSON.parse(JSON.stringify((await start(w)).save())) as Record<string, unknown>;
    delete old["errorControl"];
    const adopted = new Evolution({ surface: w.surface, settings: settings(), split: w.split, saved: old });
    const now = JSON.parse(JSON.stringify(adopted.save()));
    expect(now.errorControl).toMatchObject({ rounds: 6, "select.alpha": 0.1 });
    expect(restore(w, now, settings({ rounds: 12 }))).toThrow(/rounds was 6 and is now 12/);
  });
});

// ---- A, in the ledger ----------------------------------------------------------------------

describe("the ledger keeps the cost bounds", () => {
  it("RS19.90 a saving's record carries its point cost change and both bounds; an unbounded upper bound is left out (JSON has no infinity)", async () => {
    const w = world({ n: 40, base: (i) => (i % 2 ? 1 : 0), cost: { saver: -400 } });
    const e = await start(w);
    const { propose } = scripted((r) => (r.candidate === "A" ? toggle("saver") : toggle(`noop${r.candidate}`)));
    const report = await e.round(ports(w, propose));
    expect(report.accepted).toBe("A");
    const a = report.records.find((r) => r.candidate === "A")!.measured!;
    expect(a.costChange).toBeCloseTo(-0.4, 12);
    expect(a.costLower).toBeCloseTo(-0.4, 12);
    expect(a.costUpper).toBeCloseTo(-0.4, 12);
    expect(a.gain).toBe(0);
    // Tokens reported on disjoint halves of the tasks: a cost change exists, but nothing certifies it.
    const disjoint = async (documents: Parameters<EvolutionPorts["evaluate"]>[0], tasks: Parameters<EvolutionPorts["evaluate"]>[1], k: number) => {
      const saving = Boolean((documents["policy"] as { rules: Record<string, boolean> }).rules["saver"]);
      return (await w.evaluate(documents, tasks, k)).map((r, i) => ({ ...r, trials: r.trials.map((t) => (i % 2 === (saving ? 0 : 1) ? t : { reward: t.reward })) }));
    };
    const e2 = await start(w, settings(), w.split, disjoint);
    const report2 = await e2.round(ports(w, propose, { evaluate: disjoint }));
    const b = report2.records.find((r) => r.candidate === "A")!;
    expect(b.measured!.costChange).toBeCloseTo(-0.4, 12); // the point estimate compares the means of different tasks: that is why it certifies nothing
    expect(b.measured!.costLower).toBe(-1);
    expect(b.measured!.costUpper).toBeUndefined();
    expect(b.outcome).toBe("rejected");
    expect(b.reason).toMatch(/^the harness would spend up to unbounded tokens over the base harness/);
    // The saved state is JSON: it round-trips.
    expect(() => new Evolution({ surface: w.surface, settings: settings(), split: w.split, saved: JSON.parse(JSON.stringify(e2.save())) })).not.toThrow();
  });
});
