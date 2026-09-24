import { TARGETS } from "@harness/learning";
import type { Materialized, Materializer } from "@harness/learning";
import type { WorkflowLibrary } from "@harness/workflows";
import { compileProcedure, describeLessons, kebab, workflowFiles } from "./workflow-builder.ts";
import type { BuilderOptions } from "./workflow-builder.ts";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Materializes lessons as an agent skill (a SKILL.md with name and description
 * frontmatter, loaded by coding agents on demand) whose procedure is a durable
 * workflow: the skill tells the agent to run it rather than improvise the steps, and
 * running it again with the same run id resumes it.
 */
export function skillBuilder(options: BuilderOptions & { readonly library: WorkflowLibrary }): Materializer {
  return {
    kind: "materializer",
    id: "skill-builder",
    target: TARGETS.agentSkill,
    materialize: async (input): Promise<Materialized> => {
      const name = kebab(input.lessons[0]?.title ?? input.purpose);
      const workflow = await compileProcedure(options, input, name);
      await options.library.put(workflow);
      const description = describeLessons(input).slice(0, 1024);
      const steps = input.lessons.flatMap((l) => l.steps ?? []);
      const skill = [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        "---",
        "",
        `# ${oneLine(input.lessons[0]?.title ?? input.purpose)}`,
        "",
        ...input.lessons.map((l) => `- ${oneLine(l.text)}${l.when ? ` (when ${oneLine(l.when)})` : ""}`),
        "",
        ...(steps.length ? ["## Steps", "", ...steps.map((s, i) => `${i + 1}. ${oneLine(s)}`), ""] : []),
        "## Run",
        "",
        "These steps are a durable workflow (`workflow.json`). Run it instead of doing the steps by hand;",
        "if it is interrupted, run the same command again: finished steps are not repeated.",
        "",
        "```sh",
        "harness-workflow run workflow.json --run <run-id> --input '<json>'",
        "```",
        "",
        `Through a harness daemon, invoke \`workflows.run\` with \`{ "name": "${name}", "run": "<run-id>", "input": {} }\`.`,
        "",
      ].join("\n");
      return { target: TARGETS.agentSkill, name, description, files: [{ path: `${name}/SKILL.md`, content: skill }, ...workflowFiles(workflow, name)] };
    },
  };
}
