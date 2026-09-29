import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseResourcePolicy } from "@harness/core";
import type { DeliveryTask } from "@harness/core";
import { defaultRunner, deliverCommand, gitDeliveryEffects, gitStackRemote, runDeclarativeDelivery } from "../src/deliver.ts";
import type { CommandRunner, GitAuthor } from "../src/deliver.ts";

const AUTHOR: GitAuthor = { name: "Tyler Kendrick", email: "145080887+Tyler-R-Kendrick@users.noreply.github.com" };
const ROOMY = parseResourcePolicy({
  maxExtraDiskBytes: 1_073_741_824,
  minFreeDiskBytes: 1,
  maxMemoryBytes: 2_147_483_648,
  maxTokens: 200_000,
  gpu: "deny",
  timeoutMs: 900_000,
  maxWorktrees: 4,
});
const TASKS: readonly DeliveryTask[] = [
  { id: "loop", branch: "frontier/loop", paths: ["loop.txt"] },
  { id: "adapter", branch: "frontier/adapter", paths: ["adapter.txt"] },
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_EDITOR: "true",
};

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env: gitEnv, encoding: "utf8" });
}

function bytes(path: string): number {
  const out = execFileSync("du", ["-s", "-B1", "--", path], { encoding: "utf8" });
  return Number(out.trim().split(/\s+/)[0]);
}

function initRepo(): { dir: string; repo: string; cache: string; worktrees: string; start: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-deliver-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo], { env: gitEnv });
  const hooks = join(dir, "hooks");
  mkdirSync(hooks);
  const script = join(hooks, "pre-commit");
  writeFileSync(script, "#!/bin/sh\ncommon=$(git rev-parse --path-format=absolute --git-common-dir)\nif [ -f \"$common/BLOCK\" ]; then\n  exit 1\nfi\nexit 0\n");
  chmodSync(script, 0o755);
  execFileSync("git", ["-C", repo, "config", "core.hooksPath", hooks]);
  execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "README"), "start\n");
  git(repo, ["add", "README"]);
  git(repo, ["commit", "-m", "start"]);
  const cache = join(dir, "cache-store");
  writeFileSync(cache, Buffer.alloc(200_000, 7));
  return { dir, repo, cache, worktrees: join(dir, "worktrees"), start: git(repo, ["rev-parse", "HEAD"]).trim() };
}

describe("git delivery on a local stack", () => {
  it("DL2.5 a stack squash-merges each task's own tree, shares one cache symlink, and removes the worktrees", async () => {
    const { repo, cache, worktrees, start } = initRepo();
    mkdirSync(join(repo, "coverage"));
    writeFileSync(join(repo, "coverage", "leak.txt"), "x");
    const commons: string[] = [];
    const remote = gitStackRemote({ repo, trunk: "main", author: AUTHOR });
    const report = await runDeclarativeDelivery({ trunk: "main", tasks: TASKS, policy: ROOMY, effects: gitDeliveryEffects({
      repo,
      trunk: "main",
      worktrees,
      cachePath: cache,
      cacheName: "deps",
      tasks: TASKS,
      policy: ROOMY,
      gates: [{ command: "true", args: [] }],
      remote,
      clock: { now: () => 1_000 },
      startedAt: 1_000,
      author: AUTHOR,
      prepare: async (wt, task) => {
        const link = join(wt, "deps");
        expect(readlinkSync(link)).toBe(cache);
        expect(bytes(wt)).toBeLessThan(bytes(cache));
        commons.push(git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
        writeFileSync(join(wt, `${task.id}.txt`), `${task.id}\n`);
      },
    }), });
    expect(report.status, report.reason).toBe("done");
    expect(commons[0]).toBe(commons[1]);
    expect(remote.requests).toEqual([
      { branch: "frontier/loop", base: "main" },
      { branch: "frontier/adapter", base: "frontier/loop" },
    ]);
    const head = git(repo, ["rev-parse", "main"]).trim();
    const first = git(repo, ["rev-parse", "main^"]).trim();
    expect(git(repo, ["rev-parse", "main^^"]).trim()).toBe(start);
    expect(git(repo, ["rev-parse", `${first}^@`]).trim().split(/\s+/)).toEqual([start]);
    expect(git(repo, ["rev-parse", `${head}^@`]).trim().split(/\s+/)).toEqual([first]);
    const firstTree = git(repo, ["ls-tree", "-r", "--name-only", first]).trim().split("\n");
    const headTree = git(repo, ["ls-tree", "-r", "--name-only", head]).trim().split("\n");
    expect(firstTree).toContain("loop.txt");
    expect(firstTree).not.toContain("adapter.txt");
    expect(headTree).toEqual(expect.arrayContaining(["loop.txt", "adapter.txt"]));
    expect(git(repo, ["log", "-1", "--format=%an"]).trim()).toBe(AUTHOR.name);
    expect(existsSync(join(worktrees, "loop"))).toBe(false);
    expect(existsSync(join(worktrees, "adapter"))).toBe(false);
    expect(existsSync(cache)).toBe(true);
    expect(existsSync(join(repo, "coverage"))).toBe(false);
    expect(git(repo, ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
  });

  it("DL2.6 a failing pre-commit hook commits nothing and removes the worktrees", async () => {
    const { repo, cache, worktrees, start } = initRepo();
    writeFileSync(join(repo, ".git", "BLOCK"), "1");
    const report = await runDeclarativeDelivery({ trunk: "main", tasks: TASKS, policy: ROOMY, effects: gitDeliveryEffects({
      repo,
      trunk: "main",
      worktrees,
      cachePath: cache,
      cacheName: "deps",
      tasks: TASKS,
      policy: ROOMY,
      gates: [],
      remote: gitStackRemote({ repo, trunk: "main", author: AUTHOR }),
      clock: { now: () => 1_000 },
      startedAt: 1_000,
      author: AUTHOR,
      prepare: async (wt, task) => writeFileSync(join(wt, `${task.id}.txt`), `${task.id}\n`),
    }), });
    expect(report.status, report.reason).toBe("halted");
    expect(report.reason).toMatch(/gates failed/);
    expect(git(repo, ["rev-parse", "main"]).trim()).toBe(start);
    expect(existsSync(join(worktrees, "loop"))).toBe(false);
    expect(existsSync(join(worktrees, "adapter"))).toBe(false);
    expect(report.calls.every((call) => call.name !== "commit")).toBe(true);
  });

  it("DL2.7 a failing local gate commits nothing", async () => {
    const { repo, cache, worktrees, start } = initRepo();
    const tasks: readonly DeliveryTask[] = [{ id: "loop", branch: "frontier/loop", paths: ["loop.txt"] }];
    const report = await runDeclarativeDelivery({ trunk: "main", tasks, policy: ROOMY, effects: gitDeliveryEffects({
      repo,
      trunk: "main",
      worktrees,
      cachePath: cache,
      cacheName: "deps",
      tasks,
      policy: ROOMY,
      gates: [{ command: "false", args: [] }],
      remote: gitStackRemote({ repo, trunk: "main", author: AUTHOR }),
      clock: { now: () => 1_000 },
      startedAt: 1_000,
      author: AUTHOR,
      prepare: async (wt) => writeFileSync(join(wt, "loop.txt"), "loop\n"),
    }), });
    expect(report.status, report.reason).toBe("halted");
    expect(report.reason).toMatch(/gates failed/);
    expect(git(repo, ["rev-parse", "main"]).trim()).toBe(start);
    expect(existsSync(join(worktrees, "loop"))).toBe(false);
  });

  it("DL2.8 a free-disk reserve above the volume halts before any worktree", async () => {
    const { repo, cache, worktrees } = initRepo();
    const policy = parseResourcePolicy({ ...ROOMY, minFreeDiskBytes: 9_007_199_254_740_991 });
    const report = await runDeclarativeDelivery({ trunk: "main", tasks: TASKS, policy, effects: gitDeliveryEffects({
      repo,
      trunk: "main",
      worktrees,
      cachePath: cache,
      cacheName: "deps",
      tasks: TASKS,
      policy,
      gates: [],
      remote: gitStackRemote({ repo, trunk: "main", author: AUTHOR }),
      clock: { now: () => 1_000 },
      startedAt: 1_000,
      author: AUTHOR,
    }), });
    expect(report.status, report.reason).toBe("halted");
    expect(report.reason).toMatch(/free disk/);
    expect(report.calls.every((call) => call.name !== "link-worktrees")).toBe(true);
    expect(existsSync(join(worktrees, "loop"))).toBe(false);
  });

  it("DL2.9 a link that fails halfway removes the worktrees it already created", async () => {
    const { repo, cache, worktrees } = initRepo();
    const real = defaultRunner();
    let adds = 0;
    const run: CommandRunner = async (command, args, options) => {
      if (command === "git" && args.includes("worktree") && args.includes("add")) {
        adds += 1;
        if (adds === 2) throw new Error("no space left");
      }
      return real(command, args, options);
    };
    const report = await runDeclarativeDelivery({ trunk: "main", tasks: TASKS, policy: ROOMY, effects: gitDeliveryEffects({
      repo,
      trunk: "main",
      worktrees,
      cachePath: cache,
      cacheName: "deps",
      tasks: TASKS,
      policy: ROOMY,
      gates: [],
      remote: gitStackRemote({ repo, trunk: "main", author: AUTHOR, run }),
      clock: { now: () => 1_000 },
      startedAt: 1_000,
      author: AUTHOR,
      run,
    }), });
    expect(report.status, report.reason).toBe("halted");
    expect(report.reason).toMatch(/no space left/);
    expect(existsSync(join(worktrees, "loop"))).toBe(false);
    expect(existsSync(join(worktrees, "adapter"))).toBe(false);
    expect(git(repo, ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
  });

  it("DL2.11 the deliver command squash-merges a prepared task and removes its worktree", async () => {
    const { dir, repo, cache, worktrees, start } = initRepo();
    const policyFile = join(dir, "policy.json");
    const tasksFile = join(dir, "tasks.json");
    writeFileSync(policyFile, JSON.stringify(ROOMY));
    writeFileSync(tasksFile, JSON.stringify({
      tasks: [{ id: "loop", branch: "frontier/loop", paths: ["loop.txt"], prepare: ["node", "-e", "require('node:fs').writeFileSync('loop.txt','loop\\n')"] }],
      gates: [{ command: "true", args: [] }],
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await deliverCommand([
      "--repo", repo,
      "--policy", policyFile,
      "--tasks", tasksFile,
      "--worktrees", worktrees,
      "--cache", cache,
      "--cache-name", "deps",
      "--trunk", "main",
      "--author-name", AUTHOR.name,
      "--author-email", AUTHOR.email,
    ], { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) });
    expect(code, stderr.join("")).toBe(0);
    expect(stdout.join("")).toBe("open frontier/loop main\ndone\n");
    expect(git(repo, ["rev-parse", "main^"]).trim()).toBe(start);
    expect(git(repo, ["rev-parse", "main^@"]).trim().split(/\s+/)).toEqual([start]);
    expect(git(repo, ["ls-tree", "-r", "--name-only", "main"])).toContain("loop.txt");
    expect(existsSync(join(worktrees, "loop"))).toBe(false);
    expect(existsSync(cache)).toBe(true);
  });

  it("DL2.12 a linked worktree checks out only its task paths and stays sparse", async () => {
    const { repo, cache, worktrees } = initRepo();
    mkdirSync(join(repo, "bulk"));
    mkdirSync(join(repo, "notes"));
    writeFileSync(join(repo, "bulk", "payload"), Buffer.alloc(65_536, 3));
    writeFileSync(join(repo, "notes", "other.txt"), "keep\n");
    git(repo, ["add", "bulk/payload", "notes/other.txt"]);
    git(repo, ["commit", "-m", "bulk"]);
    const tasks: readonly DeliveryTask[] = [
      { id: "loop", branch: "frontier/loop", paths: ["notes/loop.txt"] },
      { id: "adapter", branch: "frontier/adapter", paths: ["adapter.txt"] },
    ];
    const report = await runDeclarativeDelivery({ trunk: "main", tasks, policy: ROOMY, effects: gitDeliveryEffects({
      repo,
      trunk: "main",
      worktrees,
      cachePath: cache,
      cacheName: "deps",
      tasks,
      policy: ROOMY,
      gates: [{ command: "sh", args: ["-c", "test ! -e bulk/payload && test ! -e notes/other.txt && git config --get core.sparseCheckout | grep -qx true"] }],
      remote: gitStackRemote({ repo, trunk: "main", author: AUTHOR }),
      clock: { now: () => 1_000 },
      startedAt: 1_000,
      author: AUTHOR,
      prepare: async (wt, task) => {
        expect(existsSync(join(repo, "bulk", "payload"))).toBe(true);
        expect(existsSync(join(wt, "bulk", "payload"))).toBe(false);
        expect(existsSync(join(wt, "notes", "other.txt"))).toBe(false);
        expect(git(wt, ["config", "--get", "core.sparseCheckout"]).trim()).toBe("true");
        const listed = git(wt, ["sparse-checkout", "list"]);
        for (const path of task.paths) expect(listed).toContain(`/${path}`);
        expect(() => git(repo, ["config", "--get", "core.sparseCheckout"])).toThrow();
        if (task.id === "loop") {
          mkdirSync(join(wt, "notes"), { recursive: true });
          writeFileSync(join(wt, "notes", "loop.txt"), "loop\n");
        } else {
          writeFileSync(join(wt, "adapter.txt"), "adapter\n");
        }
      },
    }), });
    expect(report.status, report.reason).toBe("done");
    const tree = git(repo, ["ls-tree", "-r", "--name-only", "main"]).trim().split("\n");
    expect(tree).toEqual(expect.arrayContaining(["README", "bulk/payload", "notes/other.txt", "notes/loop.txt", "adapter.txt"]));
    expect(() => git(repo, ["config", "--get", "core.sparseCheckout"])).toThrow();
    expect(existsSync(join(worktrees, "loop"))).toBe(false);
    expect(existsSync(join(worktrees, "adapter"))).toBe(false);
  });
});
