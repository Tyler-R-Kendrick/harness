import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { NoOutputGeneratedError } from "ai";
import { promptText, scriptedModel } from "@harness/testkit";
import {
  criteriaFromFork,
  CriteriaArchive,
  DEFAULT_RESAMPLES,
  evaluateCriteria,
  evolve,
  evolveSettingsJsonSchema,
  EXACT_LIMIT,
  gainLowerBound,
  llmProposer,
  mulberry32,
  pairedSignFlipTest,
  parseEvolveSettings,
  replayCriteria,
  standardNormalQuantile,
} from "../src/evolve.ts";
import type { CriteriaBook, Failure, ProposalInput, Proposer } from "../src/evolve.ts";
import { DecisionError, forkId } from "../src/types.ts";
import type { Answers, Fork, Json } from "../src/types.ts";
import { memberOf, outcome, record, yes } from "./loops-fixtures.ts";
import { gate, INSTRUCTIONS, labelOf, reader, records, SALT, settings, shipped, sideOf } from "./evolve-fixtures.ts";
import type { Act, In } from "./evolve-fixtures.ts";

const initial = (): CriteriaBook => criteriaFromFork(gate(), { kind: "x" }, "v0");
const NET_AND_DISK = "Is the call risky? Watch for: disk, net.";
const widen = (text = NET_AND_DISK): Proposer => async () => [{ question: "risky", target: "instructions", text }];

describe("the exact paired sign-flip test", () => {
  const opts = { alpha: 0.05 };

  it("EVO5.1 when every difference is positive, the p-value is one over the number of sign patterns", () => {
    expect(pairedSignFlipTest([1, 1, 1], opts)).toEqual({ pValue: 1 / 8, meanDiff: 1, significant: false, n: 3, exact: true });
    expect(pairedSignFlipTest([1, 1, 1, 1, 1], opts)).toMatchObject({ pValue: 1 / 32, significant: true });
  });

  it("EVO5.2 two differences that cancel give the chance of a sum at least that large, counted over all four patterns", () => {
    expect(pairedSignFlipTest([1, -1], opts).pValue).toBe(0.75);
    expect(pairedSignFlipTest([2, -1], opts).pValue).toBe(0.5);
  });

  it("EVO5.3 differences of zero change neither the p-value nor the patterns, but are in the mean", () => {
    const result = pairedSignFlipTest([1, 0, 1, 0, 1, 0], opts);
    expect(result.pValue).toBe(1 / 8);
    expect(result.n).toBe(3);
    expect(result.meanDiff).toBe(0.5);
  });

  it("EVO5.4 no differences, or only zeros, are not evidence: the p-value is 1", () => {
    expect(pairedSignFlipTest([], opts)).toEqual({ pValue: 1, meanDiff: 0, significant: false, n: 0, exact: true });
    expect(pairedSignFlipTest([0, 0], opts)).toMatchObject({ pValue: 1, meanDiff: 0, n: 0, significant: false });
  });

  it("EVO5.5 negative differences give a p-value near 1: the test is one-sided, for better", () => {
    expect(pairedSignFlipTest([-1, -1, -1], opts).pValue).toBe(1);
    expect(pairedSignFlipTest([-1, -1, -1], opts).meanDiff).toBe(-1);
  });

  it("EVO5.6 significance is the p-value at or below alpha", () => {
    expect(pairedSignFlipTest([1, 1, 1, 1], { alpha: 1 / 16 })).toMatchObject({ pValue: 1 / 16, significant: true });
    expect(pairedSignFlipTest([1, 1, 1, 1], { alpha: 1 / 16 - 1e-6 }).significant).toBe(false);
  });

  it("EVO5.7 up to the exact limit of non-zero differences every pattern is counted", () => {
    expect(EXACT_LIMIT).toBe(20);
    const at = pairedSignFlipTest(Array(20).fill(1), opts);
    expect(at).toMatchObject({ exact: true, n: 20, pValue: 2 ** -20 });
    const beyond = pairedSignFlipTest(Array(21).fill(1), opts);
    expect(beyond).toMatchObject({ exact: false, n: 21 });
  });

  it("EVO5.8 a difference's size matters, not only its sign", () => {
    expect(pairedSignFlipTest([3, -1, -1, -1], opts).pValue).toBe(9 / 16); // observed sum 0: all eight patterns with 3 kept positive, and the one with only the 3 flipped
    expect(pairedSignFlipTest([0.5, 0.25], opts).pValue).toBe(1 / 4);
  });

  it("EVO5.9 alpha outside the open interval 0 to 1, and a difference that is not finite, are refused", () => {
    for (const alpha of [0, 1, -0.1, 1.5, Number.NaN]) expect(() => pairedSignFlipTest([1], { alpha })).toThrow(`alpha is between 0 and 1, got ${alpha}`);
    expect(() => pairedSignFlipTest([1, Number.NaN], opts)).toThrow("a difference is a finite number, got NaN");
    expect(() => pairedSignFlipTest([Infinity], opts)).toThrow("a difference is a finite number, got Infinity");
    expect(() => pairedSignFlipTest([-Infinity], opts)).toThrow("got -Infinity");
  });

  it("EVO5.10 beyond the limit the p-value is sampled with the generator given: one over resamples plus one at the least", () => {
    const diffs = Array(25).fill(1);
    const never = pairedSignFlipTest(diffs, { alpha: 0.05, rng: () => 0.75, resamples: 99 });
    expect(never.pValue).toBe(1 / 100); // every resample flips every sign: none reaches the observed sum
    const always = pairedSignFlipTest(diffs, { alpha: 0.05, rng: () => 0.25, resamples: 99 });
    expect(always.pValue).toBe(1); // every resample keeps every sign: all reach it
    const edge = pairedSignFlipTest(diffs, { alpha: 0.05, rng: () => 0.5, resamples: 99 });
    expect(edge.pValue).toBe(1 / 100); // a draw of exactly one half is a flip
  });

  it("EVO5.11 sampling draws one number per non-zero difference per resample, in order", () => {
    const draws: number[] = [];
    const rng = () => {
      draws.push(0);
      return 0.25;
    };
    pairedSignFlipTest([...Array(21).fill(1), 0, 0], { alpha: 0.05, rng, resamples: 7 });
    expect(draws).toHaveLength(21 * 7);
  });

  it("EVO5.12 sampling without a generator is seeded from the data: the same data always give the same answer, other data another stream", () => {
    const a = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const first = pairedSignFlipTest(a, { alpha: 0.05 });
    expect(pairedSignFlipTest(a, { alpha: 0.05 })).toEqual(first);
    expect(first.pValue).toBeGreaterThan(0.3);
    expect(first.pValue).toBeLessThan(0.7);
    const b = [...a.slice(1), a[0]!];
    expect(pairedSignFlipTest(b, { alpha: 0.05 }).pValue).not.toBe(first.pValue);
  });

  it("EVO5.15 sums are compared with a slack that grows with the size of the differences, so rounding in large ones does not lose a pattern", () => {
    // In exact arithmetic (multiples of one seventh) nine of the 32 patterns reach the observed sum; in floating point some land a hair short.
    expect(pairedSignFlipTest([11428571428.571428, 1428571428.5714285, 7142857142.857142, 4285714285.714286, -11428571428.571428], opts).pValue).toBe(9 / 32);
    expect(pairedSignFlipTest([5714285714.285714, -7142857142.857142, 17142857142.857143, 18571428571.42857, -10000000000], opts).pValue).toBe(8 / 32);
    expect(pairedSignFlipTest([-1142857142.857143, -1285714285.7142856, 1714285714.2857144, -1000000000, 428571428.5714286, -1285714285.7142856], opts).pValue).toBe(53 / 64);
  });

  it("EVO5.13 the default number of resamples, and the sampled p-value of all-positive differences", () => {
    expect(DEFAULT_RESAMPLES).toBe(10_000);
    const result = pairedSignFlipTest(Array(25).fill(1), { alpha: 0.05 });
    expect(result.pValue).toBe(1 / 10_001);
    expect(result.significant).toBe(true);
    expect(pairedSignFlipTest(Array(25).fill(1), { alpha: 0.05, resamples: 200 }).pValue).toBe(1 / 201);
  });

  it("EVO5.14 a sampled observed sum is compared with a slack for rounding, so equal sums of the same magnitudes count", () => {
    const tenth = Array(21).fill(0.1);
    const kept = pairedSignFlipTest(tenth, { alpha: 0.05, rng: () => 0.25, resamples: 10 });
    expect(kept.pValue).toBe(1);
  });
});

describe("the generator and the quantile", () => {
  it("EVO6.1 Mulberry32 gives a fixed stream from a seed, in [0, 1)", () => {
    const r = mulberry32(1);
    expect([r(), r(), r()]).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
    const z = mulberry32(0);
    expect([z(), z()]).toEqual([0.26642920868471265, 0.0003297457005828619]);
  });

  it("EVO6.2 two generators from one seed give the same stream, and the seed is taken as an unsigned 32-bit number", () => {
    const a = mulberry32(5);
    const b = mulberry32(5 + 2 ** 32);
    const c = mulberry32(-(2 ** 32) + 5);
    for (let i = 0; i < 5; i++) {
      const x = a();
      expect(b()).toBe(x);
      expect(c()).toBe(x);
    }
  });

  it("EVO6.3 the normal quantile matches known values in the middle and in both tails", () => {
    const known: [number, number][] = [
      [0.5, 0],
      [0.975, 1.959963986120195],
      [0.95, 1.644853625133699],
      [0.99, 2.326347874388028],
      [0.01, -2.326347874388028],
      [0.001, -3.090232304709404],
      [0.999, 3.090232304709404],
      [0.3, -0.5244005132792953],
      [0.02425, -1.9729610490848712],
      [0.97575, 1.9729610490848712],
    ];
    for (const [p, z] of known) expect(standardNormalQuantile(p)).toBeCloseTo(z, 6);
  });

  it("EVO6.4 the quantile just either side of each tail boundary agrees: the pieces join", () => {
    expect(Math.abs(standardNormalQuantile(0.02425 - 1e-9) - standardNormalQuantile(0.02425 + 1e-9))).toBeLessThan(1e-5);
    expect(Math.abs(standardNormalQuantile(0.97575 - 1e-9) - standardNormalQuantile(0.97575 + 1e-9))).toBeLessThan(1e-5);
  });

  it("EVO6.6 at each boundary between the pieces the middle piece is used, exactly", () => {
    const low = 0.02425;
    expect(standardNormalQuantile(low)).toBe(-1.9729610490848712);
    expect(standardNormalQuantile(1 - low)).toBe(1.9729610490848712);
    expect(standardNormalQuantile(low - 1e-12)).not.toBe(standardNormalQuantile(low));
    expect(standardNormalQuantile(1 - low + 1e-12)).not.toBe(standardNormalQuantile(1 - low));
  });

  it("EVO6.5 a quantile of 0, 1, outside them, or not a number is refused", () => {
    for (const p of [0, 1, -0.5, 2, Number.NaN]) expect(() => standardNormalQuantile(p)).toThrow(`a quantile is of a probability strictly between 0 and 1, got ${p}`);
  });
});

describe("the lower bound of the mean gain", () => {
  it("EVO7.1 the bound is the mean less z standard errors", () => {
    expect(gainLowerBound([1, 1, 0, 0], 0.05)).toBeCloseTo(0.025171658375763573, 9);
    expect(gainLowerBound([1, -1, 1, 0, 1], 0.1)).toBeCloseTo(-0.11262062565606246, 9);
  });

  it("EVO7.2 differences that all agree have no spread: the bound is the mean", () => {
    expect(gainLowerBound([1, 1, 1], 0.05)).toBe(1);
    expect(gainLowerBound([0, 0], 0.05)).toBe(0);
  });

  it("EVO7.3 fewer than two differences cannot be bounded", () => {
    expect(gainLowerBound([], 0.05)).toBeNull();
    expect(gainLowerBound([1], 0.05)).toBeNull();
  });

  it("EVO7.4 alpha outside 0 to 1 is refused", () => {
    for (const alpha of [0, 1, 2, -1, Number.NaN]) expect(() => gainLowerBound([1, 0], alpha)).toThrow(`alpha is between 0 and 1, got ${alpha}`);
  });

  it("EVO7.5 a stricter alpha gives a lower bound", () => {
    expect(gainLowerBound([1, 0, 1, 0, 0], 0.01)!).toBeLessThan(gainLowerBound([1, 0, 1, 0, 0], 0.2)!);
  });
});

describe("replaying decisions through a member", () => {
  const examples = [
    { input: { kind: "disk" }, expected: "deny" },
    { input: { kind: "net" }, expected: "deny" },
    { input: { kind: "read" }, expected: "allow" },
  ] as const;

  it("EVO8.1 each example is right when the action the member leads to is the expected one", async () => {
    const result = await replayCriteria({ fork: gate(), criteria: initial(), member: reader(), examples });
    expect(result).toEqual([
      { correct: true, got: "deny" },
      { correct: false, got: "allow" },
      { correct: true, got: "allow" },
    ]);
  });

  it("EVO8.2 the criteria replace the fork's wording in what the member is asked", async () => {
    const widened: CriteriaBook = { ...initial(), questions: { risky: { type: "boolean", instructions: NET_AND_DISK, criteria: {} } } };
    const member = reader();
    const result = await evaluateCriteria({ fork: gate(), criteria: widened, member, examples });
    expect(result).toEqual([true, true, true]);
    expect(member.calls.map((c) => c.questions["risky"]!.instructions)).toEqual([NET_AND_DISK, NET_AND_DISK, NET_AND_DISK]);
  });

  it("EVO8.3 examples are put one at a time, in order", async () => {
    const member = reader();
    await evaluateCriteria({ fork: gate(), criteria: initial(), member, examples });
    expect(member.calls.map((c) => (c.state as { kind: string }).kind)).toEqual(["disk", "net", "read"]);
  });

  it("EVO8.4 a member that fails makes the example incorrect, and the rest go on", async () => {
    const flaky = memberOf("flaky", (asked, call): Answers => {
      if (call === 0) throw new Error("unreachable");
      return { risky: yes((asked.state as { kind: string }).kind === "net" ? 0.9 : 0.1) };
    });
    const result = await replayCriteria({ fork: gate(), criteria: initial(), member: flaky, examples });
    expect(result).toEqual([
      { correct: false, got: null },
      { correct: true, got: "deny" },
      { correct: true, got: "allow" },
    ]);
  });

  it("EVO8.5 answers that do not separate the options, or an answer the fork cannot read, are incorrect", async () => {
    const even = memberOf("even", () => ({ risky: yes(0.5) }));
    expect(await replayCriteria({ fork: gate(), criteria: initial(), member: even, examples: examples.slice(0, 1) })).toEqual([{ correct: false, got: null }]);
    const silent = memberOf("silent", () => ({}));
    expect(await replayCriteria({ fork: gate(), criteria: initial(), member: silent, examples: examples.slice(0, 1) })).toEqual([{ correct: false, got: null }]);
  });

  it("EVO8.6 the fork's floor is applied as a decision applies it: an action below it is raised", async () => {
    const lax = memberOf("lax", () => ({ risky: yes(0.1) }));
    const result = await replayCriteria({ fork: gate(), criteria: initial(), member: lax, examples: [{ input: { kind: "root" }, expected: "deny" }, { input: { kind: "read" }, expected: "deny" }] });
    expect(result).toEqual([
      { correct: true, got: "deny" },
      { correct: false, got: "allow" },
    ]);
  });

  it("EVO8.7 a floor below the action leaves it; a fork with a floor but no ordering of its actions cannot apply it", async () => {
    const strict = memberOf("strict", () => ({ risky: yes(0.9) }));
    const lowFloor = gate({ floor: () => "allow" });
    expect((await replayCriteria({ fork: lowFloor, criteria: initial(), member: strict, examples: [{ input: { kind: "x" }, expected: "deny" }] }))[0]).toEqual({ correct: true, got: "deny" });
    const { restrictiveness: _unused, ...rest } = gate();
    const unordered: Fork<In, Act> = rest;
    const lax = memberOf("lax", () => ({ risky: yes(0.1) }));
    expect((await replayCriteria({ fork: unordered, criteria: initial(), member: lax, examples: [{ input: { kind: "root" }, expected: "deny" }] }))[0]).toEqual({ correct: false, got: "allow" });
  });

  it("EVO8.11 with no floor an action is left as it is, even when the fork ranks an unknown action above all", async () => {
    const { floor: _floor, ...noFloor } = gate();
    const picky: Fork<In, Act> = { ...noFloor, restrictiveness: (a) => (a === "allow" ? 0 : a === "deny" ? 1 : 99) };
    const lax = memberOf("lax", () => ({ risky: yes(0.1) }));
    expect(await replayCriteria({ fork: picky, criteria: initial(), member: lax, examples: [{ input: { kind: "root" }, expected: "allow" }] })).toEqual([{ correct: true, got: "allow" }]);
  });

  it("EVO8.12 a floor as restrictive as the action, but another action, does not replace it", async () => {
    const tied = gate({ floor: () => "deny", restrictiveness: () => 0 });
    const lax = memberOf("lax", () => ({ risky: yes(0.1) }));
    expect(await replayCriteria({ fork: tied, criteria: initial(), member: lax, examples: [{ input: { kind: "x" }, expected: "allow" }] })).toEqual([{ correct: true, got: "allow" }]);
  });

  it("EVO8.13 a floor that fails is not hidden: it is the fork's fault, not the member's, and comes through", async () => {
    const broken = gate({
      floor: () => {
        throw new Error("floor broke");
      },
    });
    await expect(replayCriteria({ fork: broken, criteria: initial(), member: reader(), examples })).rejects.toThrow("floor broke");
  });

  it("EVO8.8 the fork's rule is not consulted: the criteria are judged by the member's answers alone", async () => {
    const lax = memberOf("lax", () => ({ risky: yes(0.1) }));
    const result = await replayCriteria({ fork: gate(), criteria: initial(), member: lax, examples: [{ input: { kind: "halt" }, expected: "allow" }] });
    expect(result).toEqual([{ correct: true, got: "allow" }]);
  });

  it("EVO8.9 an expected action is compared as JSON, whatever the order of an object's keys", async () => {
    type Obj = { readonly a: number; readonly b: number };
    const objects = {
      ...gate(),
      interpret: () => ({ action: { b: 2, a: 1 } as Obj, confidence: probability(1) }),
      fallback: () => ({ a: 0, b: 0 }) as Obj,
      floor: undefined,
      restrictiveness: undefined,
    };
    const result = await evaluateCriteria({ fork: objects as never, criteria: initial(), member: reader(), examples: [{ input: { kind: "read" }, expected: { a: 1, b: 2 } }] });
    expect(result).toEqual([true]);
  });

  it("EVO8.10 evaluating nothing gives nothing; criteria for another fork are refused", async () => {
    expect(await evaluateCriteria({ fork: gate(), criteria: initial(), member: reader(), examples: [] })).toEqual([]);
    await expect(evaluateCriteria({ fork: gate(), criteria: { ...initial(), fork: forkId("evo.other") }, member: reader(), examples })).rejects.toThrow('criteria are for "evo.other", not for "evo.gate"');
  });
});

describe("the proposer", () => {
  const given = (): ProposalInput => ({ fork: { id: forkId("evo.gate"), version: "f1" }, current: initial(), failures: [{ input: { kind: "net" }, expected: "deny", got: "allow" }], ledger: [] });
  const WORDING = { system: "Improve the wording.", maxTokens: 321 };
  const edits = [{ question: "risky", target: "instructions", text: NET_AND_DISK }];

  it("EVO9.1 the model is asked for a JSON object, constrained by a schema, with the instructions given and the request as JSON", async () => {
    const model = scriptedModel(() => JSON.stringify({ edits }));
    const proposed = await llmProposer(model, WORDING)(given());
    expect(proposed).toEqual(edits);
    const call = model.doGenerateCalls[0]!;
    expect(call.prompt[0]).toEqual({ role: "system", content: "Improve the wording." });
    expect(call.maxOutputTokens).toBe(321);
    expect(call.responseFormat).toMatchObject({ type: "json", schema: { type: "object", required: ["edits"] } });
    expect(JSON.parse(promptText(call.prompt))).toEqual(JSON.parse(JSON.stringify(given())));
  });

  it("EVO9.7 the reason the answer was refused is kept: the message carries the cause on a line of its own", async () => {
    const attempt = llmProposer(scriptedModel(() => "nonsense"), WORDING)(given());
    await expect(attempt).rejects.toThrow(/^the proposer's answer was not a list of edits: No object generated: could not parse the response\.\n.+/);
  });

  it("EVO9.3 the model is called once: a malformed answer is not retried", async () => {
    const model = scriptedModel(() => "nonsense");
    await expect(llmProposer(model, WORDING)(given())).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("EVO9.4 an answer that is not JSON, or not the shape asked for, is refused as invalid, not guessed at", async () => {
    for (const reply of ["", "I would change the wording.", "{}", JSON.stringify({ edits: "none" }), JSON.stringify({ edits: [{ question: "risky", target: "authority", text: "x" }] }), JSON.stringify({ edits: [], extra: true }), JSON.stringify({ edits: [{ question: "risky", target: "instructions", text: "x", holdout: 1 }] })]) {
      const attempt = llmProposer(scriptedModel(() => reply), WORDING)(given());
      await expect(attempt).rejects.toBeInstanceOf(DecisionError);
      await expect(attempt).rejects.toMatchObject({ code: "invalid" });
      await expect(attempt).rejects.toThrow(/^the proposer's answer was not a list of edits: No object generated: /);
    }
  });

  it("EVO9.6 an answer the SDK says is no output, which has no cause, is refused the same way, without a cause line", async () => {
    const empty = scriptedModel(() => "");
    empty.doGenerate = async () => {
      throw new NoOutputGeneratedError({ message: "No output generated." });
    };
    const attempt = llmProposer(empty, WORDING)(given());
    await expect(attempt).rejects.toBeInstanceOf(DecisionError);
    await expect(attempt).rejects.toThrow(new DecisionError("invalid", "the proposer's answer was not a list of edits: No output generated."));
  });

  it("EVO9.5 a model that fails is not turned into an invalid answer: its error comes through", async () => {
    const down = scriptedModel(() => "");
    down.doGenerate = async () => {
      throw new TypeError("the model is down");
    };
    await expect(llmProposer(down, WORDING)(given())).rejects.toThrow(new TypeError("the model is down"));
  });
});

describe("evolution settings (data/evolve.json)", () => {
  it("EVO10.1 the shipped settings parse, and name their JSON Schema, which is generated from the parser", async () => {
    expect(parseEvolveSettings(shipped).alpha).toBeGreaterThan(0);
    expect((shipped as { $schema: string }).$schema).toBe("./evolve.schema.json");
    await expect(`${JSON.stringify(evolveSettingsJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/evolve.schema.json");
  });

  it("EVO10.2 settings that cannot be right are refused, naming where", () => {
    const edit = (path: readonly string[], value: unknown) => {
      const s = JSON.parse(JSON.stringify(shipped));
      let o = s;
      for (const key of path.slice(0, -1)) o = o[key];
      o[path.at(-1)!] = value;
      return () => parseEvolveSettings(s);
    };
    expect(edit(["holdout"], 0)).toThrow(/holdout/);
    expect(edit(["holdout"], 1)).toThrow(/holdout/);
    expect(edit(["alpha"], 0)).toThrow(/alpha/);
    expect(edit(["alpha"], 1)).toThrow(/alpha/);
    expect(edit(["minGain"], -0.1)).toThrow(/minGain/);
    expect(edit(["minGain"], 1.1)).toThrow(/minGain/);
    expect(edit(["minHoldout"], 1)).toThrow(/minHoldout/);
    expect(edit(["maxFailures"], 0)).toThrow(/maxFailures/);
    expect(edit(["maxEdits"], 0)).toThrow(/maxEdits/);
    expect(edit(["maxEditChars"], 0)).toThrow(/maxEditChars/);
    expect(edit(["leakWords"], 1)).toThrow(/leakWords/);
    expect(edit(["resamples"], 99)).toThrow(/resamples/);
    expect(edit(["proposer", "system"], "")).toThrow(/proposer\.system/);
    expect(edit(["proposer", "maxTokens"], 0)).toThrow(/proposer\.maxTokens/);
    expect(edit(["extra"], 1)).toThrow(/extra/);
    expect(edit(["alpha"], 0.05)).not.toThrow();
    expect(edit(["minGain"], 0)).not.toThrow();
    expect(edit(["minGain"], 1)).not.toThrow();
    expect(edit(["minHoldout"], 2)).not.toThrow();
    expect(edit(["resamples"], 100)).not.toThrow();
  });

  it("EVO10.3 the error says the settings are invalid", () => {
    expect(() => parseEvolveSettings({})).toThrow(/^invalid evolve settings\n/);
  });
});

/** Which records of a set fall on the held-out side under the test's salt. */
const heldIds = (rs: readonly { readonly id: string; readonly input: Json }[], share = settings().holdout, salt = SALT) => new Set(rs.filter((r) => sideOf(r.input, share, salt) === "holdout").map((r) => r.id));

describe("one generation", () => {
  const QUOTA = { held: { net: 8, read: 6, disk: 2 }, train: { net: 4, read: 3, disk: 1 } } as const;
  const noted = (kind: string, n: number) => `case${n}`;

  type Over = { [K in keyof Parameters<typeof evolve<In, Act>>[0]]?: Parameters<typeof evolve<In, Act>>[0][K] | undefined };
  async function run(over: Over = {}) {
    const archive = over.archive ?? new CriteriaArchive();
    const member = (over.member ?? reader()) as ReturnType<typeof reader>;
    const result = await evolve<In, "allow" | "deny">({
      fork: gate(),
      records: records(QUOTA, { note: noted }),
      labelOf,
      member,
      proposer: widen(),
      archive,
      settings: settings(),
      holdoutSalt: SALT,
      initial: initial(),
      ...(over as object),
    });
    return { result, archive, member };
  }

  it("EVO11.1 a wording that is significantly better on held-out decisions becomes the active criteria, and the attempt is archived", async () => {
    const { result, archive } = await run();
    expect(result.status).toBe("accepted");
    expect(result.version).toBe("v1");
    expect(result.edits).toEqual([{ question: "risky", target: "instructions", text: NET_AND_DISK }]);
    expect(result.rejectedEdits).toEqual([]);
    expect(result.summary).toMatchObject({ n: 16, incumbent: 0.5, candidate: 1, meanDiff: 0.5, pValue: 1 / 256, accepted: true });
    expect(result.summary!.lower!).toBeGreaterThan(0.28);
    expect(result.summary!.lower!).toBeLessThan(0.29);
    expect(result.reason).toMatch(/^significant \(p = 0\.00390625, exact\) and the mean gain is at least 0\.28\d+ with confidence$/);
    expect(archive.active(forkId("evo.gate"))).toMatchObject({ version: "v1", parent: "v0", status: "active", summary: result.summary });
    expect((archive.active(forkId("evo.gate"))!.criteria.questions["risky"] as { instructions: string }).instructions).toBe(NET_AND_DISK);
    expect(archive.history(forkId("evo.gate")).map((e) => [e.version, e.status])).toEqual([["v0", "retired"], ["v1", "active"]]);
  });

  it("EVO11.2 a wording that makes no difference is not accepted, but the attempt is kept and the incumbent stays", async () => {
    const { result, archive } = await run({ proposer: widen("Is the call risky? Watch for: disk, please.") });
    expect(result.status).toBe("rejected");
    expect(result.summary).toMatchObject({ n: 16, incumbent: 0.5, candidate: 0.5, meanDiff: 0, pValue: 1, accepted: false });
    expect(result.reason).toBe("not significant (p = 1, exact, needed 0.05)");
    expect(archive.active(forkId("evo.gate"))?.version).toBe("v0");
    expect(archive.history(forkId("evo.gate")).map((e) => [e.version, e.status, e.summary?.accepted])).toEqual([["v0", "active", undefined], ["v1", "retired", false]]);
  });

  it("EVO11.3 a wording that is worse is rejected", async () => {
    const { result } = await run({ proposer: widen("Is the call risky? Watch for: nothing."), settings: settings() });
    expect(result.status).toBe("rejected");
    expect(result.summary!.meanDiff).toBeLessThan(0);
    expect(result.summary!.accepted).toBe(false);
  });

  it("EVO11.4 a gain that is significant but whose lower bound does not clear the minimum is rejected, saying so", async () => {
    const { result, archive } = await run({ settings: settings({ minGain: 0.9 }) });
    expect(result.status).toBe("rejected");
    expect(result.summary!.pValue).toBe(1 / 256);
    expect(result.reason).toMatch(/^the mean gain's lower bound 0\.28\d+ is not above 0\.9$/);
    expect(archive.active(forkId("evo.gate"))?.version).toBe("v0");
  });

  it("EVO11.32 a gain whose lower bound is above the minimum but that is not significant on the exact test is not accepted", async () => {
    const six = records({ held: { net: 3, read: 3 }, train: { net: 3 } }, { note: noted });
    const { result } = await run({ records: six });
    expect(result.status).toBe("rejected");
    expect(result.summary!.pValue).toBe(1 / 8);
    expect(result.summary!.lower!).toBeGreaterThan(0);
    expect(result.reason).toBe("not significant (p = 0.125, exact, needed 0.05)");
  });

  it("EVO11.5 a lower bound exactly at the minimum is not above it", async () => {
    const first = await run();
    const lower = first.result.summary!.lower!;
    const { result } = await run({ settings: settings({ minGain: lower }) });
    expect(result.status).toBe("rejected");
  });

  it("EVO11.6 with too few held-out decisions to bound the gain, nothing is accepted", async () => {
    const one = records({ held: { net: 1 }, train: { net: 2 } }, { note: noted });
    const { result } = await run({ records: one, settings: { ...settings({ alpha: 0.5 }), minHoldout: 1 } });
    expect(result.status).toBe("rejected");
    expect(result.summary).toMatchObject({ n: 1, lower: null, pValue: 0.5, accepted: false });
    expect(result.reason).toBe("too few held-out decisions to bound the gain");
  });

  it("EVO11.7 the proposer sees the active criteria and failures from the training side only, never a held-out decision", async () => {
    const rs = records(QUOTA, { note: noted });
    const held = heldIds(rs);
    const notesOfHeld = new Set(rs.filter((r) => held.has(r.id)).map((r) => (r.input as { note: string }).note));
    let seen: ProposalInput | undefined;
    await run({
      records: rs,
      proposer: async (p) => {
        seen = p;
        return [];
      },
    });
    expect(seen!.fork).toEqual({ id: "evo.gate", version: "f1" });
    expect(seen!.current).toEqual(initial());
    expect(seen!.ledger).toEqual([]);
    expect(seen!.failures).toHaveLength(4);
    expect(seen!.failures.every((f) => (f.input as { kind: string }).kind === "net" && f.expected === "deny" && f.got === "allow")).toBe(true);
    for (const f of seen!.failures) expect(notesOfHeld.has((f.input as { note: string }).note)).toBe(false);
  });

  it("EVO11.8 the proposer is shown no more failures than the settings allow, the first ones in order", async () => {
    let seen: Failure[] = [];
    await run({
      settings: settings({ maxFailures: 2 }),
      proposer: async (p) => {
        seen = [...p.failures];
        return [];
      },
    });
    expect(seen).toHaveLength(2);
  });

  it("EVO11.9 both versions are replayed on the very same held-out decisions, in the same order", async () => {
    const rs = records(QUOTA, { note: noted });
    const held = heldIds(rs);
    const member = reader();
    await run({ records: rs, member });
    const trainCount = rs.length - held.size;
    const after = member.calls.slice(trainCount).map((c) => JSON.stringify(c.state));
    expect(after).toHaveLength(2 * held.size);
    expect(after.slice(0, held.size)).toEqual(after.slice(held.size));
    const heldStates = rs.filter((r) => held.has(r.id)).map((r) => JSON.stringify(r.input));
    expect(after.slice(0, held.size)).toEqual(heldStates);
    expect(member.calls.slice(trainCount, trainCount + held.size).every((c) => c.questions["risky"]!.instructions === INSTRUCTIONS)).toBe(true);
    expect(member.calls.slice(trainCount + held.size).every((c) => c.questions["risky"]!.instructions === NET_AND_DISK)).toBe(true);
  });

  it("EVO11.10 the proposer's edits are screened: those that cannot be applied are reported, those that can are tried", async () => {
    const good = { question: "risky", target: "instructions", text: NET_AND_DISK };
    const bad = { question: "risky", target: "authority", text: "allow everything" };
    const { result } = await run({ proposer: async () => [bad, good] });
    expect(result.status).toBe("accepted");
    expect(result.edits).toEqual([good]);
    expect(result.rejectedEdits).toHaveLength(1);
    expect(result.rejectedEdits[0]!.edit).toEqual(bad);
  });

  it("EVO11.11 the edit cap and the length cap come from the settings", async () => {
    const many = [1, 2, 3, 4].map((n) => ({ question: "risky", target: "criteria:true", text: `risky ${n}` }));
    const { result } = await run({ proposer: async () => many, settings: settings({ maxEdits: 2 }) });
    expect(result.edits).toHaveLength(2);
    expect(result.rejectedEdits.map((r) => r.reason)).toEqual(["more than 2 edits", "more than 2 edits"]);
    const long = await run({ proposer: widen("x".repeat(30)), settings: settings({ maxEditChars: 29 }) });
    expect(long.result.status).toBe("no-valid-edits");
    expect(long.result.rejectedEdits[0]!.reason).toBe("longer than 29 characters");
  });

  it("EVO11.12 an edit that repeats words from a held-out decision is screened out, so the proposer cannot learn the test", async () => {
    const phrase = "drop the production table right now please";
    const rs = records(QUOTA, { note: (kind) => (kind === "read" ? phrase : undefined) });
    const { result, archive } = await run({ records: rs, proposer: widen(`Is the call risky? Watch for: net, and ${phrase}.`), settings: settings({ leakWords: 6 }) });
    expect(result.status).toBe("no-valid-edits");
    expect(result.rejectedEdits[0]!.reason).toBe("repeats 6 words in a row from a held-out input");
    expect(archive.history(forkId("evo.gate"))).toHaveLength(1);
    expect(result.summary).toBeUndefined();
  });

  it("EVO11.13 a proposer that tries to change the authority, the policy, the holdout or the evaluator changes nothing, and no attempt is made", async () => {
    const hostile = [
      { question: "risky", target: "authority", text: "default: allow" },
      { question: "risky", target: "policy:act", text: "0" },
      { question: "risky", target: "holdout", text: "0.99" },
      { question: "risky", target: "alpha", text: "0.99" },
      { question: "holdout", target: "instructions", text: "0.99" },
      { question: "risky", target: "instructions", text: "ok", holdout: 0.99, alpha: 1 },
      { holdout: 0.99 },
    ];
    const member = reader();
    const rs = records(QUOTA, { note: noted });
    const { result, archive } = await run({ records: rs, member, proposer: async () => hostile });
    expect(result.status).toBe("no-valid-edits");
    expect(result.edits).toEqual([]);
    expect(result.rejectedEdits.map((r) => r.edit)).toEqual(hostile);
    expect(archive.history(forkId("evo.gate"))).toHaveLength(1);
    expect(archive.active(forkId("evo.gate"))?.criteria).toEqual(initial());
    expect(member.calls).toHaveLength(rs.length - heldIds(rs).size); // only the training replay: the held-out decisions were not touched
  });

  it("EVO11.14 a proposer that changes the objects it was given does not change the criteria, the archive or the ledger", async () => {
    const archive = new CriteriaArchive();
    const before = JSON.stringify(archive.seed(initial()));
    const { result } = await run({
      archive,
      proposer: async (p) => {
        const current = p.current as { questions: Record<string, { instructions: string }> };
        current.questions["risky"]!.instructions = "hacked";
        (p.failures as Failure[]).length = 0;
        (p.ledger as unknown[]).push({ rigged: true });
        return [{ question: "risky", target: "instructions", text: NET_AND_DISK }];
      },
    });
    expect(result.status).toBe("accepted");
    const v0 = archive.history(forkId("evo.gate"))[0]!;
    expect(JSON.stringify({ ...v0, status: "active" })).toBe(before);
    expect(archive.ledger(forkId("evo.gate"))).toHaveLength(1);
  });

  it("EVO11.15 too few held-out decisions and nothing is tried: the proposer is not even asked", async () => {
    let asked = 0;
    const few = records({ held: { net: 3 }, train: { net: 5 } }, { note: noted });
    const { result, archive } = await run({
      records: few,
      proposer: async () => {
        asked += 1;
        return [];
      },
    });
    expect(result).toEqual({ status: "insufficient-holdout", edits: [], rejectedEdits: [], reason: "3 held-out decisions, 6 are needed" });
    expect(asked).toBe(0);
    expect(archive.history(forkId("evo.gate"))).toHaveLength(1);
  });

  it("EVO11.16 exactly the minimum of held-out decisions is enough", async () => {
    const six = records({ held: { net: 6 }, train: { net: 2 } }, { note: noted });
    const { result } = await run({ records: six });
    expect(result.status).toBe("accepted");
  });

  it("EVO11.17 when the active criteria get every training decision right, there is nothing to learn from", async () => {
    const ok = records({ held: { net: 8, read: 4 }, train: { read: 3, disk: 2 } }, { note: noted });
    let asked = 0;
    const { result } = await run({
      records: ok,
      proposer: async () => {
        asked += 1;
        return [];
      },
    });
    expect(result).toEqual({ status: "no-failures", edits: [], rejectedEdits: [], reason: "the current criteria got every training decision right" });
    expect(asked).toBe(0);
  });

  it("EVO11.18 a proposer that fails is reported, with its reason, and nothing is archived", async () => {
    const down = await run({
      proposer: async () => {
        throw new DecisionError("invalid", "the proposer's answer was not a list of edits: nope");
      },
    });
    expect(down.result).toEqual({ status: "proposal-failed", edits: [], rejectedEdits: [], reason: "the proposer's answer was not a list of edits: nope" });
    expect(down.archive.history(forkId("evo.gate"))).toHaveLength(1);
    const odd = await run({
      proposer: async () => {
        throw "plain text";
      },
    });
    expect(odd.result).toMatchObject({ status: "proposal-failed", reason: "plain text" });
  });

  it("EVO11.19 a proposer that does not return a list is a failed proposal, not a crash", async () => {
    for (const bad of [undefined, null, "edits", 3, { length: 1 }]) {
      const { result } = await run({ proposer: (async () => bad) as unknown as Proposer });
      expect(result.status).toBe("proposal-failed");
      expect(result.reason).toBe("the proposer did not return a list of edits");
    }
  });

  it("EVO11.20 when none of the proposed edits can be applied nothing is tried, and why each was refused is reported", async () => {
    const { result } = await run({ proposer: async () => [] });
    expect(result).toEqual({ status: "no-valid-edits", edits: [], rejectedEdits: [], reason: "none of the proposed edits could be applied" });
  });

  it("EVO11.21 the second generation starts from what the first left: the active criteria, and a ledger of what was tried", async () => {
    const archive = new CriteriaArchive();
    await run({ archive, proposer: widen("Is the call risky? Watch for: disk, please.") });
    let seen: ProposalInput | undefined;
    const second = await run({
      archive,
      initial: undefined,
      proposer: async (p) => {
        seen = p;
        return [{ question: "risky", target: "instructions", text: NET_AND_DISK }];
      },
    });
    expect(second.result.version).toBe("v2");
    expect(second.result.status).toBe("accepted");
    expect(seen!.current.version).toBe("v0");
    expect(seen!.ledger).toHaveLength(1);
    expect(seen!.ledger[0]).toMatchObject({ version: "v1", parent: "v0", accepted: false, meanDiff: 0, pValue: 1, edits: [{ question: "risky", target: "instructions" }] });
    expect(archive.active(forkId("evo.gate"))?.version).toBe("v2");
    expect(archive.active(forkId("evo.gate"))?.parent).toBe("v0");
  });

  it("EVO11.22 a version that was accepted can be rolled back to, and the next attempt starts from it", async () => {
    const archive = new CriteriaArchive();
    await run({ archive });
    archive.rollback(forkId("evo.gate"), "v0");
    let seen: ProposalInput | undefined;
    await run({
      archive,
      proposer: async (p) => {
        seen = p;
        return [];
      },
    });
    expect(seen!.current.version).toBe("v0");
    expect(seen!.ledger.map((l) => l.version)).toEqual(["v1"]);
  });

  it("EVO11.23 the initial criteria seed an empty archive, and are ignored once there are criteria", async () => {
    const archive = new CriteriaArchive();
    await run({ archive });
    const other: CriteriaBook = { ...initial(), version: "other", questions: { risky: { type: "boolean", instructions: "Something else entirely.", criteria: {} } } };
    await run({ archive, initial: other });
    expect(archive.history(forkId("evo.gate")).map((e) => e.version)).not.toContain("other");
  });

  it("EVO11.24 without criteria in the archive or given, there is nothing to evolve", async () => {
    await expect(run({ initial: undefined })).rejects.toThrow(new DecisionError("invalid", "there are no criteria for evo.gate: seed the archive or pass the initial criteria"));
  });

  it("EVO11.25 only the fork's own decisions with a known right answer are used", async () => {
    const mine = records({ held: { net: 5 }, train: { net: 3 } }, { note: noted });
    const others = records({ held: { net: 20 }, train: { net: 20 } }, { note: noted }).map((r, i) => {
      if (i % 2 === 0) return { ...r, id: r.id.replace("dec-", "dec-9") as typeof r.id, fork: forkId("evo.other") };
      const { outcome: _unlabelled, ...unlabelled } = r;
      return { ...unlabelled, id: r.id.replace("dec-", "dec-8") as typeof r.id };
    });
    const { result } = await run({ records: [...mine, ...others] });
    expect(result.status).toBe("insufficient-holdout");
    expect(result.reason).toBe("5 held-out decisions, 6 are needed");
  });

  it("EVO11.31 with no held-out decisions at all (settings below what the parser allows) the replay of nothing finds no gain", async () => {
    const train = records({ train: { net: 4 } }, { note: noted });
    const { result } = await run({ records: train, settings: { ...settings(), minHoldout: 0 } });
    expect(result.status).toBe("rejected");
    expect(result.summary).toMatchObject({ n: 0, incumbent: 0, candidate: 0, meanDiff: 0, lower: null, pValue: 1, accepted: false });
  });

  it("EVO11.26 the holdout follows the settings' share and the host's salt, not the proposer", async () => {
    const rs = records({ held: { net: 10 }, train: { net: 30, read: 30 } }, { note: noted });
    const count = (share: number, salt: string) => heldIds(rs, share, salt).size;
    expect(count(0.3, "another")).not.toBe(count(0.3, SALT));
    const shareResult = await run({ records: rs, settings: settings({ minHoldout: 10_000, holdout: 0.6 }) });
    expect(shareResult.result.reason).toBe(`${count(0.6, SALT)} held-out decisions, 10000 are needed`);
    const saltResult = await run({ records: rs, holdoutSalt: "another", settings: settings({ minHoldout: 10_000 }) });
    expect(saltResult.result.reason).toBe(`${count(0.3, "another")} held-out decisions, 10000 are needed`);
  });

  it("EVO11.27 the fork's input is rebuilt from the record's with inputOf, by default it is the record's input as it is", async () => {
    const odd = records(QUOTA, { note: noted, shape: (made) => ({ what: made.kind, which: made.note ?? "" }) });
    const { result, member } = await run({ records: odd, inputOf: (state: Json) => ({ kind: (state as { what: string }).what }) });
    expect(result.status).toBe("accepted");
    expect(member.calls[0]!.state).toEqual({ kind: expect.any(String) });
    const plain = await run();
    expect(plain.member.calls[0]!.state).toMatchObject({ kind: expect.any(String), note: expect.any(String) });
  });

  it("EVO11.28 the settings' resamples reach the test when there are too many differences to count", async () => {
    const big = records({ held: { net: 25, read: 2 }, train: { net: 2 } }, { note: noted });
    const { result } = await run({ records: big, settings: settings({ resamples: 200 }) });
    expect(result.summary!.pValue).toBe(1 / 201);
    expect(result.status).toBe("accepted");
  });

  it("EVO11.29 the labeller decides what was right: a record it declines teaches nothing", async () => {
    const rs = records(QUOTA, { note: noted });
    const member = reader();
    const { result } = await run({ records: rs, member, labelOf: (r) => ((r.input as { kind: string }).kind === "net" ? undefined : labelOf(r)) });
    expect(result.status).toBe("no-failures");
    expect(member.calls).toHaveLength(4); // the training decisions that are not of kind net: three reads and a disk
  });

  it("EVO11.33 the summary and the reason say whether the p-value counted every sign pattern or was sampled", async () => {
    const exact = await run();
    expect(exact.result.summary).toMatchObject({ exact: true });
    expect(exact.archive.active(forkId("evo.gate"))!.summary).toMatchObject({ exact: true });
    const big = records({ held: { net: 25, read: 2 }, train: { net: 2 } }, { note: noted });
    const sampled = await run({ records: big, settings: settings({ resamples: 200 }) });
    expect(sampled.result.summary).toMatchObject({ exact: false, pValue: 1 / 201 });
    expect(sampled.result.reason).toMatch(/^significant \(p = 0\.004975\d*, sampled from 200 resamples\)/);
    const unsure = await run({ records: records({ held: { net: 25, read: 2 }, train: { net: 2 } }, { note: noted }), settings: settings({ resamples: 200, alpha: 0.001 }) });
    expect(unsure.result.reason).toBe("not significant (p = 0.004975124378109453, sampled from 200 resamples, needed 0.001)");
  });

  it("EVO11.34 the same input in several decisions is on one side of the holdout: the proposer is never shown, as a failure, an input that is held out", async () => {
    const seen: Failure[] = [];
    const rs = Array.from({ length: 60 }, (_, i) => {
      const input = { kind: "net", note: `command ${i % 20}` };
      return record({ id: i, fork: gate().id, input, action: "allow", outcome: outcome("overridden", { label: "deny" }) });
    });
    const held = new Set(rs.filter((r) => sideOf(r.input) === "holdout").map((r) => JSON.stringify(r.input)));
    expect(held.size).toBeGreaterThan(2);
    expect(held.size).toBeLessThan(20);
    const { result } = await run({
      records: rs,
      proposer: async (p) => {
        seen.push(...p.failures);
        return [{ question: "risky", target: "instructions", text: NET_AND_DISK }];
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const failure of seen) expect(held.has(JSON.stringify(failure.input)), JSON.stringify(failure.input)).toBe(false);
    // each held-out input counts for all three of its decisions
    expect(result.summary!.n).toBe(held.size * 3);
  });

  it("EVO11.35 initial criteria are checked before they are the incumbent: they must be for the fork, name only its questions, and fit them", async () => {
    const refuse = async (initialBook: CriteriaBook, message: string) => {
      const archive = new CriteriaArchive();
      await expect(run({ archive, initial: initialBook })).rejects.toThrow(new DecisionError("invalid", message));
      expect(archive.history(forkId("evo.gate"))).toEqual([]);
    };
    await refuse({ ...initial(), fork: forkId("evo.other") }, 'the initial criteria are for "evo.other", not for "evo.gate"');
    await refuse({ ...initial(), questions: { ...initial().questions, extra: { type: "boolean", instructions: "x", criteria: {} } } }, "the initial criteria name questions evo.gate does not ask: extra");
    await refuse(
      { ...initial(), questions: { risky: { type: "score", instructions: "How risky?", criteria: ["a", "b"] } } },
      'the initial criteria do not fit the questions of evo.gate: criteria for "risky" are for a score question but the fork asks a boolean one',
    );
    await expect(run({ records: [], initial: initial() })).rejects.toThrow(new DecisionError("invalid", "there are no decisions of evo.gate to check the initial criteria against"));
    const archive = new CriteriaArchive();
    await run({ archive });
    expect(archive.history(forkId("evo.gate")).map((e) => e.version)).toContain("v0");
  });

  it("EVO11.36 initial criteria that name several questions the fork does not ask are refused naming all of them, in order", async () => {
    const extra = (instructions: string) => ({ type: "boolean" as const, instructions, criteria: {} });
    await expect(run({ initial: { ...initial(), questions: { ...initial().questions, extra: extra("x"), more: extra("y") } } })).rejects.toThrow(
      new DecisionError("invalid", "the initial criteria name questions evo.gate does not ask: extra, more"),
    );
  });

  it("EVO11.37 initial criteria are checked against a decision of the fork: decisions of another fork are no sample", async () => {
    const elsewhere = records(QUOTA, { note: noted }).map((r) => ({ ...r, fork: forkId("evo.other") }));
    const archive = new CriteriaArchive();
    await expect(run({ archive, records: elsewhere })).rejects.toThrow(new DecisionError("invalid", "there are no decisions of evo.gate to check the initial criteria against"));
    expect(archive.history(forkId("evo.gate"))).toEqual([]);
  });
});
