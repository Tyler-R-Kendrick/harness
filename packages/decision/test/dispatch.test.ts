import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { deriveFacts, dispatchFork, dispatchSettingsJsonSchema, parseDispatchSettings, switchPlan, wordsOfName } from "../src/dispatch.ts";
import type { DispatchInput, Prices, SwitchRequest } from "../src/dispatch.ts";
import { cost } from "../src/types.ts";
import type { Answers } from "../src/types.ts";
import { answer, lazy, levels } from "./loops-fixtures.ts";

const file = JSON.parse(readFileSync(new URL("../data/dispatch.json", import.meta.url), "utf8")) as Record<string, unknown>;
const shipped = lazy(() => parseDispatchSettings(file));

const tier = (input: number, cachedInput: number, cacheWrite: number, output: number) => ({ input: cost(input), cachedInput: cost(cachedInput), cacheWrite: cost(cacheWrite), output: cost(output) });
/** Per million tokens; with a context of a million tokens the sums below are in the same units. */
const prices: Prices = { large: tier(10, 1, 2, 50), small: tier(2, 0.2, 0.5, 10) };
const request = (patch: Partial<SwitchRequest> = {}): SwitchRequest => ({ context: 1e6, newOutput: 1000, expectedStretch: 10_000, from: "large", to: "small", prices, hysteresis: 0, ...patch });

describe("dispatch settings (data/dispatch.json)", () => {
  it("DSP1.1 the shipped settings parse, and name their JSON Schema, which is generated from the parser", async () => {
    expect(shipped.prices.large.output).toBeGreaterThan(shipped.prices.small.output);
    expect(file["$schema"]).toBe("./dispatch.schema.json");
    await expect(`${JSON.stringify(dispatchSettingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/dispatch.schema.json");
  });

  it("DSP1.2 settings that cannot be right are refused, naming where", () => {
    const edit = (path: readonly string[], value: unknown) => {
      const s = JSON.parse(JSON.stringify(file)) as Record<string, unknown>;
      let o: Record<string, unknown> = s;
      for (const key of path.slice(0, -1)) o = o[key] as Record<string, unknown>;
      if (value === undefined) delete o[path.at(-1)!];
      else o[path.at(-1)!] = value;
      return () => parseDispatchSettings(s);
    };
    expect(edit(["prices", "large"], undefined)).toThrow(/invalid dispatch settings[\s\S]*prices\.large/);
    expect(edit(["prices", "small", "output"], -1)).toThrow(/prices\.small\.output/);
    expect(edit(["prices", "small", "cachedInput"], 3)).toThrow(/cached input must not cost more than uncached input/);
    expect(edit(["hysteresis"], 1)).toThrow(/hysteresis/);
    expect(edit(["stepTokens"], 0)).toThrow(/stepTokens/);
    expect(edit(["stretch"], [0, 1])).toThrow(/one stretch per level[\s\S]*at stretch/);
    expect(edit(["stretch"], [0, 500, 400, 10000])).toThrow(/stretch must not shrink[\s\S]*at stretch/);
    expect(edit(["stretch"], [0, 500, 500, 10000])()).toMatchObject({ stretch: [0, 500, 500, 10000] }); // equal is not shrinking
    expect(edit(["prices", "small", "cachedInput"], 1)()).toMatchObject({ prices: { small: { cachedInput: 1, input: 1 } } }); // free caching is not dearer caching
    expect(edit(["routine", "levels"], ["only one"])).toThrow(/routine\.levels/);
    expect(edit(["protect"], { eq: ["a"] })).toThrow(/protect/);
    expect(edit(["extra"], 1)).toThrow(/extra/);
  });
});

describe("switchPlan", () => {
  it("DSP2.1 staying costs the cached reads of the context, the output and its cache write, and the cached read at the return", () => {
    // 10 steps of 1M cached at 1, 10k output at 50 + 2 written, then the next call reads 1.01M cached at 1
    expect(switchPlan(request()).stayCost).toBeCloseTo(10 + (10_000 * 52) / 1e6 + 1.01, 9);
  });

  it("DSP2.2 switching costs priming the small tier's cache, its cheap reads and output, and the return's uncached read of everything", () => {
    // priming 1M at (2 + 0.5), cached reads counted for 10 steps (the priming is one of them: minus 0.2), output at 10 + 0.5, return 1.01M at (10 + 2)
    expect(switchPlan(request()).switchCost).toBeCloseTo(1 * (2 + 0.5 - 0.2) + 10 * 0.2 + (10_000 * 10.5) / 1e6 + 1.01 * 12, 9);
  });

  it("DSP2.3 it switches only when the stretch is past the break-even, which it reports", () => {
    const at = (expectedStretch: number) => switchPlan(request({ expectedStretch }));
    const even = at(10_000).breakEvenStretch;
    expect(even).toBeCloseTo(13.3e6 / 830.5, 3);
    expect(at(10_000).switch).toBe(false);
    expect(at(even - 100).switch).toBe(false);
    expect(at(even + 100).switch).toBe(true);
    expect(at(20_000).switch).toBe(true);
    expect(at(20_000).stayCost - at(20_000).switchCost).toBeCloseTo(3.31, 2);
  });

  it("DSP2.4 hysteresis asks for savings above a share of what staying costs, and moves the break-even with it", () => {
    const plain = switchPlan(request({ expectedStretch: 20_000 }));
    const savedShare = (plain.stayCost - plain.switchCost) / plain.stayCost;
    expect(savedShare).toBeGreaterThan(0.1);
    expect(switchPlan(request({ expectedStretch: 20_000, hysteresis: savedShare - 0.01 })).switch).toBe(true);
    const held = switchPlan(request({ expectedStretch: 20_000, hysteresis: savedShare + 0.01 }));
    expect(held.switch).toBe(false);
    expect(held.breakEvenStretch).toBeGreaterThan(20_000);
    expect(switchPlan(request({ expectedStretch: held.breakEvenStretch + 100, hysteresis: savedShare + 0.01 })).switch).toBe(true);
  });

  it("DSP2.5 the same tier is never switched to", () => {
    const plan = switchPlan(request({ to: "large", expectedStretch: 1e9 }));
    expect(plan).toEqual({ switch: false, stayCost: plan.stayCost, switchCost: plan.stayCost, breakEvenStretch: Infinity });
  });

  it("DSP2.6 a stretch of nothing never pays for a switch", () => {
    const plan = switchPlan(request({ expectedStretch: 0 }));
    expect(plan.switch).toBe(false);
    expect(plan.switchCost).toBeGreaterThan(plan.stayCost);
  });

  it("DSP2.7 a tier that saves nothing per token of the stretch never breaks even", () => {
    const plan = switchPlan(request({ from: "small", to: "large", expectedStretch: 1e12 }));
    expect(plan.switch).toBe(false);
    expect(plan.breakEvenStretch).toBe(Infinity);
  });

  it("DSP2.8 with an empty context switching costs nothing to start and pays from the first token", () => {
    const plan = switchPlan(request({ context: 0, expectedStretch: 1 }));
    expect(plan.breakEvenStretch).toBe(0);
    expect(plan.switch).toBe(true);
  });

  it("DSP2.10 tiers priced the same with free input never break even, even with nothing to read", () => {
    const free: Prices = { large: tier(0, 0, 0, 1), small: tier(0, 0, 0, 1) };
    expect(switchPlan(request({ context: 0, prices: free })).breakEvenStretch).toBe(Infinity);
    expect(switchPlan(request({ prices: free })).switch).toBe(false);
  });

  it("DSP2.11 when staying and switching cost the same nothing is gained, so it stays", () => {
    const plan = switchPlan(request({ context: 0, expectedStretch: 0 }));
    expect([plan.stayCost, plan.switchCost, plan.switch]).toEqual([0, 0, false]);
  });

  it("DSP2.9 what cannot be planned is refused, saying why", () => {
    expect(() => switchPlan(request({ context: -1 }))).toThrow("context must be a finite number of tokens, 0 or more, got -1");
    expect(() => switchPlan(request({ expectedStretch: Number.NaN }))).toThrow("expectedStretch must be a finite number of tokens, 0 or more, got NaN");
    expect(() => switchPlan(request({ newOutput: 0 }))).toThrow("newOutput must be a positive, finite number of tokens, got 0");
    expect(() => switchPlan(request({ hysteresis: 1 }))).toThrow("hysteresis must be at least 0 and below 1, got 1");
    expect(() => switchPlan(request({ hysteresis: -0.1 }))).toThrow("hysteresis must be at least 0 and below 1, got -0.1");
    expect(() => switchPlan(request({ from: "medium" }))).toThrow('no prices for tier "medium"');
    expect(() => switchPlan(request({ to: "medium" }))).toThrow('no prices for tier "medium"');
  });
});

// ---- the fork -----------------------------------------------------------------------------------------

const input = (patch: Partial<DispatchInput> = {}): DispatchInput => ({ context: 100_000, current: "large", task: "rename the helper across the repo", ...patch });
const routine = (weights: readonly number[]): Answers => ({ routine: levels(weights) });
const fork = lazy(() => dispatchFork(shipped));

describe("dispatchFork", () => {
  it("DSP3.1 asks one score question, how routine the next steps are, with a level for each stretch", () => {
    const asked = fork.ask(input());
    expect(Object.keys(asked.questions)).toEqual(["routine"]);
    expect(asked.questions["routine"]).toEqual({ type: "score", instructions: shipped.routine.instructions, criteria: shipped.routine.levels });
    expect(asked.state).toEqual({ task: "rename the helper across the repo", context: 100_000, current: "large" });
    expect(fork.ask(input({ facts: { irreversible: false } })).state).toMatchObject({ facts: { irreversible: false } });
  });

  it("DSP3.2 is identified by its id and the version in its settings", () => {
    expect(fork.id).toBe("dispatch");
    expect(fork.version).toBe(shipped.version);
  });

  it("DSP3.3 on the large tier, a long routine stretch switches down and a short one stays", () => {
    expect(fork.interpret(routine([0, 0, 0, 1]), input())?.action).toBe("small");
    expect(fork.interpret(routine([1, 0, 0, 0]), input())?.action).toBe("stay");
    expect(fork.interpret(routine([0, 1, 0, 0]), input())?.action).toBe("stay");
  });

  it("DSP3.4 a larger context needs a longer stretch to pay for switching, so the same answer can stay", () => {
    const answers = routine([0, 0, 1, 0]); // level 2: about 2,500 tokens of routine work
    expect(fork.interpret(answers, input({ context: 1000 }))?.action).toBe("small");
    expect(fork.interpret(answers, input({ context: 400_000 }))?.action).toBe("stay");
  });

  it("DSP3.5 the expected level is mapped to a stretch by interpolating between levels", () => {
    // half on level 2 (2,500) and half on level 3 (10,000): expected level 2.5, a stretch of 6,250
    const plan = (context: number) => fork.interpret(routine([0, 0, 1, 1]), input({ context }));
    expect(plan(100_000)?.action).toBe("stay"); // break-even at 100k is about 6,000 tokens plus the 15% margin
    expect(plan(20_000)?.action).toBe("small");
  });

  it("DSP3.6 on the small tier it goes back to large when the routine stretch would not pay for being small, and stays otherwise", () => {
    expect(fork.interpret(routine([1, 0, 0, 0]), input({ current: "small" }))?.action).toBe("large");
    expect(fork.interpret(routine([0, 0, 0, 1]), input({ current: "small" }))?.action).toBe("stay");
  });

  it("DSP3.7 between where switching down starts to pay and where it pays past the margin, each tier stays where it is", () => {
    const answers = routine([0, 0, 1, 1]);
    const context = 60_000;
    const large = fork.interpret(answers, input({ context }))?.action;
    const small = fork.interpret(answers, input({ context, current: "small" }))?.action;
    expect(large).toBe("stay");
    expect(small).toBe("stay");
  });

  it("DSP3.8 the confidence is the probability mass on levels that give the same action", () => {
    expect(fork.interpret(routine([0, 0, 0, 1]), input())?.confidence).toBeCloseTo(1, 9);
    // 70% on level 3 (switch down), 30% on level 0 (stay): the mean level 2.1 is a stretch that stays, so the action is stay at 0.3
    const v = fork.interpret(routine([0.3, 0, 0, 0.7]), input({ context: 100_000 }));
    expect(v?.action).toBe("stay");
    expect(v?.confidence).toBeCloseTo(0.3, 9);
  });

  it("DSP3.9 an answer that is not a score over the settings' levels gives no verdict", () => {
    expect(fork.interpret({}, input())).toBeUndefined();
    expect(fork.interpret({ routine: answer("boolean", { true: 1, false: 1 }) }, input())).toBeUndefined();
    expect(fork.interpret(routine([1, 1, 1]), input())).toBeUndefined();
    expect(fork.interpret(routine([1, 1, 1, 1, 1]), input())).toBeUndefined();
    const named = (names: string[]): Answers => ({ routine: answer("score", Object.fromEntries(names.map((n) => [n, 1]))) });
    expect(fork.interpret(named(["1", "2", "3", "4"]), input())).toBeUndefined();
    expect(fork.interpret(named(["0", "x", "y", "z"]), input())).toBeUndefined();
    expect(fork.interpret(named(["0", "1", "2", "3"]), input())).toBeDefined();
  });

  it("DSP3.10 the safe action when nothing decides is to stay", () => {
    expect(fork.fallback(input())).toBe("stay");
    expect(fork.fallback(input({ current: "small" }))).toBe("stay");
  });

  it("DSP3.11 staying on the large tier is the more restrictive action, and downgrading the least", () => {
    const rank = fork.restrictiveness!;
    expect(rank("small")).toBeLessThan(rank("stay"));
    expect(rank("stay")).toBeLessThan(rank("large"));
  });

  it("DSP3.12 an input that must not be downgraded keeps the large tier: a floor of staying, or of going back", () => {
    expect(fork.floor?.(input())).toBeUndefined();
    expect(fork.floor?.(input({ facts: { irreversible: false } }))).toBeUndefined();
    expect(fork.floor?.(input({ facts: { irreversible: true } }))).toBe("stay");
    expect(fork.floor?.(input({ facts: { production: true } }))).toBe("stay");
    expect(fork.floor?.(input({ facts: { irreversible: true }, current: "small" }))).toBe("large");
  });

  it("DSP3.13 the actions on offer are staying or switching to the other tier", () => {
    expect(fork.actions?.(input())).toEqual(["stay", "small"]);
    expect(fork.actions?.(input({ current: "small" }))).toEqual(["stay", "large"]);
  });

  it("DSP3.14 records keep the input as the caller described it", () => {
    expect(fork.describe(input())).toStrictEqual({ task: "rename the helper across the repo", context: 100_000, current: "large" });
    expect(fork.describe(input({ facts: { irreversible: true } }))).toEqual({ task: "rename the helper across the repo", context: 100_000, current: "large", facts: { irreversible: true } });
  });

  it("DSP3.15 confidence is a probability in range even when the answer's mass rounds above one", () => {
    const v = fork.interpret(routine([0.1, 0.2, 0.3, 0.4]), input());
    expect(v?.confidence).toBeGreaterThanOrEqual(0);
    expect(v?.confidence).toBeLessThanOrEqual(1);
    expect(probability(v!.confidence)).toBe(v!.confidence);
  });
});

describe("the facts of a step", () => {
  const derive = { irreversible: ["delete", "rm"], production: ["deploy"] };
  const facts = (calls: Parameters<typeof deriveFacts>[1], over: Parameters<typeof deriveFacts>[0] = derive) => deriveFacts(over, calls);

  it("DSP5.1 the shipped settings name the words that make a step irreversible or about production, and parse them", () => {
    expect(shipped.derive?.["irreversible"]).toContain("delete");
    expect(shipped.derive?.["production"]).toContain("deploy");
    const protectedFacts = Object.keys(shipped.derive ?? {});
    expect(protectedFacts).toEqual(expect.arrayContaining(["irreversible", "production"]));
  });

  it("DSP5.2 words that are not lowercase letters and digits, an empty list, or a fact with no name are refused", () => {
    const edit = (derive: unknown) => () => parseDispatchSettings({ ...file, derive });
    expect(edit({ irreversible: ["Delete"] })).toThrow(/a word is lowercase letters and digits[\s\S]*derive/);
    expect(edit({ irreversible: ["rm -rf"] })).toThrow(/derive/);
    expect(edit({ irreversible: [] })).toThrow(/derive/);
    expect(edit({ irreversible: [""] })).toThrow(/derive/);
    expect(edit({ "": ["rm"] })).toThrow(/derive/);
    expect(edit({ irreversible: ["rm"], x2: ["b9"] })()).toMatchObject({ derive: { x2: ["b9"] } });
    const { derive: _derive, ...without } = file;
    expect(parseDispatchSettings(without).derive).toBeUndefined();
  });

  it("DSP5.3 the words of a name are split at anything that is not a letter or a digit and at camelCase humps, in lowercase", () => {
    expect(wordsOfName("deleteFile")).toEqual(["delete", "file"]);
    expect(wordsOfName("drop_table-v2")).toEqual(["drop", "table", "v2"]);
    expect(wordsOfName("  rm -rf /tmp/x ")).toEqual(["rm", "rf", "tmp", "x"]);
    expect(wordsOfName("a1B")).toEqual(["a1", "b"]);
    expect(wordsOfName("")).toEqual([]);
  });

  it("DSP5.4 a fact is true when a word of a tool's name is one listed for it", () => {
    expect(facts([{ toolName: "delete_file" }])).toStrictEqual({ irreversible: true });
    expect(facts([{ toolName: "grep" }, { toolName: "Deploy" }])).toStrictEqual({ production: true });
    expect(facts([{ toolName: "deleteFile" }, { toolName: "deploy.sh" }])).toStrictEqual({ irreversible: true, production: true });
  });

  it("DSP5.5 a word has to be a whole word of the name: format is not rm, and undeploy is not deploy", () => {
    expect(facts([{ toolName: "format" }, { toolName: "undeploy" }, { toolName: "terms" }])).toBeUndefined();
  });

  it("DSP5.6 the command a tool was given is read for words too, and nothing else it was given", () => {
    expect(facts([{ toolName: "bash", input: { command: "cd x && rm -rf build" } }])).toStrictEqual({ irreversible: true });
    expect(facts([{ toolName: "edit", input: { new_string: "delete everything", path: "deploy.ts" } }])).toBeUndefined();
    expect(facts([{ toolName: "bash", input: "rm -rf" }, { toolName: "bash", input: ["rm"] }, { toolName: "bash", input: null }, { toolName: "bash", input: { command: 5 } }, { toolName: "bash" }])).toBeUndefined();
  });

  it("DSP5.7 only the first thousand characters of a command are read", () => {
    expect(facts([{ toolName: "bash", input: { command: `${"x ".repeat(500)}rm` } }])).toBeUndefined();
    expect(facts([{ toolName: "bash", input: { command: `${"x ".repeat(499)}rm` } }])).toStrictEqual({ irreversible: true });
  });

  it("DSP5.8 a step with no risky call has no facts, and nothing is derived without settings for it", () => {
    expect(facts([])).toBeUndefined();
    expect(facts([{ toolName: "grep" }])).toBeUndefined();
    expect(deriveFacts(undefined, [{ toolName: "delete" }])).toBeUndefined();
    expect(facts([{ toolName: "delete" }], {})).toBeUndefined();
  });

  it("DSP5.9 with the shipped settings, a step that deletes or deploys is held on the large tier by the floor", () => {
    for (const toolName of ["delete_file", "rm", "deploy"]) {
      const derived = deriveFacts(shipped.derive, [{ toolName }]);
      expect(fork.floor?.(input({ ...(derived === undefined ? {} : { facts: derived }) })), toolName).toBe("stay");
    }
    expect(fork.floor?.(input({ ...(deriveFacts(shipped.derive, [{ toolName: "grep" }, { toolName: "edit" }]) === undefined ? {} : { facts: { irreversible: true } }) }))).toBeUndefined();
  });

  it("DSP5.10 what a model and a record are shown of the task and the facts has its secrets removed", () => {
    const described = fork.describe(input({ task: "export OPENAI_API_KEY=sk-live-1 then rename", facts: { irreversible: true, token: "t1", note: "password=p1" } })) as { task: string; facts: Record<string, unknown> };
    expect(described.task).toBe("export OPENAI_API_KEY=[redacted] then rename");
    expect(described.facts).toStrictEqual({ irreversible: true, token: "[redacted]", note: "password=[redacted]" });
    expect(fork.ask(input({ task: "secret: s1" })).state).toMatchObject({ task: "secret: [redacted]" });
  });
});
