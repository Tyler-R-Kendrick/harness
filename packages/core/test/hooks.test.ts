import { describe, expect, it } from "vitest";
import { Deduper, HookBus } from "@harness/core";

function bus(maxDepth = 3) {
  return new HookBus({ maxDepth });
}

describe("HookBus publishing", () => {
  it("HK1.1 root events get offsets, a fresh correlation and depth 0", () => {
    const b = bus();
    const e = b.publish({ type: "session.created", source: "daemon", payload: { s: 1 } }, 10);
    expect(e).toMatchObject({ ok: true, value: { offset: 0, type: "session.created", source: "daemon", depth: 0, at: 10 } });
    if (!e.ok) throw new Error("unreachable");
    expect(e.value.correlationId).toBeTruthy();
    expect(e.value.causationId).toBeUndefined();
    const f = b.publish({ type: "session.created", source: "daemon", payload: {} }, 11);
    if (!f.ok) throw new Error("unreachable");
    expect(f.value.offset).toBe(1);
    expect(f.value.correlationId).not.toBe(e.value.correlationId);
    expect(f.value.eventId).not.toBe(e.value.eventId);
  });

  it("HK1.2 caused events inherit the correlation and go one level deeper", () => {
    const b = bus();
    const root = b.publish({ type: "turn.completed", source: "daemon", payload: {} }, 0);
    if (!root.ok) throw new Error("unreachable");
    const child = b.publish({ type: "tracker.sync", source: "plg-tracker", payload: {}, cause: root.value.eventId }, 1);
    expect(child).toMatchObject({ ok: true, value: { correlationId: root.value.correlationId, causationId: root.value.eventId, depth: 1 } });
  });

  it("HK1.3 an explicit correlation id is honoured for root events", () => {
    const b = bus();
    expect(b.publish({ type: "x", source: "s", payload: {}, correlationId: "saga-7" }, 0)).toMatchObject({ ok: true, value: { correlationId: "saga-7" } });
  });

  it("HK1.4 an unknown cause is rejected", () => {
    const b = bus();
    expect(b.publish({ type: "x", source: "s", payload: {}, cause: "nope" }, 0)).toMatchObject({ ok: false, error: { code: "unknown_cause" } });
  });

  it("HK1.5 causal chains deeper than the limit are rejected", () => {
    const b = bus(2);
    let cause: string | undefined;
    for (let depth = 0; depth <= 2; depth++) {
      const r = b.publish(cause === undefined ? { type: "x", source: "a", payload: {} } : { type: "x", source: "a", payload: {}, cause }, depth);
      if (!r.ok) throw new Error(`depth ${depth} should be allowed`);
      cause = r.value.eventId;
    }
    expect(b.publish({ type: "x", source: "a", payload: {}, cause: cause! }, 9)).toMatchObject({ ok: false, error: { code: "depth_exceeded" } });
  });
});

describe("HookBus delivery", () => {
  it("HK2.1 subscribers receive exact, prefix-wildcard and catch-all matches only", () => {
    const b = bus();
    b.subscribe("exact", { types: ["turn.completed"] }, 0);
    b.subscribe("prefix", { types: ["session.*"] }, 0);
    b.subscribe("all", { types: ["*"] }, 0);
    b.publish({ type: "session.created", source: "d", payload: {} }, 0);
    b.publish({ type: "turn.completed", source: "d", payload: {} }, 0);
    b.publish({ type: "sessionx.other", source: "d", payload: {} }, 0);
    const types = (id: string) => {
      const r = b.poll(id);
      if (!r.ok) throw new Error("unreachable");
      return r.value.map((e) => e.type);
    };
    expect(types("exact")).toEqual(["turn.completed"]);
    expect(types("prefix")).toEqual(["session.created"]);
    expect(types("all")).toEqual(["session.created", "turn.completed", "sessionx.other"]);
  });

  it("HK2.2 a session filter limits delivery to that session", () => {
    const b = bus();
    b.subscribe("p", { types: ["*"], sessionId: "s1" }, 0);
    b.publish({ type: "x", source: "d", payload: {}, sessionId: "s1" }, 0);
    b.publish({ type: "x", source: "d", payload: {}, sessionId: "s2" }, 0);
    b.publish({ type: "x", source: "d", payload: {} }, 0);
    const r = b.poll("p");
    expect(r.ok && r.value.map((e) => e.sessionId)).toEqual(["s1"]);
  });

  it("HK2.3 polling does not consume: unacknowledged events are redelivered", () => {
    const b = bus();
    b.subscribe("p", { types: ["*"] }, 0);
    b.publish({ type: "x", source: "d", payload: {} }, 0);
    expect(b.poll("p")).toMatchObject({ ok: true, value: [{ offset: 0 }] });
    expect(b.poll("p")).toMatchObject({ ok: true, value: [{ offset: 0 }] });
  });

  it("HK2.4 acknowledging advances the cursor", () => {
    const b = bus();
    b.subscribe("p", { types: ["*"] }, 0);
    b.publish({ type: "x", source: "d", payload: {} }, 0);
    b.publish({ type: "y", source: "d", payload: {} }, 0);
    expect(b.ack("p", 0).ok).toBe(true);
    expect(b.cursor("p")).toBe(1);
    expect(b.poll("p")).toMatchObject({ ok: true, value: [{ type: "y" }] });
  });

  it("HK2.5 acks beyond head are invalid and stale acks never move the cursor back", () => {
    const b = bus();
    b.subscribe("p", { types: ["*"] }, 0);
    b.publish({ type: "x", source: "d", payload: {} }, 0);
    b.publish({ type: "y", source: "d", payload: {} }, 0);
    expect(b.ack("p", 2)).toMatchObject({ ok: false, error: { code: "invalid_ack" } });
    b.ack("p", 1);
    b.ack("p", 0);
    expect(b.cursor("p")).toBe(2);
  });

  it("HK2.6 a plugin never receives events it published itself", () => {
    const b = bus();
    b.subscribe("plg-a", { types: ["*"] }, 0);
    b.publish({ type: "x", source: "plg-a", payload: {} }, 0);
    b.publish({ type: "x", source: "plg-b", payload: {} }, 0);
    expect(b.poll("plg-a")).toMatchObject({ ok: true, value: [{ source: "plg-b" }] });
  });

  it("HK2.7 new subscribers start at head unless they ask to replay", () => {
    const b = bus();
    b.publish({ type: "x", source: "d", payload: {} }, 0);
    b.subscribe("late", { types: ["*"] });
    b.subscribe("replay", { types: ["*"] }, 0);
    expect(b.poll("late")).toEqual({ ok: true, value: [] });
    expect(b.poll("replay")).toMatchObject({ ok: true, value: [{ offset: 0 }] });
  });

  it("HK2.8 resubscribing changes the filter but keeps the cursor", () => {
    const b = bus();
    b.subscribe("p", { types: ["a"] }, 0);
    b.publish({ type: "a", source: "d", payload: {} }, 0);
    b.ack("p", 0);
    b.subscribe("p", { types: ["b"] });
    b.publish({ type: "b", source: "d", payload: {} }, 0);
    expect(b.cursor("p")).toBe(1);
    expect(b.poll("p")).toMatchObject({ ok: true, value: [{ type: "b" }] });
  });

  it("HK2.9 poll honours a limit", () => {
    const b = bus();
    b.subscribe("p", { types: ["*"] }, 0);
    for (let i = 0; i < 5; i++) b.publish({ type: "x", source: "d", payload: i }, 0);
    const r = b.poll("p", 2);
    expect(r.ok && r.value.map((e) => e.payload)).toEqual([0, 1]);
  });

  it("HK2.10 unknown plugins and unsubscribed plugins are reported", () => {
    const b = bus();
    expect(b.poll("nope")).toMatchObject({ ok: false, error: { code: "unknown_plugin" } });
    expect(b.ack("nope", 0)).toMatchObject({ ok: false, error: { code: "unknown_plugin" } });
    b.subscribe("p", { types: ["*"] });
    b.unsubscribe("p");
    expect(b.cursor("p")).toBeUndefined();
  });
});

describe("HookBus sagas and persistence", () => {
  it("HK3.1 the saga view shows the correlated chain and which plugins handled each step", () => {
    const b = bus();
    b.subscribe("tracker", { types: ["turn.*"] }, 0);
    b.subscribe("audit", { types: ["*"] }, 0);
    const root = b.publish({ type: "turn.completed", source: "daemon", payload: {} }, 0);
    if (!root.ok) throw new Error("unreachable");
    b.publish({ type: "noise", source: "daemon", payload: {} }, 0);
    const step = b.publish({ type: "tracker.synced", source: "tracker", payload: {}, cause: root.value.eventId }, 1);
    if (!step.ok) throw new Error("unreachable");
    b.ack("tracker", 0);
    b.ack("audit", 2);
    const saga = b.saga(root.value.correlationId);
    expect(saga.events.map((e) => e.type)).toEqual(["turn.completed", "tracker.synced"]);
    expect(saga.handledBy[root.value.eventId]).toEqual(["tracker", "audit"]);
    expect(saga.handledBy[step.value.eventId]).toEqual(["audit"]);
  });

  it("HK3.2 a plugin that crashes before acking resumes from its durable cursor", () => {
    const b = bus();
    b.subscribe("p", { types: ["*"] }, 0);
    for (let i = 0; i < 3; i++) b.publish({ type: "x", source: "d", payload: i }, i);
    b.ack("p", 0);
    const restored = HookBus.fromJSON(JSON.parse(JSON.stringify(b.toJSON())), { maxDepth: 3 });
    expect(restored.cursor("p")).toBe(1);
    const r = restored.poll("p");
    expect(r.ok && r.value.map((e) => e.payload)).toEqual([1, 2]);
    const next = restored.publish({ type: "x", source: "d", payload: 3 }, 9);
    expect(next.ok && next.value.offset).toBe(3);
  });

  it("HK3.3 fromJSON rejects malformed data", () => {
    expect(() => HookBus.fromJSON(null, { maxDepth: 1 })).toThrow(/invalid/);
    expect(() => HookBus.fromJSON({ events: [], plugins: 1 }, { maxDepth: 1 })).toThrow(/invalid/);
  });

  it("HK4.1 Deduper reports repeats within its window and forgets the oldest beyond it", () => {
    const d = new Deduper(2);
    expect(d.seen("a")).toBe(false);
    expect(d.seen("a")).toBe(true);
    expect(d.seen("b")).toBe(false);
    expect(d.seen("c")).toBe(false);
    expect(d.seen("b")).toBe(true);
    expect(d.seen("a")).toBe(false);
  });

  it("HK4.2 Deduper window must be positive", () => {
    expect(() => new Deduper(0)).toThrow(/window/);
  });
});
