/**
 * The harness in its own filesystem, as an Eve agent directory (https://eve.dev): what
 * the harness is right now (its workers, tools, settings, decision model, generators,
 * templates and commands) written as files, so a person or an agent sees it where it
 * sees everything else. `~/AGENTS.md` says what is where; `~/agent/` holds `agent.ts`
 * (the runtime settings), `instructions.md` (the person's once written, read by the
 * agents each turn), `tools/`, `skills/`, `subagents/` (the workers), `templates/` (what
 * `/ask` answers from; files the engine and the person write) and `workflows/` (the
 * script templates as scripts that run on their own). What is generated is rewritten
 * when the state changes and removed when the state no longer has it; the rest is kept.
 */
import type { ToolSet } from "ai";
import { asSchema } from "ai";
import type { IFileSystem } from "just-bash";
import { holeNames } from "./decide.ts";
import type { Settings } from "./shell.ts";
import type { Template } from "./templates.ts";
import { HOME } from "./vfs.ts";

export const AGENT = `${HOME}/agent`;
const MANIFEST = `${AGENT}/.generated`;
const INSTRUCTIONS = `${AGENT}/instructions.md`;

export interface WorkerInfo {
  readonly name: string;
  readonly description: string;
  /** Its model as provider/model id, when it has one. */
  readonly model?: string;
  readonly instructions?: string;
}

export interface HarnessState {
  /** The agents' instructions, written to instructions.md when there is none. */
  readonly instructions: string;
  readonly workers: readonly WorkerInfo[];
  readonly tools: ToolSet;
  /** How a tool's calls are approved now, in words. */
  readonly approval: (toolName: string) => string;
  readonly settings: Settings;
  readonly decisionModel: string;
  readonly generators: readonly string[];
  readonly templates: readonly Template[];
  /** The facts a template's hole can take its value from. */
  readonly facts: readonly string[];
  readonly commands: readonly { readonly name: string; readonly description: string }[];
  readonly sessions: readonly string[];
}

const quote = (s: string) => JSON.stringify(s);
const indent = (text: string, by: string) => text.replace(/\n/g, `\n${by}`);

function agentTs(state: HarnessState): string {
  const model = state.workers.find((w) => w.name === state.settings.worker)?.model;
  return [
    "// The harness in this page, as an Eve agent (https://eve.dev/docs/reference/agent-files).",
    "// Generated from the harness's state: edits here are overwritten. Yours to edit: instructions.md",
    "// (read each turn) and templates/ (what /ask answers from); /help lists the commands that change the rest.",
    'import { defineAgent } from "eve";',
    "",
    "export default defineAgent({",
    model ? `  model: ${quote(model)},` : `  // the ${state.settings.worker} worker answers without a model`,
    "});",
    "",
    "/** The harness's settings behind this agent (see /status). */",
    "export const harness = {",
    `  worker: ${quote(state.settings.worker)},`,
    `  tier: ${quote(state.settings.tier)},`,
    `  approve: ${quote(state.settings.approval)},`,
    `  generate: ${quote(state.settings.generate)},`,
    `  decisionModel: ${quote(state.decisionModel)},`,
    `  generators: [${state.generators.map(quote).join(", ")}],`,
    "} as const;",
    "",
  ].join("\n");
}

async function toolTs(name: string, state: HarnessState): Promise<string> {
  const t = state.tools[name]!;
  const schema = await asSchema(t.inputSchema).jsonSchema;
  return [
    `// The agent's ${name} tool, as the harness runs it (generated; edits are overwritten).`,
    'import { defineTool } from "eve";',
    "",
    "export default defineTool({",
    `  description: ${quote(typeof t.description === "string" ? t.description : name)},`,
    `  inputSchema: ${indent(JSON.stringify(schema, null, 2), "  ")},`,
    `  approval: ${quote(state.approval(name))},`,
    "});",
    "",
  ].join("\n");
}

function subagentTs(worker: WorkerInfo): string {
  return [
    `// The ${worker.name} worker, as an Eve subagent a turn runs on (/worker ${worker.name}). Generated; edits are overwritten.`,
    'import { defineAgent } from "eve";',
    "",
    "export default defineAgent({",
    `  description: ${quote(worker.description)},`,
    ...(worker.model ? [`  model: ${quote(worker.model)},`] : []),
    "});",
    "",
  ].join("\n");
}

/** A script template as a script that fills its own holes from variables of their names, then runs. */
function workflow(template: Template): string {
  const holes = [...new Set(holeNames(template))];
  const said = (h: string) => (template.holes[h]?.description ?? h).replace(/[}"$`\\]/g, "");
  return [
    "#!/bin/bash",
    `# ${template.description}`,
    `# The script template ${template.id} (version ${template.version}, ~/agent/templates/${template.id}.md) as a workflow.`,
    `# /ask fills its holes itself${template.examples[0] ? ` (/ask ${template.examples[0]})` : ""}; here, set them and run it:`,
    `#   ${[...holes.map((h) => `${h}='…'`), `bash ~/agent/workflows/${template.id}.sh`].join(" ")}`,
    "# Generated from the template: edit the template, not this file.",
    ...holes.map((h) => `: "\${${h}:?${h}: ${said(h)}}"`),
    "template=$(cat <<'HARNESS_TEMPLATE'",
    template.body.trimEnd(),
    "HARNESS_TEMPLATE",
    ")",
    "script=$template",
    ...holes.map((h) => `script=\${script//"{{${h}}}"/$${h}}`),
    'eval "$script"',
    "",
  ].join("\n");
}

function agentsMd(state: HarnessState): string {
  const { settings } = state;
  const templates = state.templates.map((t) => `- ${t.id} (${t.kind}, +${t.helpful} -${t.harmful}): ${t.description}`);
  return [
    "# This workspace",
    "",
    "The harness daemon runs in this page, and this shell's files are its agents' files. It answers `/ask` from",
    "templates before it spends any inference: a decision model picks the template, the harness fills it, and a",
    "generator writes one only when none fits (asking first). Everything below is kept in sync with the harness.",
    "",
    "## The harness now",
    "",
    `- Worker: ${settings.worker}; approvals: ${settings.approval}; generation: ${settings.generate}; Claude's tier: ${settings.tier}`,
    `- Decision model: ${state.decisionModel}`,
    `- Generators, cheapest first: ${state.generators.join(", ") || "none here"}`,
    `- Sessions: ${state.sessions.length}`,
    "",
    "## Layout: an Eve agent (https://eve.dev)",
    "",
    "- `agent/agent.ts`: the runtime settings (generated)",
    "- `agent/instructions.md`: the agents' instructions; yours to edit, read each turn",
    "- `agent/templates/`: what `/ask` answers from; edit, add, and rate them (`/rate`)",
    "- `agent/workflows/`: the script templates as scripts that run on their own (generated)",
    "- `agent/tools/`: the agents' tools and how their calls are approved (generated)",
    "- `agent/skills/`: how to use the harness and write templates (generated)",
    "- `agent/subagents/`: the workers a turn runs on (generated)",
    "",
    "## Templates",
    "",
    ...(templates.length ? templates : ["- none yet"]),
    "",
    "## Commands",
    "",
    ...state.commands.map((c) => `- \`/${c.name}\`: ${c.description}`),
    "",
  ].join("\n");
}

function templatesSkill(state: HarnessState): string {
  return [
    "---",
    "name: templates",
    "description: How /ask answers from templates, and how to write or fix one.",
    "---",
    "# Templates",
    "",
    "A template is a file `~/agent/templates/<id>.md`: YAML frontmatter and a body. The body is the answer (kind: reply)",
    "or a bash script (kind: script) with `{{hole}}` markers (snake_case; never two holes next to each other).",
    "",
    "```yaml",
    "description: which requests it answers",
    "examples: [requests it answers]",
    "kind: reply | script",
    "match: an optional regular expression; a request it matches is this template's without a decision",
    "holes:",
    "  name: { description: what goes here, source: fact | pattern | choice | text, fact: …, pattern: …, options: […] }",
    "```",
    "",
    "A hole is filled cheapest first: a fact the harness knows, the first group of a pattern found in the request, a",
    "choice the decision model makes among options (or a fact's lines), or text a generator writes (asking first).",
    "An undeclared hole is a fact of its name when there is one, else text. The facts now:",
    "",
    ...state.facts.map((f) => `- ${f}`),
    "",
    "`/rate good` or `/rate bad <why>` after an answer counts it in the template's file; a reason has the template",
    "rewritten the next time it is chosen (the old version kept under `.history/`), and one rated harmful by the",
    "margin retires to `retired/`.",
    "",
  ].join("\n");
}

function terminalSkill(state: HarnessState): string {
  return [
    "---",
    "name: terminal",
    "description: Driving the harness from the terminal with slash commands.",
    "---",
    "# The terminal",
    "",
    "A line whose first word is a slash command is the harness's; anything else is bash's. Every command takes",
    "`--help`. `/ask` takes the rest of its line as typed; the others' output pipes into bash (`/trace 50 | grep model`).",
    "",
    ...state.commands.map((c) => `- \`/${c.name}\`: ${c.description}`),
    "",
  ].join("\n");
}

/** Every generated file, by path. */
async function agentFiles(state: HarnessState): Promise<Map<string, string>> {
  const files = new Map<string, string>([
    [`${HOME}/AGENTS.md`, agentsMd(state)],
    [`${AGENT}/agent.ts`, agentTs(state)],
    [`${AGENT}/skills/templates.md`, templatesSkill(state)],
    [`${AGENT}/skills/terminal.md`, terminalSkill(state)],
  ]);
  for (const name of Object.keys(state.tools)) files.set(`${AGENT}/tools/${name}.ts`, await toolTs(name, state));
  for (const worker of state.workers) {
    files.set(`${AGENT}/subagents/${worker.name}/agent.ts`, subagentTs(worker));
    files.set(`${AGENT}/subagents/${worker.name}/instructions.md`, `${worker.instructions ?? worker.description}\n`);
  }
  for (const t of state.templates) if (t.kind === "script") files.set(`${AGENT}/workflows/${t.id}.sh`, workflow(t));
  return files;
}

async function readManifest(fs: IFileSystem): Promise<string[]> {
  try {
    const paths: unknown = JSON.parse(await fs.readFile(MANIFEST));
    return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Write the harness's state into its agent directory: the generated files that changed,
 * removing the ones it generated before and no longer has, and instructions.md when
 * there is none. Returns what it wrote and removed, and the instructions in effect.
 */
export async function syncAgentDir(fs: IFileSystem, state: HarnessState): Promise<{ written: string[]; removed: string[]; instructions: string }> {
  const files = await agentFiles(state);
  files.set(MANIFEST, `${JSON.stringify([...files.keys()].sort(), null, 2)}\n`);
  const written: string[] = [];
  const removed: string[] = [];
  for (const path of await readManifest(fs)) {
    if (files.has(path) || !(await fs.exists(path))) continue;
    await fs.rm(path);
    removed.push(path);
  }
  if (!(await fs.exists(INSTRUCTIONS))) files.set(INSTRUCTIONS, `${state.instructions}\n`);
  for (const [path, content] of files) {
    if ((await fs.exists(path)) && (await fs.readFile(path)) === content) continue;
    await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(path, content);
    written.push(path);
  }
  return { written, removed, instructions: (await fs.readFile(INSTRUCTIONS)).trim() };
}
