import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { ConstraintSchema, fillTemplate, readTemplate } from "@harness/cognitive";
import type { TemplateConstraint } from "@harness/cognitive";

/** A template alternating fixed text (from a small alphabet) and holes, with values that never contain the text after their hole. */
const filled = fc
  .array(fc.tuple(fc.string({ unit: fc.constantFrom("a", "b", ":", "\n"), minLength: 1, maxLength: 4 }), fc.string({ unit: fc.constantFrom("x", "y", " "), maxLength: 6 })), { minLength: 1, maxLength: 5 })
  .chain((pairs) => fc.boolean().map((endsWithText) => ({ pairs, endsWithText })))
  .map(({ pairs, endsWithText }) => {
    const parts: TemplateConstraint["parts"] = [];
    const values: Record<string, string> = {};
    pairs.forEach(([text, value], i) => {
      parts.push(text, { hole: `h${i}` });
      values[`h${i}`] = value;
    });
    if (endsWithText) parts.push("!");
    return { template: ConstraintSchema.parse({ type: "template", parts }) as TemplateConstraint, values };
  });

describe("template properties", () => {
  test.prop([filled])("CN2.1 reading back a filled template gives the values it was filled with", ({ template, values }) => {
    expect(readTemplate(template, fillTemplate(template, values))).toEqual(values);
  });
});
