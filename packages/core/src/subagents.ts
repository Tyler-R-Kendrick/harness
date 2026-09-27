import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

/**
 * Everything that participates in a session is a subagent node: workers, attached
 * clients, plugins and humans. Roles are grants; a node's grants are always a subset
 * of its parent's, so authority can only narrow as the tree deepens.
 */
export type Grant = "observe" | "control" | "approve" | "spawn" | "cancel" | `cap:${string}`;
export type NodeKind = "agent" | "human" | "client" | "plugin";
export type NodeState = "active" | "detached" | "closed";

export interface SubagentNode {
  readonly id: string;
  readonly parent?: string;
  readonly kind: NodeKind;
  readonly state: NodeState;
  readonly grants: readonly Grant[];
}

export type TreeError = "unknown_node" | "duplicate_node" | "grant_not_held" | "not_permitted" | "inactive_parent" | "closed";

interface MutableNode {
  id: string;
  parent?: string;
  kind: NodeKind;
  state: NodeState;
  grants: Set<Grant>;
  children: string[];
}

export class SubagentTree {
  #nodes = new Map<string, MutableNode>();
  #root: string | undefined;

  createRoot(id: string, kind: NodeKind, grants: readonly Grant[]): void {
    if (this.#root !== undefined) throw new Error("tree already has a root");
    this.#root = id;
    this.#nodes.set(id, { id, kind, state: "active", grants: new Set(grants), children: [] });
  }

  spawn(parentId: string, id: string, kind: NodeKind, grants: readonly Grant[]): Result<SubagentNode, TreeError> {
    const parent = this.#nodes.get(parentId);
    if (!parent) return err("unknown_node", `no node ${parentId}`);
    if (this.#nodes.has(id)) return err("duplicate_node", `node ${id} already exists`);
    if (parent.state !== "active") return err("inactive_parent", `parent ${parentId} is ${parent.state}`);
    if (!parent.grants.has("spawn")) return err("not_permitted", `${parentId} lacks the spawn grant`);
    const missing = grants.find((g) => !parent.grants.has(g));
    if (missing !== undefined) return err("grant_not_held", `${parentId} does not hold ${missing}`);
    const node: MutableNode = { id, parent: parentId, kind, state: "active", grants: new Set(grants), children: [] };
    this.#nodes.set(id, node);
    parent.children.push(id);
    return ok(view(node));
  }

  /** Remove grants from a node and, to keep the subset invariant, from all its descendants. */
  revoke(id: string, grants: readonly Grant[]): Result<void, TreeError> {
    const node = this.#nodes.get(id);
    if (!node) return err("unknown_node", `no node ${id}`);
    for (const n of this.#subtree(node)) for (const g of grants) n.grants.delete(g);
    return ok(undefined);
  }

  grant(id: string, grants: readonly Grant[]): Result<void, TreeError> {
    const node = this.#nodes.get(id);
    if (!node) return err("unknown_node", `no node ${id}`);
    if (node.state === "closed") return err("closed", `node ${id} is closed`);
    const parent = node.parent === undefined ? undefined : this.#nodes.get(node.parent);
    const missing = parent === undefined ? undefined : grants.find((g) => !parent.grants.has(g));
    if (missing !== undefined) return err("grant_not_held", `parent does not hold ${missing}`);
    for (const g of grants) node.grants.add(g);
    return ok(undefined);
  }

  detach(id: string): Result<void, TreeError> {
    return this.#setState(id, "detached");
  }

  reattach(id: string): Result<void, TreeError> {
    return this.#setState(id, "active");
  }

  close(id: string): Result<void, TreeError> {
    const node = this.#nodes.get(id);
    if (!node) return err("unknown_node", `no node ${id}`);
    for (const n of this.#subtree(node)) n.state = "closed";
    return ok(undefined);
  }

  get(id: string): SubagentNode | undefined {
    const node = this.#nodes.get(id);
    return node && view(node);
  }

  grants(id: string): ReadonlySet<Grant> {
    return new Set(this.#nodes.get(id)?.grants);
  }

  /** True only for an active node that currently holds the grant. */
  hasGrant(id: string, grant: Grant): boolean {
    const node = this.#nodes.get(id);
    return node !== undefined && node.state === "active" && node.grants.has(grant);
  }

  holders(grant: Grant): string[] {
    return [...this.#nodes.values()].filter((n) => n.state === "active" && n.grants.has(grant)).map((n) => n.id);
  }

  children(id: string): string[] {
    return [...(this.#nodes.get(id)?.children ?? [])];
  }

  ancestors(id: string): string[] {
    const out: string[] = [];
    let parent = this.#nodes.get(id)?.parent;
    while (parent !== undefined) {
      out.push(parent);
      parent = this.#nodes.get(parent)?.parent;
    }
    return out;
  }

  toJSON(): { nodes: SubagentNode[] } {
    return { nodes: [...this.#nodes.values()].map(view) };
  }

  static fromJSON(data: unknown): SubagentTree {
    if (typeof data !== "object" || data === null || !Array.isArray((data as { nodes?: unknown }).nodes)) {
      throw new Error("invalid subagent tree data");
    }
    const tree = new SubagentTree();
    for (const n of (data as { nodes: SubagentNode[] }).nodes) {
      if (n.parent === undefined) {
        tree.createRoot(n.id, n.kind, n.grants);
      } else {
        const parent = tree.#nodes.get(n.parent);
        if (!parent) throw new Error(`node ${n.id} references unknown parent ${n.parent}`);
        if (!n.grants.every((g) => parent.grants.has(g))) throw new Error(`node ${n.id} grants are not a subset of its parent's`);
        tree.#nodes.set(n.id, { id: n.id, parent: n.parent, kind: n.kind, state: "active", grants: new Set(n.grants), children: [] });
        parent.children.push(n.id);
      }
      tree.#nodes.get(n.id)!.state = n.state;
    }
    return tree;
  }

  #setState(id: string, state: "active" | "detached"): Result<void, TreeError> {
    const node = this.#nodes.get(id);
    if (!node) return err("unknown_node", `no node ${id}`);
    if (node.state === "closed") return err("closed", `node ${id} is closed`);
    node.state = state;
    return ok(undefined);
  }

  *#subtree(node: MutableNode): Generator<MutableNode> {
    yield node;
    for (const child of node.children) yield* this.#subtree(this.#nodes.get(child)!);
  }
}

function view(n: MutableNode): SubagentNode {
  return n.parent === undefined
    ? { id: n.id, kind: n.kind, state: n.state, grants: [...n.grants] }
    : { id: n.id, parent: n.parent, kind: n.kind, state: n.state, grants: [...n.grants] };
}
