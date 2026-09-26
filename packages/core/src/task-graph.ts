import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

export type DependencyKind = "data" | "control" | "assurance";
export type EdgeKind = "contains" | DependencyKind | "exclusion";
export type Join = { readonly kind: "all" } | { readonly kind: "any" } | { readonly kind: "quorum"; readonly count: number };
export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface NodeSpec {
  readonly join?: Join;
  /** Exclusive resources (ports, databases, browser profiles, devices, files...). */
  readonly resources?: readonly string[];
  /** Fan-out groups that must be sealed before this node can become ready. */
  readonly awaits?: readonly string[];
}

export type GraphError =
  | "duplicate_node"
  | "unknown_node"
  | "self_edge"
  | "duplicate_edge"
  | "cycle"
  | "multiple_parents"
  | "sealed"
  | "target_started"
  | "not_ready"
  | "not_running"
  | "already_terminal";

interface GraphNode {
  id: string;
  join: Join;
  resources: readonly string[];
  awaits: readonly string[];
  status: NodeStatus;
  sealed: boolean;
  parent?: string;
  children: string[];
  preds: string[];
  succs: string[];
  exclusive: string[];
}

const TERMINAL: ReadonlySet<NodeStatus> = new Set(["succeeded", "failed", "cancelled", "skipped"]);

/**
 * Typed partial-order task graph. Containment records structure without blocking;
 * data/control/assurance edges gate readiness through explicit join policies; fan-out
 * groups must be sealed before joins that await them; exclusive resources and
 * exclusion edges keep conflicting nodes from running at the same time.
 */
export class TaskGraph {
  #nodes = new Map<string, GraphNode>();
  #edges = new Set<string>();
  #revision = 0;

  revision(): number {
    return this.#revision;
  }

  addNode(id: string, spec: NodeSpec = {}): Result<void, GraphError> {
    if (this.#nodes.has(id)) return err("duplicate_node", `node ${id} exists`);
    const missing = spec.awaits?.find((g) => !this.#nodes.has(g));
    if (missing !== undefined) return err("unknown_node", `awaited group ${missing} does not exist`);
    const join = spec.join ?? { kind: "all" };
    if (join.kind === "quorum" && !(Number.isInteger(join.count) && join.count >= 1)) throw new Error("quorum count must be a positive integer");
    this.#nodes.set(id, {
      id,
      join,
      resources: spec.resources ?? [],
      awaits: spec.awaits ?? [],
      status: "pending",
      sealed: false,
      children: [],
      preds: [],
      succs: [],
      exclusive: [],
    });
    this.#revision++;
    return ok(undefined);
  }

  addEdge(from: string, to: string, kind: EdgeKind): Result<void, GraphError> {
    const a = this.#nodes.get(from);
    const b = this.#nodes.get(to);
    if (!a || !b) return err("unknown_node", `unknown node ${a ? to : from}`);
    if (from === to) return err("self_edge", `${from} cannot depend on itself`);
    const key = `${kind}:${from}->${to}`;
    if (this.#edges.has(key)) return err("duplicate_edge", `edge ${key} exists`);
    if (kind === "contains") {
      if (a.sealed) return err("sealed", `group ${from} is sealed`);
      if (b.parent !== undefined) return err("multiple_parents", `${to} already belongs to ${b.parent}`);
      if (this.#isAncestor(to, from)) return err("cycle", `${to} contains ${from}`);
      b.parent = from;
      a.children.push(to);
    } else if (kind === "exclusion") {
      a.exclusive.push(to);
      b.exclusive.push(from);
    } else {
      if (b.status !== "pending") return err("target_started", `${to} has already started`);
      if (this.#reaches(to, from)) return err("cycle", `${to} already leads to ${from}`);
      a.succs.push(to);
      b.preds.push(from);
    }
    this.#edges.add(key);
    this.#revision++;
    return ok(undefined);
  }

  seal(groupId: string): Result<void, GraphError> {
    const g = this.#nodes.get(groupId);
    if (!g) return err("unknown_node", `no node ${groupId}`);
    if (!g.sealed) {
      g.sealed = true;
      this.#revision++;
    }
    return ok(undefined);
  }

  isSealed(groupId: string): boolean {
    return this.#nodes.get(groupId)?.sealed === true;
  }

  status(id: string): NodeStatus | undefined {
    return this.#nodes.get(id)?.status;
  }

  parent(id: string): string | undefined {
    return this.#nodes.get(id)?.parent;
  }

  children(id: string): string[] {
    return [...(this.#nodes.get(id)?.children ?? [])];
  }

  /** Pending nodes whose dependencies are satisfied and whose awaited groups are sealed. */
  ready(): string[] {
    return [...this.#nodes.values()].filter((n) => this.#isReady(n)).map((n) => n.id);
  }

  /** A conflict-free subset of ready nodes, in order, up to `limit`. */
  schedule(limit: number): string[] {
    const busy = [...this.#nodes.values()].filter((n) => n.status === "running");
    const chosen: GraphNode[] = [];
    for (const id of this.ready()) {
      if (chosen.length >= limit) break;
      const n = this.#nodes.get(id)!;
      if (![...busy, ...chosen].some((o) => conflicts(n, o))) chosen.push(n);
    }
    return chosen.map((n) => n.id);
  }

  start(id: string): Result<void, GraphError> {
    const n = this.#nodes.get(id);
    if (!n) return err("unknown_node", `no node ${id}`);
    if (!this.#isReady(n)) return err("not_ready", `${id} is not ready`);
    n.status = "running";
    return ok(undefined);
  }

  /** Finish a running node. Returns nodes that became unsatisfiable and were skipped. */
  complete(id: string, outcome: "succeeded" | "failed"): Result<string[], GraphError> {
    const n = this.#nodes.get(id);
    if (!n) return err("unknown_node", `no node ${id}`);
    if (n.status !== "running") return err("not_running", `${id} is ${n.status}`);
    n.status = outcome;
    return ok(this.#settle());
  }

  /** Stop pending or running work. Cancellation is not rollback: finished work stays finished. */
  cancel(id: string): Result<string[], GraphError> {
    const n = this.#nodes.get(id);
    if (!n) return err("unknown_node", `no node ${id}`);
    if (TERMINAL.has(n.status)) return err("already_terminal", `${id} is ${n.status}`);
    n.status = "cancelled";
    return ok(this.#settle());
  }

  #isReady(n: GraphNode): boolean {
    return n.status === "pending" && this.#satisfaction(n) === "satisfied" && n.awaits.every((g) => this.#nodes.get(g)!.sealed);
  }

  #satisfaction(n: GraphNode): "satisfied" | "waiting" | "impossible" {
    const statuses = n.preds.map((p) => this.#nodes.get(p)!.status);
    const succeeded = statuses.filter((s) => s === "succeeded").length;
    const open = statuses.filter((s) => !TERMINAL.has(s)).length;
    const need = n.join.kind === "all" ? statuses.length : n.join.kind === "any" ? Math.min(1, statuses.length) : n.join.count;
    if (succeeded >= need) return "satisfied";
    return succeeded + open < need ? "impossible" : "waiting";
  }

  #settle(): string[] {
    const skipped: string[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of this.#nodes.values()) {
        if (n.status === "pending" && this.#satisfaction(n) === "impossible") {
          n.status = "skipped";
          skipped.push(n.id);
          changed = true;
        }
      }
    }
    return skipped;
  }

  #reaches(from: string, target: string): boolean {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...this.#nodes.get(id)!.succs);
    }
    return false;
  }

  #isAncestor(candidate: string, of: string): boolean {
    for (let p: string | undefined = of; p !== undefined; p = this.#nodes.get(p)!.parent) if (p === candidate) return true;
    return false;
  }
}

function conflicts(a: GraphNode, b: GraphNode): boolean {
  return a.exclusive.includes(b.id) || a.resources.some((r) => b.resources.includes(r));
}
