import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { SubagentTree } from "./subagents.ts";

export interface CallbackOption {
  readonly optionId: string;
  readonly kind: string;
}

export type CallbackOutcome = { readonly outcome: "selected"; readonly optionId: string } | { readonly outcome: "cancelled" };

export interface OpenRequest {
  readonly requestId: string;
  /** The subagent (usually a worker) that raised the request. It can never answer it. */
  readonly from: string;
  readonly options: readonly CallbackOption[];
  readonly at: number;
  readonly deadline?: number;
}

export interface PendingRequest extends OpenRequest {
  readonly targets: readonly string[];
}

export interface Resolution {
  readonly requestId: string;
  readonly by: string;
  readonly outcome: CallbackOutcome;
  readonly at: number;
}

export type RoutingError = "duplicate_request" | "unknown_request" | "already_resolved" | "not_authorized" | "invalid_option";

/**
 * Routes permission-style callbacks from a worker to the subagents holding the
 * `approve` grant. The first valid answer wins; nothing is ever auto-approved.
 */
export class CallbackRouter {
  readonly #tree: SubagentTree;
  readonly #exclude: ReadonlySet<string>;
  #pending = new Map<string, PendingRequest>();
  #resolved = new Map<string, Resolution>();

  constructor(tree: SubagentTree, options: { exclude?: readonly string[] } = {}) {
    this.#tree = tree;
    this.#exclude = new Set(options.exclude);
  }

  open(request: OpenRequest): Result<{ targets: string[] }, RoutingError> {
    if (this.#pending.has(request.requestId) || this.#resolved.has(request.requestId)) {
      return err("duplicate_request", `request ${request.requestId} already exists`);
    }
    const targets = this.#tree.holders("approve").filter((id) => this.#eligible(id, request));
    this.#pending.set(request.requestId, { ...request, targets });
    return ok({ targets });
  }

  answer(requestId: string, by: string, outcome: CallbackOutcome, at: number): Result<Resolution, RoutingError> {
    if (this.#resolved.has(requestId)) return err("already_resolved", `request ${requestId} is already resolved`);
    const request = this.#pending.get(requestId);
    if (!request) return err("unknown_request", `no request ${requestId}`);
    if (!this.#tree.hasGrant(by, "approve") || !this.#eligible(by, request)) {
      return err("not_authorized", `${by} cannot answer ${requestId}`);
    }
    if (outcome.outcome === "selected" && !request.options.some((o) => o.optionId === outcome.optionId)) {
      return err("invalid_option", `option ${outcome.optionId} was not offered`);
    }
    return ok(this.#resolve(request, by, outcome, at));
  }

  cancel(requestId: string, at: number): Result<Resolution, RoutingError> {
    if (this.#resolved.has(requestId)) return err("already_resolved", `request ${requestId} is already resolved`);
    const request = this.#pending.get(requestId);
    if (!request) return err("unknown_request", `no request ${requestId}`);
    return ok(this.#resolve(request, "system", { outcome: "cancelled" }, at));
  }

  /** Resolve every request whose deadline has passed as cancelled. Requests without a deadline wait. */
  expire(now: number): Resolution[] {
    const due = [...this.#pending.values()].filter((r) => (r.deadline ?? Number.POSITIVE_INFINITY) <= now);
    return due.map((r) => this.#resolve(r, "system", { outcome: "cancelled" }, now));
  }

  pending(requestId: string): PendingRequest | undefined {
    return this.#pending.get(requestId);
  }

  resolution(requestId: string): Resolution | undefined {
    return this.#resolved.get(requestId);
  }

  /** Unresolved requests the node could answer right now (e.g. after it reattaches). */
  pendingFor(nodeId: string): string[] {
    if (!this.#tree.hasGrant(nodeId, "approve")) return [];
    return [...this.#pending.values()].filter((r) => this.#eligible(nodeId, r)).map((r) => r.requestId);
  }

  #eligible(nodeId: string, request: OpenRequest): boolean {
    return nodeId !== request.from && !this.#exclude.has(nodeId);
  }

  #resolve(request: PendingRequest, by: string, outcome: CallbackOutcome, at: number): Resolution {
    const resolution: Resolution = { requestId: request.requestId, by, outcome, at };
    this.#pending.delete(request.requestId);
    this.#resolved.set(request.requestId, resolution);
    return resolution;
  }
}
