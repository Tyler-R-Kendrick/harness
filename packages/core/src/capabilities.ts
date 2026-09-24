import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

/** Where a capability comes from. The same capability can arrive from any of these. */
export type Provenance = "platform" | "client" | "federated" | "plugin";
export type Trust = "trusted" | "untrusted";

export interface CapabilityOffer {
  readonly providerId: string;
  readonly name: string;
  /** Major version; offers only satisfy requests for the same major. */
  readonly version: number;
  readonly provenance: Provenance;
  readonly trust: Trust;
}

export interface Criteria {
  readonly version: number;
  readonly allow?: readonly Provenance[];
  readonly prefer?: readonly Provenance[];
  readonly trust?: "trusted";
}

export interface CapabilityLease {
  readonly leaseId: string;
  readonly holder: string;
  readonly providerId: string;
  readonly name: string;
  readonly epoch: number;
}

export type CapabilityEvent =
  | ({ readonly type: "capability.added"; readonly at: number } & Omit<CapabilityOffer, "trust">)
  | ({ readonly type: "capability.revoked"; readonly at: number; readonly leases: readonly string[] } & Omit<CapabilityOffer, "trust">);

export type CapabilityError = "duplicate_offer" | "unavailable";

const DEFAULT_PREFERENCE: readonly Provenance[] = ["platform", "client", "federated", "plugin"];

/**
 * Capabilities offered by the platform layer, connected clients, federated daemons and
 * plugins, which may appear and disappear at runtime. Holders use epoch-stamped leases;
 * withdrawing a provider revokes its leases so in-flight work can be fenced and re-resolved.
 */
export class CapabilityRegistry {
  #offers: CapabilityOffer[] = [];
  #leases = new Map<string, CapabilityLease>();
  #events: CapabilityEvent[] = [];
  #epoch = 0;
  #leaseSeq = 0;

  offer(offer: CapabilityOffer, at: number): Result<void, CapabilityError> {
    if (this.#offers.some((o) => o.providerId === offer.providerId && o.name === offer.name)) {
      return err("duplicate_offer", `${offer.providerId} already offers ${offer.name}`);
    }
    this.#offers.push({ ...offer });
    this.#events.push({ type: "capability.added", ...describe(offer), at });
    return ok(undefined);
  }

  /** Withdraw one or all of a provider's offers. Returns the leases that were revoked. */
  withdraw(providerId: string, at: number, name?: string): CapabilityLease[] {
    const gone = this.#offers.filter((o) => o.providerId === providerId && (name === undefined || o.name === name));
    this.#offers = this.#offers.filter((o) => !gone.includes(o));
    const revoked: CapabilityLease[] = [];
    for (const o of gone) {
      const leases = [...this.#leases.values()].filter((l) => l.providerId === providerId && l.name === o.name);
      for (const l of leases) this.#leases.delete(l.leaseId);
      revoked.push(...leases);
      this.#events.push({ type: "capability.revoked", ...describe(o), at, leases: leases.map((l) => l.leaseId) });
    }
    return revoked;
  }

  resolve(name: string, criteria: Criteria): CapabilityOffer | undefined {
    const order = criteria.prefer ?? DEFAULT_PREFERENCE;
    const rank = (p: Provenance) => (order.includes(p) ? order.indexOf(p) : order.length);
    const candidates = this.#offers.filter(
      (o) =>
        o.name === name &&
        o.version === criteria.version &&
        (criteria.allow === undefined || criteria.allow.includes(o.provenance)) &&
        (criteria.trust === undefined || o.trust === "trusted"),
    );
    // Stable sort keeps offer order among equal provenance.
    return candidates.sort((a, b) => rank(a.provenance) - rank(b.provenance))[0];
  }

  acquire(name: string, holder: string, criteria: Criteria): Result<CapabilityLease, CapabilityError> {
    const provider = this.resolve(name, criteria);
    if (!provider) return err("unavailable", `no provider offers ${name}@${criteria.version}`);
    const lease: CapabilityLease = { leaseId: `lease-${++this.#leaseSeq}`, holder, providerId: provider.providerId, name, epoch: ++this.#epoch };
    this.#leases.set(lease.leaseId, lease);
    return ok(lease);
  }

  release(leaseId: string): void {
    this.#leases.delete(leaseId);
  }

  validate(leaseId: string, epoch: number): boolean {
    return this.#leases.get(leaseId)?.epoch === epoch;
  }

  inventory(): CapabilityOffer[] {
    return this.#offers.map((o) => ({ ...o }));
  }

  /** Change events since the last drain, for publication on the hook bus. */
  drainEvents(): CapabilityEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }
}

function describe(o: CapabilityOffer): Omit<CapabilityOffer, "trust"> {
  return { providerId: o.providerId, name: o.name, version: o.version, provenance: o.provenance };
}
