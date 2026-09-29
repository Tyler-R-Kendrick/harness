import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deliverCommand, deliveryPolicyJsonSchema, githubPullRemote, readDeliveryPlan, readDeliveryPolicy, unresolvedThreadIds } from "../src/deliver.ts";
import type { CommandRunner } from "../src/deliver.ts";

const shipped = JSON.parse(readFileSync(new URL("../data/delivery-policy.json", import.meta.url), "utf8")) as Record<string, unknown>;

function fakeGh(onApi: () => string): { calls: string[][]; run: CommandRunner } {
  const calls: string[][] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") return "parent\n";
    if (args[1] === "view" && args.includes(".number")) return "4\n";
    if (args[1] === "view" && args.includes("mergeCommit")) return "abc\n";
    if (args[0] === "api") return onApi();
    return "";
  };
  return { calls, run };
}

describe("github delivery remote", () => {
  it("DL2.1 a review is a comment and never an approval", async () => {
    const { calls, run } = fakeGh(() => "{}");
    const remote = githubPullRemote({ owner: "acme", name: "harness", trunk: "release", repo: "/repo", run });
    expect(await remote.review("frontier/loop")).toBe("comment");
    const review = calls.find((call) => call[2] === "review");
    expect(review).toContain("--comment");
    expect(calls.some((call) => call.includes("--approve"))).toBe(false);
  });

  it("DL2.2 resolve keeps a thread that is still open after the mutation", async () => {
    let queries = 0;
    const { calls, run } = fakeGh(() => {
      queries += 1;
      return JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "T1", isResolved: false }, { id: "T2", isResolved: true }, { id: 3, isResolved: false }] } } } },
      });
    });
    const remote = githubPullRemote({ owner: "acme", name: "harness", trunk: "release", repo: "/repo", run });
    expect(await remote.resolve("frontier/loop")).toBe(1);
    expect(queries).toBe(3);
    expect(calls.some((call) => call.join(" ").includes("resolveReviewThread"))).toBe(true);
    expect(unresolvedThreadIds("{}")).toEqual([]);
    expect(unresolvedThreadIds(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "T2", isResolved: true }] } } } } }))).toEqual([]);
  });

  it("DL2.3 a squash asks for one parent and a retarget bases on the trunk", async () => {
    const { calls, run } = fakeGh(() => "{}");
    const remote = githubPullRemote({ owner: "acme", name: "harness", trunk: "release", repo: "/repo", run });
    expect(await remote.squashMerge("frontier/loop")).toEqual({ sha: "abc", parents: 1 });
    expect(calls.find((call) => call[2] === "merge")).toContain("--squash");
    expect(calls.some((call) => call[0] === "git" && call.includes("abc^@"))).toBe(true);
    await remote.noteRetarget("frontier/adapter", "squashsha");
    const edit = calls.find((call) => call[2] === "edit");
    expect(edit?.[edit.indexOf("--base") + 1]).toBe("release");
  });

  it("DL2.4 the shipped policy keeps a free-disk reserve and denies the gpu", async () => {
    expect(shipped["$schema"]).toBe("./delivery-policy.schema.json");
    expect(readDeliveryPolicy(JSON.stringify(shipped))).toEqual({
      maxExtraDiskBytes: 1_073_741_824,
      minFreeDiskBytes: 2_147_483_648,
      maxMemoryBytes: 2_147_483_648,
      maxTokens: 200_000,
      gpu: "deny",
      timeoutMs: 900_000,
      maxWorktrees: 4,
    });
    expect(deliveryPolicyJsonSchema()).toMatchObject({ type: "object" });
    await expect(`${JSON.stringify(deliveryPolicyJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/delivery-policy.schema.json");
    expect(() => readDeliveryPolicy(JSON.stringify({ ...shipped, minFreeDiskBytes: 0 }))).toThrow(/minFreeDiskBytes/);
  });

  it("DL2.10 a plan names tasks, prepares, and gates, and a command without a repo is refused", async () => {
    expect(readDeliveryPlan(JSON.stringify({
      tasks: [{ id: "loop", branch: "frontier/loop", paths: ["loop.txt"], prepare: ["node", "-e", "process.exit(0)"] }],
      gates: [{ command: "true", args: [] }],
    }))).toEqual({
      tasks: [{ id: "loop", branch: "frontier/loop", paths: ["loop.txt"] }],
      prepares: { loop: ["node", "-e", "process.exit(0)"] },
      gates: [{ command: "true", args: [] }],
    });
    expect(() => readDeliveryPlan('{"tasks":[{}]}')).toThrow(/task/);
    const errors: string[] = [];
    expect(await deliverCommand([], { stdout: () => undefined, stderr: (text) => errors.push(text) })).toBe(2);
    expect(errors.join("")).toMatch(/usage: harness-deliver/);
  });
});
