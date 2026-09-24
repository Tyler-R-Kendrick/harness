import { describe, expect, it } from "vitest";
import { FlowController } from "@harness/core";

describe("FlowController", () => {
  it("MX2.1 subscribers receive entries while within capacity", () => {
    const flow = new FlowController(3);
    flow.subscribe("a", 0);
    expect(flow.route(0)).toEqual({ send: ["a"], resync: [] });
    expect(flow.route(1)).toEqual({ send: ["a"], resync: [] });
  });

  it("MX2.2 a subscriber that falls capacity behind switches to snapshot mode", () => {
    const flow = new FlowController(2);
    flow.subscribe("slow", 0);
    flow.route(0);
    flow.route(1);
    expect(flow.route(2)).toEqual({ send: [], resync: ["slow"] });
    expect(flow.route(3)).toEqual({ send: [], resync: [] });
    expect(flow.state("slow")).toMatchObject({ mode: "snapshot" });
  });

  it("MX2.3 a slow subscriber does not hold back a fast one", () => {
    const flow = new FlowController(2);
    flow.subscribe("slow", 0);
    flow.subscribe("fast", 0);
    for (let i = 0; i < 10; i++) {
      const r = flow.route(i);
      expect(r.send).toContain("fast");
      expect(flow.ack("fast", i + 1).ok).toBe(true);
    }
    expect(flow.state("slow")).toMatchObject({ mode: "snapshot" });
    expect(flow.state("fast")).toMatchObject({ mode: "stream", next: 10, acked: 10 });
  });

  it("MX2.4 acknowledging frees capacity", () => {
    const flow = new FlowController(1);
    flow.subscribe("a", 0);
    flow.route(0);
    flow.ack("a", 1);
    expect(flow.route(1)).toEqual({ send: ["a"], resync: [] });
  });

  it("MX2.5 resync returns a subscriber to streaming from the snapshot offset", () => {
    const flow = new FlowController(1);
    flow.subscribe("a", 0);
    flow.route(0);
    flow.route(1);
    expect(flow.resync("a", 2).ok).toBe(true);
    expect(flow.route(2)).toEqual({ send: ["a"], resync: [] });
  });

  it("MX2.6 acks beyond what was delivered are rejected; stale acks are ignored", () => {
    const flow = new FlowController(5);
    flow.subscribe("a", 0);
    flow.route(0);
    flow.route(1);
    expect(flow.ack("a", 3)).toMatchObject({ ok: false, error: { code: "invalid_ack" } });
    expect(flow.ack("a", 2).ok).toBe(true);
    expect(flow.ack("a", 1).ok).toBe(true);
    expect(flow.state("a")).toMatchObject({ acked: 2 });
  });

  it("MX2.7 subscribing mid-stream skips entries before the start offset", () => {
    const flow = new FlowController(5);
    flow.subscribe("late", 3);
    expect(flow.route(2)).toEqual({ send: [], resync: [] });
    expect(flow.route(3)).toEqual({ send: ["late"], resync: [] });
  });

  it("MX2.8 a gap in routed offsets forces a resync rather than silently skipping", () => {
    const flow = new FlowController(5);
    flow.subscribe("a", 0);
    flow.route(0);
    expect(flow.route(2)).toEqual({ send: [], resync: ["a"] });
  });

  it("MX2.9 unknown subscribers are reported and unsubscribe removes", () => {
    const flow = new FlowController(5);
    expect(flow.ack("x", 0)).toMatchObject({ ok: false, error: { code: "unknown_subscriber" } });
    expect(flow.resync("x", 0)).toMatchObject({ ok: false, error: { code: "unknown_subscriber" } });
    flow.subscribe("a", 0);
    flow.unsubscribe("a");
    expect(flow.route(0)).toEqual({ send: [], resync: [] });
    expect(flow.state("a")).toBeUndefined();
  });

  it("MX2.10 capacity must be a positive integer", () => {
    expect(() => new FlowController(0)).toThrow(/capacity/);
    expect(() => new FlowController(1.5)).toThrow(/capacity/);
  });
});
