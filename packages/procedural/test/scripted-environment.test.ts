import { describe, expect, it } from "vitest";
import { ManualClock, ScriptedEnvironment, SeededEntropy } from "@harness/testkit";
import { applyEdits, GraphIdSchema, MemoryProceduralStore, parseSettings, ProceduralGraphSchema, presetOf, revisionId, RevisionRecordSchema, runDream } from "@harness/procedural";
import { readFileSync } from "node:fs";
import { addVerify, core, toGhost } from "./dream-fixtures.ts";

const settings = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));
const TASKS = {
  train: [
    { id: "t0", query: "Who directed it?", route: ["Start", "First_Hop_Retrieve", "Scan_Index"] },
    { id: "t1", query: "Check the answer.", route: ["Bridge_Extract", "Verify", "End"] },
    { id: "t2", query: "Just start.", route: ["Verify"] },
  ],
  validation: [{ id: "v0", query: "Verify it.", route: ["Bridge_Extract", "Verify", "End"] }],
};

describe("the scripted environment (dream's evaluator for tests)", () => {
  it("PD3.5 scores a task by the share of its route's edges the graph has, and rolls out the calls it walks", async () => {
    const env = new ScriptedEnvironment(TASKS);
    const g = core();
    expect(await env.evaluate(g, "validation")).toEqual([{ task: "v0", score: 0 }]);
    expect(await env.evaluate(ProceduralGraphSchema.parse(applyEdits(g, addVerify)), "validation")).toEqual([{ task: "v0", score: 1 }]);
    const [t0, t1, t2] = await env.evaluate(g, "train");
    expect(t0).toEqual({
      task: "t0",
      score: 1,
      query: "Who directed it?",
      steps: [
        { role: "assistant", content: "", call: { name: "First_Hop_Retrieve", arguments: {} } },
        { role: "tool", content: "First_Hop_Retrieve done" },
        { role: "assistant", content: "", call: { name: "Scan_Index", arguments: {} } },
        { role: "tool", content: "Scan_Index done" },
      ],
    });
    expect(t1).toMatchObject({ score: 0, steps: [] });
    // A route of one node scores whether the graph has it.
    expect([t2!.score, (await env.evaluate(ProceduralGraphSchema.parse(applyEdits(g, addVerify)), "train", ["t2"]))[0]!.score]).toEqual([0, 1]);
    await expect(env.evaluate(g, "train", ["nope"])).rejects.toThrow("no train task nope");
    expect(env.calls).toEqual([
      { split: "validation", tasks: ["v0"] },
      { split: "validation", tasks: ["v0"] },
      { split: "train", tasks: ["t0", "t1", "t2"] },
      { split: "train", tasks: ["t2"] },
    ]);
  });

  it("PD3.6 dream runs the paper's Algorithm 1 on it: a candidate that routes the validation task is committed, a broken one is not", async () => {
    const store = new MemoryProceduralStore();
    const graph = GraphIdSchema.parse("scripted");
    const g = core();
    await store.revisions.put(RevisionRecordSchema.parse({ id: revisionId(g), graph, parents: [], document: g, edits: null, origin: "seed", evidence: {}, decision: { kind: "head" }, at: 0 }));
    await store.heads.set(graph, undefined, revisionId(g));
    const env = new ScriptedEnvironment(TASKS);
    const answers = [{ edits: toGhost, raw: "{}" }, { edits: addVerify, raw: "{}" }];
    const paper = presetOf(settings, "paper");
    const result = await runDream({
      store,
      graph,
      settings: { ...paper, dream: { ...paper.dream, rounds: 2 } },
      ports: { refiner: { refine: async () => answers.shift()! }, evaluator: env, trajectories: { select: async () => [] }, clock: new ManualClock(5), entropy: new SeededEntropy(1) },
    });
    expect(result).toMatchObject({ status: "done", score: 1, rounds: [{ round: 1, outcome: "rejected", gate: "structure" }, { round: 2, outcome: "committed", score: 1 }] });
    expect((await store.heads.get(graph))?.revision).toBe(revisionId(ProceduralGraphSchema.parse(applyEdits(g, addVerify))));
  });
});
