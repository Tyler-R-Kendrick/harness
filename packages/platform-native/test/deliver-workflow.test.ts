import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseResourcePolicy } from "@harness/core";
import type { DeliveryEffects, DeliveryTask, ResourceSample } from "@harness/core";
import { deliverCommand, runDeclarativeDelivery } from "../src/deliver.ts";

const policy = parseResourcePolicy({
  maxExtraDiskBytes: 5_000,
  minFreeDiskBytes: 1_000,
  maxMemoryBytes: 8_000,
  maxTokens: 100,
  gpu: "deny",
  timeoutMs: 50,
  maxWorktrees: 4,
});

const tasks: readonly DeliveryTask[] = [
  { id: "loop", branch: "frontier/loop", paths: ["loop.txt"] },
  { id: "adapter", branch: "frontier/adapter", paths: ["adapter.txt"] },
];

const trace = [
  "measure",
  "link-worktrees",
  "gates",
  "commit",
  "clean-artifacts",
  "measure",
  "gates",
  "commit",
  "clean-artifacts",
  "measure",
  "open-pr",
  "open-pr",
  "verify",
  "review",
  "resolve",
  "squash-merge",
  "retarget",
  "remove-worktree",
  "measure-reclaim",
  "verify",
  "review",
  "resolve",
  "squash-merge",
  "remove-worktree",
  "measure-reclaim",
];

function sample(): ResourceSample {
  return {
    extraDiskBytes: 100,
    freeDiskBytes: 5_000,
    memoryBytes: 100,
    tokens: 10,
    gpuRequested: false,
    elapsedMs: 10,
    artifactBytes: 0,
  };
}

function effects(): DeliveryEffects {
  return {
    measure: async () => sample(),
    link: async () => ({ commonDir: "/repo/.git", caches: ["symlink", "symlink"] }),
    gates: async () => ({ hooks: "pass", local: "pass" }),
    commit: async (branch, parent) => ({ sha: `sha-${branch}`, parent: parent ?? "trunk" }),
    cleanArtifacts: async () => undefined,
    openPullRequest: async (_branch, base) => base,
    verify: async () => ({ correctness: "pass", gates: "pass", budget: "pass" }),
    review: async () => "comment",
    resolve: async () => 0,
    squashMerge: async (branch) => ({ sha: `merge-${branch}`, parents: 1 }),
    retarget: async () => 1,
    removeWorktree: async () => undefined,
    worktreePresent: async () => false,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the shipped delivery workflow file", () => {
  it("DY3.1 the shipped file measures, stacks commits and pull requests, then lands each task", async () => {
    const report = await runDeclarativeDelivery({ trunk: "main", tasks, policy, effects: effects() });
    expect(report.status, report.reason).toBe("done");
    expect(report.calls.map((call) => call.name)).toEqual(trace);
    const commits = report.calls.filter((call) => call.name === "commit");
    expect(commits.map((call) => call.arguments["parent"])).toEqual([null, "sha-frontier/loop"]);
    const opens = report.calls.filter((call) => call.name === "open-pr");
    expect(opens.map((call) => call.arguments)).toEqual([
      { branch: "frontier/loop", base: "main" },
      { branch: "frontier/adapter", base: "frontier/loop" },
    ]);
    const retarget = report.calls.find((call) => call.name === "retarget");
    expect(retarget?.arguments).toEqual({ branch: "frontier/adapter", onto: "merge-frontier/loop" });
  });

  it("DY3.2 a runtime workflow that only ends leaves the trunk and creates no worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-deliver-"));
    dirs.push(dir);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "Tyler Kendrick",
      GIT_AUTHOR_EMAIL: "145080887+Tyler-R-Kendrick@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Tyler Kendrick",
      GIT_COMMITTER_EMAIL: "145080887+Tyler-R-Kendrick@users.noreply.github.com",
    };
    execFileSync("git", ["init", "-b", "main", repo], { env });
    execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "README"), "start\n");
    execFileSync("git", ["-C", repo, "add", "README"], { env });
    execFileSync("git", ["-C", repo, "commit", "-m", "start"], { env });
    const start = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim();
    const cache = join(dir, "cache-store");
    writeFileSync(cache, "cache");
    const worktrees = join(dir, "worktrees");
    const workflow = join(dir, "end.workflow.yaml");
    writeFileSync(workflow, [
      "kind: Workflow",
      "name: stop",
      "description: Replace the delivery sequence.",
      "inputs:",
      "  trunk:",
      "    type: string",
      "  tasks:",
      "    type: array",
      "trigger:",
      "  kind: OnConversationStart",
      "  id: stop",
      "  actions:",
      "    - kind: EndWorkflow",
      "      id: done",
      "",
    ].join("\n"));
    writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
    writeFileSync(join(dir, "tasks.json"), JSON.stringify({
      tasks: [{ id: "loop", branch: "frontier/loop", paths: ["loop.txt"] }],
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await deliverCommand([
      "--repo", repo,
      "--policy", join(dir, "policy.json"),
      "--tasks", join(dir, "tasks.json"),
      "--worktrees", worktrees,
      "--cache", cache,
      "--trunk", "main",
      "--workflow", workflow,
    ], { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
    expect(code, stderr.join("")).toBe(0);
    expect(stdout.join("")).toBe("done\n");
    expect(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim()).toBe(start);
    expect(existsSync(join(worktrees, "loop"))).toBe(false);
    expect(execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
  });
});
