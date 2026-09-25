import { z } from "zod";
import { readTemplate } from "@harness/cognitive";
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { constrain } from "@harness/cognitive";
import type { TemplateConstraint, ToolSpec } from "@harness/cognitive";
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

const HEADER = "async function workflow(input, ctx) {\n";
const FOOTER = "\n}\n";

/**
 * The answer's template: the model writes only the name, the description, the input's
 * JSON Schema and the workflow's body; the rest (labels, the code fence and the function
 * header and footer) is fixed. Generators that enforce templates put the fixed text in
 * the output themselves, never sampling it, and hold each hole to its constraint.
 */
export const TOOL_TEMPLATE: TemplateConstraint = {
  type: "template",
  parts: [
    "name: ",
    { hole: "name", constraint: { type: "regex", pattern: "[a-z0-9]+(-[a-z0-9]+)*" } },
    "\ndescription: ",
    { hole: "description", constraint: { type: "regex", pattern: "[^\\n]+" } },
    "\nparameters: ",
    { hole: "parameters", constraint: { type: "json-schema", schema: { type: "object" } } },
    `\n\`\`\`js\n${HEADER}`,
    { hole: "body" },
    `${FOOTER}\`\`\`\n`,
  ],
};

/** Check a draft: it follows the template, the code compiles, and it calls only tools that exist. */
async function review(raw: string, tools: readonly ToolSpec[]): Promise<{ draft: Draft } | { problem: string }> {
  let holes: Record<string, string>;
  try {
    holes = readTemplate(TOOL_TEMPLATE, raw.trim() + "\n");
  } catch (e) {
    return { problem: `the answer does not follow the template: ${(e as Error).message}` };
  }
  let parameters: unknown;
  try {
    parameters = JSON.parse(holes["parameters"]!);
  } catch (e) {
    return { problem: `the parameters are not JSON: ${(e as Error).message}` };
  }
  const parsed = Draft.safeParse({ name: holes["name"], description: holes["description"], parameters, code: `${HEADER}${holes["body"]}${FOOTER}` });
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
export function toolBuilder(options: { readonly coder: LanguageModel; readonly library: WorkflowLibrary; readonly settings: PluginSettings }): Materializer {
  const { system, maxTokens, attempts } = options.settings.toolBuilder;
  const ask = async (messages: { role: "user" | "assistant"; content: string }[]) =>
    (await generateText({ model: options.coder, instructions: system, messages: [...messages], maxOutputTokens: maxTokens, maxRetries: 0, ...constrain(TOOL_TEMPLATE) })).text;
  return {
    kind: "materializer",
    id: "tool-builder",
    target: TARGETS.tool,
    materialize: async (input: MaterializeInput): Promise<Materialized> => {
      const request = JSON.stringify({ task: input.purpose, tools: input.tools, lessons: input.lessons.map((l) => ({ title: l.title, text: l.text, steps: l.steps })) });
      const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: request }];
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
        messages.push({ role: "assistant", content: raw }, { role: "user", content: `That draft failed its check: ${reviewed.problem}\nAnswer again, in the same format, with it fixed.` });
      }
      throw new Error(`no usable tool after ${attempts} attempts:\n- ${problems.join("\n- ")}`);
    },
  };
}
