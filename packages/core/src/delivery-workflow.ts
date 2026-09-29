/**
 * Static delivery actions the declarative workflow may invoke.
 * Budget, hooks, review shape, squash shape, and worktree cleanup are enforced
 * here. The workflow file chooses the order; it cannot turn these checks off.
 */

import { executeDeclarative } from "./declarative.ts";
import type { DeclarativeReport, DeclarativeTool, DeclarativeWorkflow } from "./declarative.ts";
import { inspectBudget, pending, startDelivery } from "./delivery.ts";
import type { DeliveryEffects, DeliveryRequest, ResourceSample } from "./delivery.ts";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a string`);
  return value;
}

function accept(policy: DeliveryRequest["policy"], sample: ResourceSample, artifactBytes: number, compareArtifacts: boolean): void {
  const verdict = inspectBudget(policy, sample);
  if (!verdict.ok) throw new Error(verdict.reason);
  if (compareArtifacts && sample.artifactBytes > artifactBytes) {
    throw new Error(`artifact bytes grew from ${artifactBytes} to ${sample.artifactBytes}`);
  }
}

/** Run a declarative workflow as a git delivery. A thrown action removes every worktree still live. */
export async function runDeliveryWorkflow(
  request: DeliveryRequest,
  effects: DeliveryEffects,
  workflow: DeclarativeWorkflow,
): Promise<DeclarativeReport> {
  const first = pending(startDelivery(request));
  if (first.kind === "halt") return { status: "halted", reason: first.reason, calls: [] };
  const live: string[] = [];
  let artifactBytes = 0;
  let extraDiskBytes = 0;
  const recover = async (): Promise<void> => {
    const pendingBranches = live.splice(0).reverse();
    for (const branch of pendingBranches) {
      try {
        await effects.removeWorktree(branch);
      } catch {
        // One removal failing must not skip the worktrees that are still live.
      }
    }
  };
  const tools: Record<string, DeclarativeTool> = {
    async measure(args) {
      const sample = await effects.measure();
      accept(request.policy, sample, artifactBytes, args["phase"] === "after-commit");
      artifactBytes = sample.artifactBytes;
      extraDiskBytes = sample.extraDiskBytes;
      return sample;
    },
    async "link-worktrees"() {
      const linked = await effects.link();
      for (const task of request.tasks) live.push(task.branch);
      const shared = linked.commonDir.length > 0
        && linked.caches.length === request.tasks.length
        && linked.caches.every((cache) => cache === "symlink" || cache === "absent");
      if (!shared) throw new Error("worktrees must share one object store and a symlink cache");
      return linked;
    },
    async gates(args) {
      const branch = text(args["branch"], "branch");
      const result = await effects.gates(branch);
      if (result.hooks !== "pass" || result.local !== "pass") throw new Error(`gates failed for ${branch}`);
      return result;
    },
    async commit(args) {
      const branch = text(args["branch"], "branch");
      const raw = args["parent"];
      const parent = raw === null || raw === undefined ? undefined : text(raw, "parent");
      const committed = await effects.commit(branch, parent);
      if (committed.sha.length === 0 || (parent !== undefined && committed.parent !== parent)) {
        throw new Error(`commit parent for ${branch} is not the previous task`);
      }
      return committed;
    },
    async "clean-artifacts"() {
      await effects.cleanArtifacts();
      return null;
    },
    async "open-pr"(args) {
      return effects.openPullRequest(text(args["branch"], "branch"), text(args["base"], "base"));
    },
    async verify(args) {
      const branch = text(args["branch"], "branch");
      const result = await effects.verify(branch);
      if (result.correctness !== "pass" || result.gates !== "pass" || result.budget !== "pass") {
        throw new Error(`verification failed for ${branch}`);
      }
      return result;
    },
    async review(args) {
      const branch = text(args["branch"], "branch");
      const event = await effects.review(branch);
      if (event !== "comment") throw new Error("an author approval is not a review");
      return event;
    },
    async resolve(args) {
      const branch = text(args["branch"], "branch");
      const unresolved = await effects.resolve(branch);
      if (unresolved !== 0) throw new Error(`${unresolved} review threads are still open`);
      return unresolved;
    },
    async "squash-merge"(args) {
      const branch = text(args["branch"], "branch");
      const merged = await effects.squashMerge(branch);
      if (merged.parents !== 1 || merged.sha.length === 0) throw new Error("a squash merge has one parent");
      return merged;
    },
    async retarget(args) {
      const branch = text(args["branch"], "branch");
      const onto = text(args["onto"], "onto");
      const count = await effects.retarget(branch, onto);
      if (count !== 1) throw new Error("the next branch must contain only its own commit on the squash");
      return count;
    },
    async "remove-worktree"(args) {
      const branch = text(args["branch"], "branch");
      await effects.removeWorktree(branch);
      const at = live.lastIndexOf(branch);
      if (at >= 0) live.splice(at, 1);
      return null;
    },
    async "measure-reclaim"(args) {
      const branch = text(args["branch"], "branch");
      const present = await effects.worktreePresent(branch);
      const sample = await effects.measure();
      const verdict = inspectBudget(request.policy, sample);
      if (!verdict.ok) throw new Error(verdict.reason);
      if (present || sample.extraDiskBytes > extraDiskBytes) throw new Error(`worktree ${branch} was not reclaimed`);
      extraDiskBytes = sample.extraDiskBytes;
      return { present, sample };
    },
  };
  return executeDeclarative({
    workflow,
    inputs: { trunk: request.trunk, tasks: request.tasks },
    tools,
    onFailure: recover,
  });
}
