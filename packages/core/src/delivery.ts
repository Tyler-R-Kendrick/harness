/**
 * Opinionated git delivery. The machine decides the next command; a host performs it.
 * Task branches are linked worktrees that share one object store and one cache symlink.
 * Commits stay incremental, pull requests stack, and a finished branch is verified,
 * comment-reviewed, resolved, and squash-merged. The budget monitor can stop the run,
 * and every stop removes the worktrees that are still live.
 */

export interface ResourcePolicy {
  readonly maxExtraDiskBytes: number;
  readonly minFreeDiskBytes: number;
  readonly maxMemoryBytes: number;
  readonly maxTokens: number;
  readonly gpu: "deny" | "allow";
  readonly timeoutMs: number;
  readonly maxWorktrees: number;
}

export interface ResourceSample {
  readonly extraDiskBytes: number;
  readonly freeDiskBytes: number;
  readonly memoryBytes: number;
  readonly tokens: number;
  readonly gpuRequested: boolean;
  readonly elapsedMs: number;
  readonly artifactBytes: number;
}

export type BudgetVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly cleanup: true; readonly reason: string };

export interface DeliveryTask {
  readonly id: string;
  readonly branch: string;
  readonly paths: readonly string[];
}

export interface DeliveryRequest {
  readonly trunk: string;
  readonly tasks: readonly DeliveryTask[];
  readonly policy: ResourcePolicy;
}

export const VERIFICATION_ROLES = ["correctness", "gates", "budget"] as const;
export type VerificationRole = (typeof VERIFICATION_ROLES)[number];
export type Gate = "pass" | "fail";
export type CacheKind = "symlink" | "copy" | "absent";

export type DeliveryCommand =
  | { readonly kind: "measure"; readonly phase: "baseline" | "after-commit"; readonly branch?: string }
  | { readonly kind: "link-worktrees"; readonly branches: readonly string[] }
  | { readonly kind: "gates"; readonly branch: string }
  | { readonly kind: "commit"; readonly branch: string; readonly parent: string | undefined }
  | { readonly kind: "clean-artifacts" }
  | { readonly kind: "open-pr"; readonly branch: string; readonly base: string }
  | { readonly kind: "verify"; readonly branch: string; readonly roles: readonly VerificationRole[] }
  | { readonly kind: "review"; readonly branch: string }
  | { readonly kind: "resolve"; readonly branch: string }
  | { readonly kind: "squash-merge"; readonly branch: string }
  | { readonly kind: "retarget"; readonly branch: string; readonly onto: string }
  | { readonly kind: "remove-worktree"; readonly branch: string }
  | { readonly kind: "measure-reclaim"; readonly branch: string }
  | { readonly kind: "halt"; readonly reason: string }
  | { readonly kind: "done" };

export type DeliveryObservation =
  | { readonly kind: "measured"; readonly sample: ResourceSample }
  | { readonly kind: "linked"; readonly commonDir: string; readonly caches: readonly CacheKind[] }
  | { readonly kind: "gates"; readonly branch: string; readonly hooks: Gate; readonly local: Gate }
  | { readonly kind: "committed"; readonly branch: string; readonly sha: string; readonly parent: string | undefined }
  | { readonly kind: "cleaned" }
  | { readonly kind: "opened"; readonly branch: string; readonly base: string }
  | { readonly kind: "verified"; readonly branch: string; readonly correctness: Gate; readonly gates: Gate; readonly budget: Gate }
  | { readonly kind: "reviewed"; readonly branch: string; readonly event: "comment" | "approve" }
  | { readonly kind: "resolved"; readonly branch: string; readonly unresolved: number }
  | { readonly kind: "merged"; readonly branch: string; readonly sha: string; readonly parents: number }
  | { readonly kind: "retargeted"; readonly branch: string; readonly onto: string; readonly commitCount: number }
  | { readonly kind: "removed"; readonly branch: string }
  | { readonly kind: "reclaimed"; readonly branch: string; readonly present: boolean; readonly sample: ResourceSample }
  | { readonly kind: "failed"; readonly reason: string };

export interface DeliveryEffects {
  measure(): Promise<ResourceSample>;
  link(): Promise<{ readonly commonDir: string; readonly caches: readonly CacheKind[] }>;
  gates(branch: string): Promise<{ readonly hooks: Gate; readonly local: Gate }>;
  commit(branch: string, parent: string | undefined): Promise<{ readonly sha: string; readonly parent: string | undefined }>;
  cleanArtifacts(): Promise<void>;
  openPullRequest(branch: string, base: string): Promise<string>;
  verify(branch: string): Promise<{ readonly correctness: Gate; readonly gates: Gate; readonly budget: Gate }>;
  review(branch: string): Promise<"comment" | "approve">;
  resolve(branch: string): Promise<number>;
  squashMerge(branch: string): Promise<{ readonly sha: string; readonly parents: number }>;
  retarget(branch: string, onto: string): Promise<number>;
  removeWorktree(branch: string): Promise<void>;
  worktreePresent(branch: string): Promise<boolean>;
}

export interface DeliveryReport {
  readonly status: "done" | "halted";
  readonly reason?: string;
  readonly commands: readonly DeliveryCommand[];
}

type Phase = "baseline" | "link" | "gate" | "commit" | "clean" | "post-commit" | "open" | "verify" | "review" | "resolve" | "merge" | "retarget" | "remove" | "reclaim" | "halt" | "done";

interface State {
  readonly trunk: string;
  readonly tasks: readonly DeliveryTask[];
  readonly policy: ResourcePolicy;
  readonly phase: Phase;
  readonly index: number;
  readonly commits: readonly string[];
  readonly merges: readonly string[];
  readonly artifactBytes: number;
  readonly extraDiskBytes: number;
  readonly live: readonly number[];
  readonly recovering: boolean;
  readonly reason: string;
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function finite(value: unknown, name: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

/** A policy is data. A reserve of zero is rejected so delivery cannot fill the disk. */
export function parseResourcePolicy(input: unknown): ResourcePolicy {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("resource policy must be an object");
  const raw = input as Record<string, unknown>;
  const gpu = raw["gpu"];
  if (gpu !== "deny" && gpu !== "allow") throw new TypeError("gpu must be deny or allow");
  return {
    maxExtraDiskBytes: finite(raw["maxExtraDiskBytes"], "maxExtraDiskBytes", 0),
    minFreeDiskBytes: finite(raw["minFreeDiskBytes"], "minFreeDiskBytes", 1),
    maxMemoryBytes: finite(raw["maxMemoryBytes"], "maxMemoryBytes", 0),
    maxTokens: finite(raw["maxTokens"], "maxTokens", 0),
    gpu,
    timeoutMs: finite(raw["timeoutMs"], "timeoutMs", 1),
    maxWorktrees: finite(raw["maxWorktrees"], "maxWorktrees", 1),
  };
}

/** The budget monitor. Every refusal asks the delivery to clean up. */
export function inspectBudget(policy: ResourcePolicy, sample: ResourceSample): BudgetVerdict {
  if (sample.freeDiskBytes < policy.minFreeDiskBytes) {
    return { ok: false, cleanup: true, reason: `free disk ${sample.freeDiskBytes} is below the reserve ${policy.minFreeDiskBytes}` };
  }
  if (sample.extraDiskBytes > policy.maxExtraDiskBytes) {
    return { ok: false, cleanup: true, reason: `extra disk ${sample.extraDiskBytes} exceeds ${policy.maxExtraDiskBytes}` };
  }
  if (sample.memoryBytes > policy.maxMemoryBytes) {
    return { ok: false, cleanup: true, reason: `memory ${sample.memoryBytes} exceeds ${policy.maxMemoryBytes}` };
  }
  if (sample.tokens > policy.maxTokens) {
    return { ok: false, cleanup: true, reason: `tokens ${sample.tokens} exceeds ${policy.maxTokens}` };
  }
  if (sample.elapsedMs > policy.timeoutMs) {
    return { ok: false, cleanup: true, reason: `elapsed ${sample.elapsedMs} exceeds ${policy.timeoutMs}` };
  }
  if (sample.gpuRequested && policy.gpu === "deny") {
    return { ok: false, cleanup: true, reason: "gpu is denied" };
  }
  return { ok: true };
}

function taskName(value: string, label: string): void {
  if (!BRANCH.test(value) || value.includes("..") || value.endsWith("/") || value.endsWith(".")) {
    throw new TypeError(`${label} is not a safe git name`);
  }
}

function checkTask(task: DeliveryTask): void {
  taskName(task.id, "task id");
  if (task.id.includes("/")) throw new TypeError("task id is not a safe git name");
  taskName(task.branch, "branch");
  if (task.paths.length === 0) throw new TypeError(`task ${task.id} lists no paths`);
  for (const path of task.paths) {
    if (path.startsWith("/") || path.split("/").includes("..")) throw new TypeError(`task ${task.id} has an unsafe path`);
  }
}

export function startDelivery(request: DeliveryRequest): State {
  if (request.tasks.length === 0) throw new TypeError("delivery needs a task");
  taskName(request.trunk, "trunk");
  const branches = new Set<string>();
  for (const task of request.tasks) {
    checkTask(task);
    if (branches.has(task.branch)) throw new TypeError(`branch ${task.branch} is repeated`);
    branches.add(task.branch);
  }
  const overCap = request.tasks.length > request.policy.maxWorktrees;
  return {
    trunk: request.trunk,
    tasks: request.tasks,
    policy: request.policy,
    phase: overCap ? "halt" : "baseline",
    index: 0,
    commits: [],
    merges: [],
    artifactBytes: 0,
    extraDiskBytes: 0,
    live: [],
    recovering: false,
    reason: overCap ? `worktrees ${request.tasks.length} exceed the cap ${request.policy.maxWorktrees}` : "",
  };
}

function branchAt(state: State, index: number): string {
  const task = state.tasks[index];
  if (task === undefined) throw new TypeError("delivery index is outside the stack");
  return task.branch;
}

function baseAt(state: State, index: number): string {
  return index === 0 ? state.trunk : branchAt(state, index - 1);
}

export function pending(delivery: State): DeliveryCommand {
  if (delivery.recovering) {
    const last = delivery.live.at(-1);
    if (last === undefined) return { kind: "halt", reason: delivery.reason };
    return { kind: "remove-worktree", branch: branchAt(delivery, last) };
  }
  switch (delivery.phase) {
    case "baseline":
      return { kind: "measure", phase: "baseline" };
    case "link":
      return { kind: "link-worktrees", branches: delivery.tasks.map((task) => task.branch) };
    case "gate":
      return { kind: "gates", branch: branchAt(delivery, delivery.index) };
    case "commit":
      return {
        kind: "commit",
        branch: branchAt(delivery, delivery.index),
        parent: delivery.index === 0 ? undefined : delivery.commits[delivery.index - 1],
      };
    case "clean":
      return { kind: "clean-artifacts" };
    case "post-commit":
      return { kind: "measure", phase: "after-commit", branch: branchAt(delivery, delivery.index) };
    case "open":
      return { kind: "open-pr", branch: branchAt(delivery, delivery.index), base: baseAt(delivery, delivery.index) };
    case "verify":
      return { kind: "verify", branch: branchAt(delivery, delivery.index), roles: VERIFICATION_ROLES };
    case "review":
      return { kind: "review", branch: branchAt(delivery, delivery.index) };
    case "resolve":
      return { kind: "resolve", branch: branchAt(delivery, delivery.index) };
    case "merge":
      return { kind: "squash-merge", branch: branchAt(delivery, delivery.index) };
    case "retarget":
      return { kind: "retarget", branch: branchAt(delivery, delivery.index + 1), onto: delivery.merges[delivery.index] ?? "" };
    case "remove":
      return { kind: "remove-worktree", branch: branchAt(delivery, delivery.index) };
    case "reclaim":
      return { kind: "measure-reclaim", branch: branchAt(delivery, delivery.index) };
    case "halt":
      return { kind: "halt", reason: delivery.reason };
    case "done":
      return { kind: "done" };
    default:
      return { kind: "halt", reason: "unknown delivery phase" };
  }
}

function recover(state: State, reason: string): State {
  return { ...state, recovering: true, reason, phase: "halt" };
}

function sameBranch(state: State, index: number, branch: string): void {
  if (branch !== branchAt(state, index)) throw new TypeError(`observation is for ${branch}, the delivery is on ${branchAt(state, index)}`);
}

function acceptMeasure(state: State, sample: ResourceSample, artifacts: boolean): State | undefined {
  const verdict = inspectBudget(state.policy, sample);
  if (!verdict.ok) return recover(state, verdict.reason);
  if (artifacts && sample.artifactBytes > state.artifactBytes) {
    return recover(state, `artifact bytes grew from ${state.artifactBytes} to ${sample.artifactBytes}`);
  }
  return undefined;
}

function afterMerge(state: State, sha: string): State {
  const merges = [...state.merges];
  merges[state.index] = sha;
  const next = { ...state, merges };
  if (state.index + 1 < state.tasks.length) return { ...next, phase: "retarget" };
  return { ...next, phase: "remove" };
}

function afterReclaim(state: State): State {
  if (state.index + 1 < state.tasks.length) return { ...state, index: state.index + 1, phase: "verify" };
  return { ...state, phase: "done", recovering: false };
}

export function apply(delivery: State, observation: DeliveryObservation): State {
  if (observation.kind === "failed") {
    if (delivery.recovering && delivery.live.length > 0) return { ...delivery, live: delivery.live.slice(0, -1) };
    return recover(delivery, observation.reason);
  }
  if (delivery.recovering) {
    if (observation.kind !== "removed") throw new TypeError("recovery removes a worktree");
    const last = delivery.live.at(-1);
    if (last === undefined || observation.branch !== branchAt(delivery, last)) throw new TypeError("recovery removed the wrong worktree");
    return { ...delivery, live: delivery.live.slice(0, -1) };
  }
  switch (delivery.phase) {
    case "baseline": {
      if (observation.kind !== "measured") throw new TypeError("baseline measures disk");
      const refused = acceptMeasure(delivery, observation.sample, false);
      if (refused) return refused;
      return { ...delivery, phase: "link", artifactBytes: observation.sample.artifactBytes, extraDiskBytes: observation.sample.extraDiskBytes };
    }
    case "link": {
      if (observation.kind !== "linked") throw new TypeError("link reports the worktrees");
      const live = delivery.tasks.map((_, index) => index);
      const cachesOk = observation.caches.length === delivery.tasks.length && observation.caches.every((cache) => cache === "symlink" || cache === "absent");
      const dirOk = observation.commonDir.length > 0;
      const linked = { ...delivery, live };
      if (!cachesOk || !dirOk) return recover(linked, "worktrees must share one object store and a symlink cache");
      return { ...linked, phase: "gate", index: 0 };
    }
    case "gate": {
      if (observation.kind !== "gates") throw new TypeError("gates report the hook and the local checks");
      sameBranch(delivery, delivery.index, observation.branch);
      if (observation.hooks !== "pass" || observation.local !== "pass") return recover(delivery, `gates failed for ${observation.branch}`);
      return { ...delivery, phase: "commit" };
    }
    case "commit": {
      if (observation.kind !== "committed") throw new TypeError("commit reports the new sha");
      sameBranch(delivery, delivery.index, observation.branch);
      const stacked = delivery.index > 0 && observation.parent !== delivery.commits[delivery.index - 1];
      if (stacked || observation.sha.length === 0) return recover(delivery, `commit parent for ${observation.branch} is not the previous task`);
      const commits = [...delivery.commits];
      commits[delivery.index] = observation.sha;
      return { ...delivery, commits, phase: "clean" };
    }
    case "clean": {
      if (observation.kind !== "cleaned") throw new TypeError("clean reports the artifact directories");
      return { ...delivery, phase: "post-commit" };
    }
    case "post-commit": {
      if (observation.kind !== "measured") throw new TypeError("a commit is followed by a disk sample");
      const refused = acceptMeasure(delivery, observation.sample, true);
      if (refused) return refused;
      const recorded = { ...delivery, artifactBytes: observation.sample.artifactBytes, extraDiskBytes: observation.sample.extraDiskBytes };
      if (delivery.index + 1 < delivery.tasks.length) return { ...recorded, index: delivery.index + 1, phase: "gate" };
      return { ...recorded, index: 0, phase: "open" };
    }
    case "open": {
      if (observation.kind !== "opened") throw new TypeError("open reports the pull request");
      sameBranch(delivery, delivery.index, observation.branch);
      if (observation.base !== baseAt(delivery, delivery.index)) return recover(delivery, `pull request base for ${observation.branch} is not the previous branch`);
      if (delivery.index + 1 < delivery.tasks.length) return { ...delivery, index: delivery.index + 1 };
      return { ...delivery, index: 0, phase: "verify" };
    }
    case "verify": {
      if (observation.kind !== "verified") throw new TypeError("verify reports the three checks");
      sameBranch(delivery, delivery.index, observation.branch);
      if (observation.correctness !== "pass" || observation.gates !== "pass" || observation.budget !== "pass") {
        return recover(delivery, `verification failed for ${observation.branch}`);
      }
      return { ...delivery, phase: "review" };
    }
    case "review": {
      if (observation.kind !== "reviewed") throw new TypeError("review reports the author's event");
      sameBranch(delivery, delivery.index, observation.branch);
      if (observation.event !== "comment") return recover(delivery, "an author approval is not a review");
      return { ...delivery, phase: "resolve" };
    }
    case "resolve": {
      if (observation.kind !== "resolved") throw new TypeError("resolve reports the open threads");
      sameBranch(delivery, delivery.index, observation.branch);
      if (observation.unresolved !== 0) return recover(delivery, `${observation.unresolved} review threads are still open`);
      return { ...delivery, phase: "merge" };
    }
    case "merge": {
      if (observation.kind !== "merged") throw new TypeError("merge reports the squash");
      sameBranch(delivery, delivery.index, observation.branch);
      if (observation.parents !== 1 || observation.sha.length === 0) return recover(delivery, "a squash merge has one parent");
      return afterMerge(delivery, observation.sha);
    }
    case "retarget": {
      if (observation.kind !== "retargeted") throw new TypeError("retarget reports the rebased branch");
      const onto = delivery.merges[delivery.index] ?? "";
      if (observation.branch !== branchAt(delivery, delivery.index + 1) || observation.onto !== onto || observation.commitCount !== 1) {
        return recover(delivery, "the next branch must contain only its own commit on the squash");
      }
      return { ...delivery, phase: "remove" };
    }
    case "remove": {
      if (observation.kind !== "removed") throw new TypeError("remove reports the worktree");
      sameBranch(delivery, delivery.index, observation.branch);
      return { ...delivery, live: delivery.live.filter((index) => index !== delivery.index), phase: "reclaim" };
    }
    case "reclaim": {
      if (observation.kind !== "reclaimed") throw new TypeError("reclaim measures the removed worktree");
      sameBranch(delivery, delivery.index, observation.branch);
      const refused = acceptMeasure(delivery, observation.sample, false);
      if (refused) return refused;
      if (observation.present || observation.sample.extraDiskBytes > delivery.extraDiskBytes) {
        return recover(delivery, `worktree ${observation.branch} was not reclaimed`);
      }
      return afterReclaim({ ...delivery, extraDiskBytes: observation.sample.extraDiskBytes });
    }
    default:
      throw new TypeError("delivery is already finished");
  }
}

async function perform(command: DeliveryCommand, effects: DeliveryEffects): Promise<DeliveryObservation> {
  switch (command.kind) {
    case "measure":
      return { kind: "measured", sample: await effects.measure() };
    case "link-worktrees":
      return { kind: "linked", ...(await effects.link()) };
    case "gates": {
      const gates = await effects.gates(command.branch);
      return { kind: "gates", branch: command.branch, hooks: gates.hooks, local: gates.local };
    }
    case "commit": {
      const committed = await effects.commit(command.branch, command.parent);
      return { kind: "committed", branch: command.branch, sha: committed.sha, parent: committed.parent };
    }
    case "clean-artifacts":
      await effects.cleanArtifacts();
      return { kind: "cleaned" };
    case "open-pr":
      return { kind: "opened", branch: command.branch, base: await effects.openPullRequest(command.branch, command.base) };
    case "verify": {
      const verdict = await effects.verify(command.branch);
      return { kind: "verified", branch: command.branch, correctness: verdict.correctness, gates: verdict.gates, budget: verdict.budget };
    }
    case "review":
      return { kind: "reviewed", branch: command.branch, event: await effects.review(command.branch) };
    case "resolve":
      return { kind: "resolved", branch: command.branch, unresolved: await effects.resolve(command.branch) };
    case "squash-merge": {
      const merged = await effects.squashMerge(command.branch);
      return { kind: "merged", branch: command.branch, sha: merged.sha, parents: merged.parents };
    }
    case "retarget":
      return { kind: "retargeted", branch: command.branch, onto: command.onto, commitCount: await effects.retarget(command.branch, command.onto) };
    case "remove-worktree":
      await effects.removeWorktree(command.branch);
      return { kind: "removed", branch: command.branch };
    case "measure-reclaim":
      return { kind: "reclaimed", branch: command.branch, present: await effects.worktreePresent(command.branch), sample: await effects.measure() };
    default:
      throw new TypeError(`nothing to perform for ${command.kind}`);
  }
}

/** Run the delivery to done or halt. A thrown effect becomes a failure and the worktrees come down. */
export async function runDelivery(request: DeliveryRequest, effects: DeliveryEffects): Promise<DeliveryReport> {
  let delivery = startDelivery(request);
  const commands: DeliveryCommand[] = [];
  for (let step = 0; step < 64; step++) {
    const command = pending(delivery);
    commands.push(command);
    if (command.kind === "done") return { status: "done", commands };
    if (command.kind === "halt") return { status: "halted", reason: command.reason, commands };
    try {
      delivery = apply(delivery, await perform(command, effects));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      delivery = apply(delivery, { kind: "failed", reason });
    }
  }
  return { status: "halted", reason: "delivery exceeded its step budget", commands };
}
