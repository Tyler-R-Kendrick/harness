import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { f1Score, normalizeAnswer, parseTaskSuite, scoreAnswer, TaskSuiteSchema, taskSuiteJsonSchema } from "@harness/procedural";

const suite = (over: Record<string, unknown> = {}) => ({
  scorer: "exact",
  tasks: [
    { id: "t1", prompt: "Capital of France?", expected: "Paris", split: "train" },
    { id: "v1", prompt: "Capital of Italy?", expected: "Rome", split: "validation" },
  ],
  ...over,
});

describe("task suites (a user's replayable tasks for dream's evaluator)", () => {
  it("PD3.7 a task file parses into tasks, a scorer and optional tools, and its JSON Schema is generated from the parser", async () => {
    const parsed = parseTaskSuite({
      $schema: "./task-suite.schema.json",
      description: "Answer geography questions.",
      instructions: "Answer with the name alone.",
      scorer: "judge",
      judge: { instructions: "Is the answer right?" },
      tools: [{ name: "search" }, { name: "lookup", description: "Look a name up." }],
      tasks: [{ id: "v1", prompt: "Capital of Italy?", split: "validation" }],
    });
    expect(parsed).toMatchObject({ scorer: "judge", judge: { instructions: "Is the answer right?" }, tools: [{ name: "search" }, { name: "lookup", description: "Look a name up." }] });
    expect(parsed.tasks).toEqual([{ id: "v1", prompt: "Capital of Italy?", split: "validation" }]);
    expect(parseTaskSuite(suite()).tools).toBeUndefined();
    await expect(`${JSON.stringify(taskSuiteJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/task-suite.schema.json");
    const schema = JSON.parse(readFileSync(new URL("../data/task-suite.schema.json", import.meta.url), "utf8")) as { required: string[] };
    expect(schema.required).toEqual(["scorer", "tasks"]);
  });

  it("PD3.8 a task file that cannot be right is refused whole, naming where", () => {
    const refused = (input: unknown) => () => parseTaskSuite(input);
    expect(refused(suite({ scorer: "bleu" }))).toThrow(/invalid task suite[\s\S]*at scorer/);
    expect(refused(suite({ tasks: [] }))).toThrow(/at tasks/);
    expect(refused(suite({ tasks: [{ id: "", prompt: "p", expected: "e", split: "validation" }] }))).toThrow(/tasks\[0\]\.id/);
    expect(refused(suite({ tasks: [{ id: "a", prompt: "", expected: "e", split: "validation" }] }))).toThrow(/tasks\[0\]\.prompt/);
    expect(refused(suite({ tasks: [{ id: "a", prompt: "p", expected: "e", split: "test" }] }))).toThrow(/tasks\[0\]\.split/);
    expect(refused(suite({ extra: 1 }))).toThrow(/extra/);
    expect(refused(suite({ tools: [{ name: "" }] }))).toThrow(/tools\[0\]\.name/);
    expect(refused(suite({ judge: { instructions: "" } }))).toThrow(/judge\.instructions/);
    expect(refused(suite({ description: "" }))).toThrow(/description/);
    expect(refused(suite({ instructions: "" }))).toThrow(/instructions/);
  });

  it("PD3.9 task ids and tool names are unique, a metric needs every task's expected answer, and there are validation tasks", () => {
    const issue = (input: unknown) => {
      const { code, path, message } = TaskSuiteSchema.safeParse(input).error!.issues[0]!;
      return { code, path, message };
    };
    const twice = { id: "v1", prompt: "again", expected: "x", split: "validation" };
    expect(issue(suite({ tasks: [...suite().tasks, twice] }))).toEqual({ code: "custom", path: ["tasks", 2, "id"], message: "task id v1 is used twice" });
    expect(issue(suite({ tools: [{ name: "search" }, { name: "search" }] }))).toEqual({ code: "custom", path: ["tools", 1, "name"], message: "tool search is named twice" });
    for (const scorer of ["exact", "normalized-exact", "f1"]) {
      expect(issue(suite({ scorer, tasks: [{ id: "v1", prompt: "p", split: "validation" }] }))).toEqual({ code: "custom", path: ["tasks", 0, "expected"], message: `the ${scorer} scorer compares with an expected answer` });
    }
    expect(parseTaskSuite(suite({ scorer: "judge", tasks: [{ id: "v1", prompt: "p", split: "validation" }] })).scorer).toBe("judge");
    expect(issue(suite({ tasks: [{ id: "t1", prompt: "p", expected: "e", split: "train" }] }))).toEqual({ code: "custom", path: ["tasks"], message: "a task suite needs at least one validation task" });
  });

  it("PD3.10 normalized answers are lower case, without punctuation, articles or extra spaces", () => {
    expect(normalizeAnswer("  The Eiffel   Tower! ")).toBe("eiffel tower");
    expect(normalizeAnswer("A cat, an owl & the  END.")).toBe("cat owl end");
    expect(normalizeAnswer("Théâtre—an’s thé")).toBe("théâtreans thé");
    expect(normalizeAnswer("then another")).toBe("then another");
    expect(normalizeAnswer("")).toBe("");
  });

  it("PD3.11 F1 is the harmonic mean of token precision and recall over normalized answers, counting repeats", () => {
    expect(f1Score("the Eiffel Tower", "Eiffel Tower")).toBe(1);
    expect(f1Score("Eiffel", "Eiffel Tower")).toBeCloseTo(2 / 3);
    expect(f1Score("Tower Eiffel Paris", "Eiffel Tower")).toBeCloseTo(0.8);
    expect(f1Score("x x y", "x y y")).toBeCloseTo(2 / 3);
    expect(f1Score("x x", "x")).toBeCloseTo(2 / 3);
    expect(f1Score("Rome", "Paris")).toBe(0);
    expect(f1Score("", "")).toBe(1);
    expect(f1Score("the", "Paris")).toBe(0);
    expect(f1Score("Paris", "an")).toBe(0);
  });

  it("PD3.12 each metric scores an answer against the expected one in [0, 1]", () => {
    expect(scoreAnswer("exact", " Paris\n", "Paris")).toBe(1);
    expect(scoreAnswer("exact", "Paris", " Paris\n")).toBe(1);
    expect(scoreAnswer("exact", "paris", "Paris")).toBe(0);
    expect(scoreAnswer("normalized-exact", "The paris.", "Paris")).toBe(1);
    expect(scoreAnswer("normalized-exact", "Paris, France", "Paris")).toBe(0);
    expect(scoreAnswer("f1", "Paris, France", "Paris")).toBeCloseTo(2 / 3);
  });
});
