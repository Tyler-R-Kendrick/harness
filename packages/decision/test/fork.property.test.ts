import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { probability } from "@harness/cognitive";
import { chooseOne } from "../src/fork.ts";
import { answerOf } from "../src/member.ts";
import { DecisionRecordSchema } from "../src/types.ts";
import type { Fork } from "../src/types.ts";
import { fixedRng, gate, member, policyJson, rig, sure, testExplorer, withActions, withFloor, withVerify } from "./fork-fixtures.ts";
import type { Act, In } from "./fork-fixtures.ts";

const unit = fc.double({ min: 0, max: 1, noNaN: true });
const draw = fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true });
const RANK = { allow: 0, deny: 1 } as const;

const scenario = fc.record({
  pModel: unit,
  pJudge: unit,
  hasJudge: fc.boolean(),
  generator: fc.constantFrom(undefined, "allow" as const, "deny" as const),
  thresholds: fc.tuple(unit, unit).map(([a, b]) => ({ act: Math.max(a, b), verify: Math.min(a, b) })),
  accept: unit,
  explore: unit,
  mode: fc.constantFrom("active", "shadow"),
  floor: fc.constantFrom(undefined, "allow" as const, "deny" as const),
  rule: fc.constantFrom(undefined, "allow" as const, "deny" as const),
  draws: fc.array(draw, { minLength: 1, maxLength: 4 }),
});

describe("the runner's properties", () => {
  test.prop([scenario])("FRK14.1 a decision is never less restrictive than its floor, whatever rung decided, whether it explored and whether it is shadow", async (s) => {
    const fork = gate({
      ...withVerify,
      ...withActions,
      ...withFloor(() => s.floor),
      ...(s.rule === undefined ? {} : { rule: () => s.rule }),
    });
    const { decider, log } = rig({
      members: [sure("m", s.pModel)],
      ...(s.hasJudge ? { judge: sure("j", s.pJudge) } : {}),
      ...(s.generator === undefined ? {} : { generator: async () => ({ action: s.generator as never, confidence: probability(0.5) }) }),
      policy: policyJson({ default: { ...s.thresholds, accept: s.accept, explore: s.explore, mode: s.mode } }),
      explorer: testExplorer,
      rng: fixedRng(...s.draws),
    });
    const d = await decider.decide(fork, { text: "x" });
    if (s.floor !== undefined) expect(RANK[d.action]).toBeGreaterThanOrEqual(RANK[s.floor]);
    expect(d.record.action).toBe(d.action);
    expect(DecisionRecordSchema.safeParse(d.record).success).toBe(true);
    expect(await log.get(d.id)).toEqual(d.record);
    expect(d.active).toBe(s.mode === "active");
    if (s.mode === "shadow" || s.explore === 0) expect(d.record).toMatchObject({ propensity: 1, explored: false });
    expect(d.record.propensity).toBeGreaterThan(0);
    expect(d.needsHuman).toBe(d.rung === "human");
  });

  test.prop([fc.array(fc.string(), { minLength: 1, maxLength: 12 })])("FRK14.2 decision ids strictly increase in the order decisions are made", async (texts) => {
    const { decider } = rig({ members: [sure("m", 0.95)] });
    const seen: number[] = [];
    for (const text of texts) seen.push(Number((await decider.decide(gate(), { text })).id.slice(4)));
    expect(seen).toEqual(seen.map((_, i) => i));
  });

  const abc = () => chooseOne({ id: "prop.choose", version: "1", instructions: "which", options: { a: "a", b: "b", c: "c" }, describe: (i: In) => ({ text: i.text }), text: (i: In) => i.text, fallback: () => "a" });

  test.prop([fc.tuple(unit, unit, unit).filter(([a, b, c]) => Math.abs(a - b) > 0.01 && Math.abs(a - c) > 0.01 && Math.abs(b - c) > 0.01), fc.integer({ min: 2, max: 6 })])("FRK14.3 a member with no position bias gives the same answer however many rotations are averaged", async ([wa, wb, wc], rotate) => {
    const weights = { a: wa + 0.01, b: wb + 0.01, c: wc + 0.01 };
    const unbiased = () => member("m", () => ({ choice: answerOf("choice", weights) }));
    const once = rig({ members: [unbiased()], policy: policyJson({ default: { act: 0, verify: 0, rotate: 1 } }) });
    const many = rig({ members: [unbiased()], policy: policyJson({ default: { act: 0, verify: 0, rotate } }) });
    const a = (await once.decider.decide(abc(), { text: "x" })).record.answers["choice"]!.distribution;
    const b = (await many.decider.decide(abc(), { text: "x" })).record.answers["choice"]!.distribution;
    for (const key of ["a", "b", "c"]) expect(b[key]).toBeCloseTo(a[key]!, 9);
  });

  test.prop([fc.array(unit, { minLength: 1, maxLength: 4 })])("FRK14.4 a member that fails never stops a decision: the ladder ends with an action and a record", async (ps) => {
    const members = ps.map((p, i) => (i % 2 === 0 ? sure(`m${i}`, p) : member(`m${i}`, () => { throw new Error("down"); })));
    const { decider, log } = rig({ members });
    const fork: Fork<In, Act> = gate();
    const d = await decider.decide(fork, { text: "x" });
    expect(["allow", "deny"]).toContain(d.action);
    expect(await log.size()).toBe(1);
  });
});
