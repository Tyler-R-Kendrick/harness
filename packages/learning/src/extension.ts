import { z } from "zod";
import { ToolSpecSchema } from "@harness/cognitive";
import type { CognitiveExtension, ToolSpec } from "@harness/cognitive";
import { planTask } from "./ladder.ts";
import type { Learning, Reasoner } from "./learning.ts";
import type { Plugins } from "./plugins.ts";
import { parse } from "./schemas.ts";
import type { TrajectoryInput } from "./schemas.ts";

const tools = z.array(ToolSpecSchema).exactOptional();
const INPUTS = {
  recall: z.strictObject({ task: z.string().min(1), limit: z.int().positive().exactOptional() }),
  feedback: z.strictObject({ id: z.string().min(1), helpful: z.boolean() }),
  plan: z.strictObject({ task: z.string().min(1), tools }),
  buildTool: z.strictObject({ task: z.string().min(1), tools }),
  materialize: z.strictObject({ target: z.string().min(1), lessons: z.array(z.string().min(1)).min(1), purpose: z.string().exactOptional(), tools }),
};
const input = <T>(op: string, schema: z.ZodType<T>, value: unknown): T => parse(schema, `learning.${op} input`, value ?? {});

/**
 * Learning for the cognitive core, as an extension on memory: it requires the memory
 * extension (lessons are found by meaning there) and brings no models of its own; it
 * thinks with the ensemble's generator, judge and router. Operations, through
 * `_harness/cognitive/invoke`:
 *
 * - `learning.observe` (a trajectory): reflect on a session and update the lessons
 * - `learning.recall` / `learning.feedback`: lessons for a task, and whether one helped
 * - `learning.plan`: the capability ladder for a task (native, tool, build, teach)
 * - `learning.build-tool`, `learning.materialize`, `learning.teach`: the plugins' work
 * - `learning.consolidate`: merge lessons that say the same thing
 * - `learning.status`: lesson count and installed plugins
 */
export function learningExtension(options: { readonly learning: Learning; readonly reasoner: Reasoner; readonly plugins: Plugins; readonly discover?: (task: string) => Promise<readonly ToolSpec[]> }): CognitiveExtension {
  const { learning, plugins } = options;
  return {
    id: "learning",
    requires: ["memory"],
    models: [],
    operations: {
      observe: (value) => learning.observe(value as TrajectoryInput),
      recall: async (value) => {
        const { task, limit } = input("recall", INPUTS.recall, value);
        return learning.recall(task, limit === undefined ? {} : { limit });
      },
      feedback: async (value) => {
        const { id, helpful } = input("feedback", INPUTS.feedback, value);
        return { changes: await learning.feedback(id, helpful) };
      },
      plan: (value) => planTask(options, input("plan", INPUTS.plan, value)),
      "build-tool": (value) => plugins.buildTool(learning, input("build-tool", INPUTS.buildTool, value)),
      materialize: (value) => plugins.materialize(learning, input("materialize", INPUTS.materialize, value)),
      teach: (value) => plugins.teach(learning, value),
      consolidate: async () => ({ changes: await learning.consolidate() }),
      status: async () => ({ lessons: learning.lessons().length, plugins: plugins.list() }),
    },
  };
}
