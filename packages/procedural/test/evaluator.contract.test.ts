import { evaluatorContract, ScriptedEnvironment } from "@harness/testkit";
import { applyEdits, ProceduralGraphSchema } from "@harness/procedural";
import { addVerify, core } from "./dream-fixtures.ts";

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
