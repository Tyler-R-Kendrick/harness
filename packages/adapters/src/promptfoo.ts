import { parse, stringify } from "yaml";
import { parseSpec } from "@harness/ir";
import type { Case, Spec } from "@harness/ir";

/** The suite `promptfoo.evaluate` runs. Fields are Promptfoo's, not a second dialect. */
export interface PromptfooSuite {
  prompts: string[];
  providers: string[];
  tests: {
    vars: { instruction: string };
    assert: { type: string; value?: unknown }[];
  }[];
}

export function promptfooSuite(specCase: Case): PromptfooSuite {
  const asserts = specCase.expect?.promptfoo ?? [];
  return {
    prompts: ["{{instruction}}"],
    providers: ["echo"],
    tests: [{
      vars: { instruction: specCase.instruction },
      assert: asserts.map((assertion) => assertion.value === undefined ? { type: assertion.type } : { type: assertion.type, value: assertion.value }),
    }],
  };
}

function metadata(spec: Spec, specCase: Case): Record<string, unknown> {
  const row: Record<string, unknown> = {
    specId: spec.id,
    specName: spec.name,
    kind: spec.kind,
    source: specCase.source,
    split: spec.split.train.includes(specCase.id) ? "train" : "test",
  };
  if (specCase.permissible !== undefined) row["permissible"] = specCase.permissible;
  if (specCase.k !== undefined) row["k"] = specCase.k;
  return row;
}

/** Write a Promptfoo config. `metadata` is Promptfoo's field. */
export function writePromptfoo(spec: Spec): string {
  const tests = spec.cases.map((specCase) => {
    const test: Record<string, unknown> = {
      description: specCase.id,
      vars: { instruction: specCase.instruction },
      metadata: metadata(spec, specCase),
    };
    const asserts = specCase.expect?.promptfoo;
    if (asserts !== undefined && asserts.length > 0) {
      test["assert"] = asserts.map((assertion) => assertion.value === undefined ? { type: assertion.type } : { type: assertion.type, value: assertion.value });
    }
    return test;
  });
  return stringify({ description: spec.name, prompts: ["{{instruction}}"], providers: ["echo"], tests });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${field}`);
  return value;
}

export function readPromptfoo(text: string): Spec {
  const doc = record(parse(text), "promptfoo");
  const tests = doc["tests"];
  if (!Array.isArray(tests)) throw new Error("missing tests");
  const cases: Case[] = [];
  const train: string[] = [];
  const test: string[] = [];
  let specId = "";
  let specName = "";
  let kind: "policy" | "capability" = "capability";
  for (const item of tests) {
    const row = record(item, "test");
    const meta = record(row["metadata"], "metadata");
    specId = stringField(meta, "specId");
    specName = stringField(meta, "specName");
    const kindValue = stringField(meta, "kind");
    if (kindValue !== "policy" && kindValue !== "capability") throw new Error("missing kind");
    kind = kindValue;
    const id = stringField(row, "description");
    const vars = record(row["vars"], "vars");
    const specCase: Case = { id, source: sourceOf(meta), instruction: stringField(vars, "instruction") };
    if (typeof meta["permissible"] === "boolean") specCase.permissible = meta["permissible"];
    if (typeof meta["k"] === "number") specCase.k = meta["k"];
    const asserts = row["assert"];
    if (Array.isArray(asserts)) {
      specCase.expect = { promptfoo: asserts.map((assertion) => promptfooAssert(record(assertion, "assert"))) };
    }
    cases.push(specCase);
    if (meta["split"] === "test") test.push(id);
    else train.push(id);
  }
  return parseSpec({ id: specId, name: specName, kind, cases, split: { train, test } });
}

function sourceOf(meta: Record<string, unknown>): Case["source"] {
  const source = meta["source"];
  if (source === "local" || source === "promptfoo" || source === "skills" || source === "adk" || source === "harbor" || source === "assert" || source === "inspect") return source;
  throw new Error("missing source");
}

function promptfooAssert(row: Record<string, unknown>): { type: string; value?: unknown } {
  const type = stringField(row, "type");
  if (!Object.hasOwn(row, "value")) return { type };
  return { type, value: row["value"] };
}
