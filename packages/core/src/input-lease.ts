import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

export type LeasePriority = "human" | "agent";

export interface LeaseGrant {
  readonly holder: string;
  readonly epoch: number;
  readonly expiresAt: number;
}

export interface LeaseState extends LeaseGrant {
  readonly priority: LeasePriority;
}

export type LeaseError = "held_by_other" | "not_holder";

/**
 * Decides which subagent may send input into a session. Humans preempt agents;
 * nobody preempts a human, who must hand over explicitly. Every change of holder
 * advances the epoch, so input stamped with an old epoch is fenced out.
 */
export class InputLease {
  #state: LeaseState | undefined;
  #epoch = 0;

  acquire(holder: string, priority: LeasePriority, now: number, ttl: number): Result<LeaseGrant, LeaseError> {
    if (!(ttl > 0)) throw new Error("lease ttl must be positive");
    const live = this.holder(now);
    if (live && live.holder === holder) return ok(this.#set(holder, priority, now, ttl, live.epoch));
    if (live && !(priority === "human" && live.priority === "agent")) {
      return err("held_by_other", `input lease is held by ${live.holder}`);
    }
    return ok(this.#set(holder, priority, now, ttl, ++this.#epoch));
  }

  transfer(from: string, to: string, priority: LeasePriority, now: number, ttl: number): Result<LeaseGrant, LeaseError> {
    if (this.holder(now)?.holder !== from) return err("not_holder", `${from} does not hold the input lease`);
    return ok(this.#set(to, priority, now, ttl, ++this.#epoch));
  }

  release(holder: string, now: number): Result<void, LeaseError> {
    if (this.holder(now)?.holder !== holder) return err("not_holder", `${holder} does not hold the input lease`);
    this.#state = undefined;
    return ok(undefined);
  }

  holder(now: number): LeaseState | undefined {
    return this.#state !== undefined && now < this.#state.expiresAt ? this.#state : undefined;
  }

  /** Input is accepted only from the live holder carrying the current epoch. */
  check(holder: string, epoch: number, now: number): boolean {
    const live = this.holder(now);
    return live !== undefined && live.holder === holder && live.epoch === epoch;
  }

  #set(holder: string, priority: LeasePriority, now: number, ttl: number, epoch: number): LeaseGrant {
    this.#state = { holder, priority, epoch, expiresAt: now + ttl };
    return { holder, epoch, expiresAt: now + ttl };
  }
}
