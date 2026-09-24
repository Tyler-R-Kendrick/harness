import type { Ensemble } from "@harness/cognitive";
import { TARGETS } from "@harness/learning";
import type { MaterializeInput, Materialized, Materializer } from "@harness/learning";
import { checkWorkflow, parseWorkflow } from "@harness/workflows";
import type { Workflow, WorkflowLibrary } from "@harness/workflows";
import type { PluginSettings } from "./settings.ts";

export interface BuilderOptions {
  readonly reasoner: Pick<Ensemble, "route">;
  readonly settings: PluginSettings;
}

/** A kebab-case name for workflows and skills (at most 64 characters, as agent skills require). */
export function kebab(text: string): string {
  const name = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
  return name || "workflow";
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** What the lessons describe: the procedures' steps in order (a procedure without steps is one step), and the other lessons as guidance. */
function stepsAndGuidance(input: MaterializeInput): { steps: string[]; guidance: string[] } {
  const steps = input.lessons.flatMap((l) => (l.kind === "procedure" ? (l.steps ?? [l.text]) : []));
  const guidance = input.lessons.filter((l) => l.kind !== "procedure").map((l) => `${l.title}: ${l.text}`);
  return { steps: steps.length ? steps : [input.purpose], guidance };
}

export const describeLessons = (input: MaterializeInput): string => {
  const [first] = input.lessons;
  const what = oneLine(input.lessons.map((l) => l.text).join(" ") || input.purpose);
  return first?.when ? `${what}. Use when ${oneLine(first.when)}.` : what;
};

/**
 * Compile learned procedures into workflow code, deterministically: the same lessons,
 * tools and router answers always give the same code. Each step the router confidently
 * fits to a tool calls that tool; every other step asks the model, with the purpose,
 * the guidance from the other lessons, the input and the results so far. The code
 * reaches the world only through `ctx`, so it runs durably (see @harness/workflows).
 */
export async function compileProcedure(options: BuilderOptions, input: MaterializeInput, name: string = kebab(input.purpose)): Promise<Workflow> {
  const { steps, guidance } = stepsAndGuidance(input);
  const lines: string[] = [];
  for (const [i, step] of steps.entries()) {
    let call: { name: string; arguments: Readonly<Record<string, unknown>> } | undefined;
    if (input.tools.length) {
      try {
        const routing = await options.reasoner.route({ input: step, tools: input.tools });
        if (routing.confidence >= options.settings.workflow.toolConfidence) call = routing.calls[0];
      } catch {
        // No router: the step asks the model instead.
      }
    }
    lines.push(`  // ${i + 1}. ${oneLine(step)}`);
    if (call) lines.push(`  steps.push(await ctx.tool(${JSON.stringify(call.name)}, ${JSON.stringify(call.arguments)}));`);
    else {
      const prompt = [`Step ${i + 1} of ${JSON.stringify(oneLine(input.purpose))}: ${oneLine(step)}`, ...guidance.map((g) => `Guidance: ${oneLine(g)}`), "Context: "].join("\n");
      lines.push(`  steps.push(await ctx.ask(${JSON.stringify(prompt)} + JSON.stringify({ input, steps })));`);
    }
  }
  const sources = input.lessons.map((l) => l.id).join(", ") || "none";
  const code = [
    `// ${name}: ${oneLine(input.purpose)}`,
    `// Compiled by the workflow builder from lessons ${sources}. Deterministic: every effect goes through ctx.`,
    "async function workflow(input, ctx) {",
    "  const steps = [];",
    ...lines,
    "  return { steps };",
    "}",
    "",
  ].join("\n");
  const checked = await checkWorkflow(code);
  if (!checked.ok) throw new Error(`the workflow builder produced code that does not compile: ${checked.error}`);
  return parseWorkflow({ name, description: describeLessons(input), inputs: { type: "object", additionalProperties: true }, code });
}

export const workflowFiles = (workflow: Workflow, dir: string = workflow.name) => [
  { path: `${dir}/workflow.json`, content: `${JSON.stringify(workflow, null, 2)}\n` },
];

/** Materializes lessons as a durable workflow, kept in the library so it can be run by name. */
export function workflowBuilder(options: BuilderOptions & { readonly library: WorkflowLibrary }): Materializer {
  return {
    kind: "materializer",
    id: "workflow-builder",
    target: TARGETS.workflow,
    materialize: async (input): Promise<Materialized> => {
      const workflow = await compileProcedure(options, input);
      await options.library.put(workflow);
      return { target: TARGETS.workflow, name: workflow.name, description: workflow.description, files: [...workflowFiles(workflow), { path: `${workflow.name}/workflow.js`, content: workflow.code }] };
    },
  };
}
