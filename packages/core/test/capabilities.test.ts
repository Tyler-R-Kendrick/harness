import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "@harness/core";
import type { CapabilityOffer } from "@harness/core";

const offer = (over: Partial<CapabilityOffer> = {}): CapabilityOffer => ({
  providerId: "native",
  name: "process.spawn",
  version: 1,
  provenance: "platform",
  trust: "trusted",
  ...over,
});

describe("CapabilityRegistry", () => {
  it("CAP1.1 an offered capability resolves and emits an added event", () => {
    const r = new CapabilityRegistry();
    expect(r.offer(offer(), 0).ok).toBe(true);
    expect(r.resolve("process.spawn", { version: 1 })?.providerId).toBe("native");
    expect(r.drainEvents()).toEqual([{ type: "capability.added", providerId: "native", name: "process.spawn", version: 1, provenance: "platform", at: 0 }]);
    expect(r.drainEvents()).toEqual([]);
  });

  it("CAP1.2 the same provider cannot offer the same capability twice", () => {
    const r = new CapabilityRegistry();
    r.offer(offer(), 0);
    expect(r.offer(offer(), 1)).toMatchObject({ ok: false, error: { code: "duplicate_offer" } });
  });

  it("CAP1.3 resolution requires the same major version", () => {
    const r = new CapabilityRegistry();
    r.offer(offer({ version: 2 }), 0);
    expect(r.resolve("process.spawn", { version: 1 })).toBeUndefined();
    expect(r.resolve("process.spawn", { version: 2 })).toBeDefined();
  });

  it("CAP1.4 platform providers are preferred, then clients, then federated daemons, then plugins", () => {
    const r = new CapabilityRegistry();
    r.offer(offer({ providerId: "plug", provenance: "plugin" }), 0);
    r.offer(offer({ providerId: "peer", provenance: "federated" }), 0);
    r.offer(offer({ providerId: "ext", provenance: "client" }), 0);
    expect(r.resolve("process.spawn", { version: 1 })?.providerId).toBe("ext");
    r.offer(offer({ providerId: "native", provenance: "platform" }), 0);
    expect(r.resolve("process.spawn", { version: 1 })?.providerId).toBe("native");
  });

  it("CAP1.5 policy can restrict provenance and require trusted providers", () => {
    const r = new CapabilityRegistry();
    r.offer(offer({ providerId: "ext", provenance: "client", trust: "untrusted" }), 0);
    r.offer(offer({ providerId: "peer", provenance: "federated", trust: "trusted" }), 0);
    expect(r.resolve("process.spawn", { version: 1, trust: "trusted" })?.providerId).toBe("peer");
    expect(r.resolve("process.spawn", { version: 1, allow: ["client"] })?.providerId).toBe("ext");
    expect(r.resolve("process.spawn", { version: 1, allow: ["platform"] })).toBeUndefined();
  });

  it("CAP1.6 a custom preference order overrides the default", () => {
    const r = new CapabilityRegistry();
    r.offer(offer({ providerId: "native", provenance: "platform" }), 0);
    r.offer(offer({ providerId: "peer", provenance: "federated" }), 0);
    expect(r.resolve("process.spawn", { version: 1, prefer: ["federated", "platform"] })?.providerId).toBe("peer");
  });

  it("CAP1.7 among equal provenance the earliest offer wins", () => {
    const r = new CapabilityRegistry();
    r.offer(offer({ providerId: "a", provenance: "client" }), 0);
    r.offer(offer({ providerId: "b", provenance: "client" }), 1);
    expect(r.resolve("process.spawn", { version: 1 })?.providerId).toBe("a");
  });

  it("CAP2.1 a lease binds a holder to a provider with an epoch", () => {
    const r = new CapabilityRegistry();
    r.offer(offer(), 0);
    const lease = r.acquire("process.spawn", "worker-1", { version: 1 });
    expect(lease).toMatchObject({ ok: true, value: { holder: "worker-1", providerId: "native", name: "process.spawn", epoch: 1 } });
    if (!lease.ok) throw new Error("unreachable");
    expect(r.validate(lease.value.leaseId, lease.value.epoch)).toBe(true);
    expect(r.validate(lease.value.leaseId, 99)).toBe(false);
    expect(r.validate("nope", 1)).toBe(false);
  });

  it("CAP2.2 acquiring an unavailable capability reports unavailable", () => {
    const r = new CapabilityRegistry();
    expect(r.acquire("browser.tabs", "w", { version: 1 })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("CAP2.3 withdrawing a provider revokes its leases and emits revoked events", () => {
    const r = new CapabilityRegistry();
    r.offer(offer(), 0);
    r.offer(offer({ name: "pty" }), 0);
    const a = r.acquire("process.spawn", "w1", { version: 1 });
    const b = r.acquire("pty", "w2", { version: 1 });
    r.drainEvents();
    if (!a.ok || !b.ok) throw new Error("unreachable");
    const revoked = r.withdraw("native", 5);
    expect(revoked.map((l) => l.leaseId).sort()).toEqual([a.value.leaseId, b.value.leaseId].sort());
    expect(r.validate(a.value.leaseId, a.value.epoch)).toBe(false);
    expect(r.resolve("process.spawn", { version: 1 })).toBeUndefined();
    expect(r.drainEvents()).toEqual([
      { type: "capability.revoked", providerId: "native", name: "process.spawn", version: 1, provenance: "platform", at: 5, leases: [a.value.leaseId] },
      { type: "capability.revoked", providerId: "native", name: "pty", version: 1, provenance: "platform", at: 5, leases: [b.value.leaseId] },
    ]);
  });

  it("CAP2.4 withdrawing a single capability leaves the provider's other offers", () => {
    const r = new CapabilityRegistry();
    r.offer(offer(), 0);
    r.offer(offer({ name: "pty" }), 0);
    r.withdraw("native", 1, "pty");
    expect(r.resolve("pty", { version: 1 })).toBeUndefined();
    expect(r.resolve("process.spawn", { version: 1 })).toBeDefined();
  });

  it("CAP2.5 after revocation the holder can re-resolve to another provider with a new epoch", () => {
    const r = new CapabilityRegistry();
    r.offer(offer({ providerId: "ext", name: "browser.tabs", provenance: "client" }), 0);
    r.offer(offer({ providerId: "peer", name: "browser.tabs", provenance: "federated" }), 0);
    const first = r.acquire("browser.tabs", "w", { version: 1 });
    if (!first.ok) throw new Error("unreachable");
    r.withdraw("ext", 1);
    const second = r.acquire("browser.tabs", "w", { version: 1 });
    expect(second).toMatchObject({ ok: true, value: { providerId: "peer" } });
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.epoch).toBeGreaterThan(first.value.epoch);
  });

  it("CAP2.6 releasing a lease invalidates it", () => {
    const r = new CapabilityRegistry();
    r.offer(offer(), 0);
    const lease = r.acquire("process.spawn", "w", { version: 1 });
    if (!lease.ok) throw new Error("unreachable");
    r.release(lease.value.leaseId);
    expect(r.validate(lease.value.leaseId, lease.value.epoch)).toBe(false);
    expect(r.withdraw("native", 1)).toEqual([]);
  });

  it("CAP2.7 withdrawing an unknown provider is a no-op", () => {
    const r = new CapabilityRegistry();
    expect(r.withdraw("nobody", 0)).toEqual([]);
    expect(r.drainEvents()).toEqual([]);
  });

  it("CAP3.1 inventory lists current offers for capability negotiation", () => {
    const r = new CapabilityRegistry();
    r.offer(offer(), 0);
    r.offer(offer({ providerId: "ext", name: "browser.tabs", provenance: "client", trust: "untrusted" }), 0);
    expect(r.inventory()).toEqual([
      { providerId: "native", name: "process.spawn", version: 1, provenance: "platform", trust: "trusted" },
      { providerId: "ext", name: "browser.tabs", version: 1, provenance: "client", trust: "untrusted" },
    ]);
  });
});
