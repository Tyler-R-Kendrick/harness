import { describe, expect, it } from "vitest";
import { CallbackRouter, CapabilityRegistry, EffectLedger, FlowController, HookBus, InputLease, SessionLog, SubagentTree, err, newId } from "@harness/core";

describe("errors always explain themselves", () => {
  it("HD1.1 err() refuses an empty message", () => {
    expect(() => err("x", "")).toThrow(/message/);
    expect(err("x", "why")).toEqual({ ok: false, error: { code: "x", message: "why" } });
  });
});

describe("ids: known vectors", () => {
  it("HD2.1 encoding matches an independent Crockford base32 implementation", () => {
    const fixed = (bytes: number[]) => ({ bytes: () => new Uint8Array(bytes) });
    expect(newId("session", fixed([...Array(16).keys()]))).toBe("ses_000G40R40M30E209185GR38E1W");
    expect(newId("session", fixed(Array(4).fill([0xde, 0xad, 0xbe, 0xef]).flat()))).toBe("ses_VTPVXVYYNPZEZQNDQVQXXBDYXW");
  });

  it("HD2.2 entropy that returns the wrong number of bytes is rejected", () => {
    expect(() => newId("session", { bytes: () => new Uint8Array(8) })).toThrow(/entropy/);
  });
});

describe("capability registry hardening", () => {
  const offer = (providerId: string, provenance: "platform" | "client" | "federated" | "plugin") => ({ providerId, name: "tabs", version: 1, provenance, trust: "trusted" as const });

  it("HD3.1 withdrawing one provider revokes only its own leases", () => {
    const r = new CapabilityRegistry();
    r.offer(offer("a", "client"), 0);
    r.offer(offer("b", "federated"), 0);
    const leaseA = r.acquire("tabs", "w1", { version: 1, allow: ["client"] });
    const leaseB = r.acquire("tabs", "w2", { version: 1, allow: ["federated"] });
    if (!leaseA.ok || !leaseB.ok) throw new Error("unreachable");
    expect(r.withdraw("a", 1).map((l) => l.leaseId)).toEqual([leaseA.value.leaseId]);
    expect(r.validate(leaseB.value.leaseId, leaseB.value.epoch)).toBe(true);
  });

  it("HD3.2 federated daemons are preferred over plugins by default", () => {
    const r = new CapabilityRegistry();
    r.offer(offer("plug", "plugin"), 0);
    r.offer(offer("peer", "federated"), 0);
    expect(r.resolve("tabs", { version: 1 })?.providerId).toBe("peer");
  });

  it("HD3.3 lease ids are distinct and carry their epoch", () => {
    const r = new CapabilityRegistry();
    r.offer(offer("a", "client"), 0);
    const one = r.acquire("tabs", "w", { version: 1 });
    const two = r.acquire("tabs", "w", { version: 1 });
    if (!one.ok || !two.ok) throw new Error("unreachable");
    expect(one.value.leaseId).toBe(`lease-${one.value.epoch}`);
    expect(two.value.leaseId).not.toBe(one.value.leaseId);
  });
});

describe("effect ledger hardening", () => {
  const intent = (idempotent: boolean) => ({ effectId: "e", target: "t", intentKey: "k", idempotent, epoch: 1 });

  it("HD4.1 a receipt naming an attempt that does not exist is rejected even when others exist", () => {
    const l = new EffectLedger();
    l.intend(intent(false));
    l.dispatch("e", "a1", 1);
    expect(l.receipt("e", "a9", "succeeded", 1)).toMatchObject({ ok: false, error: { code: "unknown_attempt" } });
  });

  it("HD4.2 a success receipt contradicting a recorded failure is rejected", () => {
    const l = new EffectLedger();
    l.intend(intent(false));
    l.dispatch("e", "a1", 1);
    l.receipt("e", "a1", "failed", 1);
    expect(l.receipt("e", "a1", "succeeded", 1)).toMatchObject({ ok: false, error: { code: "conflicting_receipt" } });
  });

  it("HD4.3 after reconciliation found nothing applied, a late success receipt is a contradiction", () => {
    const l = new EffectLedger();
    l.intend(intent(false));
    l.dispatch("e", "a1", 1);
    l.recover(2);
    l.reconcile("e", "not_applied", 2);
    expect(l.receipt("e", "a1", "succeeded", 2)).toMatchObject({ ok: false, error: { code: "conflicting_receipt" } });
  });

  it("HD4.4 after reconciliation found nothing applied, a late failure receipt keeps the effect retryable", () => {
    const l = new EffectLedger();
    l.intend(intent(false));
    l.dispatch("e", "a1", 1);
    l.recover(2);
    l.reconcile("e", "not_applied", 2);
    expect(l.receipt("e", "a1", "failed", 2)).toMatchObject({ ok: true, value: { status: "intended" } });
    expect(l.get("e")?.attempts[0]?.status).toBe("failed");
    expect(l.dispatch("e", "a2", 2).ok).toBe(true);
  });

  it("HD4.5 an old attempt's failure does not settle an effect whose newer attempt is still in flight", () => {
    const l = new EffectLedger();
    l.intend(intent(true));
    l.dispatch("e", "a1", 1);
    l.recover(2);
    l.dispatch("e", "a2", 2);
    expect(l.receipt("e", "a1", "failed", 2)).toMatchObject({ ok: true, value: { status: "dispatched" } });
    expect(l.receipt("e", "a2", "succeeded", 2)).toMatchObject({ ok: true, value: { status: "succeeded" } });
  });

  it("HD4.6 an old attempt's success does settle the effect: it happened", () => {
    const l = new EffectLedger();
    l.intend(intent(true));
    l.dispatch("e", "a1", 1);
    l.recover(2);
    l.dispatch("e", "a2", 2);
    expect(l.receipt("e", "a1", "succeeded", 2)).toMatchObject({ ok: true, value: { status: "succeeded" } });
  });

  it("HD4.7 recovery marks only in-flight attempts unknown and leaves settled attempts alone", () => {
    const l = new EffectLedger();
    l.intend(intent(true));
    l.dispatch("e", "a1", 1);
    l.recover(2);
    l.dispatch("e", "a2", 2);
    l.receipt("e", "a1", "failed", 2);
    l.recover(3);
    expect(l.get("e")?.attempts.map((a) => a.status)).toEqual(["failed", "unknown"]);
  });
});

describe("flow, lease, routing and log hardening", () => {
  it("HD5.1 resync puts the subscriber back into stream mode", () => {
    const f = new FlowController(1);
    f.subscribe("a", 0);
    f.route(0);
    f.route(1);
    f.resync("a", 2);
    expect(f.state("a")).toEqual({ mode: "stream", next: 2, acked: 2 });
  });

  it("HD5.2 releasing when nobody holds the lease reports not_holder", () => {
    expect(new InputLease().release("a", 0)).toMatchObject({ ok: false, error: { code: "not_holder" } });
  });

  it("HD5.3 the requester never sees its own request as pending, even with the approve grant", () => {
    const t = new SubagentTree();
    t.createRoot("root", "agent", ["approve", "spawn"]);
    t.spawn("root", "worker", "agent", ["approve"]);
    t.spawn("root", "human", "human", ["approve"]);
    const r = new CallbackRouter(t, { exclude: ["root"] });
    r.open({ requestId: "q", from: "worker", options: [{ optionId: "ok", kind: "allow_once" }], at: 0 });
    expect(r.pendingFor("worker")).toEqual([]);
    expect(r.pendingFor("root")).toEqual([]);
    expect(r.pendingFor("human")).toEqual(["q"]);
  });

  it("HD5.4 compacting twice keeps exactly the retained tail", () => {
    const log = new SessionLog<number>();
    for (let i = 0; i < 6; i++) log.append("u", i, i);
    log.compact(2, "s2");
    log.compact(4, "s4");
    const r = log.read(4);
    expect(r.kind === "entries" && r.entries.map((e) => e.payload)).toEqual([4, 5]);
  });

  it("HD5.5 granting to a closed node is refused", () => {
    const t = new SubagentTree();
    t.createRoot("root", "agent", ["spawn", "observe"]);
    t.spawn("root", "a", "agent", []);
    t.close("a");
    expect(t.grant("a", ["observe"])).toMatchObject({ ok: false, error: { code: "closed" } });
  });
});

describe("hook bus hardening", () => {
  it("HD6.1 head reports the number of published events and late subscribers see new ones", () => {
    const b = new HookBus({ maxDepth: 2 });
    expect(b.head()).toBe(0);
    b.publish({ type: "x", source: "d", payload: 0 }, 0);
    expect(b.head()).toBe(1);
    b.subscribe("late", { types: ["*"] });
    b.publish({ type: "x", source: "d", payload: 1 }, 1);
    expect(b.poll("late")).toMatchObject({ ok: true, value: [{ payload: 1 }] });
  });

  it("HD6.2 subscribing from a middle offset starts exactly there", () => {
    const b = new HookBus({ maxDepth: 2 });
    for (let i = 0; i < 5; i++) b.publish({ type: "x", source: "d", payload: i }, i);
    b.subscribe("p", { types: ["*"] }, 2);
    expect(b.cursor("p")).toBe(2);
    const r = b.poll("p");
    expect(r.ok && r.value.map((e) => e.payload)).toEqual([2, 3, 4]);
  });

  it("HD6.3 events without a session carry no sessionId field", () => {
    const b = new HookBus({ maxDepth: 2 });
    const e = b.publish({ type: "x", source: "d", payload: 0 }, 0);
    expect(e.ok && "sessionId" in e.value).toBe(false);
  });

  it("HD6.4 a subscriber without a session filter receives events from every session", () => {
    const b = new HookBus({ maxDepth: 2 });
    b.subscribe("p", { types: ["*"] }, 0);
    b.publish({ type: "x", source: "d", payload: 0, sessionId: "s1" }, 0);
    expect(b.poll("p")).toMatchObject({ ok: true, value: [{ sessionId: "s1" }] });
  });

  it("HD6.5 a type pattern without a wildcard matches only exactly; any listed pattern suffices", () => {
    const b = new HookBus({ maxDepth: 2 });
    b.subscribe("exact", { types: ["session"] }, 0);
    b.subscribe("either", { types: ["a.one", "b.two"] }, 0);
    b.publish({ type: "session.created", source: "d", payload: 0 }, 0);
    b.publish({ type: "b.two", source: "d", payload: 0 }, 0);
    expect(b.poll("exact")).toEqual({ ok: true, value: [] });
    expect(b.poll("either")).toMatchObject({ ok: true, value: [{ type: "b.two" }] });
  });

  it("HD6.6 the saga view counts a step as handled only if the plugin subscribes to it and has acked past it", () => {
    const b = new HookBus({ maxDepth: 2 });
    b.subscribe("unrelated", { types: ["other.*"] }, 0);
    b.subscribe("behind", { types: ["*"] }, 0);
    const root = b.publish({ type: "x", source: "d", payload: 0 }, 0);
    b.publish({ type: "other.y", source: "d", payload: 0 }, 0);
    if (!root.ok) throw new Error("unreachable");
    b.ack("unrelated", 1);
    const saga = b.saga(root.value.correlationId);
    expect(saga.handledBy[root.value.eventId]).toEqual([]);
    b.ack("behind", 0);
    expect(b.saga(root.value.correlationId).handledBy[root.value.eventId]).toEqual(["behind"]);
  });

  it("HD6.7 after a restore, new events can still be caused by restored ones", () => {
    const b = new HookBus({ maxDepth: 2 });
    const root = b.publish({ type: "x", source: "d", payload: 0 }, 0);
    if (!root.ok) throw new Error("unreachable");
    const restored = HookBus.fromJSON(b.toJSON(), { maxDepth: 2 });
    expect(restored.publish({ type: "y", source: "p", payload: 0, cause: root.value.eventId }, 1)).toMatchObject({ ok: true, value: { depth: 1 } });
  });
});
