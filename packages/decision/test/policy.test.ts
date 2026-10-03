import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePolicy, policyFor, policyJsonSchema } from "../src/policy.ts";
import { DecisionError, forkId } from "../src/types.ts";
import type { Policy } from "../src/types.ts";

const file = JSON.parse(readFileSync(new URL("../data/policy.json", import.meta.url), "utf8")) as Record<string, unknown>;

type Editable = { [key: string]: unknown; default: Record<string, unknown> };

const edit = (change: (policy: Editable) => void) => {
  const copy = JSON.parse(JSON.stringify(file)) as Editable;
  change(copy);
  return () => parsePolicy(copy);
};

describe("decision policy (data/policy.json)", () => {
  it("POL1.1 the shipped policy parses, and names its JSON Schema, which is generated from the parser", async () => {
    expect(parsePolicy(file).version).toBe("policy-1");
    expect(file["$schema"]).toBe("./policy.schema.json");
    await expect(`${JSON.stringify(policyJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/policy.schema.json");
  });

  it("POL1.2 the shipped default acts at 0.9, verifies from 0.5, accepts at 0.8, asks once, never explores and is active", () => {
    expect(policyFor(parsePolicy(file), forkId("anything"))).toEqual({ act: 0.9, verify: 0.5, accept: 0.8, rotate: 1, explore: 0, mode: "active" });
  });

  it("POL2.1 a fork with no override gets the default", () => {
    const policy = parsePolicy({ ...file, forks: { other: { act: 0.99 } } });
    expect(policyFor(policy, forkId("permission.risk"))).toEqual(policy.default);
  });

  it("POL2.2 a fork's override wins over the default only for the fields it names", () => {
    const policy = parsePolicy({ ...file, forks: { "permission.risk": { act: 0.99, mode: "shadow", rotate: 3 } } });
    expect(policyFor(policy, forkId("permission.risk"))).toEqual({ act: 0.99, verify: 0.5, accept: 0.8, rotate: 3, explore: 0, mode: "shadow" });
  });

  it("POL2.3 an override written with an undefined field does not blank the default", () => {
    const policy = parsePolicy(file);
    const forked = { ...policy, forks: { [forkId("x")]: { act: undefined, explore: 0.1 } } } as unknown as Policy;
    expect(policyFor(forked, forkId("x"))).toEqual({ ...policy.default, explore: 0.1 });
  });

  it("POL3.1 a policy that is not an object is refused with a named error", () => {
    expect(() => parsePolicy("nope")).toThrow(DecisionError);
    expect(() => parsePolicy(null)).toThrow(/invalid decision policy/);
    expect(() => parsePolicy(null)).toThrowError(expect.objectContaining({ code: "invalid", name: "DecisionError" }));
  });

  it("POL3.2 a value that cannot be right is refused, naming where", () => {
    expect(edit((p) => (p["default"]["act"] = 1.5))).toThrow(/default\.act|act/);
    expect(edit((p) => (p["default"]["rotate"] = 0))).toThrow(/rotate/);
    expect(edit((p) => (p["default"]["mode"] = "loud"))).toThrow(/mode/);
    expect(edit((p) => (p["version"] = ""))).toThrow(/version/);
    expect(edit((p) => (p["extra"] = 1))).toThrow(/extra/);
    expect(edit((p) => (p["forks"] = { "Bad Id": { act: 0.5 } }))).toThrow(/forks/);
  });

  it("POL3.3 a default whose verify is above its act is refused", () => {
    expect(edit((p) => (p["default"]["verify"] = 0.95))).toThrow(/verify must not be above act/);
  });

  it("POL3.4 an override that breaks verify <= act once merged is refused, naming the fork", () => {
    const bad = edit((p) => (p["forks"] = { "permission.risk": { act: 0.4 } }));
    expect(bad).toThrow(/forks\.permission\.risk/);
    expect(bad).toThrow(/verify must not be above act/);
    expect(bad).toThrowError(expect.objectContaining({ code: "invalid" }));
    expect(edit((p) => (p["forks"] = { "permission.risk": { verify: 0.95 } }))).toThrow(/forks\.permission\.risk/);
  });

  it("POL3.5 an override that is fine on its own but fine once merged too is accepted", () => {
    expect(edit((p) => (p["forks"] = { "permission.risk": { act: 0.5, verify: 0.4 } }))).not.toThrow();
    expect(edit((p) => (p["forks"] = { "permission.risk": { act: 0.5 } }))).not.toThrow();
  });

  it("POL3.6 the schema is generated from the parser: it lists the same fields", () => {
    const schema = policyJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["$schema", "default", "forks", "version"]);
  });
});
