import { evaluatorContract, ManualClock, ScriptedEnvironment, SeededEntropy } from "@harness/testkit";
import { applyEdits, ProceduralGraphSchema, taskSuiteEvaluator } from "@harness/procedural";
import { addVerify, core, settings } from "./dream-fixtures.ts";
import { graphs, guidanceModel, solverModel, suiteOf } from "./task-fixtures.ts";

/** Hotpot tasks: one the core already routes, one that needs Verify before End. */
const TASKS = {
  train: [
    { id: "t0", query: "Who directed it?", route: ["Start", "First_Hop_Retrieve", "Scan_Index"] },
    { id: "t1", query: "Check the answer.", route: ["Bridge_Extract", "Verify", "End"] },
    { id: "t2", query: "Just start.", route: ["Start"] },
  ],
  validation: [
    { id: "v0", query: "Who wrote it?", route: ["Start", "First_Hop_Retrieve", "Scan_Index", "Bridge_Extract"] },
    { id: "v1", query: "Verify it.", route: ["Bridge_Extract", "Verify", "End"] },
  ],
};

evaluatorContract("ScriptedEnvironment", () => ({ evaluator: new ScriptedEnvironment(TASKS), graphs: [core(), ProceduralGraphSchema.parse(applyEdits(core(), addVerify))] }));

// The task-suite evaluator on scripted models: the solver answers right only when the candidate's guidance says to verify.
evaluatorContract("task suite on scripted models", () => ({
  evaluator: taskSuiteEvaluator({ suite: suiteOf(), settings, model: solverModel(), guidance: guidanceModel(), clock: new ManualClock(1_000), entropy: new SeededEntropy(5) }),
  graphs: graphs(),
}));
