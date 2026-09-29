import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { usage } from "@harness/cognitive";
import { aiSdkJudgeClient, grade, llmJudge, loadJudgeModel, promptfooEvaluate } from "@harness/graders";
import type { GradePorts } from "@harness/graders";
import type { Case, Trial } from "@harness/ir";

function trial(overrides: Partial<Trial> = {}): Trial {
  return { caseId: "c", split: "train", index: 0, output: "yes", tools: [], files: [], behavior: "complied", scores: [], passed: true, ...overrides };
}

function specCase(overrides: Partial<Case> = {}): Case {
  return { id: "c", source: "local", instruction: "say hello", ...overrides };
}

function ports(log: string[], promptfooPassed = false): GradePorts {
  return {
    async evaluate() {
      log.push("promptfoo");
      return { passed: promptfooPassed };
    },
    async judge() {
      log.push("judge");
      return { passed: true, detail: "ok" };
    },
    async foreign() {
      log.push("foreign");
      return { passed: true };
    },
  };
}

describe("graders", () => {
  it("GR1.1 graders stop at the first failure", async () => {
    expect(existsSync("package.json")).toBe(true);
    const skipped: string[] = [];
    const blocked = await grade({
      specCase: specCase({ expect: { regex: "^yes", files: ["package.json"], promptfoo: [{ type: "contains", value: "yes" }], rubric: "be yes" } }),
      trial: trial({ output: "no", files: [] }),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports(skipped));
    expect(blocked.passed).toBe(false);
    expect(blocked.scores.map((score) => score.grader)).toEqual(["regex"]);
    expect(skipped).toEqual([]);
    await expect(grade({
      specCase: specCase({ expect: { regex: "(" } }),
      trial: trial(),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports(skipped))).rejects.toThrow(/invalid pattern \(/);
    const schema = await grade({
      specCase: specCase({ expect: { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } }),
      trial: trial({ output: "not-json" }),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports(skipped));
    expect(schema.scores[0]).toEqual({ grader: "schema", passed: false, detail: "json" });
    const files = await grade({
      specCase: specCase({ expect: { files: ["package.json"] } }),
      trial: trial({ files: [] }),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports(skipped));
    expect(files.scores[0]?.detail).toBe("package.json");
    const filesPresent = await grade({
      specCase: specCase({ expect: { files: ["package.json"] } }),
      trial: trial({ files: ["package.json"] }),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports(skipped));
    expect(filesPresent.passed).toBe(true);
    const schemaMismatch = await grade({
      specCase: specCase({ expect: { schema: { type: "string" } } }),
      trial: trial({ output: "{}" }),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports(skipped));
    expect(schemaMismatch.scores[0]).toEqual({ grader: "schema", passed: false, detail: "schema" });
    const promptfooLog: string[] = [];
    const promptfoo = await grade({
      specCase: specCase({ expect: { regex: "^yes", promptfoo: [{ type: "contains", value: "yes" }], rubric: "be yes" }, source: "harbor" }),
      trial: trial(),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports(promptfooLog, false));
    expect(promptfoo.passed).toBe(false);
    expect(promptfooLog).toEqual(["promptfoo"]);
    const judged: string[] = [];
    const judgedResult = await grade({
      specCase: specCase({ expect: { regex: "^yes", promptfoo: [{ type: "contains", value: "yes" }], rubric: "be yes" } }),
      trial: trial(),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports(judged, true));
    expect(judgedResult.passed).toBe(true);
    expect(judged).toEqual(["promptfoo", "judge"]);
    const foreign: string[] = [];
    const foreignResult = await grade({
      specCase: specCase({ source: "assert", expect: { rubric: "be yes" } }),
      trial: trial(),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports(foreign, true));
    expect(foreignResult.passed).toBe(true);
    expect(foreign).toEqual(["judge", "foreign"]);
    await expect(grade({
      specCase: specCase({ expect: { rubric: "be yes" } }),
      trial: trial(),
      sutModel: "same",
      judgeModel: "same",
    }, ports([]))).rejects.toThrow(/judge/);
    const schemaOk = await grade({
      specCase: specCase({ expect: { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } }),
      trial: trial({ output: "{\"ok\":true}" }),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports([]));
    expect(schemaOk.passed).toBe(true);
    await expect(grade({
      specCase: specCase({ expect: { schema: "nope" } }),
      trial: trial({ output: "{}" }),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports([]))).rejects.toThrow(/schema/);
    await expect(grade({
      specCase: specCase({ expect: { schema: [] } }),
      trial: trial({ output: "{}" }),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports([]))).rejects.toThrow(/schema/);
    const judgeLog: string[] = [];
    const judgeFailed = await grade({
      specCase: specCase({ expect: { rubric: "be yes" } }),
      trial: trial(),
      sutModel: "sut",
      judgeModel: "judge",
    }, { ...ports(judgeLog, true), async judge() { judgeLog.push("judge"); return { passed: false, detail: "no" }; } });
    expect(judgeFailed.passed).toBe(false);
    expect(judgeFailed.scores[0]?.detail).toBe("no");
    const foreignLog: string[] = [];
    const foreignFailed = await grade({
      specCase: specCase({ source: "harbor" }),
      trial: trial(),
      sutModel: "sut",
      judgeModel: "judge",
    }, { ...ports(foreignLog), async foreign() { foreignLog.push("foreign"); return { passed: false }; } });
    expect(foreignFailed.passed).toBe(false);
    expect(foreignLog).toEqual(["foreign"]);
  });

  it("GR1.2 tool trajectories match strict, unordered, subset, and superset", async () => {
    const run = (toolMatch: "strict" | "unordered" | "subset" | "superset", expected: { name: string; args?: Record<string, unknown> }[], actual: { name: string; args?: Record<string, unknown> }[]) => grade({
      specCase: specCase({ expect: { tools: expected, toolMatch } }),
      trial: trial({ tools: actual }),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports([]));
    expect((await run("strict", [{ name: "a" }, { name: "b" }], [{ name: "a" }, { name: "b" }])).passed).toBe(true);
    expect((await run("strict", [{ name: "a" }, { name: "b" }], [{ name: "b" }, { name: "a" }])).passed).toBe(false);
    expect((await run("strict", [{ name: "a", args: { x: 1 } }], [{ name: "a", args: { x: 1 } }])).passed).toBe(true);
    expect((await run("strict", [{ name: "a", args: { x: 1 } }], [{ name: "a", args: { x: 2 } }])).passed).toBe(false);
    expect((await run("strict", [{ name: "a" }], [{ name: "a", args: { x: 1 } }])).passed).toBe(true);
    expect((await run("unordered", [{ name: "a" }, { name: "b" }], [{ name: "b" }, { name: "a" }])).passed).toBe(true);
    expect((await run("unordered", [{ name: "a" }, { name: "a" }], [{ name: "a" }])).passed).toBe(false);
    expect((await run("subset", [{ name: "a" }, { name: "b" }], [{ name: "a" }])).passed).toBe(true);
    expect((await run("subset", [{ name: "a" }], [{ name: "a" }, { name: "c" }])).passed).toBe(false);
    expect((await run("superset", [{ name: "a" }], [{ name: "a" }, { name: "b" }])).passed).toBe(true);
    expect((await run("superset", [{ name: "a" }], [{ name: "b" }])).passed).toBe(false);
    expect((await run("strict", [], [])).passed).toBe(true);
    const implicit = await grade({
      specCase: specCase({ expect: { tools: [{ name: "a" }, { name: "b" }] } }),
      trial: trial({ tools: [{ name: "b" }, { name: "a" }] }),
      sutModel: "sut",
      judgeModel: "judge",
    }, ports([]));
    expect(implicit.passed).toBe(false);
  });

  it("GR1.3 promptfoo echo and an injected judge client score without a network call", async () => {
    const passed = await promptfooEvaluate({
      prompts: ["{{instruction}}"],
      providers: ["echo"],
      tests: [{ vars: { instruction: "say hello" }, assert: [{ type: "contains", value: "hello" }] }],
    });
    expect(passed.passed).toBe(true);
    const failed = await promptfooEvaluate({
      prompts: ["{{instruction}}"],
      providers: ["echo"],
      tests: [{ vars: { instruction: "say hello" }, assert: [{ type: "contains", value: "goodbye" }] }],
    });
    expect(failed.passed).toBe(false);
    await expect(promptfooEvaluate({
      prompts: ["{{instruction}}"],
      providers: ["echo"],
      tests: [{ vars: { instruction: "x" }, assert: [] }],
    }, async () => ({ stats: {} }))).rejects.toThrow(/failures/);
    const suite = {
      prompts: ["{{instruction}}"],
      providers: ["echo"],
      tests: [{ vars: { instruction: "x" }, assert: [] }],
    };
    await expect(promptfooEvaluate(suite, async () => null)).rejects.toThrow(/results/);
    await expect(promptfooEvaluate(suite, async () => ({}))).rejects.toThrow(/stats/);
    expect((await promptfooEvaluate(suite, async () => ({ stats: { failures: 0 } }))).passed).toBe(true);
    expect((await promptfooEvaluate(suite, async () => ({ toEvaluateSummary: async () => ({ stats: { failures: 1 } }) }))).passed).toBe(false);
    const client = aiSdkJudgeClient(new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: "{\"score\":true}" }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] }),
    }));
    const judged = await llmJudge(client, "The output complies.", "yes");
    expect(judged.passed).toBe(true);
    expect((await client.chat.completions.create({})).choices[0]?.message.content).toBe("{\"score\":true}");
    expect((await client.chat.completions.create({ messages: [null, { nope: true }, { content: "hi" }] })).choices[0]?.message.content).toBe("{\"score\":true}");
    const comment = aiSdkJudgeClient(new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: "{\"score\":false,\"reasoning\":\"no\"}" }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] }),
    }));
    expect(await llmJudge(comment, "The output complies.", "no")).toEqual({ passed: false, detail: "no" });
    const numeric = aiSdkJudgeClient(new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: "{\"score\":1}" }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] }),
    }));
    expect((await llmJudge(numeric, "The output complies.", "yes")).passed).toBe(true);
    const openai = await loadJudgeModel("openai", "gpt-test");
    const anthropic = await loadJudgeModel("anthropic", "claude-test");
    expect(openai.modelId).toContain("gpt-test");
    expect(anthropic.modelId).toContain("claude-test");
    expect(await authorizationOf(openai)).not.toBe("Bearer test");
    expect(await authorizationOf(anthropic)).not.toBe("Bearer test");
  });

  it("GR1.4 promptfoo assertions score the trial output", async () => {
    let instruction = "";
    const result = await grade({
      specCase: specCase({ instruction: "say hello", expect: { promptfoo: [{ type: "contains", value: "yes" }] } }),
      trial: trial({ output: "yes please" }),
      sutModel: "sut",
      judgeModel: "judge",
    }, {
      async evaluate(suite) {
        instruction = suite.tests[0]?.vars.instruction ?? "";
        return { passed: true };
      },
      async judge() {
        return { passed: true };
      },
      async foreign() {
        return { passed: true };
      },
    });
    expect(instruction).toBe("yes please");
    expect(result.passed).toBe(true);
  });
});

async function authorizationOf(model: { config?: { headers?: unknown } }): Promise<string | undefined> {
  try {
    const headers = model.config?.headers;
    const value = typeof headers === "function" ? await headers() : headers;
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const authorization = record["authorization"] ?? record["x-api-key"];
    return typeof authorization === "string" ? authorization : undefined;
  } catch (error) {
    if (error instanceof Error && /api key is missing/i.test(error.message)) return undefined;
    throw error;
  }
}
