/**
 * What a deployment declares about its session tools (data: data/tools.json): which are
 * free of side effects, so that dream's `approval-for-side-effects` gate lets a candidate
 * route into them without approval. Every tool not declared counts as having side effects.
 */
import { z } from "zod";

export const ToolDeclarationsSchema = z
  .strictObject({
    $schema: z.string().optional(),
    /** Tools (by the name sessions call them) declared free of side effects. */
    sideEffectFree: z.array(z.string().min(1)),
  })
  .superRefine((declarations, ctx) => {
    const seen = new Set<string>();
    for (const name of declarations.sideEffectFree) {
      if (seen.has(name)) ctx.addIssue({ code: "custom", path: ["sideEffectFree"], message: `declared twice: ${name}` });
      seen.add(name);
    }
  });
export type ToolDeclarations = z.output<typeof ToolDeclarationsSchema>;

export function parseToolDeclarations(input: unknown): ToolDeclarations {
  const result = ToolDeclarationsSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid tool declarations\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for the declarations file, for editors (data/tools.schema.json). */
export const toolDeclarationsJsonSchema = (): object => z.toJSONSchema(ToolDeclarationsSchema);
