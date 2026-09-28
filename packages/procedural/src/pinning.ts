/**
 * Session pinning (plan §5.1). A session reads one version pair, a core revision and an
 * overlay version (I3), recorded as its `Pin` in the store so it survives restarts. At
 * each turn boundary `pinSession` decides the pair for the turn:
 *
 * - A first pin takes the graph's head, and the overlay's latest version on that core.
 * - A pinned core that was reverted (the head no longer descends from it) is re-pinned.
 * - When a dream moves the head, `repinOnDream: "turn"` re-pins to the new head; `"never"`
 *   keeps the old core, whose overlay then stops at the version the `rebased` event
 *   recorded as `frozenAt`.
 * - With the core kept, `overlayRefresh: "turn"` moves to the overlay's latest version on
 *   that core, and `"session"` keeps the pinned version.
 *
 * A session never pairs a core with an overlay version built on a different core. Version
 * 0 is the empty overlay, which holds nothing, so it pairs with any core: a head whose
 * rebase has not landed yet is pinned with it.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import type { GraphId, RevisionId } from "./graph.ts";
import type { OverlayEvent, OverlayState } from "./overlay-types.ts";
import { emptyOverlay, foldOverlay } from "./overlay.ts";
import type { Pin, ProceduralStore } from "./store.ts";

/** Bytes of entropy in a session's salt. */
export const SALT_BYTES = 16;

export interface PinRequest {
  readonly store: ProceduralStore;
  readonly session: string;
  /** The graph the session resolves to now. */
  readonly graph: GraphId;
  /** Draws the session's salt, once. */
  readonly entropy: { bytes(length: number): Uint8Array };
  /** Stamps a pin when it changes. */
  readonly clock: { now(): number };
  readonly repinOnDream: "turn" | "never";
  /** Defaults to `"turn"`. */
  readonly overlayRefresh?: "turn" | "session";
}

/**
 * The core each overlay version is built on, indexed by version: `initial` for version 0
 * and for every version before the first `rebased` event, then each rebase's core.
 */
export function overlayBases(initial: RevisionId, events: readonly OverlayEvent[]): RevisionId[] {
  const bases = [initial];
  let state = emptyOverlay(initial);
  for (const event of events) {
    const next = foldOverlay(state, event);
    if (next.version !== state.version) bases.push(next.base);
    state = next;
  }
  return bases;
}

/** The last overlay version built on `core`, or 0 (the empty overlay) when there is none. */
export const latestOn = (bases: readonly RevisionId[], core: RevisionId): number => Math.max(bases.lastIndexOf(core), 0);

/** The overlay state at `version`: the log folded from the empty overlay on `core` until it reaches that version. */
export function overlayAt(core: RevisionId, events: readonly OverlayEvent[], version: number): OverlayState {
  let state = emptyOverlay(core);
  for (const event of events) {
    if (state.version >= version) break;
    state = foldOverlay(state, event);
  }
  return state;
}

/** The overlay a pin reads: its graph's log at its version, on its core. */
export async function readOverlay(store: ProceduralStore, pin: Pin): Promise<OverlayState> {
  const events = (await store.overlay(pin.graph).read(0)).map((e) => e.event);
  return overlayAt(pin.core, events, pin.overlay);
}

/** Whether `ancestor` is reachable from `id` through the graph's revision parents. */
async function descends(store: ProceduralStore, graph: GraphId, id: RevisionId, ancestor: RevisionId): Promise<boolean> {
  const seen = new Set<string>();
  const queue = [id];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const record = await store.revisions.get(graph, next);
    if (record === undefined) continue;
    for (const parent of record.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** Whether the head moved on from `pinned` by dream or merge, rather than reverting it (or replacing it by an import). */
async function movedOn(store: ProceduralStore, graph: GraphId, pinned: RevisionId, head: RevisionId): Promise<boolean> {
  const record = await store.revisions.get(graph, head);
  return record !== undefined && record.origin !== "revert" && (await descends(store, graph, head, pinned));
}

/** Pin the session for this turn (see the module comment), storing the pin when it changes. */
export async function pinSession(request: PinRequest): Promise<Pin> {
  const { store, session, graph } = request;
  const head = await store.heads.get(graph);
  if (head === undefined) throw new RangeError(`graph ${graph} has no head to pin`);
  const events = (await store.overlay(graph).read(0)).map((e) => e.event);
  // The overlay log starts on the graph's first head, the oldest in its history.
  const bases = overlayBases(head.history.at(-1) ?? head.revision, events);
  const old = await store.pins.get(session);
  const same = old !== undefined && old.graph === graph;
  const keep = same && (old.core === head.revision || (request.repinOnDream === "never" && (await movedOn(store, graph, old.core, head.revision))));
  const core = keep ? old.core : head.revision;
  const overlay = keep && request.overlayRefresh === "session" ? old.overlay : latestOn(bases, core);
  if (same && old.core === core && old.overlay === overlay) return old;
  const pin: Pin = { graph, core, overlay, salt: old?.salt ?? bytesToHex(request.entropy.bytes(SALT_BYTES)), at: request.clock.now() };
  await store.pins.set(session, pin);
  return pin;
}
