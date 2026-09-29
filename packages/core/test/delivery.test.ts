import { describe, expect, it } from "vitest";
import { apply, inspectBudget, parseResourcePolicy, pending, runDelivery, startDelivery } from "@harness/core";
import type { DeliveryCommand, DeliveryEffects, DeliveryObservation, DeliveryTask, ResourceSample } from "@harness/core";

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
  { id: "loop", branch: "frontier/loop", paths: ["packages/cognitive/src/frontier.ts"] },
  { id: "adapter", branch: "frontier/adapter", paths: ["packages/cognitive/src/frontier-adapter.ts"] },
];

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

function pass(branch: string): DeliveryObservation {
  return { kind: "verified", branch, correctness: "pass", gates: "pass", budget: "pass" };
}

/** Walk a two-task delivery that does what a stacked squash delivery does. */
function script(observation: (command: DeliveryCommand, step: number) => DeliveryObservation): DeliveryCommand[] {
  let delivery = startDelivery({ trunk: "main", tasks, policy });
  const commands: DeliveryCommand[] = [];
  for (let step = 0; step < 40; step++) {
    const command = pending(delivery);
    commands.push(command);
    if (command.kind === "done" || command.kind === "halt") return commands;
    delivery = apply(delivery, observation(command, step));
  }
  throw new Error("delivery did not finish");
}

describe("resource policy", () => {
  it("DL1.1 a free-disk reserve of zero is refused, so a policy cannot fill the disk", () => {
    expect(() => parseResourcePolicy({ ...policy, minFreeDiskBytes: 0 })).toThrow(/minFreeDiskBytes/);
  });

  it("DL1.2 a non-finite limit, a negative limit, a fractional token cap, or an unknown gpu is refused", () => {
    expect(() => parseResourcePolicy({ ...policy, maxExtraDiskBytes: Number.NaN })).toThrow(/maxExtraDiskBytes/);
    expect(() => parseResourcePolicy({ ...policy, maxMemoryBytes: -1 })).toThrow(/maxMemoryBytes/);
    expect(() => parseResourcePolicy({ ...policy, maxTokens: 1.5 })).toThrow(/maxTokens/);
    expect(() => parseResourcePolicy({ ...policy, gpu: "yes" })).toThrow(/gpu/);
    expect(() => parseResourcePolicy(null)).toThrow(/object/);
  });

  it("DL1.3 a sample inside every cap is allowed, including one that sits on the cap", () => {
    expect(inspectBudget(policy, sample({
      extraDiskBytes: 5_000,
      freeDiskBytes: 1_000,
      memoryBytes: 8_000,
      tokens: 100,
      elapsedMs: 50,
    }))).toEqual({ ok: true });
  });

  it("DL1.4 dropping below the free-disk reserve refuses the sample and requires cleanup", () => {
    expect(inspectBudget(policy, sample({ freeDiskBytes: 999 }))).toEqual({
      ok: false,
      cleanup: true,
      reason: "free disk 999 is below the reserve 1000",
    });
  });

  it("DL1.5 extra disk, memory, tokens, and elapsed time each refuse on their own and require cleanup", () => {
    const extra = inspectBudget(policy, sample({ extraDiskBytes: 5_001 }));
    const memory = inspectBudget(policy, sample({ memoryBytes: 8_001 }));
    const tokens = inspectBudget(policy, sample({ tokens: 101 }));
    const elapsed = inspectBudget(policy, sample({ elapsedMs: 51 }));
    expect(extra.ok).toBe(false);
    expect(memory.ok ? "" : memory.reason).toMatch(/memory/);
    expect(tokens.ok ? "" : tokens.reason).toMatch(/tokens/);
    expect(elapsed.ok ? false : elapsed.cleanup).toBe(true);
  });

  it("DL1.6 a gpu request is refused while the policy denies gpu, and allowed when the policy allows it", () => {
    const denied = inspectBudget(policy, sample({ gpuRequested: true }));
    expect(denied.ok ? "" : denied.reason).toMatch(/gpu/);
    const allowed = parseResourcePolicy({ ...policy, gpu: "allow" });
    expect(inspectBudget(allowed, sample({ gpuRequested: true })).ok).toBe(true);
  });
});

describe("delivery workflow", () => {
  it("DL1.7 two tasks link together, commit one at a time, and stack each pull request on the previous branch", () => {
    const shas = ["aaa", "bbb"];
    let commits = 0;
    const commands = script((command) => {
      if (command.kind === "measure" && command.phase === "baseline") return { kind: "measured", sample: sample() };
      if (command.kind === "link-worktrees") return { kind: "linked", commonDir: "/repo/.git", caches: ["symlink", "symlink"] };
      if (command.kind === "gates") return { kind: "gates", branch: command.branch, hooks: "pass", local: "pass" };
      if (command.kind === "commit") {
        const sha = shas[commits] ?? "zzz";
        commits += 1;
        return { kind: "committed", branch: command.branch, sha, parent: command.parent };
      }
      if (command.kind === "clean-artifacts") return { kind: "cleaned" };
      if (command.kind === "measure") return { kind: "measured", sample: sample({ extraDiskBytes: 200, artifactBytes: 0 }) };
      if (command.kind === "open-pr") return { kind: "opened", branch: command.branch, base: command.base };
      if (command.kind === "verify") return pass(command.branch);
      if (command.kind === "review") return { kind: "reviewed", branch: command.branch, event: "comment" };
      if (command.kind === "resolve") return { kind: "resolved", branch: command.branch, unresolved: 0 };
      if (command.kind === "squash-merge") return { kind: "merged", branch: command.branch, sha: `squash-${command.branch}`, parents: 1 };
      if (command.kind === "retarget") return { kind: "retargeted", branch: command.branch, onto: command.onto, commitCount: 1 };
      if (command.kind === "remove-worktree") return { kind: "removed", branch: command.branch };
      if (command.kind === "measure-reclaim") return { kind: "reclaimed", branch: command.branch, present: false, sample: sample({ extraDiskBytes: 50 }) };
      throw new Error(`unexpected ${command.kind}`);
    });
    expect(commands.map((command) => command.kind)).toEqual([
      "measure", "link-worktrees",
      "gates", "commit", "clean-artifacts", "measure",
      "gates", "commit", "clean-artifacts", "measure",
      "open-pr", "open-pr",
      "verify", "review", "resolve", "squash-merge", "retarget", "remove-worktree", "measure-reclaim",
      "verify", "review", "resolve", "squash-merge", "remove-worktree", "measure-reclaim",
      "done",
    ]);
    const opens = commands.filter((command) => command.kind === "open-pr");
    expect(opens).toEqual([
      { kind: "open-pr", branch: "frontier/loop", base: "main" },
      { kind: "open-pr", branch: "frontier/adapter", base: "frontier/loop" },
    ]);
    const second = commands.find((command) => command.kind === "commit" && command.branch === "frontier/adapter");
    expect(second).toMatchObject({ parent: "aaa" });
    const retarget = commands.find((command) => command.kind === "retarget");
    expect(retarget).toEqual({ kind: "retarget", branch: "frontier/adapter", onto: "squash-frontier/loop" });
  });

  it("DL1.8 a copied dependency cache is not a shared cache and the worktrees are removed", () => {
    let delivery = startDelivery({ trunk: "main", tasks: [tasks[0]!], policy });
    delivery = apply(delivery, { kind: "measured", sample: sample() });
    expect(pending(delivery).kind).toBe("link-worktrees");
    delivery = apply(delivery, { kind: "linked", commonDir: "/repo/.git", caches: ["copy"] });
    expect(pending(delivery)).toEqual({ kind: "remove-worktree", branch: "frontier/loop" });
    delivery = apply(delivery, { kind: "removed", branch: "frontier/loop" });
    expect(pending(delivery).kind).toBe("halt");
  });

  it("DL1.9 a failed pre-commit hook does not commit", () => {
    let delivery = startDelivery({ trunk: "main", tasks: [tasks[0]!], policy });
    delivery = apply(delivery, { kind: "measured", sample: sample() });
    delivery = apply(delivery, { kind: "linked", commonDir: "/repo/.git", caches: ["symlink"] });
    delivery = apply(delivery, { kind: "gates", branch: "frontier/loop", hooks: "fail", local: "pass" });
    expect(pending(delivery).kind).not.toBe("commit");
    expect(pending(delivery)).toEqual({ kind: "remove-worktree", branch: "frontier/loop" });
  });

  it("DL1.10 an author approval is not a review, and an unresolved thread is not a merge", () => {
    let delivery = startDelivery({ trunk: "main", tasks: [tasks[0]!], policy });
    delivery = apply(delivery, { kind: "measured", sample: sample() });
    delivery = apply(delivery, { kind: "linked", commonDir: "/repo/.git", caches: ["absent"] });
    delivery = apply(delivery, { kind: "gates", branch: "frontier/loop", hooks: "pass", local: "pass" });
    delivery = apply(delivery, { kind: "committed", branch: "frontier/loop", sha: "aaa", parent: undefined });
    delivery = apply(delivery, { kind: "cleaned" });
    delivery = apply(delivery, { kind: "measured", sample: sample() });
    delivery = apply(delivery, { kind: "opened", branch: "frontier/loop", base: "main" });
    delivery = apply(delivery, pass("frontier/loop"));
    delivery = apply(delivery, { kind: "reviewed", branch: "frontier/loop", event: "approve" });
    expect(pending(delivery).kind).toBe("remove-worktree");
    let again = startDelivery({ trunk: "main", tasks: [tasks[0]!], policy });
    again = apply(again, { kind: "measured", sample: sample() });
    again = apply(again, { kind: "linked", commonDir: "/repo/.git", caches: ["symlink"] });
    again = apply(again, { kind: "gates", branch: "frontier/loop", hooks: "pass", local: "pass" });
    again = apply(again, { kind: "committed", branch: "frontier/loop", sha: "aaa", parent: undefined });
    again = apply(again, { kind: "cleaned" });
    again = apply(again, { kind: "measured", sample: sample() });
    again = apply(again, { kind: "opened", branch: "frontier/loop", base: "main" });
    again = apply(again, pass("frontier/loop"));
    again = apply(again, { kind: "reviewed", branch: "frontier/loop", event: "comment" });
    again = apply(again, { kind: "resolved", branch: "frontier/loop", unresolved: 1 });
    expect(pending(again).kind).not.toBe("squash-merge");
  });

  it("DL1.11 a squash with two parents is refused, and a retarget that still carries the previous task is refused", () => {
    let delivery = startDelivery({ trunk: "main", tasks, policy });
    const commands = ["measured", "linked", "gates", "committed", "cleaned", "measured", "gates", "committed", "cleaned", "measured", "opened", "opened", "verified", "reviewed", "resolved"] as const;
    for (const kind of commands) {
      const command = pending(delivery);
      delivery = apply(delivery, canned(command, kind));
    }
    delivery = apply(delivery, { kind: "merged", branch: "frontier/loop", sha: "squash", parents: 2 });
    expect(pending(delivery)).toEqual({ kind: "remove-worktree", branch: "frontier/adapter" });
    let stacked = startDelivery({ trunk: "main", tasks, policy });
    for (const kind of [...commands, "merged"] as const) {
      const command = pending(stacked);
      stacked = apply(stacked, kind === "merged"
        ? { kind: "merged", branch: "frontier/loop", sha: "squash", parents: 1 }
        : canned(command, kind));
    }
    expect(pending(stacked)).toEqual({ kind: "retarget", branch: "frontier/adapter", onto: "squash" });
    stacked = apply(stacked, { kind: "retargeted", branch: "frontier/adapter", onto: "squash", commitCount: 2 });
    stacked = apply(stacked, { kind: "removed", branch: "frontier/adapter" });
    stacked = apply(stacked, { kind: "removed", branch: "frontier/loop" });
    expect(pending(stacked)).toMatchObject({ kind: "halt" });
  });

  it("DL1.12 artifact bytes that grow after a commit stop the delivery", () => {
    let delivery = startDelivery({ trunk: "main", tasks: [tasks[0]!], policy });
    delivery = apply(delivery, { kind: "measured", sample: sample({ artifactBytes: 10 }) });
    delivery = apply(delivery, { kind: "linked", commonDir: "/repo/.git", caches: ["symlink"] });
    delivery = apply(delivery, { kind: "gates", branch: "frontier/loop", hooks: "pass", local: "pass" });
    delivery = apply(delivery, { kind: "committed", branch: "frontier/loop", sha: "aaa", parent: undefined });
    delivery = apply(delivery, { kind: "cleaned" });
    delivery = apply(delivery, { kind: "measured", sample: sample({ artifactBytes: 11 }) });
    expect(pending(delivery).kind).toBe("remove-worktree");
  });

  it("DL1.13 a worktree that is still present after removal is not reclaimed", () => {
    let delivery = startDelivery({ trunk: "main", tasks: [tasks[0]!], policy });
    delivery = walkToRemove(delivery);
    delivery = apply(delivery, { kind: "removed", branch: "frontier/loop" });
    expect(pending(delivery).kind).toBe("measure-reclaim");
    delivery = apply(delivery, { kind: "reclaimed", branch: "frontier/loop", present: true, sample: sample({ extraDiskBytes: 0 }) });
    expect(pending(delivery).kind).toBe("halt");
  });

  it("DL1.14 a budget breach after both worktrees exist removes every live worktree", () => {
    let delivery = startDelivery({ trunk: "main", tasks, policy });
    delivery = apply(delivery, { kind: "measured", sample: sample() });
    delivery = apply(delivery, { kind: "linked", commonDir: "/repo/.git", caches: ["symlink", "symlink"] });
    delivery = apply(delivery, { kind: "gates", branch: "frontier/loop", hooks: "pass", local: "pass" });
    delivery = apply(delivery, { kind: "committed", branch: "frontier/loop", sha: "aaa", parent: undefined });
    delivery = apply(delivery, { kind: "cleaned" });
    delivery = apply(delivery, { kind: "measured", sample: sample({ freeDiskBytes: 1 }) });
    const removed: string[] = [];
    while (pending(delivery).kind === "remove-worktree") {
      const command = pending(delivery);
      if (command.kind !== "remove-worktree") break;
      removed.push(command.branch);
      delivery = apply(delivery, { kind: "removed", branch: command.branch });
    }
    expect(removed.sort()).toEqual(["frontier/adapter", "frontier/loop"]);
    expect(pending(delivery).kind).toBe("halt");
  });

  it("DL1.15 more tasks than the worktree cap are refused before any worktree is linked", () => {
    const tight = parseResourcePolicy({ ...policy, maxWorktrees: 1 });
    const delivery = startDelivery({ trunk: "main", tasks, policy: tight });
    expect(pending(delivery).kind).toBe("halt");
  });

  it("DL1.17 a stack of six tasks finishes and does not stop on the step budget", async () => {
    const many: DeliveryTask[] = Array.from({ length: 6 }, (_, index) => ({
      id: `t${index}`,
      branch: `frontier/t${index}`,
      paths: [`f${index}.txt`],
    }));
    const wide = parseResourcePolicy({ ...policy, maxWorktrees: 6 });
    const effects = fakeEffects();
    effects.link = async () => ({ commonDir: "/repo/.git", caches: many.map(() => "symlink" as const) });
    effects.commit = async (branch, parent) => ({ sha: branch, parent });
    const report = await runDelivery({ trunk: "main", tasks: many, policy: wide }, effects);
    expect(report.status).toBe("done");
    expect(report.commands.filter((command) => command.kind === "squash-merge")).toHaveLength(6);
  });

  it("DL1.18 a step-budget stop removes the live worktrees", async () => {
    const effects = fakeEffects();
    const report = await runDelivery({ trunk: "main", tasks: [tasks[0]!], policy }, effects, 3);
    expect(report.status).toBe("halted");
    expect(report.reason).toMatch(/step budget/);
    expect(report.commands.map((command) => command.kind)).toContain("remove-worktree");
    expect(report.commands.at(-1)?.kind).toBe("halt");
  });

  it("DL1.16 a thrown gate is a failed check, and the runner still removes the worktree", async () => {
    const effects = fakeEffects();
    effects.gates = async () => {
      throw new Error("hook failed");
    };
    const report = await runDelivery({ trunk: "main", tasks: [tasks[0]!], policy }, effects);
    expect(report.status).toBe("halted");
    expect(report.commands.map((command) => command.kind)).toContain("remove-worktree");
    expect(report.commands.at(-1)?.kind).toBe("halt");
    expect(effects.commits).toEqual([]);
  });
});

function canned(command: DeliveryCommand, kind: string): DeliveryObservation {
  if (kind === "measured" && command.kind === "measure") return { kind: "measured", sample: sample() };
  if (kind === "linked" && command.kind === "link-worktrees") {
    return { kind: "linked", commonDir: "/repo/.git", caches: command.branches.map(() => "symlink" as const) };
  }
  if (kind === "gates" && command.kind === "gates") return { kind: "gates", branch: command.branch, hooks: "pass", local: "pass" };
  if (kind === "committed" && command.kind === "commit") {
    const sha = command.branch === "frontier/loop" ? "aaa" : "bbb";
    return { kind: "committed", branch: command.branch, sha, parent: command.parent };
  }
  if (kind === "cleaned") return { kind: "cleaned" };
  if (kind === "opened" && command.kind === "open-pr") return { kind: "opened", branch: command.branch, base: command.base };
  if (kind === "verified" && command.kind === "verify") return pass(command.branch);
  if (kind === "reviewed" && command.kind === "review") return { kind: "reviewed", branch: command.branch, event: "comment" };
  if (kind === "resolved" && command.kind === "resolve") return { kind: "resolved", branch: command.branch, unresolved: 0 };
  throw new Error(`cannot can ${kind} for ${command.kind}`);
}

function walkToRemove(delivery: ReturnType<typeof startDelivery>): ReturnType<typeof startDelivery> {
  const steps = ["measured", "linked", "gates", "committed", "cleaned", "measured", "opened", "verified", "reviewed", "resolved", "merged", "removed-skip"] as const;
  let current = delivery;
  for (const kind of steps) {
    if (kind === "removed-skip") break;
    const command = pending(current);
    if (kind === "merged") {
      current = apply(current, { kind: "merged", branch: "frontier/loop", sha: "squash", parents: 1 });
      continue;
    }
    current = apply(current, canned(command, kind));
  }
  expect(pending(current)).toEqual({ kind: "remove-worktree", branch: "frontier/loop" });
  return current;
}

function fakeEffects(): DeliveryEffects & { commits: string[] } {
  const commits: string[] = [];
  const effects: DeliveryEffects & { commits: string[] } = {
    commits,
    measure: async () => sample(),
    link: async () => ({ commonDir: "/repo/.git", caches: ["symlink"] as const }),
    gates: async () => ({ hooks: "pass" as const, local: "pass" as const }),
    commit: async (branch) => {
      commits.push(branch);
      return { sha: "aaa", parent: undefined };
    },
    cleanArtifacts: async () => undefined,
    openPullRequest: async (_branch, base) => base,
    verify: async () => ({ correctness: "pass" as const, gates: "pass" as const, budget: "pass" as const }),
    review: async () => "comment" as const,
    resolve: async () => 0,
    squashMerge: async () => ({ sha: "squash", parents: 1 }),
    retarget: async () => 1,
    removeWorktree: async () => undefined,
    worktreePresent: async () => false,
  };
  return effects;
}
