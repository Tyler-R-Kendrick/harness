import { describe, expect, it } from "vitest";
import { InputLease } from "@harness/core";

describe("InputLease", () => {
  it("MX7.1 a free lease is granted with a fresh epoch", () => {
    const lease = new InputLease();
    expect(lease.acquire("a", "agent", 0, 100)).toEqual({ ok: true, value: { holder: "a", epoch: 1, expiresAt: 100 } });
  });

  it("MX7.2 the holder renews without changing the epoch", () => {
    const lease = new InputLease();
    lease.acquire("a", "agent", 0, 100);
    expect(lease.acquire("a", "agent", 50, 100)).toEqual({ ok: true, value: { holder: "a", epoch: 1, expiresAt: 150 } });
  });

  it("MX7.3 another agent cannot take a live lease", () => {
    const lease = new InputLease();
    lease.acquire("a", "agent", 0, 100);
    expect(lease.acquire("b", "agent", 10, 100)).toMatchObject({ ok: false, error: { code: "held_by_other" } });
  });

  it("MX7.4 an expired lease can be taken and the epoch advances", () => {
    const lease = new InputLease();
    lease.acquire("a", "agent", 0, 100);
    expect(lease.acquire("b", "agent", 100, 100)).toEqual({ ok: true, value: { holder: "b", epoch: 2, expiresAt: 200 } });
  });

  it("MX7.5 a human preempts an agent and the agent is fenced out", () => {
    const lease = new InputLease();
    lease.acquire("bot", "agent", 0, 100);
    expect(lease.acquire("alice", "human", 10, 100)).toEqual({ ok: true, value: { holder: "alice", epoch: 2, expiresAt: 110 } });
    expect(lease.check("bot", 1, 20)).toBe(false);
    expect(lease.check("alice", 2, 20)).toBe(true);
  });

  it("MX7.6 an agent cannot preempt a human", () => {
    const lease = new InputLease();
    lease.acquire("alice", "human", 0, 100);
    expect(lease.acquire("bot", "agent", 10, 100)).toMatchObject({ ok: false, error: { code: "held_by_other" } });
  });

  it("MX7.7 a human cannot preempt another human; the holder must transfer", () => {
    const lease = new InputLease();
    lease.acquire("alice", "human", 0, 100);
    expect(lease.acquire("bob", "human", 10, 100)).toMatchObject({ ok: false, error: { code: "held_by_other" } });
    expect(lease.transfer("alice", "bob", "human", 20, 100)).toEqual({ ok: true, value: { holder: "bob", epoch: 2, expiresAt: 120 } });
    expect(lease.check("alice", 1, 21)).toBe(false);
  });

  it("MX7.8 only the current holder can transfer or release", () => {
    const lease = new InputLease();
    lease.acquire("alice", "human", 0, 100);
    expect(lease.transfer("bob", "carol", "human", 1, 100)).toMatchObject({ ok: false, error: { code: "not_holder" } });
    expect(lease.release("bob", 1)).toMatchObject({ ok: false, error: { code: "not_holder" } });
    expect(lease.release("alice", 2).ok).toBe(true);
    expect(lease.holder(2)).toBeUndefined();
  });

  it("MX7.9 check requires the current holder, epoch and an unexpired lease", () => {
    const lease = new InputLease();
    lease.acquire("a", "agent", 0, 100);
    expect(lease.check("a", 1, 99)).toBe(true);
    expect(lease.check("a", 2, 99)).toBe(false);
    expect(lease.check("b", 1, 99)).toBe(false);
    expect(lease.check("a", 1, 100)).toBe(false);
  });

  it("MX7.10 releasing then reacquiring advances the epoch", () => {
    const lease = new InputLease();
    lease.acquire("a", "agent", 0, 100);
    lease.release("a", 1);
    expect(lease.acquire("a", "agent", 2, 100)).toMatchObject({ ok: true, value: { epoch: 2 } });
  });

  it("MX7.11 holder() reports only a live lease", () => {
    const lease = new InputLease();
    expect(lease.holder(0)).toBeUndefined();
    lease.acquire("a", "human", 0, 100);
    expect(lease.holder(50)).toEqual({ holder: "a", priority: "human", epoch: 1, expiresAt: 100 });
    expect(lease.holder(100)).toBeUndefined();
  });

  it("MX7.12 transferring an expired lease is rejected", () => {
    const lease = new InputLease();
    lease.acquire("alice", "human", 0, 100);
    expect(lease.transfer("alice", "bob", "human", 100, 100)).toMatchObject({ ok: false, error: { code: "not_holder" } });
  });

  it("MX7.13 ttl must be positive", () => {
    const lease = new InputLease();
    expect(() => lease.acquire("a", "agent", 0, 0)).toThrow(/ttl/);
  });
});
