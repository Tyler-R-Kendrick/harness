import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

export type DependencyKind = "data" | "control" | "assurance";
export type EdgeKind = "contains" | DependencyKind | "exclusion";
export type Join = { readonly kind: "all" } | { readonly kind: "any" } | { readonly kind: "quorum"; readonly count: number };
export type NodeStatus = "pending" | "running" | "awaiting" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface NodeSpec<P = unknown> {
  readonly join?: Join;
  /** Exclusive resources (ports, databases, browser profiles, devices, files...). */
  readonly resources?: readonly string[];
  /** Fan-out groups that must be sealed before this node can become ready. */
  readonly awaits?: readonly string[];
  /** What the node stands for, opaque to the graph (a task, a tool call, a plan step). */
  readonly payload?: P;
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

/** A node as `toJSON` gives it: its spec, where execution has it, and its payload when it has one. */
export interface TaskNodeData<P = unknown> {
  readonly id: string;
  readonly join: Join;
  readonly resources: readonly string[];
  readonly awaits: readonly string[];
  readonly status: NodeStatus;
  readonly sealed: boolean;
  readonly payload?: P;
}

export interface TaskEdgeData {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
}

/** A task graph as JSON: nodes and edges in the order they were added. */
export interface TaskGraphData<P = unknown> {
  readonly nodes: readonly TaskNodeData<P>[];
  readonly edges: readonly TaskEdgeData[];
}

interface GraphNode<P> {
  id: string;
  payload: P | undefined;
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
const STATUSES: ReadonlySet<unknown> = new Set(["pending", "running", "awaiting", ...TERMINAL]);
/** Statuses only a node that was ready can reach. Awaiting is a running node parked for a person. */
const STARTED: ReadonlySet<NodeStatus> = new Set(["running", "awaiting", "succeeded", "failed"]);
const EDGE_KINDS: ReadonlySet<unknown> = new Set(["contains", "data", "control", "assurance", "exclusion"]);

/**
 * Typed partial-order task graph. Containment records structure without blocking;
 * data/control/assurance edges gate readiness through explicit join policies; fan-out
 * groups must be sealed before joins that await them; exclusive resources and
 * exclusion edges keep conflicting nodes from running at the same time.
 */
export class TaskGraph<P = unknown> {
  #nodes = new Map<string, GraphNode<P>>();
  /** Edges by `kind:from->to`, in the order added. */
  #edges = new Map<string, TaskEdgeData>();
  #revision = 0;

  revision(): number {
    return this.#revision;
  }

  addNode(id: string, spec: NodeSpec<P> = {}): Result<void, GraphError> {
    if (this.#nodes.has(id)) return err("duplicate_node", `node ${id} exists`);
    const missing = spec.awaits?.find((g) => !this.#nodes.has(g));
    if (missing !== undefined) return err("unknown_node", `awaited group ${missing} does not exist`);
    const join = spec.join ?? { kind: "all" };
    if (join.kind === "quorum" && !(Number.isInteger(join.count) && join.count >= 1)) throw new Error("quorum count must be a positive integer");
    this.#nodes.set(id, {
      id,
      payload: spec.payload,
      join,
      resources: spec.resources ?? [],
      awaits: spec.awaits ?? [],
      status: "pending",
      sealed: false,
      children: [],
      preds: [],
      succs: [],
      // Stryker disable next-line ArrayDeclaration: equivalent; an exclusion names a node id, and no node is added with a placeholder's id
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
    this.#edges.set(key, { from, to, kind });
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

  /** The payload the node was added with, if any. */
  payload(id: string): P | undefined {
    return this.#nodes.get(id)?.payload;
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
    const chosen: GraphNode<P>[] = [];
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

  /**
   * Park a running node that is awaiting a person. It leaves the running slot and its
   * exclusive resources, stays unfinished, and is not ready to start again.
   */
  background(id: string): Result<void, GraphError> {
    const n = this.#nodes.get(id);
    if (!n) return err("unknown_node", `no node ${id}`);
    if (n.status !== "running") return err("not_running", `${id} is ${n.status}`);
    n.status = "awaiting";
    return ok(undefined);
  }

  /** Finish a running or awaiting node. Returns nodes that became unsatisfiable and were skipped. */
  complete(id: string, outcome: "succeeded" | "failed"): Result<string[], GraphError> {
    const n = this.#nodes.get(id);
    if (!n) return err("unknown_node", `no node ${id}`);
    if (n.status !== "running" && n.status !== "awaiting") return err("not_running", `${id} is ${n.status}`);
    n.status = outcome;
    return ok(this.#settle());
  }

  /** Stop pending, running, or awaiting work. Cancellation is not rollback: finished work stays finished. */
  cancel(id: string): Result<string[], GraphError> {
    const n = this.#nodes.get(id);
    if (!n) return err("unknown_node", `no node ${id}`);
    if (TERMINAL.has(n.status)) return err("already_terminal", `${id} is ${n.status}`);
    n.status = "cancelled";
    return ok(this.#settle());
  }

  /** The graph as JSON, for `fromJSON`: payloads are kept as given, so they should be JSON too. */
  toJSON(): TaskGraphData<P> {
    return {
      nodes: [...this.#nodes.values()].map((n) => ({
        id: n.id,
        join: n.join,
        resources: [...n.resources],
        awaits: [...n.awaits],
        status: n.status,
        sealed: n.sealed,
        ...(n.payload === undefined ? {} : { payload: n.payload }),
      })),
      edges: [...this.#edges.values()],
    };
  }

  /**
   * A graph from `toJSON`'s data. Structure is rebuilt through `addNode`, `addEdge` and
   * `seal`, so it keeps every rule they enforce; statuses must be ones an execution
   * reaches (a started node was ready, a skipped node can no longer be satisfied).
   * `payload` checks each payload; without it payloads are kept as given. Throws on
   * anything else.
   */
  static fromJSON<P = unknown>(data: unknown, payload: (raw: unknown) => P = (raw) => raw as P): TaskGraph<P> {
    const { nodes, edges } = readData(data);
    const g = new TaskGraph<P>();
    for (const n of nodes) {
      must(g.addNode(n.id, { join: n.join, resources: n.resources, awaits: n.awaits }));
      try {
        g.#nodes.get(n.id)!.payload = n.payload === undefined ? undefined : payload(n.payload);
      } catch (e) {
        invalid(`node ${n.id} has an invalid payload: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    for (const e of edges) must(g.addEdge(e.from, e.to, e.kind));
    for (const n of nodes) if (n.sealed) g.seal(n.id);
    for (const n of nodes) g.#nodes.get(n.id)!.status = n.status;
    for (const n of g.#nodes.values()) {
      const satisfaction = g.#satisfaction(n);
      const ready = satisfaction === "satisfied" && n.awaits.every((a) => g.#nodes.get(a)!.sealed);
      if (STARTED.has(n.status) && !ready) invalid(`node ${n.id} is ${n.status} but was never ready`);
      if (n.status === "skipped" && satisfaction !== "impossible") invalid(`node ${n.id} is skipped but can still run`);
    }
    return g;
  }

  #isReady(n: GraphNode<P>): boolean {
    return n.status === "pending" && this.#satisfaction(n) === "satisfied" && n.awaits.every((g) => this.#nodes.get(g)!.sealed);
  }

  #satisfaction(n: GraphNode<P>): "satisfied" | "waiting" | "impossible" {
    const statuses = n.preds.map((p) => this.#nodes.get(p)!.status);
    const succeeded = statuses.filter((s) => s === "succeeded").length;
    const open = statuses.filter((s) => !TERMINAL.has(s)).length;
    const need = n.join.kind === "all" ? statuses.length : n.join.kind === "any" ? Math.min(1, statuses.length) : n.join.count;
    if (succeeded >= need) return "satisfied";
    // Stryker disable next-line StringLiteral: equivalent; callers only ask whether it is satisfied or impossible
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
      // Stryker disable next-line ConditionalExpression,BlockStatement,CallExpression: equivalent; dependency edges form a DAG, so the walk ends without the seen set, which only saves revisits
      if (seen.has(id)) continue;
      // Stryker disable next-line CallExpression: equivalent, as above
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

function invalid(message: string): never {
  throw new Error(`invalid task graph data: ${message}`);
}

function must(result: Result<void, GraphError>): void {
  if (!result.ok) invalid(`${result.error.code}: ${result.error.message}`);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function readJoin(v: unknown): Join | undefined {
  if (!isRecord(v)) return undefined;
  if (v["kind"] === "all" || v["kind"] === "any") return { kind: v["kind"] };
  const count = v["count"];
  return v["kind"] === "quorum" && Number.isInteger(count) && Number(count) >= 1 ? { kind: "quorum", count: Number(count) } : undefined;
}

/** A node as read, before its payload is checked. */
type ReadNode = Omit<TaskNodeData, "payload"> & { readonly payload: unknown };

/** The shape of `toJSON`'s data, checked field by field. */
function readData(data: unknown): { nodes: ReadNode[]; edges: TaskEdgeData[] } {
  if (!isRecord(data)) return invalid("not an object");
  if (!Array.isArray(data["nodes"])) return invalid("nodes is not a list");
  if (!Array.isArray(data["edges"])) return invalid("edges is not a list");
  const nodes = data["nodes"].map((n: unknown, i): ReadNode => {
    if (!isRecord(n)) return invalid(`node ${i} is not an object`);
    const id = n["id"];
    if (typeof id !== "string") return invalid(`node ${i} has no id`);
    const join = readJoin(n["join"]);
    if (join === undefined) return invalid(`node ${id} has an invalid join`);
    if (!isStrings(n["resources"])) return invalid(`node ${id} has invalid resources`);
    if (!isStrings(n["awaits"])) return invalid(`node ${id} has invalid awaits`);
    if (!STATUSES.has(n["status"])) return invalid(`node ${id} has an invalid status`);
    if (typeof n["sealed"] !== "boolean") return invalid(`node ${id} has an invalid sealed flag`);
    return { id, join, resources: n["resources"], awaits: n["awaits"], status: n["status"] as NodeStatus, sealed: n["sealed"], payload: n["payload"] };
  });
  const edges = data["edges"].map((e: unknown, i): TaskEdgeData => {
    if (!isRecord(e)) return invalid(`edge ${i} is not an object`);
    if (typeof e["from"] !== "string" || typeof e["to"] !== "string") return invalid(`edge ${i} has no endpoints`);
    if (!EDGE_KINDS.has(e["kind"])) return invalid(`edge ${i} has an invalid kind`);
    return { from: e["from"], to: e["to"], kind: e["kind"] as EdgeKind };
  });
  return { nodes, edges };
}

function conflicts(a: GraphNode<unknown>, b: GraphNode<unknown>): boolean {
  return a.exclusive.includes(b.id) || a.resources.some((r) => b.resources.includes(r));
}
