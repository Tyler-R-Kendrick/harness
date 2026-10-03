import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type * as SelectExports from "../src/select.ts";

// select.ts builds its rule schemas when it loads. A mutant in those statements (an emptied
// schema object, a changed discriminator name) makes zod throw during the import, and a test
// file that fails to import reports no failing test, so the mutant would survive. The module is
// therefore imported here, inside beforeAll, and a throw while it loads is kept and rethrown by
// every test: the failure is a failing test, which kills the mutant.
type Select = typeof SelectExports;

interface Shape {
  readonly properties: Record<string, unknown>;
  readonly required: readonly string[];
  readonly additionalProperties?: boolean;
  readonly oneOf?: readonly Shape[];
}
const shapeOf = (schema: z.ZodType, io: "input" | "output"): Shape => z.toJSONSchema(schema, { io }) as unknown as Shape;

let select: Select | undefined;
let loadError: unknown;

beforeAll(async () => {
  try {
    select = await import("../src/select.ts");
  } catch (error) {
    loadError = error;
  }
});

const loaded = (): Select => {
  if (select === undefined) throw new Error("select.ts did not load", { cause: loadError });
  return select;
};

const paper = { rule: "paper", beta0: 0.25, beta1: 1, ws: 1, wc: 0, wn: 0, prune: 4 };
const calibrated = { rule: "calibrated", alpha: 0.1, resamples: 1000, margin: 0.01, saving: 0.05, beta0: 0.1, beta1: 40 };

describe("the rule schemas as the module builds them when it loads", () => {
  it("RS30.1 the module loads", () => {
    expect(loadError).toBeUndefined();
    expect(Object.keys(loaded())).toEqual(expect.arrayContaining(["PaperRuleSchema", "CalibratedRuleSchema", "RuleSchema"]));
  });

  it("RS30.2 a paper rule parses with z defaulting to 2 and every other field kept", () => {
    expect(loaded().PaperRuleSchema.parse(paper)).toEqual({ ...paper, z: 2 });
    expect(loaded().PaperRuleSchema.parse({ ...paper, delta: 0.5, z: 3 })).toEqual({ ...paper, delta: 0.5, z: 3 });
  });

  it("RS30.3 a paper rule refuses a key it does not name, and a rule field that is not paper", () => {
    expect(loaded().PaperRuleSchema.safeParse({ ...paper, extra: 1 }).success).toBe(false);
    expect(loaded().PaperRuleSchema.safeParse({ ...paper, rule: "calibrated" }).success).toBe(false);
    expect(loaded().PaperRuleSchema.safeParse({ ...paper, prune: 0 }).success).toBe(false);
    expect(loaded().PaperRuleSchema.safeParse({ ...paper, z: 0 }).success).toBe(false);
  });

  it("RS30.4 a calibrated rule parses with a uniform spending default and every other field kept", () => {
    expect(loaded().CalibratedRuleSchema.parse(calibrated)).toEqual({ ...calibrated, spending: { kind: "uniform" } });
    const futility = { fraction: 0.5, alpha: 0.25 };
    expect(loaded().CalibratedRuleSchema.parse({ ...calibrated, futility })).toEqual({ ...calibrated, spending: { kind: "uniform" }, futility });
  });

  it("RS30.5 a calibrated rule refuses a key it does not name, and a rule field that is not calibrated", () => {
    expect(loaded().CalibratedRuleSchema.safeParse({ ...calibrated, extra: 1 }).success).toBe(false);
    expect(loaded().CalibratedRuleSchema.safeParse({ ...calibrated, rule: "paper" }).success).toBe(false);
    expect(loaded().CalibratedRuleSchema.safeParse({ ...calibrated, alpha: 1.5 }).success).toBe(false);
    expect(loaded().CalibratedRuleSchema.safeParse({ ...calibrated, resamples: 0 }).success).toBe(false);
  });

  it("RS30.6 the union picks its schema by the rule field, paper or calibrated, and refuses any other value", () => {
    expect(loaded().RuleSchema.parse(paper)).toEqual({ ...paper, z: 2 });
    expect(loaded().RuleSchema.parse(calibrated)).toEqual({ ...calibrated, spending: { kind: "uniform" } });
    expect(loaded().RuleSchema.safeParse({ ...calibrated, rule: "other" }).success).toBe(false);
    expect(loaded().RuleSchema.safeParse({ ...paper, rule: "" }).success).toBe(false);
    expect(loaded().RuleSchema.safeParse({ beta0: 0 }).success).toBe(false);
  });

  it("RS30.7 a rule that names the other rule's fields is refused by the schema its rule field picks", () => {
    expect(loaded().RuleSchema.safeParse({ ...paper, alpha: 0.1 }).success).toBe(false);
    expect(loaded().RuleSchema.safeParse({ ...calibrated, ws: 1 }).success).toBe(false);
  });

  it("RS30.8 the union's JSON Schema is a oneOf of the calibrated and the paper object, each closed and discriminated by rule", () => {
    const { oneOf } = shapeOf(loaded().RuleSchema, "output");
    expect(oneOf).toHaveLength(2);
    const [cal, pap] = oneOf as [Shape, Shape];
    expect(cal.properties["rule"]).toEqual({ type: "string", const: "calibrated" });
    expect(pap.properties["rule"]).toEqual({ type: "string", const: "paper" });
    expect(cal.additionalProperties).toBe(false);
    expect(pap.additionalProperties).toBe(false);
    expect(Object.keys(cal.properties)).toEqual(["rule", "alpha", "resamples", "margin", "saving", "beta0", "beta1", "spending", "futility"]);
    expect(Object.keys(pap.properties)).toEqual(["rule", "delta", "z", "beta0", "beta1", "ws", "wc", "wn", "prune"]);
    expect(cal.required).toEqual(["rule", "alpha", "resamples", "margin", "saving", "beta0", "beta1", "spending"]);
    expect(pap.required).toEqual(["rule", "z", "beta0", "beta1", "ws", "wc", "wn", "prune"]);
  });

  it("RS30.9 the input JSON Schema of each rule leaves its defaulted fields out of required, and delta and futility stay optional", () => {
    const pap = shapeOf(loaded().PaperRuleSchema, "input");
    expect(pap.required).toEqual(["rule", "beta0", "beta1", "ws", "wc", "wn", "prune"]);
    expect(pap.properties["z"]).toMatchObject({ default: 2 });
    const cal = shapeOf(loaded().CalibratedRuleSchema, "input");
    expect(cal.required).toEqual(["rule", "alpha", "resamples", "margin", "saving", "beta0", "beta1"]);
    expect(cal.properties["spending"]).toMatchObject({ default: { kind: "uniform" } });
  });
});
