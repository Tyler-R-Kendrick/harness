/**
 * Doubles for the plugin's tests: a hook bus that delivers what it is given (and again, when
 * told to), and a world of facts the plugin reads. Both record every call, so a test can
 * say which methods the plugin used and which it did not.
 */
import type { Facts, HookEventLike, HookSource, LogEntryLike, PermissionOptionLike } from "../src/plugin.ts";
import type { PermissionFacts } from "../src/permission.ts";

export class FakeBus implements HookSource {
  readonly events: HookEventLike[] = [];
  readonly calls: string[] = [];
  readonly acked: number[] = [];
  readonly polled: (number | undefined)[] = [];
  subscribed: { types: string[]; from: number | undefined }[] = [];
  /** Event ids to deliver once more on the next poll, after the others. */
  redeliver: string[] = [];
  failPoll: Error | undefined;
  failAck: Error | undefined;
  failSubscribe: Error | undefined;
  #cursor = 0;

  /** Add an event as the daemon would publish it. */
  publish(type: string, sessionId: string | undefined, payload: unknown, extra: Partial<HookEventLike> = {}): HookEventLike {
    const offset = this.events.length;
    const event: HookEventLike = { eventId: `evt-${offset}`, offset, type, source: "daemon", ...(sessionId === undefined ? {} : { sessionId }), correlationId: `cor-${offset}`, at: 1_000 + offset, payload, ...extra };
    this.events.push(event);
    return event;
  }

  async subscribe(filter: { readonly types: string[] }, from?: number): Promise<void> {
    this.calls.push("subscribe");
    if (this.failSubscribe) throw this.failSubscribe;
    this.subscribed.push({ types: filter.types, from });
    if (from !== undefined) this.#cursor = from;
  }

  async poll(max?: number): Promise<{ readonly events: readonly HookEventLike[] }> {
    this.calls.push("poll");
    this.polled.push(max);
    if (this.failPoll) throw this.failPoll;
    const types = this.subscribed.at(-1)?.types ?? [];
    const fresh = this.events.slice(this.#cursor).filter((e) => types.includes(e.type)).slice(0, max ?? Number.POSITIVE_INFINITY);
    const again = this.redeliver.flatMap((id) => this.events.filter((e) => e.eventId === id));
    this.redeliver = [];
    return { events: [...fresh, ...again] };
  }

  async ack(offset: number): Promise<void> {
    this.calls.push("ack");
    if (this.failAck) throw this.failAck;
    this.acked.push(offset);
    this.#cursor = Math.max(this.#cursor, offset + 1);
  }
}

export interface World {
  /** Open requests, by `session/request`. */
  readonly open: Map<string, { facts: PermissionFacts; options: readonly PermissionOptionLike[] | undefined }>;
  readonly logs: Map<string, LogEntryLike[]>;
  readonly sessionIds: Set<string>;
}

/** What the daemon would say, set by the test. */
export class FakeFacts implements Facts {
  readonly world: World = { open: new Map(), logs: new Map(), sessionIds: new Set() };
  readonly calls: string[] = [];
  readonly logReads: [string, number | undefined][] = [];

  openRequest(session: string, requestId: string, facts: PermissionFacts, options?: readonly PermissionOptionLike[]): void {
    this.world.sessionIds.add(session);
    this.world.open.set(`${session}/${requestId}`, { facts, options });
  }

  closeRequest(session: string, requestId: string): void {
    this.world.open.delete(`${session}/${requestId}`);
  }

  /** Append an entry to a session's log; returns its offset. */
  append(session: string, kind: "event" | "update", payload: unknown): number {
    this.world.sessionIds.add(session);
    const entries = this.world.logs.get(session) ?? [];
    const offset = entries.length;
    entries.push({ offset, at: 500 + offset, kind, payload });
    this.world.logs.set(session, entries);
    return offset;
  }

  toolCall(session: string, id: string, title: string, rawInput: unknown, extra: Record<string, unknown> = {}): void {
    this.append(session, "update", { update: { sessionUpdate: "tool_call", toolCallId: id, title, kind: "execute", status: "pending", rawInput, ...extra } });
  }

  toolUpdate(session: string, id: string, patch: Record<string, unknown>): void {
    this.append(session, "update", { update: { sessionUpdate: "tool_call_update", toolCallId: id, ...patch } });
  }

  permission(sessionId: string, requestId: string) {
    this.calls.push("permission");
    return this.world.open.get(`${sessionId}/${requestId}`)?.facts;
  }

  permissionOptions(sessionId: string, requestId: string) {
    this.calls.push("permissionOptions");
    return this.world.open.get(`${sessionId}/${requestId}`)?.options;
  }

  log(sessionId: string, afterOffset?: number): readonly LogEntryLike[] {
    this.calls.push("log");
    this.logReads.push([sessionId, afterOffset]);
    return (this.world.logs.get(sessionId) ?? []).filter((e) => afterOffset === undefined || e.offset > afterOffset);
  }

  sessions() {
    this.calls.push("sessions");
    return [...this.world.sessionIds].map((id) => ({ id }));
  }
}

export const ALLOW: PermissionOptionLike = { optionId: "allow", kind: "allow_once" };
export const DENY: PermissionOptionLike = { optionId: "deny", kind: "reject_once" };
export const OPTIONS = [ALLOW, DENY] as const;
