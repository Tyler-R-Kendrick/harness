import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

export interface SubscriberState {
  readonly mode: "stream" | "snapshot";
  /** Next log offset this subscriber expects. */
  readonly next: number;
  /** Everything below this offset has been acknowledged. */
  readonly acked: number;
}

export type FlowError = "unknown_subscriber" | "invalid_ack";

/**
 * Per-subscriber flow control for one session's log. Each subscriber may have at
 * most `capacity` unacknowledged entries; one that falls further behind is switched
 * to snapshot mode instead of stalling the session or the other subscribers.
 */
export class FlowController {
  readonly #capacity: number;
  #subs = new Map<string, { mode: "stream" | "snapshot"; next: number; acked: number }>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be a positive integer");
    this.#capacity = capacity;
  }

  subscribe(id: string, from: number): void {
    this.#subs.set(id, { mode: "stream", next: from, acked: from });
  }

  unsubscribe(id: string): void {
    this.#subs.delete(id);
  }

  /** Decide, for a newly appended offset, who gets it and who must resync from a snapshot. */
  route(offset: number): { send: string[]; resync: string[] } {
    const send: string[] = [];
    const resync: string[] = [];
    for (const [id, s] of this.#subs) {
      if (s.mode === "snapshot" || offset < s.next) continue;
      if (offset > s.next || s.next - s.acked >= this.#capacity) {
        s.mode = "snapshot";
        resync.push(id);
        continue;
      }
      s.next = offset + 1;
      send.push(id);
    }
    return { send, resync };
  }

  ack(id: string, upTo: number): Result<void, FlowError> {
    const s = this.#subs.get(id);
    if (!s) return err("unknown_subscriber", `no subscriber ${id}`);
    if (upTo > s.next) return err("invalid_ack", `ack ${upTo} is beyond delivered ${s.next}`);
    s.acked = Math.max(s.acked, upTo);
    return ok(undefined);
  }

  resync(id: string, from: number): Result<void, FlowError> {
    const s = this.#subs.get(id);
    if (!s) return err("unknown_subscriber", `no subscriber ${id}`);
    s.mode = "stream";
    s.next = from;
    s.acked = from;
    return ok(undefined);
  }

  state(id: string): SubscriberState | undefined {
    const s = this.#subs.get(id);
    return s && { mode: s.mode, next: s.next, acked: s.acked };
  }
}
