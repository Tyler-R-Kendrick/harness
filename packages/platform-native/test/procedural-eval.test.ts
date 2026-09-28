import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { usage } from "@harness/cognitive";
import { scriptedJudge } from "@harness/testkit";
import { FORMAT, GraphIdSchema, MemoryProceduralStore, parseGraph, parseSettings, revisionId, RevisionRecordSchema } from "@harness/procedural";
import { loadProceduralSettings, loadTaskSuite, nativeDream, nativeTaskEvaluator } from "@harness/platform-native";

const settings = loadProceduralSettings();
const graph = GraphIdSchema.parse("team/capitals");
const parsed = parseGraph({
  format: FORMAT,
  nodeTypes: ["ACTION", "REASONING", "STATUS"],
  relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
  nodes: [
    { id: "Start", type: "STATUS", description: "The task begins." },
    { id: "search", type: "ACTION", description: "Search the index." },
    { id: "End", type: "STATUS", description: "Answered." },
  ],
  edges: [
    { from: "Start", relation: "LEADS_TO", to: "search", condition: null, guidance: "Search the index before anything else.", pitfalls: "" },
    { from: "search", relation: "LEADS_TO", to: "End", condition: null, guidance: "Answer.", pitfalls: "" },
  ],
});
if (!parsed.ok) throw new Error("fixture");
const seed = parsed.graph;

const TASK_FILE = {
  $schema: "../node_modules/@harness/procedural/data/task-suite.schema.json",
  description: "Name the capital of a country.",
  scorer: "normalized-exact",
  tasks: [
    { id: "t0", prompt: "Capital of Spain?", expected: "Madrid", split: "train" },
    { id: "v0", prompt: "Capital of France?", expected: "Paris", split: "validation" },
    { id: "v1", prompt: "Capital of Italy?", expected: "Rome", split: "validation" },
  ],
};
const ANSWERS: Record<string, string> = { "Capital of Spain?": "madrid", "Capital of France?": "The Paris", "Capital of Italy?": "rome." };

const text = (reply: (prompt: string) => string, calls: string[] = []) =>
  new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      const prompt = JSON.stringify(options.prompt);
      calls.push(prompt);
      return { content: [{ type: "text", text: reply(prompt) }], finishReason: { unified: "stop", raw: undefined }, usage: usage(1, 1), warnings: [] };
    },
  });

async function withFile<T>(content: unknown, run: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "harness-eval-"));
  try {
    const file = join(dir, "tasks.json");
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("dream's evaluator on the native host (--procedural-eval)", () => {
  it("PX2.68 a user's task file is read and parsed at startup; one that cannot be right is refused, naming where", async () => {
    const suite = await withFile(TASK_FILE, async (file) => loadTaskSuite(file));
    expect(suite).toMatchObject({ scorer: "normalized-exact", description: "Name the capital of a country." });
    expect(suite.tasks.map((t) => t.id)).toEqual(["t0", "v0", "v1"]);
    await expect(withFile({ ...TASK_FILE, scorer: "bleu" }, async (file) => loadTaskSuite(file))).rejects.toThrow(/invalid task suite[\s\S]*at scorer/);
    await expect(withFile("{", async (file) => loadTaskSuite(file))).rejects.toThrow(SyntaxError);
  });

  it("PX2.69 nativeDream gates on the task suite: the solver, guided by each candidate, answers the suite's tasks, and a candidate that scores higher is committed", async () => {
    const store = new MemoryProceduralStore();
    await store.revisions.put(RevisionRecordSchema.parse({ id: revisionId(seed), graph, parents: [], document: seed, edits: null, origin: "import", evidence: {}, decision: { kind: "head" }, at: 0 }));
    await store.heads.set(graph, undefined, revisionId(seed));
    const suite = await withFile(TASK_FILE, async (file) => loadTaskSuite(file));
    const solved: string[] = [];
    const guidance = text((prompt) => (prompt.includes("Verify") ? "Verify the answer before you give it." : "Answer at once."));
    const solver = text((prompt) => (prompt.includes("Verify the answer") ? (ANSWERS[Object.keys(ANSWERS).find((q) => prompt.includes(q))!] ?? "") : "Lyon"), solved);
    const refined: string[] = [];
    const verify = { add_nodes: [], delete_nodes: [], delete_edges: [{ source: "Start", target: "search" }], add_edges: [{ source: "Start", target: "search", relation: "LEADS_TO", condition: null, guidance: "Verify each answer, then search.", pitfalls: "" }] };
    const refiner = text(() => JSON.stringify(verify), refined);
    // The paper's gate (at least the retained score), in one round.
    const paper = settings.presets["paper"]!;
    const oneRound = parseSettings({ ...settings, presets: { ...settings.presets, paper: { ...paper, dream: { ...paper.dream, rounds: 1 } } } });
    const evaluator = nativeTaskEvaluator({ suite, settings: oneRound, preset: "paper", model: solver, guidance });
    const result = await nativeDream({ store, settings: oneRound, preset: "paper", model: refiner, sessions: async () => [], evaluator, task: suite.description! })(graph);
    expect(result).toMatchObject({ status: "done", score: 1, rounds: [{ round: 1, outcome: "committed" }] });
    const head = await store.heads.get(graph);
    expect(head?.history).toEqual([revisionId(seed)]);
    expect((await store.revisions.get(head!.revision))?.document.edges[1]).toMatchObject({ from: "Start", to: "search", guidance: "Verify each answer, then search." });
    // The refiner was told the suite's task and shown the training rollout; the solver answered every task.
    expect(refined[0]).toContain("Name the capital of a country.");
    expect(refined[0]).toContain("Capital of Spain?");
    for (const q of ["Capital of Spain?", "Capital of France?", "Capital of Italy?"]) expect(solved.some((p) => p.includes(q))).toBe(true);
  });

  it("PX2.70 a judge-scored suite asks the judge the host gives it, once per evaluation", async () => {
    const suite = await withFile({ ...TASK_FILE, scorer: "judge" }, async (file) => loadTaskSuite(file));
    const judge = scriptedJudge(() => ({ type: "boolean", probability: 0.75 }));
    let resolved = 0;
    const evaluator = nativeTaskEvaluator({ suite, settings, model: text(() => "Paris"), judge: async () => (resolved++, judge) });
    expect(await evaluator.evaluate(seed, "validation")).toEqual([
      { task: "v0", score: 0.75 },
      { task: "v1", score: 0.75 },
    ]);
    expect(resolved).toBe(1);
    expect(judge.requests[0]!.state).toEqual({ task: "Capital of France?", expected: "Paris", answer: "Paris" });
  });
});
