import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { experimental_evaluate } from "ai";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { probability } from "@harness/cognitive";
import { chooseTemplate, lexicalDecider, lexicalJudge, modelDecider, resolveHoles } from "../src/decide.ts";
import { parseEngineSettings } from "../src/engine-settings.ts";
import { parseTemplate } from "../src/templates.ts";

const settings = parseEngineSettings(JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")));
const judge = lexicalJudge(settings.lexical);
const lexical = [lexicalDecider(settings.lexical)];
/** The settings with a model asked once, in the options' order, as tests about names and thresholds need. */
const once = { ...settings, decision: { ...settings.decision, rotate: false } };

const template = (id: string, description: string, examples: string[], body = "x\n", holes = "") =>
  parseTemplate(id, `---\ndescription: ${description}\nexamples: ${JSON.stringify(examples)}\n${holes}---\n${body}`);
const listFiles = template("list-files", "Lists the files in the working directory", ["what files are here?", "list the files"]);
const date = template("today", "Says today's date", ["what day is it?", "what's the date today"]);
const run = template("run-command", "Runs the shell command given after $", ["$ ls -la"], "{{command}}", "holes:\n  command: { description: the command, source: pattern, pattern: '^\\s*\\$\\s*(.+)$' }\n");

/** A decision model that answers every choice with fixed probabilities, and keeps the questions it was asked. */
function fixed(p: Record<string, number>): EvaluationModelV4 & { asked: Record<string, unknown>[] } {
  const asked: Record<string, unknown>[] = [];
  return {
    asked,
    specificationVersion: "v4",
    provider: "test",
    modelId: "fixed",
    supportedQuestionTypes: ["choice"],
    doEvaluate: async ({ questions }) => {
      asked.push(questions);
      return {
        answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "choice" as const, choice: Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0], probabilities: p }])),
        warnings: [],
      };
    },
  };
}
/** A decision model that cannot answer. */
const failing = (message: string): EvaluationModelV4 => ({ ...fixed({}), provider: "test", modelId: "down", doEvaluate: () => Promise.reject(new Error(message)) });

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
  it("DC2.1 the decision model's choice answers when it is likely enough (a model and the lexical judge each by their own threshold); none, or too little probability, is no template", async () => {
    expect(await chooseTemplate(lexical, "list the files here", [listFiles, date], settings)).toMatchObject({ template: { id: "list-files" }, by: "harness.lexical/tf-idf" });
    expect((await chooseTemplate(lexical, "write me a sonnet", [listFiles, date], settings)).template).toBeUndefined();
    const lexicallySure = (p: number) => ({ ...lexicalDecider(settings.lexical), judge: fixed({ "list-files": p, none: 1 - p }) });
    expect((await chooseTemplate([lexicallySure(settings.lexical.accept - 0.05)], "anything", [listFiles], settings)).template).toBeUndefined();
    expect((await chooseTemplate([lexicallySure(settings.lexical.accept + 0.05)], "anything", [listFiles], settings)).template?.id).toBe("list-files");
    // Each kind of decider has its own threshold.
    const modelSure = (p: number) => modelDecider(fixed({ "list-files": p, none: 1 - p }));
    const strict = { ...once, decision: { ...once.decision, accept: probability(0.9) } };
    expect((await chooseTemplate([modelSure(0.8)], "anything", [listFiles], strict)).template).toBeUndefined();
    expect((await chooseTemplate([lexicallySure(0.8)], "anything", [listFiles], strict)).template?.id).toBe("list-files");
    expect((await chooseTemplate([modelSure(0.91)], "anything", [listFiles], strict)).template?.id).toBe("list-files");
    expect(await chooseTemplate(lexical, "anything", [], settings)).toEqual({ probability: 0, probabilities: {}, by: "none: no templates" });
  });

  it("DC2.4 a model is asked what the user asks for, with each template's description alone; the lexical judge reads names, descriptions and examples", async () => {
    const model = fixed({ none: 1, "list-files": 0, today: 0 });
    await chooseTemplate([modelDecider(model)], "anything", [listFiles, date], once);
    expect(model.asked[0]!["q0"]).toEqual({ type: "choice", instructions: settings.decision.question, criteria: { none: settings.decision.none, "list-files": listFiles.description, today: date.description } });
    const words = fixed({ none: 1, "list-files": 0 });
    await chooseTemplate([{ ...lexicalDecider(settings.lexical), judge: words }], "anything", [listFiles], settings);
    expect((words.asked[0]!["q0"] as { criteria: Record<string, string> }).criteria["list-files"]).toBe("Lists the files in the working directory. what files are here?. list the files");
  });

  it("DC2.6 a model is asked with the options in every rotation at once and its answers averaged, so where an option sits does not decide it; the lexical judge is asked once", async () => {
    // A model that always prefers the option it is shown first.
    const asked: string[][] = [];
    const firstWins: EvaluationModelV4 = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "first",
      supportedQuestionTypes: ["choice"],
      doEvaluate: async ({ questions }) => ({
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, q]) => {
            const criteria = (q as { criteria: Record<string, string> }).criteria;
            asked.push(Object.values(criteria));
            const keys = Object.keys(criteria);
            return [id, { type: "choice" as const, choice: keys[0]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / (keys.length - 1)])) }];
          }),
        ),
        warnings: [],
      }),
    };
    const decision = await chooseTemplate([modelDecider(firstWins)], "anything", [listFiles, date], settings);
    const [n, l, d] = [settings.decision.none, listFiles.description, date.description];
    expect(asked).toEqual([
      [n, l, d],
      [l, d, n],
      [d, n, l],
    ]);
    // Each option was first once: an even spread, below the threshold.
    expect(decision.template).toBeUndefined();
    for (const p of Object.values(decision.probabilities)) expect(p).toBeCloseTo(1 / 3, 6);
    asked.length = 0;
    await chooseTemplate([modelDecider(firstWins)], "anything", [listFiles, date], once);
    expect(asked).toHaveLength(1);
  });

  it("DC2.7 rotating works for any option names: the model sees each rotation in its own order, integer-like names included, and answers come back by name", async () => {
    const orders: unknown[][] = [];
    const firstWins: EvaluationModelV4 = {
      specificationVersion: "v4",
      provider: "test",
      modelId: "first",
      supportedQuestionTypes: ["choice"],
      doEvaluate: async ({ questions }) => ({
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, q]) => {
            const criteria = (q as { criteria: Record<string, unknown> }).criteria;
            orders.push(Object.values(criteria));
            const keys = Object.keys(criteria);
            return [id, { type: "choice" as const, choice: keys[0]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.8 : 0.1])) }];
          }),
        ),
        warnings: [],
      }),
    };
    const t = parseTemplate("pick", "---\ndescription: d\nholes:\n  n: { description: which, source: choice, options: [b, '10', '2'] }\n---\n{{n}}");
    const resolved = await resolveHoles(t, "x", {}, [modelDecider(firstWins)], settings);
    expect(orders).toEqual([
      ["b", "10", "2"],
      ["10", "2", "b"],
      ["2", "b", "10"],
    ]);
    // Each was first once, so none wins outright; the answer is one of the names, not a stand-in key.
    expect(["b", "10", "2"]).toContain(resolved.values["n"]);
  });

  it("DC2.5 deciders are asked in order: one that fails hands the decision to the next, which says who decided and why the others did not", async () => {
    const decision = await chooseTemplate([modelDecider(failing("offline")), ...lexical], "list the files here", [listFiles, date], settings);
    expect(decision).toMatchObject({ template: { id: "list-files" }, by: "harness.lexical/tf-idf", problems: ["test/down: offline"] });
    expect((await chooseTemplate(lexical, "list the files here", [listFiles], settings)).problems).toBeUndefined();
    await expect(chooseTemplate([modelDecider(failing("offline")), modelDecider(failing("no weights"))], "x", [listFiles], settings)).rejects.toThrow("no decision model answered: test/down: offline; test/down: no weights");
  });

  it("DC2.3 a request a template's match expression fits is that template's, without asking the decision model", async () => {
    const matching = template("run-command", "Runs a command", ["$ ls"], "{{command}}", "match: '^\\s*\\$\\s'\nholes:\n  command: { description: c, source: pattern, pattern: '^\\s*\\$\\s*(.+)$' }\n");
    const refuse: EvaluationModelV4 = { ...judge, doEvaluate: () => Promise.reject(new Error("the decision model was asked")) };
    expect(await chooseTemplate([modelDecider(refuse)], "$ echo hi > x", [listFiles, matching], settings)).toMatchObject({ template: { id: "run-command" }, probability: 1, by: "match" });
    expect(() => template("bad", "d", [], "x", "match: '('\n")).toThrow(/match/);
  });

  it("DC2.2 more templates than one question takes are narrowed lexically first, so the decision model sees the likeliest", async () => {
    const many = Array.from({ length: 30 }, (_, i) => template(`t${i}`, `Answers about topic${i}`, [`tell me about topic${i}`]));
    const asked: string[][] = [];
    const spy: EvaluationModelV4 = { ...judge, doEvaluate: async (o) => (asked.push(Object.keys((o.questions["q0"] as { criteria: object }).criteria)), judge.doEvaluate(o)) };
    const chosen = await chooseTemplate([{ ...lexicalDecider(settings.lexical), judge: spy }], "tell me about topic27", many, settings);
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
    const { values, missing } = await resolveHoles(t, "$ cat README.md # I am happy", facts, lexical);
    expect(values).toEqual({ cwd: "/home/user", command: "cat README.md # I am happy", file: "README.md", mood: "happy" });
    expect(missing).toEqual(["poem", "gone", "undeclared"]);
    expect((await resolveHoles(run, "no dollar here", facts, lexical)).missing).toEqual(["command"]);
  });

  it("DC3.2 a choice with one option takes it; with none, it is missing", async () => {
    const t = parseTemplate("one", "---\ndescription: d\nholes:\n  file: { description: f, source: choice, fact: files }\n---\n{{file}}");
    expect((await resolveHoles(t, "x", { files: () => "only.md" }, lexical)).values).toEqual({ file: "only.md" });
    expect((await resolveHoles(t, "x", { files: () => "" }, lexical)).missing).toEqual(["file"]);
  });

  it("DC3.3 a choice hole goes to the first decider that answers, asked the hole's description with the options as they are", async () => {
    const t = parseTemplate("pick", "---\ndescription: d\nholes:\n  file: { description: the file to show, source: choice, fact: files }\n---\n{{file}}");
    const model = fixed({ "README.md": 0.1, "notes/todo.md": 0.9 });
    const resolved = await resolveHoles(t, "open my todo list", facts, [modelDecider(failing("offline")), modelDecider(model), ...lexical], once);
    expect(resolved).toMatchObject({ values: { file: "notes/todo.md" }, problems: ["test/down: offline"] });
    expect(model.asked[0]!["q0"]).toEqual({ type: "choice", instructions: "the file to show", criteria: { "README.md": null, "notes/todo.md": null } });
  });
});
