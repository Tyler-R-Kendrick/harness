import { z } from "zod";

/**
 * What a generation must look like, enforced token by token by generators that can
 * (see the catalog's `constraints`): a JSON Schema, a grammar (EBNF), a regular
 * expression, or a template of fixed text with holes. A template puts the known text
 * in the output without the model having to produce it and leaves the model only the
 * holes, each optionally constrained itself. Read a template's holes back with
 * readTemplate.
 */
export const CONSTRAINT_TYPES = ["json-schema", "grammar", "regex", "template"] as const;
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number];

const JsonSchemaConstraint = z.strictObject({ type: z.literal("json-schema"), schema: z.record(z.string(), z.unknown()) });
const GrammarConstraint = z.strictObject({ type: z.literal("grammar"), ebnf: z.string().min(1) });
const RegexConstraint = z.strictObject({ type: z.literal("regex"), pattern: z.string().min(1) });
const HoleConstraint = z.discriminatedUnion("type", [JsonSchemaConstraint, GrammarConstraint, RegexConstraint], { error: "a template in a template is not supported" });
const Hole = z.strictObject({ hole: z.string().regex(/^[a-z][a-z0-9_]*$/, "a hole is named in snake_case"), constraint: HoleConstraint.exactOptional() });

const TemplateConstraint = z
  .strictObject({ type: z.literal("template"), parts: z.array(z.union([z.string().min(1), Hole])).min(1) })
  .superRefine(({ parts }, ctx) => {
    const names = new Set<string>();
    parts.forEach((part, i) => {
      if (typeof part === "string") return;
      if (typeof parts[i - 1] === "object") ctx.addIssue({ code: "custom", message: "holes next to each other have no text between them to tell where one ends", path: ["parts", i] });
      if (names.has(part.hole)) ctx.addIssue({ code: "custom", message: `hole ${part.hole} is named twice`, path: ["parts", i] });
      names.add(part.hole);
    });
  });

export const ConstraintSchema = z.union([JsonSchemaConstraint, GrammarConstraint, RegexConstraint, TemplateConstraint]);
export type Constraint = z.output<typeof ConstraintSchema>;
export type TemplateConstraint = z.output<typeof TemplateConstraint>;

/** The holes of a template's output, by name. The text must follow the template exactly. */
export function readTemplate(template: TemplateConstraint, text: string): Record<string, string> {
  const values: Record<string, string> = {};
  let rest = text;
  template.parts.forEach((part, i) => {
    if (typeof part === "string") {
      if (!rest.startsWith(part)) throw new Error(`the output does not start with ${JSON.stringify(part)}`);
      rest = rest.slice(part.length);
      return;
    }
    const next = template.parts[i + 1] as string | undefined;
    const end = next === undefined ? rest.length : rest.indexOf(next);
    if (end < 0) throw new Error(`the output has no ${JSON.stringify(next)} after hole ${part.hole}`);
    const value = rest.slice(0, end);
    if (part.constraint?.type === "regex" && !new RegExp(`^(?:${part.constraint.pattern})$`).test(value)) {
      throw new Error(`hole ${part.hole} does not match /${part.constraint.pattern}/: ${value}`);
    }
    values[part.hole] = value;
    rest = rest.slice(end);
  });
  if (rest) throw new Error("the output goes on after the template");
  return values;
}

/**
 * A constraint applied while decoding one generation (a decoder's port; see
 * @harness/constrained): mask the logits, accept each sampled token, and take the text
 * the constraint forces without sampling it.
 */
export interface TokenConstraint {
  /** Set the logits of every token not allowed next to -Infinity. */
  mask(logits: Float32Array): void;
  /** Accept a token; false, with no change, when it is not allowed. */
  accept(token: number): boolean;
  /** Text forced next ("" when none), which a decoder can feed without sampling. */
  forced(): string;
  /** Whether the output is complete (an end token was accepted). */
  readonly done: boolean;
  dispose(): void;
}
