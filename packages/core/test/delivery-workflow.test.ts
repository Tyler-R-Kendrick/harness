import { describe, expect, it } from "vitest";
import { parseDeclarativeWorkflow, parseResourcePolicy, runDeliveryWorkflow } from "@harness/core";
import type { DeliveryEffects, DeliveryTask, ResourceSample } from "@harness/core";

const policy = parseResourcePolicy({
  maxExtraDiskBytes: 5_000,
  minFreeDiskBytes: 1_000,
  maxMemoryBytes: 8_000,
  maxTokens: 100,
  gpu: "deny",
  timeoutMs: 50,
  maxWorktrees: 4,
});

const task: DeliveryTask = { id: "loop", branch: "frontier/loop", paths: ["loop.txt"] };

function sample(over: Partial<ResourceSample> = {}): ResourceSample {
  return {
    extraDiskBytes: 100,
    freeDiskBytes: 5_000,
    memoryBytes: 100,
    tokens: 10,
    gpuRequested: false,
    elapsedMs: 10,
    artifactBytes: 0,
    ...over,
  };
}

function effects(over: Partial<DeliveryEffects> = {}): DeliveryEffects & { removed: string[] } {
  const removed: string[] = [];
  const base: DeliveryEffects = {
    measure: async () => sample(),
    link: async () => ({ commonDir: "/repo/.git", caches: ["symlink"] }),
    gates: async () => ({ hooks: "pass", local: "pass" }),
    commit: async (_branch, parent) => ({ sha: "sha-1", parent: parent ?? "trunk" }),
    cleanArtifacts: async () => undefined,
    openPullRequest: async (_branch, base) => base,
    verify: async () => ({ correctness: "pass", gates: "pass", budget: "pass" }),
    review: async () => "comment",
    resolve: async () => 0,
    squashMerge: async () => ({ sha: "squash", parents: 1 }),
    retarget: async () => 1,
    removeWorktree: async (branch) => {
      removed.push(branch);
    },
    worktreePresent: async () => false,
  };
  return { removed, ...base, ...over };
}

function doc(actions: unknown[]) {
  return parseDeclarativeWorkflow({
    kind: "Workflow",
    name: "mini",
    description: "mini",
    inputs: { trunk: { type: "string" }, tasks: { type: "array" } },
    trigger: { kind: "OnConversationStart", id: "mini", actions },
  });
}

describe("delivery actions under a declarative workflow", () => {
  it("DY2.1 a budget breach on the baseline measure halts before a worktree is linked", async () => {
    let linked = false;
    const harness = effects({
      measure: async () => sample({ freeDiskBytes: 1 }),
      link: async () => {
        linked = true;
        return { commonDir: "/repo/.git", caches: ["symlink"] };
      },
    });
    const report = await runDeliveryWorkflow({ trunk: "main", tasks: [task], policy }, harness, doc([
      { kind: "InvokeFunctionTool", functionName: "measure", arguments: { phase: "baseline" } },
      { kind: "InvokeFunctionTool", functionName: "link-worktrees", arguments: {} },
    ]));
    expect(report.status).toBe("halted");
    expect(report.reason).toMatch(/free disk 1 is below the reserve 1000/);
    expect(linked).toBe(false);
    expect(harness.removed).toEqual([]);
  });

  it("DY2.2 a failed gate does not commit and removes the linked worktree", async () => {
    let committed = false;
    const harness = effects({
      gates: async () => ({ hooks: "fail", local: "pass" }),
      commit: async () => {
        committed = true;
        return { sha: "sha-1", parent: "trunk" };
      },
    });
    const report = await runDeliveryWorkflow({ trunk: "main", tasks: [task], policy }, harness, doc([
      { kind: "InvokeFunctionTool", functionName: "link-worktrees", arguments: {} },
      { kind: "InvokeFunctionTool", functionName: "gates", arguments: { branch: "frontier/loop" } },
      { kind: "InvokeFunctionTool", functionName: "commit", arguments: { branch: "frontier/loop", parent: null } },
    ]));
    expect(report.status).toBe("halted");
    expect(report.reason).toMatch(/gates failed/);
    expect(committed).toBe(false);
    expect(harness.removed).toEqual(["frontier/loop"]);
  });

  it("DY2.3 an author approval removes the linked worktree", async () => {
    const harness = effects({ review: async () => "approve" });
    const report = await runDeliveryWorkflow({ trunk: "main", tasks: [task], policy }, harness, doc([
      { kind: "InvokeFunctionTool", functionName: "link-worktrees", arguments: {} },
      { kind: "InvokeFunctionTool", functionName: "review", arguments: { branch: "frontier/loop" } },
    ]));
    expect(report.status).toBe("halted");
    expect(report.reason).toBe("an author approval is not a review");
    expect(harness.removed).toEqual(["frontier/loop"]);
  });

  it("DY2.4 a copied cache is removed, and more worktrees than the cap never link", async () => {
    const copied = effects({ link: async () => ({ commonDir: "/repo/.git", caches: ["copy"] }) });
    const copyReport = await runDeliveryWorkflow({ trunk: "main", tasks: [task], policy }, copied, doc([
      { kind: "InvokeFunctionTool", functionName: "link-worktrees", arguments: {} },
    ]));
    expect(copyReport.status).toBe("halted");
    expect(copyReport.reason).toMatch(/symlink cache/);
    expect(copied.removed).toEqual(["frontier/loop"]);
    let linked = false;
    const capped = effects({
      link: async () => {
        linked = true;
        return { commonDir: "/repo/.git", caches: ["symlink", "symlink"] };
      },
    });
    const cap = parseResourcePolicy({ ...policy, maxWorktrees: 1 });
    const tasks: DeliveryTask[] = [task, { id: "adapter", branch: "frontier/adapter", paths: ["adapter.txt"] }];
    const capReport = await runDeliveryWorkflow({ trunk: "main", tasks, policy: cap }, capped, doc([]));
    expect(capReport.status).toBe("halted");
    expect(capReport.reason).toMatch(/worktrees 2 exceed the cap 1/);
    expect(linked).toBe(false);
    expect(capReport.calls).toEqual([]);
  });

  it("DY2.5 artifact bytes that stay level pass, and bytes that grow stop the delivery", async () => {
    const level = effects({
      measure: async () => sample({ artifactBytes: 10 }),
    });
    const held = await runDeliveryWorkflow({ trunk: "main", tasks: [task], policy }, level, doc([
      { kind: "InvokeFunctionTool", functionName: "measure", arguments: { phase: "baseline" } },
      { kind: "InvokeFunctionTool", functionName: "measure", arguments: { phase: "after-commit" } },
    ]));
    expect(held.status).toBe("done");
    let n = 0;
    const grown = effects({
      measure: async () => sample({ artifactBytes: n++ === 0 ? 10 : 11 }),
    });
    const grew = await runDeliveryWorkflow({ trunk: "main", tasks: [task], policy }, grown, doc([
      { kind: "InvokeFunctionTool", functionName: "measure", arguments: { phase: "baseline" } },
      { kind: "InvokeFunctionTool", functionName: "measure", arguments: { phase: "after-commit" } },
    ]));
    expect(grew.status).toBe("halted");
    expect(grew.reason).toMatch(/artifact bytes grew from 10 to 11/);
  });
});
