import { describe, expect, it } from "vitest";
import { executeDeclarative, parseDeclarativeWorkflow } from "@harness/core";

function workflow(actions: unknown[]) {
  return parseDeclarativeWorkflow({
    kind: "Workflow",
    name: "sample",
    description: "a sample",
    inputs: { tasks: { type: "array" }, trunk: { type: "string" } },
    trigger: { kind: "OnConversationStart", id: "sample", actions },
  });
}

describe("declarative workflow executor", () => {
  it("DY1.1 a document that is not a workflow is refused before any tool runs", () => {
    expect(() => parseDeclarativeWorkflow({ kind: "Prompt", name: "x" })).toThrow(/kind must be Workflow/);
    expect(() => parseDeclarativeWorkflow({
      kind: "Workflow",
      name: "x",
      trigger: { kind: "OnConversationStart", id: "x", actions: [{ kind: "SendActivity" }] },
    })).toThrow(/unknown action kind SendActivity/);
  });

  it("DY1.2 tools run in order and a thrown tool halts the rest", async () => {
    const seen: string[] = [];
    const report = await executeDeclarative({
      workflow: workflow([
        { kind: "InvokeFunctionTool", functionName: "one", arguments: { n: 1 } },
        { kind: "InvokeFunctionTool", functionName: "two", arguments: {} },
        { kind: "InvokeFunctionTool", functionName: "three", arguments: {} },
      ]),
      inputs: { tasks: [], trunk: "main" },
      tools: {
        one: async () => {
          seen.push("one");
          return null;
        },
        two: async () => {
          seen.push("two");
          throw new Error("two failed");
        },
        three: async () => {
          seen.push("three");
          return null;
        },
      },
      onFailure: async () => {
        seen.push("recover");
      },
    });
    expect(report.status).toBe("halted");
    expect(report.reason).toBe("two failed");
    expect(seen).toEqual(["one", "two", "recover"]);
    expect(report.calls.map((call) => call.name)).toEqual(["one", "two"]);
  });

  it("DY1.3 foreach binds the item and the index, and If keeps the previous value", async () => {
    const parents: unknown[] = [];
    const report = await executeDeclarative({
      workflow: workflow([
        { kind: "SetVariable", variable: "Local.commits", value: [] },
        {
          kind: "Foreach",
          source: "=Workflow.Inputs.tasks",
          itemName: "task",
          indexName: "index",
          actions: [
            {
              kind: "InvokeFunctionTool",
              functionName: "commit",
              arguments: {
                branch: "=task.branch",
                parent: "=If(index = 0, Blank(), Last(Local.commits))",
              },
              output: { result: "Local.commit" },
            },
            { kind: "AppendValue", variable: "Local.commits", value: "=Local.commit.sha" },
            {
              kind: "If",
              condition: "=index + 1 < Count(Workflow.Inputs.tasks)",
              then: [{
                kind: "InvokeFunctionTool",
                functionName: "retarget",
                arguments: {
                  branch: "=Index(Workflow.Inputs.tasks, index + 1).branch",
                  onto: "=Last(Local.commits)",
                },
              }],
            },
          ],
        },
      ]),
      inputs: {
        trunk: "main",
        tasks: [{ branch: "frontier/loop" }, { branch: "frontier/adapter" }],
      },
      tools: {
        commit: async (args) => {
          parents.push(args["parent"]);
          return { sha: `sha-${String(args["branch"])}` };
        },
        retarget: async (args) => args,
      },
    });
    expect(report.status).toBe("done");
    expect(parents).toEqual([null, "sha-frontier/loop"]);
    expect(report.calls.filter((call) => call.name === "retarget")).toEqual([
      { name: "retarget", arguments: { branch: "frontier/adapter", onto: "sha-frontier/loop" } },
    ]);
  });
});
