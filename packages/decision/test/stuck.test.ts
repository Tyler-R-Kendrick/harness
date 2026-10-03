import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectStuck, parseStuckSettings, stuckFork, stuckSettingsJsonSchema } from "../src/stuck.ts";
import type { StuckInput, StuckSettings, StuckStep } from "../src/stuck.ts";
import { lazy, levels, yes } from "./loops-fixtures.ts";

const file = JSON.parse(readFileSync(new URL("../data/stuck.json", import.meta.url), "utf8")) as Record<string, unknown>;
const shipped = lazy(() => parseStuckSettings(file));

type Patch = { repeat?: { times?: number }; cycle?: { maxPeriod?: number; repeats?: number }; progress?: { window?: number }; escalate?: { repeat?: number; cycle?: number; noProgress?: number } };
const settings = (patch: Patch = {}): StuckSettings =>
  parseStuckSettings({
    ...file,
    repeat: { times: 3, ...patch.repeat },
    cycle: { maxPeriod: 4, repeats: 3, ...patch.cycle },
    progress: { window: 4, ...patch.progress },
    escalate: { repeat: 6, cycle: 5, noProgress: 8, ...patch.escalate },
  });

const acts = (...names: string[]): StuckStep[] => names.map((action) => ({ action }));
const at = (values: readonly (number | undefined)[]): StuckStep[] => values.map((progress, i) => ({ action: `a${i}`, ...(progress === undefined ? {} : { progress }) }));

describe("stuck settings (data/stuck.json)", () => {
  it("STK1.1 the shipped settings parse, and name their JSON Schema, which is generated from the parser", async () => {
    expect(shipped.repeat.times).toBeGreaterThan(1);
    expect(file["$schema"]).toBe("./stuck.schema.json");
    await expect(`${JSON.stringify(stuckSettingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/stuck.schema.json");
  });

  it("STK1.2 settings that cannot be right are refused, naming where", () => {
    const edit = (path: readonly string[], value: unknown) => {
      const s = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
      let o: Record<string, unknown> = s;
      for (const key of path.slice(0, -1)) o = o[key] as Record<string, unknown>;
      o[path.at(-1)!] = value;
      return () => parseStuckSettings(s);
    };
    // the edits that must be refused throw when called; the ones that must be accepted return the settings when called
    expect(edit(["repeat", "times"], 1)).toThrow(/invalid stuck settings[\s\S]*repeat\.times/);
    expect(edit(["cycle", "maxPeriod"], 1)).toThrow(/cycle\.maxPeriod/);
    expect(edit(["cycle", "repeats"], 1)).toThrow(/cycle\.repeats/);
    expect(edit(["progress", "window"], 1)).toThrow(/progress\.window/);
    expect(edit(["escalate", "repeat"], 2)).toThrow(/escalation is at or above detection[\s\S]*escalate\.repeat/);
    expect(edit(["escalate", "cycle"], 2)).toThrow(/escalation is at or above detection[\s\S]*escalate\.cycle/);
    expect(edit(["escalate", "noProgress"], 5)).toThrow(/escalation is at or above detection[\s\S]*escalate\.noProgress/);
    expect(edit(["escalate", "repeat"], 3)()).toMatchObject({ escalate: { repeat: 3 } }); // escalating at the moment of detection is allowed
    expect(edit(["escalate", "cycle"], 3)()).toMatchObject({ escalate: { cycle: 3 } });
    expect(edit(["escalate", "noProgress"], 6)()).toMatchObject({ escalate: { noProgress: 6 } });
    expect(edit(["recent"], 0)).toThrow(/recent/);
    expect(edit(["chars"], 0)).toThrow(/chars/);
    expect(edit(["question", "instructions"], "")).toThrow(/question\.instructions/);
    expect(edit(["extra"], 1)).toThrow(/extra/);
  });
});

describe("detectStuck: repeats", () => {
  it("STK2.1 no steps is not stuck", () => {
    expect(detectStuck([], settings())).toEqual({ stuck: false, kind: "none", evidence: "no repeat, cycle or stall in 0 steps", count: 0 });
  });

  it("STK2.2 the same action and state k times in a row is a repeat, and says what and how often", () => {
    const steps = [...acts("read"), { action: "edit", state: "e1" }, { action: "edit", state: "e1" }, { action: "edit", state: "e1" }, { action: "edit", state: "e1" }];
    expect(detectStuck(steps, settings())).toEqual({ stuck: true, kind: "repeat", evidence: 'the last 4 steps are all "edit" with the same state', count: 4 });
  });

  it("STK2.3 a repeat without a state is named by its action alone, and one step less than k is not a repeat", () => {
    expect(detectStuck(acts("x", "x", "x"), settings())).toMatchObject({ stuck: true, kind: "repeat", evidence: 'the last 3 steps are all "x"' });
    expect(detectStuck(acts("x", "x"), settings())).toMatchObject({ stuck: false });
  });

  it("STK2.4 a changed state or action breaks the run", () => {
    const changed = [{ action: "edit", state: "e1" }, { action: "edit", state: "e2" }, { action: "edit", state: "e1" }];
    expect(detectStuck(changed, settings({ cycle: { maxPeriod: 2, repeats: 9 }, escalate: { cycle: 9 } }))).toMatchObject({ stuck: false });
    expect(detectStuck(acts("x", "x", "y"), settings())).toMatchObject({ stuck: false });
    expect(detectStuck([{ action: "x" }, { action: "x", state: "s" }, { action: "x" }], settings())).toMatchObject({ stuck: false });
  });

  it("STK2.5 only the run at the end counts: an earlier repeat that the agent got out of is not stuck", () => {
    expect(detectStuck(acts("x", "x", "x", "x", "y"), settings())).toMatchObject({ stuck: false });
  });

  it("STK2.6 the threshold is the setting", () => {
    expect(detectStuck(acts("x", "x"), settings({ repeat: { times: 2 } }))).toMatchObject({ stuck: true, kind: "repeat", count: 2 });
    expect(detectStuck(acts("x", "x", "x", "x"), settings({ repeat: { times: 5 }, escalate: { repeat: 5 } }))).toMatchObject({ stuck: false });
  });
});

describe("detectStuck: cycles", () => {
  it("STK2.7 a block of two steps repeated three times is a cycle of period 2", () => {
    expect(detectStuck(acts("a", "b", "a", "b", "a", "b"), settings())).toEqual({ stuck: true, kind: "cycle", evidence: "the last 6 steps repeat a cycle of 2 steps (a, b) 3 times", count: 3 });
  });

  it("STK2.8 the cycle is counted from the end, and the steps before it do not matter", () => {
    expect(detectStuck(acts("x", "y", "a", "b", "c", "a", "b", "c", "a", "b", "c"), settings())).toMatchObject({ kind: "cycle", count: 3, evidence: "the last 9 steps repeat a cycle of 3 steps (a, b, c) 3 times" });
  });

  it("STK2.9 a partial last period counts as a repeat of what was repeated: two full periods and a bit is two periods", () => {
    expect(detectStuck(acts("a", "b", "a", "b", "a"), settings())).toMatchObject({ stuck: false });
    expect(detectStuck(acts("a", "b", "a", "b", "a"), settings({ cycle: { repeats: 2 } }))).toMatchObject({ kind: "cycle", count: 2 });
  });

  it("STK2.10 periods above the maximum are not looked for", () => {
    const steps = acts("a", "b", "c", "a", "b", "c", "a", "b", "c");
    expect(detectStuck(steps, settings({ cycle: { maxPeriod: 2 } }))).toMatchObject({ stuck: false });
    expect(detectStuck(steps, settings({ cycle: { maxPeriod: 3 } }))).toMatchObject({ kind: "cycle" });
  });

  it("STK2.11 fewer repeats than the setting is not a cycle", () => {
    expect(detectStuck(acts("a", "b", "a", "b"), settings())).toMatchObject({ stuck: false });
  });

  it("STK2.12 the smallest period is the one reported", () => {
    expect(detectStuck(acts("a", "b", "a", "b", "a", "b", "a", "b"), settings())).toMatchObject({ kind: "cycle", count: 4, evidence: "the last 8 steps repeat a cycle of 2 steps (a, b) 4 times" });
  });

  it("STK2.13 a block of one repeated step is a repeat, never a cycle", () => {
    const steps = acts("a", "a", "a", "a", "a", "a");
    expect(detectStuck(steps, settings({ repeat: { times: 9 }, escalate: { repeat: 9 } }))).toMatchObject({ stuck: false });
  });

  it("STK2.14 steps in a cycle differ by state as well as action", () => {
    const steps: StuckStep[] = [1, 2, 1, 2, 1, 2].map((n) => ({ action: "edit", state: `s${n}` }));
    expect(detectStuck(steps, settings())).toMatchObject({ kind: "cycle", evidence: "the last 6 steps repeat a cycle of 2 steps (edit [s1], edit [s2]) 3 times" });
  });

  it("STK2.15 a repeat is reported before a cycle", () => {
    expect(detectStuck(acts("a", "b", "b", "b"), settings())).toMatchObject({ kind: "repeat" });
  });
});

describe("detectStuck: no progress", () => {
  it("STK2.16 no strict rise in progress over the window is no progress", () => {
    expect(detectStuck(at([1, 1, 1, 1]), settings())).toEqual({ stuck: true, kind: "no-progress", evidence: "progress has not risen in the last 4 steps (it is 1)", count: 3 });
    expect(detectStuck(at([3, 2, 2, 1]), settings())).toMatchObject({ kind: "no-progress" });
  });

  it("STK2.17 any rise inside the window is progress", () => {
    expect(detectStuck(at([1, 1, 1, 2]), settings())).toMatchObject({ stuck: false });
    expect(detectStuck(at([1, 2, 2, 2]), settings())).toMatchObject({ stuck: false });
  });

  it("STK2.18 what counts as a rise is measured against the best before it, also before the window", () => {
    expect(detectStuck(at([5, 3, 4, 5, 5]), settings())).toMatchObject({ kind: "no-progress", count: 4 });
    expect(detectStuck(at([5, 3, 4, 5, 6]), settings())).toMatchObject({ stuck: false });
  });

  it("STK2.19 fewer steps than the window cannot be said to have stalled", () => {
    expect(detectStuck(at([1, 1, 1]), settings())).toMatchObject({ stuck: false });
  });

  it("STK2.20 steps that report no progress at all say nothing about it", () => {
    expect(detectStuck(at([undefined, undefined, undefined, undefined, undefined]), settings())).toMatchObject({ stuck: false });
  });

  it("STK2.25 a single reported value is a baseline, not a stall", () => {
    expect(detectStuck(at([undefined, undefined, undefined, 3]), settings())).toMatchObject({ stuck: false });
    expect(detectStuck(at([undefined, undefined, 3, 3]), settings())).toMatchObject({ kind: "no-progress", count: 1 });
  });

  it("STK2.26 a rise at the first step of the window is inside the window; one just before it is not", () => {
    expect(detectStuck(at([1, 2, 2, 2, 2]), settings())).toMatchObject({ stuck: false });
    expect(detectStuck(at([1, 2, 2, 2, 2, 2]), settings())).toMatchObject({ kind: "no-progress", count: 4 });
  });

  it("STK2.27 progress reported only before the window says nothing about the window", () => {
    expect(detectStuck(at([1, 1, undefined, undefined, undefined, undefined]), settings())).toMatchObject({ stuck: false });
  });

  it("STK2.21 steps without a progress value do not break a stall, and a rise is seen through them", () => {
    expect(detectStuck(at([2, undefined, 2, undefined, 2]), settings())).toMatchObject({ kind: "no-progress", evidence: "progress has not risen in the last 4 steps (it is 2)" });
    expect(detectStuck(at([2, undefined, 2, undefined, 3]), settings())).toMatchObject({ stuck: false });
  });

  it("STK2.22 the count is the steps since progress last rose, which can be more than the window", () => {
    expect(detectStuck(at([1, 2, 2, 2, 2, 2, 2]), settings())).toMatchObject({ kind: "no-progress", count: 5 });
  });

  it("STK2.23 the window is the setting", () => {
    expect(detectStuck(at([1, 1, 1, 1]), settings({ progress: { window: 5 } }))).toMatchObject({ stuck: false });
    expect(detectStuck(at([1, 1]), settings({ progress: { window: 2 } }))).toMatchObject({ kind: "no-progress", count: 1 });
  });

  it("STK2.24 a cycle is reported before a stall, and a repeat before both", () => {
    const flat = (names: string[]) => names.map((action) => ({ action, progress: 1 }));
    expect(detectStuck(flat(["a", "b", "a", "b", "a", "b"]), settings())).toMatchObject({ kind: "cycle" });
    expect(detectStuck(flat(["a", "a", "a", "a"]), settings())).toMatchObject({ kind: "repeat" });
  });
});

// ---- the fork ---------------------------------------------------------------------------------------------

const input = (steps: readonly StuckStep[], goal = "make the tests pass"): StuckInput => ({ goal, steps });
const fork = lazy(() => stuckFork(shipped));
const many = (n: number, step: StuckStep = { action: "run tests", state: "3 failing" }): StuckStep[] => Array.from({ length: n }, () => step);
const varied = (n: number): StuckStep[] => Array.from({ length: n }, (_, i) => ({ action: `step ${i}`, progress: i }));

describe("stuckFork", () => {
  it("STK3.1 asks whether the agent is making progress, over the goal and the recent steps only", () => {
    const asked = fork.ask(input(varied(20)));
    expect(Object.keys(asked.questions)).toEqual(["progress"]);
    expect(asked.questions["progress"]).toEqual({ type: "boolean", instructions: shipped.question.instructions, criteria: shipped.question.criteria });
    const state = asked.state as unknown as { goal: string; steps: StuckStep[] };
    expect(state.goal).toBe("make the tests pass");
    expect(state.steps).toHaveLength(shipped.recent);
    expect(state.steps.at(-1)).toEqual({ action: "step 19", progress: 19 });
    expect(state.steps[0]).toEqual({ action: "step 8", progress: 8 });
  });

  it("STK3.12 a question without criteria is asked without them", () => {
    const bare = stuckFork(parseStuckSettings({ ...file, question: { instructions: "progress?" } }));
    expect(bare.ask(input([])).questions["progress"]).toStrictEqual({ type: "boolean", instructions: "progress?" });
  });

  it("STK3.2 is identified by its id and the version in its settings", () => {
    expect(fork.id).toBe("stuck");
    expect(fork.version).toBe(shipped.version);
  });

  it("STK3.3 the rule rung answers when the detector finds a repeat, a cycle or a stall: warn, and escalate when it is severe", () => {
    expect(fork.rule?.(input(many(3)))).toBe("warn");
    expect(fork.rule?.(input(many(5)))).toBe("warn");
    expect(fork.rule?.(input(many(6)))).toBe("escalate");
    const cycle = (periods: number) => Array.from({ length: periods }, () => [{ action: "a" }, { action: "b" }]).flat();
    expect(fork.rule?.(input(cycle(3)))).toBe("warn");
    expect(fork.rule?.(input(cycle(4)))).toBe("warn");
    expect(fork.rule?.(input(cycle(5)))).toBe("escalate");
    const stall = (n: number) => Array.from({ length: n }, (_, i) => ({ action: `s${i}`, progress: 1 }));
    expect(fork.rule?.(input(stall(6)))).toBe("warn");
    expect(fork.rule?.(input(stall(12)))).toBe("warn"); // 11 steps since progress rose
    expect(fork.rule?.(input(stall(13)))).toBe("escalate");
  });

  it("STK3.4 the rule has nothing to say when the steps are not stuck", () => {
    expect(fork.rule?.(input(varied(8)))).toBeUndefined();
    expect(fork.rule?.(input([]))).toBeUndefined();
  });

  it("STK3.5 the floor is what the detector says, so a model can raise a verdict and never lower it", () => {
    expect(fork.floor?.(input(many(3)))).toBe("warn");
    expect(fork.floor?.(input(many(9)))).toBe("escalate");
    expect(fork.floor?.(input(varied(8)))).toBeUndefined();
  });

  it("STK3.6 restrictiveness rises from continue to warn to escalate", () => {
    const rank = fork.restrictiveness!;
    expect(rank("continue")).toBeLessThan(rank("warn"));
    expect(rank("warn")).toBeLessThan(rank("escalate"));
  });

  it("STK3.7 the model saying progress is being made continues, at the probability, and saying it is not warns", () => {
    expect(fork.interpret({ progress: yes(0.9) }, input(varied(4)))).toEqual({ action: "continue", confidence: 0.9 });
    const stalled = fork.interpret({ progress: yes(0.2) }, input(varied(4)));
    expect(stalled?.action).toBe("warn");
    expect(stalled?.confidence).toBeCloseTo(0.8, 12);
    expect(fork.interpret({ progress: yes(0.5) }, input(varied(4)))?.action).toBe("continue");
  });

  it("STK3.8 an answer that is not a boolean, or none, gives no verdict", () => {
    expect(fork.interpret({}, input(varied(4)))).toBeUndefined();
    expect(fork.interpret({ progress: levels([1, 1]) }, input(varied(4)))).toBeUndefined();
  });

  it("STK3.9 the safe action when nothing decides is to warn", () => {
    expect(fork.fallback(input([]))).toBe("warn");
  });

  it("STK3.10 the actions on offer are all three", () => {
    expect(fork.actions?.(input([]))).toEqual(["continue", "warn", "escalate"]);
  });

  it("STK3.11 records keep the goal and the recent steps, each shortened, and nothing else", () => {
    const long = "x".repeat(500);
    const described = fork.describe({ goal: long, steps: [{ action: long, state: long, progress: 2 }, { action: "b" }] }) as { goal: string; steps: Record<string, unknown>[] };
    expect(described.goal).toHaveLength(shipped.chars);
    expect(described.steps[0]).toEqual({ action: "x".repeat(shipped.chars), state: "x".repeat(shipped.chars), progress: 2 });
    expect(described.steps[1]).toStrictEqual({ action: "b" });
    expect((fork.describe(input(varied(30))) as { steps: unknown[] }).steps).toHaveLength(shipped.recent);
  });

  it("STK6.1 records keep the goal and the steps with their secrets removed", () => {
    const described = fork.describe({
      goal: "export OPENAI_API_KEY=sk-live-1 and deploy with password: hunter2",
      steps: [{ action: "curl -H 'Authorization: Bearer sk-live-2' https://x --token abc", state: "password=zzz", progress: 1 }],
    }) as { goal: string; steps: Record<string, unknown>[] };
    expect(described.goal).toBe("export OPENAI_API_KEY=[redacted] and deploy with password: [redacted]");
    expect(described.steps[0]).toStrictEqual({ action: "curl -H 'Authorization: [redacted]' https://x --token [redacted]", state: "password=[redacted]", progress: 1 });
  });

  it("STK6.2 a model is shown the goal and the steps with their secrets removed, and the detector still sees them as they are", () => {
    const secret: StuckInput = { goal: "token=g1", steps: acts("run key=a1", "run key=a2", "run key=a3") };
    expect(JSON.stringify(fork.ask(secret).state)).not.toMatch(/g1|a1|a2|a3/);
    expect(fork.rule?.(secret)).toBeUndefined(); // three different actions are not a repeat, though they would be the same once scrubbed
  });
});
