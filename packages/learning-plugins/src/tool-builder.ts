import { z } from "zod";
import type { Ensemble, ToolSpec } from "@harness/cognitive";
import { TARGETS } from "@harness/learning";
import type { MaterializeInput, Materialized, Materializer } from "@harness/learning";
import { checkWorkflow, WorkflowSchema } from "@harness/workflows";
import type { WorkflowLibrary } from "@harness/workflows";
import type { PluginSettings } from "./settings.ts";
import { workflowFiles } from "./workflow-builder.ts";

const Draft = z.strictObject({
  name: WorkflowSchema.shape.name,
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  code: z.string().min(1),
});
type Draft = z.output<typeof Draft>;

/** Tool names the code calls with a literal name: `ctx.tool("name", ...)`. */
const calledTools = (code: string) => [...code.matchAll(/ctx\s*\.\s*tool\s*\(\s*(["'`])([^"'`]+)\1/g)].map((m) => m[2]!);

/** Check a draft: JSON of the right shape, code that compiles, and only tools that exist. */
async function review(raw: string, tools: readonly ToolSpec[]): Promise<{ draft: Draft } | { problem: string }> {
  const start = raw.indexOf("{");
  if (start < 0) return { problem: "the answer held no JSON object" };
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1));
  } catch (e) {
    return { problem: `the answer was not valid JSON: ${(e as Error).message}` };
  }
  const parsed = Draft.safeParse(json);
  if (!parsed.success) return { problem: `the answer was not a tool\n${z.prettifyError(parsed.error)}` };
  const checked = await checkWorkflow(parsed.data.code);
  if (!checked.ok) return { problem: `the code does not work: ${checked.error}` };
  const unknown = calledTools(parsed.data.code).filter((t) => !tools.some((spec) => spec.name === t));
  if (unknown.length) return { problem: `the code calls tools that are not available: ${[...new Set(unknown)].join(", ")}` };
  return { draft: parsed.data };
}

/**
 * Builds a tool in code mode: a model writes the tool as workflow code that composes the
 * available tools (`ctx.tool`) and questions to a model (`ctx.ask`). Each draft is
 * checked (it compiles in the sandbox, defines the workflow, and calls only tools that
 * exist) and a failed check goes back to the model. The tool is kept in the library, so
 * calling it runs a durable workflow; learning then offers it on later tasks.
 */
export function toolBuilder(options: { readonly reasoner: Pick<Ensemble, "generate">; readonly library: WorkflowLibrary; readonly settings: PluginSettings }): Materializer {
  const { system, maxTokens, attempts } = options.settings.toolBuilder;
  const ask = async (messages: { role: "system" | "user" | "assistant"; content: string }[]) => {
    let text = "";
    for await (const e of options.reasoner.generate({ messages: [...messages], maxTokens }, "coding")) if (e.type === "text") text += e.text;
    return text;
  };
  return {
    kind: "materializer",
    id: "tool-builder",
    target: TARGETS.tool,
    materialize: async (input: MaterializeInput): Promise<Materialized> => {
      const request = JSON.stringify({ task: input.purpose, tools: input.tools, lessons: input.lessons.map((l) => ({ title: l.title, text: l.text, steps: l.steps })) });
      const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: system },
        { role: "user", content: request },
      ];
      const problems: string[] = [];
      for (let attempt = 0; attempt < attempts; attempt++) {
        const raw = await ask(messages);
        const reviewed = await review(raw, input.tools);
        if ("draft" in reviewed) {
          const { name, description, parameters, code } = reviewed.draft;
          const workflow = { name, description, inputs: parameters, code };
          await options.library.put(workflow);
          return { target: TARGETS.tool, name, description, files: workflowFiles(workflow), tool: { name, description, parameters } };
        }
        problems.push(reviewed.problem);
        messages.push({ role: "assistant", content: raw }, { role: "user", content: `That draft failed its check: ${reviewed.problem}\nAnswer with a corrected JSON object.` });
      }
      throw new Error(`no usable tool after ${attempts} attempts:\n- ${problems.join("\n- ")}`);
    },
  };
}
