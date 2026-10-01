/**
 * Self-healing for a task-graph branch. Inspired by LogAct (arXiv:2604.07988):
 * the hook bus is the agent bus, and an intention is appended before the node
 * starts. Cancel, failure, over-budget, and an intention left open by a crash
 * read that trajectory and attempt the next path it has not already named.
 * Finished nodes stay finished.
 */

import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { HookBus, HookEvent } from "./hooks.ts";
import type { GraphError, TaskGraph } from "./task-graph.ts";

export type BranchFailure = "cancelled" | "failed" | "over-budget" | "interrupted";

export interface BranchPath {
  readonly id: string;
  readonly nodes: readonly string[];
}

export interface BranchPlan {
  readonly id: string;
  readonly budget: number;
  readonly paths: readonly BranchPath[];
}

export interface BranchRecovery {
  readonly failure: BranchFailure;
  readonly avoided: readonly string[];
  readonly path?: string;
  readonly started?: string;
}

export type BranchStep =
  | { readonly status: "started"; readonly node: string }
  | { readonly status: "succeeded"; readonly node: string }
  | ({ readonly status: "recovered" } & BranchRecovery);

interface Mark {
  readonly node: string;
  readonly path: string;
  readonly failure?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function check(plan: BranchPlan): void {
  if (typeof plan.id !== "string" || plan.id.length === 0) throw new TypeError("branch id must be a string");
  if (!Number.isInteger(plan.budget) || plan.budget < 1) throw new TypeError("branch budget must be a positive integer");
  if (!Array.isArray(plan.paths) || plan.paths.length === 0) throw new TypeError("branch needs a path");
  const paths = new Set<string>();
  const nodes = new Set<string>();
  for (const path of plan.paths) {
    if (typeof path.id !== "string" || path.id.length === 0) throw new TypeError("path id must be a string");
    if (paths.has(path.id)) throw new TypeError(`path ${path.id} is duplicated`);
    paths.add(path.id);
    if (!Array.isArray(path.nodes) || path.nodes.length === 0) throw new TypeError(`path ${path.id} is empty`);
    for (const node of path.nodes) {
      if (typeof node !== "string" || node.length === 0) throw new TypeError("path node must be a string");
      if (nodes.has(node)) throw new TypeError(`node ${node} is on two paths`);
      nodes.add(node);
    }
  }
}

function pathOf(plan: BranchPlan, node: string): BranchPath {
  const path = plan.paths.find((candidate) => candidate.nodes.includes(node));
  if (path === undefined) throw new TypeError(`node ${node} is not on a path`);
  return path;
}

function mark(event: HookEvent): Mark | undefined {
  if (!isRecord(event.payload)) return undefined;
  const node = event.payload["node"];
  const path = event.payload["path"];
  if (typeof node !== "string" || typeof path !== "string") return undefined;
  const failure = event.payload["failure"];
  if (failure !== undefined && typeof failure !== "string") return undefined;
  return failure === undefined ? { node, path } : { node, path, failure };
}

function trajectory(bus: HookBus, branch: string): readonly HookEvent[] {
  return bus.saga(branch).events.filter((event) => event.type.startsWith("branch."));
}

function avoidedOf(events: readonly HookEvent[]): string[] {
  const avoided: string[] = [];
  for (const event of events) {
    if (event.type !== "branch.intention" && event.type !== "branch.failure") continue;
    const item = mark(event);
    if (item === undefined || avoided.includes(item.node)) continue;
    avoided.push(item.node);
  }
  return avoided;
}

function spent(events: readonly HookEvent[], path: BranchPath): number {
  let count = 0;
  for (const event of events) {
    if (event.type !== "branch.intention") continue;
    const item = mark(event);
    if (item?.path === path.id) count += 1;
  }
  return count;
}

function openNode<P>(graph: TaskGraph<P>, events: readonly HookEvent[]): string | undefined {
  const open: string[] = [];
  for (const event of events) {
    const item = mark(event);
    if (item === undefined) continue;
    if (event.type === "branch.intention" && !open.includes(item.node)) open.push(item.node);
    if (event.type === "branch.result" || event.type === "branch.failure") {
      const index = open.indexOf(item.node);
      if (index >= 0) open.splice(index, 1);
    }
  }
  return open.find((node) => graph.status(node) === "pending");
}

function write(bus: HookBus, branch: string, type: string, payload: { readonly node: string; readonly path: string; readonly failure?: BranchFailure }, at: number): void {
  const body = payload.failure === undefined ? { node: payload.node, path: payload.path } : { node: payload.node, path: payload.path, failure: payload.failure };
  const result = bus.publish({ type, source: "task-graph", correlationId: branch, payload: body }, at);
  if (!result.ok) throw new Error(result.error.message);
}

function close<P>(graph: TaskGraph<P>, node: string, failure: BranchFailure): Result<unknown, GraphError> | undefined {
  const status = graph.status(node);
  if (status === undefined) return err("unknown_node", `no node ${node}`);
  if (failure === "failed") return status === "failed" ? undefined : graph.complete(node, "failed");
  if (status === "cancelled") return undefined;
  if (status !== "pending" && status !== "running" && status !== "awaiting") return err("already_terminal", `${node} is ${status}`);
  return graph.cancel(node);
}

function course<P>(graph: TaskGraph<P>, bus: HookBus, plan: BranchPlan, node: string, failure: BranchFailure, at: number): Result<BranchRecovery, GraphError> {
  const path = pathOf(plan, node);
  const closed = close(graph, node, failure);
  if (closed !== undefined && !closed.ok) return closed;
  write(bus, plan.id, "branch.failure", { node, path: path.id, failure }, at);
  const events = trajectory(bus, plan.id);
  const avoided = avoidedOf(events);
  const blocked = new Set(avoided);
  for (const candidate of plan.paths) {
    const head = candidate.nodes[0];
    if (head === undefined) continue;
    if (candidate.nodes.some((id) => blocked.has(id))) continue;
    if (candidate.nodes.some((id) => graph.status(id) !== "pending")) continue;
    if (!graph.ready().includes(head)) continue;
    if (spent(events, candidate) >= plan.budget) continue;
    write(bus, plan.id, "branch.correction", { node: head, path: candidate.id }, at);
    write(bus, plan.id, "branch.intention", { node: head, path: candidate.id }, at);
    const started = graph.start(head);
    if (!started.ok) return started;
    return ok({ failure, avoided, path: candidate.id, started: head });
  }
  return ok({ failure, avoided });
}

/** Append the intention, then start the node. Over budget, try a different path instead. */
export function intendBranch<P>(graph: TaskGraph<P>, bus: HookBus, plan: BranchPlan, node: string, at: number): Result<BranchStep, GraphError> {
  check(plan);
  const path = pathOf(plan, node);
  if (graph.status(node) === undefined) return err("unknown_node", `no node ${node}`);
  if (!graph.ready().includes(node)) return err("not_ready", `${node} is not ready`);
  if (spent(trajectory(bus, plan.id), path) >= plan.budget) {
    const healed = course(graph, bus, plan, node, "over-budget", at);
    if (!healed.ok) return healed;
    return ok({ status: "recovered", ...healed.value });
  }
  write(bus, plan.id, "branch.intention", { node, path: path.id }, at);
  const started = graph.start(node);
  if (!started.ok) return started;
  return ok({ status: "started", node });
}

/** Record a success, or course-correct after a failure. A success does not undo earlier nodes. */
export function completeBranch<P>(
  graph: TaskGraph<P>,
  bus: HookBus,
  plan: BranchPlan,
  node: string,
  outcome: "succeeded" | "failed",
  at: number,
): Result<BranchStep, GraphError> {
  check(plan);
  const path = pathOf(plan, node);
  if (outcome === "succeeded") {
    const done = graph.complete(node, "succeeded");
    if (!done.ok) return done;
    write(bus, plan.id, "branch.result", { node, path: path.id }, at);
    return ok({ status: "succeeded", node });
  }
  const healed = course(graph, bus, plan, node, "failed", at);
  if (!healed.ok) return healed;
  return ok({ status: "recovered", ...healed.value });
}

/** Cancel the node and attempt a path the trajectory has not already failed. */
export function abandonBranch<P>(graph: TaskGraph<P>, bus: HookBus, plan: BranchPlan, node: string, at: number): Result<BranchRecovery, GraphError> {
  check(plan);
  pathOf(plan, node);
  return course(graph, bus, plan, node, "cancelled", at);
}

/** An intention with no result, whose node never started, is an interrupted attempt. */
export function recoverBranch<P>(graph: TaskGraph<P>, bus: HookBus, plan: BranchPlan, at: number): Result<BranchRecovery, GraphError | "idle"> {
  check(plan);
  const open = openNode(graph, trajectory(bus, plan.id));
  if (open === undefined) return err("idle", "branch has no open intention");
  return course(graph as TaskGraph<unknown>, bus, plan, open, "interrupted", at);
}
