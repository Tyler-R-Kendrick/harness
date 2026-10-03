import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { probability } from "@harness/cognitive";
import { MemoryDecisionLog } from "@harness/decision";
import type { DecisionEvent } from "@harness/decision";
import { chooseTemplate, lexicalDecider, modelDecider } from "../src/decide.ts";
import { parseEngineSettings } from "../src/engine-settings.ts";
import { TEMPLATE_FORK, TemplateDecisions } from "../src/template-decision.ts";
import { parseTemplate } from "../src/templates.ts";

const settings = parseEngineSettings(JSON.parse(readFileSync(new URL("../data/templates.json", import.meta.url), "utf8")));
const once = { ...settings, decision: { ...settings.decision, rotate: false } };

const template = (id: string, description: string, examples: string[], extra = "") => parseTemplate(id, `---\ndescription: ${description}\nexamples: ${JSON.stringify(examples)}\n${extra}---\nx\n`);
const listFiles = template("list-files", "Lists the files in the working directory", ["what files are here?", "list the files"]);
const date = template("today", "Says today's date", ["what day is it?"]);

/** A deterministic clock: each reading is the next whole number. */
const ticking = () => {
  let t = 0;
  return { now: () => t++ };
};
const decisions = (keep = 100, publish?: (e: DecisionEvent) => void) => new TemplateDecisions({ clock: ticking(), keep, ...(publish ? { publish } : {}) });

/** A decision model that answers every choice with fixed probabilities. */
function fixed(p: Record<string, number>, modelId = "fixed"): EvaluationModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId,
    supportedQuestionTypes: ["choice"],
    doEvaluate: async ({ questions }) => ({
      answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "choice" as const, choice: Object.entries(p).sort((a, b) => b[1] - a[1])[0]![0], probabilities: p }])),
      warnings: [],
    }),
  };
}
const failing = (message: string): EvaluationModelV4 => ({ ...fixed({}, "down"), doEvaluate: () => Promise.reject(new Error(message)) });

describe("choosing a template is the fork playground.template, decided by the decision layer", () => {
  it("TPD1.1 a decision is one record of the fork: the model that decided at its pinned id and version, the template as the action, its probability as confidence", async () => {
    const d = decisions();
    const model = modelDecider(fixed({ none: 0.1, "list-files": 0.8, today: 0.1 }), { id: "org/julia", version: "a".repeat(40) });
    const decision = await chooseTemplate([model], "show me files", [listFiles, date], once, d);
    expect(decision).toMatchObject({ template: { id: "list-files" }, by: "test/fixed", probability: 0.8, id: "dec-0" });
    const [record, ...rest] = await d.log.query();
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      id: "dec-0",
      fork: TEMPLATE_FORK,
      rung: "model",
      member: "org/julia",
      memberVersion: "a".repeat(40),
      action: "list-files",
      confidence: 0.8,
      mode: "active",
      input: { request: "show me files", options: ["list-files", "today"] },
      trace: [{ rung: "model", member: "org/julia", outcome: "accepted", confidence: 0.8 }],
    });
  });

  it("TPD1.2 a decider without a pinned identity is keyed by its model's provider and id, which also stand for its version; the lexical judge's version follows its settings", async () => {
    const d = decisions();
    await chooseTemplate([modelDecider(fixed({ none: 0.1, "list-files": 0.9 }))], "x", [listFiles], once, d);
    await chooseTemplate([lexicalDecider(settings.lexical)], "list the files here", [listFiles], once, d);
    await chooseTemplate([lexicalDecider({ ...settings.lexical, temperature: settings.lexical.temperature * 2 })], "list the files here", [listFiles], once, d);
    const [model, lexical, retuned] = await d.log.query();
    expect([model!.member, model!.memberVersion]).toEqual(["test/fixed", "test/fixed"]);
    expect(lexical!.member).toBe("harness.lexical/tf-idf");
    expect(lexical!.memberVersion).toMatch(/^tf-idf-[0-9a-f]{8}$/);
    expect(retuned!.memberVersion).not.toBe(lexical!.memberVersion);
  });

  it("TPD1.3 a template's match expression is the fork's rule: decided with confidence 1 at the rule rung, no model asked, and recorded", async () => {
    const d = decisions();
    const matching = template("run-command", "Runs a command", ["$ ls"], "match: '^\\s*\\$\\s'\n");
    const refuse = modelDecider({ ...fixed({}), doEvaluate: () => Promise.reject(new Error("the decision model was asked")) });
    const decision = await chooseTemplate([refuse], "$ echo hi", [listFiles, matching], settings, d);
    expect(decision).toMatchObject({ template: { id: "run-command" }, probability: 1, probabilities: { "run-command": 1 }, by: "match" });
    expect(await d.log.query()).toMatchObject([{ fork: TEMPLATE_FORK, rung: "rule", action: "run-command", confidence: 1, trace: [{ rung: "rule", outcome: "decided by rule" }] }]);
  });

  it("TPD1.4 a decider that fails is passed over in the record's trace and in the problems; the next one decides", async () => {
    const d = decisions();
    const decision = await chooseTemplate([modelDecider(failing("offline")), lexicalDecider(settings.lexical)], "list the files here", [listFiles, date], settings, d);
    expect(decision).toMatchObject({ template: { id: "list-files" }, by: "harness.lexical/tf-idf", problems: ["test/down: offline"] });
    const [record] = await d.log.query();
    expect(record!.trace.map((s) => [s.member, s.outcome.split(":")[0]])).toEqual([
      ["test/down", "failed"],
      ["harness.lexical/tf-idf", "accepted"],
    ]);
    expect(record!.member).toBe("harness.lexical/tf-idf");
  });

  it("TPD1.5 when every decider fails nobody decided, so there is nothing to answer with: it throws as before, and the failed attempts are still recorded", async () => {
    const d = decisions();
    await expect(chooseTemplate([modelDecider(failing("offline")), modelDecider(failing("no weights"))], "x", [listFiles], settings, d)).rejects.toThrow("no decision model answered: test/down: offline; test/down: no weights");
    expect(await d.log.query()).toMatchObject([{ rung: "human", action: "none", confidence: 0 }]);
    await expect(chooseTemplate([], "x", [listFiles], settings, d)).rejects.toThrow("no decision model answered: ");
  });

  it("TPD1.6 [changed from asking only the first decider that answers] a model below its threshold passes the decision on, so the next decider may decide: here the lexical judge, which is sure", async () => {
    const d = decisions();
    // The model leans to list-files at 0.5, short of the 0.6 it needs; the lexical judge is sure of it.
    const unsure = modelDecider(fixed({ none: 0.3, "list-files": 0.5, today: 0.2 }));
    const decision = await chooseTemplate([unsure, lexicalDecider(settings.lexical)], "list the files here", [listFiles, date], once, d);
    expect(decision).toMatchObject({ template: { id: "list-files" }, by: "harness.lexical/tf-idf" });
    const [record] = await d.log.query();
    expect(record!.trace).toMatchObject([
      { member: "test/fixed", outcome: "below verify", confidence: 0.5 },
      { member: "harness.lexical/tf-idf", outcome: "accepted" },
    ]);
  });

  it("TPD1.7 when no decider is sure enough the decision is the fork's fallback, none, at the human rung; the probabilities are those of the decider that came closest", async () => {
    const d = decisions();
    const decision = await chooseTemplate([modelDecider(fixed({ none: 0.3, "list-files": 0.5, today: 0.2 })), modelDecider(fixed({ none: 0.2, "list-files": 0.4, today: 0.4 }, "other"))], "anything", [listFiles, date], once, d);
    expect(decision.template).toBeUndefined();
    expect(decision).toMatchObject({ by: "test/fixed", probability: 0.5, probabilities: { none: 0.3, "list-files": 0.5, today: 0.2 }, id: "dec-0" });
    expect(await d.log.query()).toMatchObject([{ rung: "human", action: "none", confidence: 0 }]);
  });

  it("TPD1.8 each kind of decider keeps its own accept threshold: the stricter one's answer below it is no answer, and the ladder acts at the looser threshold", async () => {
    const strict = { ...once, decision: { ...once.decision, accept: probability(0.9) } };
    // The model at 0.8 is short of its 0.9, so it passes the decision on; the lexical judge at 0.8 clears its 0.6.
    const sure = { ...lexicalDecider(settings.lexical), judge: fixed({ none: 0.2, "list-files": 0.8 }, "lex") };
    const d = decisions();
    const decision = await chooseTemplate([modelDecider(fixed({ none: 0.2, "list-files": 0.8 })), sure], "anything", [listFiles], strict, d);
    expect(decision).toMatchObject({ template: { id: "list-files" }, by: "test/lex" });
    const [record] = await d.log.query();
    // The record keeps what the model said before it was withheld.
    expect(record!.trace[0]).toMatchObject({ member: "test/fixed", outcome: "answers do not separate the options" });
    // The policy version says which thresholds applied.
    expect(record!.policy).toBe("playground-template/act=0.6/rotate=1");
  });

  it("TPD1.9 a model is asked in the layer's rotations, one question per rotation of the options, and a decision records the rotations it averaged in its policy", async () => {
    const asked: string[][] = [];
    const spy: EvaluationModelV4 = { ...fixed({}), doEvaluate: async ({ questions }) => ({ answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => { const keys = Object.keys((q as { criteria: object }).criteria); asked.push(keys); return [id, { type: "choice" as const, choice: keys[0]!, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.5 : 0.5 / (keys.length - 1)])) }]; })), warnings: [] }) };
    const d = decisions();
    await chooseTemplate([modelDecider(spy)], "anything", [listFiles, date], settings, d);
    expect(asked.map((keys) => keys[0]).sort()).toEqual(["list-files", "none", "today"]);
    expect((await d.log.query())[0]!.policy).toBe("playground-template/act=0.6/rotate=3");
  });

  it("TPD1.10 the layer publishes decision.made for each decision, and the log keeps at most the settings' number of records, the oldest first to go", async () => {
    const events: DecisionEvent[] = [];
    const d = decisions(2, (e) => events.push(e));
    for (const request of ["a", "b", "c"]) await chooseTemplate([lexicalDecider(settings.lexical)], request, [listFiles], settings, d);
    expect(events.map((e) => [e.type, e.payload.id, e.payload.fork])).toEqual([
      ["decision.made", "dec-0", TEMPLATE_FORK],
      ["decision.made", "dec-1", TEMPLATE_FORK],
      ["decision.made", "dec-2", TEMPLATE_FORK],
    ]);
    expect((await d.log.query()).map((r) => r.id)).toEqual(["dec-1", "dec-2"]);
    expect(d.log).toBeInstanceOf(MemoryDecisionLog);
  });

  it("TPD1.11 a decision's outcome is attached to its record, and a decision the log no longer has takes none", async () => {
    const d = decisions();
    const { id } = await chooseTemplate([lexicalDecider(settings.lexical)], "list the files here", [listFiles], settings, d);
    expect(await d.outcome(id!, "rated-good")).toBe(true);
    expect((await d.log.query())[0]!.outcome).toEqual({ at: expect.any(Number), source: "human", kind: "rated-good" });
    expect(await d.outcome("dec-99", "rated-bad")).toBe(false);
  });

  it("TPD1.12 without templates there is nothing to decide, and nothing is recorded", async () => {
    const d = decisions();
    expect(await chooseTemplate([lexicalDecider(settings.lexical)], "x", [], settings, d)).toEqual({ probability: 0, probabilities: {}, by: "none: no templates" });
    expect(await d.log.size()).toBe(0);
  });
});
