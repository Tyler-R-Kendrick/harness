import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { Bash } from "just-bash";
import { AGENT, syncAgentDir } from "../src/agent-dir.ts";
import type { HarnessState } from "../src/agent-dir.ts";
import { parseTemplate, TEMPLATES } from "../src/templates.ts";
import { HOME } from "../src/vfs.ts";

const showFile = parseTemplate(
  "show-file",
  "---\ndescription: Shows the contents of a file\nexamples: [show me README.md]\nkind: script\nholes:\n  path: { description: the file to show, source: choice, fact: files }\n---\ncat '{{path}}' | head -n 1\n",
);
const listFiles = parseTemplate("list-files", "---\ndescription: Lists the files\n---\nFiles: {{files}}\n");

function state(overrides: Partial<HarnessState> = {}): HarnessState {
  return {
    instructions: "You are an agent in a playground.",
    workers: [
      { name: "templates", description: "Answers from templates", model: "harness.templates/templates", instructions: "Answer from ~/agent/templates." },
      { name: "echo", description: "Echoes the prompt" },
    ],
    tools: {
      bash: tool({ description: "Run a bash command", inputSchema: jsonSchema<{ command: string }>({ type: "object", properties: { command: { type: "string" } }, required: ["command"] }) }),
    },
    approval: (name) => (name === "bash" ? "asks first (/approve ask)" : "runs on its own"),
    settings: { worker: "templates", tier: "default", approval: "ask", generate: "ask" },
    decisionModel: "harness.lexical/tf-idf",
    generators: ["claude.sample/sample"],
    templates: [showFile, listFiles],
    facts: ["cwd", "files"],
    commands: [
      { name: "ask [...prompt]", description: "Run a turn" },
      { name: "templates", description: "The templates" },
    ],
    sessions: ["ses_1"],
    ...overrides,
  };
}

describe("the harness as an Eve agent directory in the filesystem", () => {
  it("AD1.1 the harness's state is written as an Eve agent: AGENTS.md, agent.ts, instructions, tools, skills, subagents (the workers) and workflows (the script templates)", async () => {
    const bash = new Bash({ cwd: HOME, files: {} });
    const { written } = await syncAgentDir(bash.fs, state());
    expect(written.sort()).toEqual(
      [
        `${HOME}/AGENTS.md`,
        `${AGENT}/agent.ts`,
        `${AGENT}/instructions.md`,
        `${AGENT}/tools/bash.ts`,
        `${AGENT}/skills/templates.md`,
        `${AGENT}/skills/terminal.md`,
        `${AGENT}/subagents/templates/agent.ts`,
        `${AGENT}/subagents/templates/instructions.md`,
        `${AGENT}/subagents/echo/agent.ts`,
        `${AGENT}/subagents/echo/instructions.md`,
        `${AGENT}/workflows/show-file.sh`,
        `${AGENT}/.generated`,
      ].sort(),
    );
    const agent = await bash.readFile(`${AGENT}/agent.ts`);
    expect(agent).toContain('import { defineAgent } from "eve";');
    expect(agent).toContain('model: "harness.templates/templates"');
    expect(agent).toMatch(/generate: "ask"/);
    expect(agent).toMatch(/decisionModel: "harness.lexical\/tf-idf"/);
    const tool = await bash.readFile(`${AGENT}/tools/bash.ts`);
    expect(tool).toContain('description: "Run a bash command"');
    expect(tool).toContain('"required": [\n      "command"\n    ]');
    expect(tool).toContain('approval: "asks first (/approve ask)"');
    expect(await bash.readFile(`${AGENT}/subagents/templates/agent.ts`)).toContain('description: "Answers from templates"');
    expect(await bash.readFile(`${AGENT}/subagents/templates/instructions.md`)).toBe("Answer from ~/agent/templates.\n");
    const agents = await bash.readFile(`${HOME}/AGENTS.md`);
    for (const said of ["agent/templates/", "agent/workflows/", "agent/subagents/", "`/ask [...prompt]`", "show-file (script, +0 -0): Shows the contents of a file", "harness.lexical/tf-idf", "claude.sample/sample", "Sessions: 1"]) expect(agents).toContain(said);
    expect(await bash.readFile(`${AGENT}/skills/templates.md`)).toContain("- cwd\n- files");
    expect(await bash.readFile(`${AGENT}/skills/terminal.md`)).toContain("`/templates`: The templates");
  });

  it("AD1.2 a script template's workflow runs on its own with its holes set, and refuses to run without them", async () => {
    const bash = new Bash({ cwd: HOME, files: { [`${HOME}/README.md`]: "# hello\nmore\n" } });
    await syncAgentDir(bash.fs, state());
    expect(await bash.exec("path='README.md' bash agent/workflows/show-file.sh", { cwd: HOME })).toMatchObject({ stdout: "# hello\n", exitCode: 0 });
    expect(await bash.exec("bash agent/workflows/show-file.sh", { cwd: HOME })).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("path: the file to show") });
  });

  it("AD1.3 instructions.md is the person's once written: kept as edited, never overwritten; what it holds is read back", async () => {
    const bash = new Bash({ cwd: HOME, files: {} });
    const first = await syncAgentDir(bash.fs, state());
    expect(first.instructions).toBe("You are an agent in a playground.");
    await bash.fs.writeFile(`${AGENT}/instructions.md`, "Be terse.\n");
    const again = await syncAgentDir(bash.fs, state());
    expect(again.written).not.toContain(`${AGENT}/instructions.md`);
    expect(again.instructions).toBe("Be terse.");
  });

  it("AD1.4 a sync writes only what changed, and removes the generated files the state no longer has", async () => {
    const bash = new Bash({ cwd: HOME, files: {} });
    await syncAgentDir(bash.fs, state());
    expect((await syncAgentDir(bash.fs, state())).written).toEqual([]);
    const changed = await syncAgentDir(bash.fs, state({ templates: [listFiles], settings: { worker: "echo", tier: "default", approval: "ask", generate: "off" } }));
    expect(changed.written.sort()).toEqual([`${HOME}/AGENTS.md`, `${AGENT}/.generated`, `${AGENT}/agent.ts`].sort());
    expect(changed.removed).toEqual([`${AGENT}/workflows/show-file.sh`]);
    expect(await bash.fs.exists(`${AGENT}/workflows/show-file.sh`)).toBe(false);
    // What is not generated (a template, a file of the person's) is never removed.
    await bash.fs.mkdir(TEMPLATES, { recursive: true });
    await bash.fs.writeFile(`${TEMPLATES}/mine.md`, "x");
    await bash.fs.writeFile(`${AGENT}/tools/mine.ts`, "x");
    await syncAgentDir(bash.fs, state({ tools: {} }));
    expect(await bash.fs.exists(`${TEMPLATES}/mine.md`)).toBe(true);
    expect(await bash.fs.exists(`${AGENT}/tools/mine.ts`)).toBe(true);
    expect(await bash.fs.exists(`${AGENT}/tools/bash.ts`)).toBe(false);
  });

  it("AD1.5 a manifest that is not a list of paths is taken as none", async () => {
    const bash = new Bash({ cwd: HOME, files: { [`${AGENT}/.generated`]: "not json" } });
    expect((await syncAgentDir(bash.fs, state())).removed).toEqual([]);
  });
});
