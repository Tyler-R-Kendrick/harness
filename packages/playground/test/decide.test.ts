import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { experimental_evaluate } from "ai";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { chooseTemplate, lexicalJudge, resolveHoles } from "../src/decide.ts";
import { parseEngineSettings } from "../src/engine-settings.ts";
import { parseTemplate } from "../src/templates.ts";

const settings = parseEngineSettings(JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")));
const judge = lexicalJudge(settings.lexical);

const template = (id: string, description: string, examples: string[], body = "x\n", holes = "") =>
  parseTemplate(id, `---\ndescription: ${description}\nexamples: ${JSON.stringify(examples)}\n${holes}---\n${body}`);
const listFiles = template("list-files", "Lists the files in the working directory", ["what files are here?", "list the files"]);
const date = template("today", "Says today's date", ["what day is it?", "what's the date today"]);
const run = template("run-command", "Runs the shell command given after $", ["$ ls -la"], "{{command}}", "holes:\n  command: { description: the command, source: pattern, pattern: '^\\s*\\$\\s*(.+)$' }\n");

/** A decision model that answers every choice with fixed probabilities. */
function fixed(p: Record<string, number>): EvaluationModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "fixed",
    supportedQuestionTypes: ["choice"],
    doEvaluate: async ({ questions }) => ({
      answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "choice" as const, choice: Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0], probabilities: p }])),
      warnings: [],
    }),
  };
}

describe("the lexical decision model: a deterministic judge, no inference", () => {
  it("DC1.1 a choice goes to the option whose words the state shares most (stopwords aside), with a probability for every option", async () => {
    const { answers } = await experimental_evaluate({
      model: judge,
      state: "which files are in here?",
      questions: { pick: { type: "choice", instructions: "Which template?", criteria: { "list-files": "Lists the files. list the files", today: "Says today's date", none: "none of these" } } },
    });
    expect(answers.pick.choice).toBe("list-files");
    expect(Object.keys(answers.pick.probabilities!).sort()).toEqual(["list-files", "none", "today"]);
    expect(answers.pick.probabilities!["list-files"]).toBeGreaterThan(0.9);
  });

  it("DC1.2 a state sharing no words with any option goes to none, which scores the settings' floor; an option without a description is read by its name", async () => {
    const { answers } = await experimental_evaluate({ model: judge, state: "write me a poem", questions: { pick: { type: "choice", instructions: "?", criteria: { "list-files": "Lists the files", none: null } } } });
    expect(answers.pick.choice).toBe("none");
    const byName = await experimental_evaluate({ model: judge, state: { request: "open the README please" }, questions: { file: { type: "choice", instructions: "Which file?", criteria: { "README.md": null, "notes/todo.md": null } } } });
    expect(byName.answers.file.choice).toBe("README.md");
  });

  it("DC1.3 it declares only choice questions", () => {
    expect(judge.supportedQuestionTypes).toEqual(["choice"]);
    expect(judge.provider).toBe("harness.lexical");
  });
});

describe("choosing a template", () => {
  it("DC2.1 the decision model's choice answers when it is likely enough; none, or too little probability, is no template", async () => {
    expect(await chooseTemplate(judge, "list the files here", [listFiles, date], settings)).toMatchObject({ template: { id: "list-files" }, by: "harness.lexical/tf-idf" });
    expect((await chooseTemplate(judge, "write me a sonnet", [listFiles, date], settings)).template).toBeUndefined();
    expect((await chooseTemplate(fixed({ "list-files": 0.55, none: 0.45 }), "anything", [listFiles], settings)).template).toBeUndefined();
    expect((await chooseTemplate(fixed({ "list-files": 0.7, none: 0.3 }), "anything", [listFiles], settings)).template?.id).toBe("list-files");
    expect(await chooseTemplate(judge, "anything", [], settings)).toEqual({ probability: 0, probabilities: {}, by: "none: no templates" });
  });

  it("DC2.3 a request a template's match expression fits is that template's, without asking the decision model", async () => {
    const matching = template("run-command", "Runs a command", ["$ ls"], "{{command}}", "match: '^\\s*\\$\\s'\nholes:\n  command: { description: c, source: pattern, pattern: '^\\s*\\$\\s*(.+)$' }\n");
    const refuse: EvaluationModelV4 = { ...judge, doEvaluate: () => Promise.reject(new Error("the decision model was asked")) };
    expect(await chooseTemplate(refuse, "$ echo hi > x", [listFiles, matching], settings)).toMatchObject({ template: { id: "run-command" }, probability: 1, by: "match" });
    expect(() => template("bad", "d", [], "x", "match: '('\n")).toThrow(/match/);
  });

  it("DC2.2 more templates than one question takes are narrowed lexically first, so the decision model sees the likeliest", async () => {
    const many = Array.from({ length: 30 }, (_, i) => template(`t${i}`, `Answers about topic${i}`, [`tell me about topic${i}`]));
    const asked: string[][] = [];
    const spy: EvaluationModelV4 = { ...judge, doEvaluate: async (o) => (asked.push(Object.keys((o.questions["template"] as { criteria: object }).criteria)), judge.doEvaluate(o)) };
    const chosen = await chooseTemplate(spy, "tell me about topic27", many, settings);
    expect(chosen.template?.id).toBe("t27");
    expect(asked[0]).toHaveLength(settings.decision.maxOptions);
    expect(asked[0]).toContain("t27");
    expect(asked[0]).toContain("none");
  });
});

describe("filling a template's holes without inference", () => {
  const facts = { cwd: () => "/home/user", files: () => "README.md\nnotes/todo.md" };

  it("DC3.1 facts, patterns and choices are filled; text holes (and what cannot be found) are left for a generator", async () => {
    const t = parseTemplate(
      "mix",
      `---
description: d
holes:
  command: { description: the command, source: pattern, pattern: '^\\$\\s*(.+)$' }
  file: { description: which file, source: choice, fact: files }
  mood: { description: a mood, source: choice, options: [happy, sad] }
  poem: { description: a poem }
  gone: { description: a fact nobody knows, source: fact }
---
{{cwd}} {{command}} {{file}} {{mood}} {{poem}} {{gone}} {{undeclared}}`,
    );
    const { values, missing } = await resolveHoles(t, "$ cat README.md # I am happy", facts, judge);
    expect(values).toEqual({ cwd: "/home/user", command: "cat README.md # I am happy", file: "README.md", mood: "happy" });
    expect(missing).toEqual(["poem", "gone", "undeclared"]);
    expect((await resolveHoles(run, "no dollar here", facts, judge)).missing).toEqual(["command"]);
  });

  it("DC3.2 a choice with one option takes it; with none, it is missing", async () => {
    const t = parseTemplate("one", "---\ndescription: d\nholes:\n  file: { description: f, source: choice, fact: files }\n---\n{{file}}");
    expect((await resolveHoles(t, "x", { files: () => "only.md" }, judge)).values).toEqual({ file: "only.md" });
    expect((await resolveHoles(t, "x", { files: () => "" }, judge)).missing).toEqual(["file"]);
  });
});
