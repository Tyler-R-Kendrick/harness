import { describe, expect, it } from "vitest";
import { ManualClock, MemoryStorage, SeededEntropy } from "@harness/testkit";
import { bytesToHex } from "@noble/hashes/utils.js";
import { GraphIdSchema, importGraph, latestOn, overlayAt, overlayBases, pinSession, readOverlay, revertGraph, SALT_BYTES, SnapshotProceduralStore } from "@harness/procedural";
import type { PinRequest } from "@harness/procedural";
import { commit, FakeStore, GRAPH, observe, rebase, revision, turn } from "./pin-store.ts";
import { hotpot } from "./fixtures.ts";

/** Counts what it hands out. */
class CountingEntropy extends SeededEntropy {
  draws: number[] = [];
  override bytes(length: number): Uint8Array {
    this.draws.push(length);
    return super.bytes(length);
  }
}

async function world() {
  const store = new FakeStore();
  const seed = revision(0, [], "seed");
  await commit(store, seed);
  const clock = new ManualClock(1_000);
  const entropy = new CountingEntropy(7);
  const pin = (over: Partial<PinRequest> = {}) => pinSession({ store, session: "s1", graph: GRAPH, entropy, clock, repinOnDream: "turn", ...over });
  return { store, seed, clock, entropy, pin };
}

describe("pinning a session (plan §5.1)", () => {
  it("PX1.30 a first pin takes the head core, the overlay's latest version on it, a salt from Entropy and the time from the Clock", async () => {
    const { store, seed, pin } = await world();
    await observe(store, 3);
    const pinned = await pin();
    expect(pinned).toEqual({ graph: GRAPH, core: seed.id, overlay: 3, salt: bytesToHex(new SeededEntropy(7).bytes(SALT_BYTES)), at: 1_000 });
    expect(SALT_BYTES).toBe(16);
    expect(await store.pins.get("s1")).toEqual(pinned);
  });

  it("PX1.31 pinning again with nothing changed gives the stored pin without drawing or writing", async () => {
    const { store, entropy, clock, pin } = await world();
    const first = await pin();
    clock.advance(5);
    expect(await pin()).toBe(await store.pins.get("s1"));
    expect(await pin()).toEqual(first);
    expect(entropy.draws).toEqual([SALT_BYTES]);
    expect(store.pinWrites).toBe(1);
  });

  it("PX1.32 a pin survives a store reopen", async () => {
    const { store, entropy, clock, pin } = await world();
    const first = await pin();
    const reopened = store.reopen();
    clock.advance(10);
    const again = await pinSession({ store: reopened, session: "s1", graph: GRAPH, entropy, clock, repinOnDream: "turn" });
    expect(again).toEqual(first);
    expect(entropy.draws).toEqual([SALT_BYTES]);
    expect(reopened.pinWrites).toBe(0);
  });

  it("PX1.33 overlayRefresh 'turn' (the default) moves the pin to the overlay's latest version on its core; 'session' keeps it", async () => {
    const { store, clock, pin } = await world();
    const first = await pin();
    expect(first.overlay).toBe(0);
    await observe(store, 2);
    clock.advance(5);
    expect(await pin({ overlayRefresh: "session" })).toEqual(first);
    const refreshed = await pin();
    expect(refreshed).toEqual({ ...first, overlay: 2, at: 1_005 });
    await observe(store, 1);
    expect((await pin({ overlayRefresh: "turn" })).overlay).toBe(3);
  });

  it("PX1.34 a dream that moves the head re-pins at the next turn under repinOnDream 'turn', to the new head and its rebased overlay, keeping the salt", async () => {
    const { store, seed, clock, pin } = await world();
    await observe(store, 2);
    const first = await pin();
    const next = revision(1, [seed.id]);
    await commit(store, next);
    await rebase(store, next.id);
    await observe(store, 1);
    clock.advance(7);
    expect(await pin()).toEqual({ ...first, core: next.id, overlay: 4, at: 1_007 });
  });

  it("PX1.35 under repinOnDream 'never' a session keeps its core, with the overlay frozen where the rebase recorded", async () => {
    const { store, seed, pin } = await world();
    await observe(store, 2);
    const first = await pin({ repinOnDream: "never" });
    const next = revision(1, [seed.id]);
    await commit(store, next);
    await observe(store, 1);
    // The rebase has not landed: the old core's overlay is still growing.
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: seed.id, overlay: 3 });
    const frozenAt = await rebase(store, next.id);
    await observe(store, 2);
    expect(frozenAt).toBe(3);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: seed.id, overlay: frozenAt, salt: first.salt });
    // Another dream further on still descends from the pinned core.
    const later = revision(2, [next.id]);
    await commit(store, later);
    await rebase(store, later.id);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: seed.id, overlay: 3 });
    expect(await pin({ repinOnDream: "never", overlayRefresh: "session" })).toMatchObject({ core: seed.id, overlay: 3 });
  });

  it("PX1.36 a reverted core is re-pinned at the next turn, even under repinOnDream 'never'", async () => {
    const { store, seed, pin } = await world();
    const next = revision(1, [seed.id]);
    await commit(store, next);
    await rebase(store, next.id);
    await observe(store, 2);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: next.id, overlay: 3 });
    // Revert: the head moves back to the seed, whose overlay was frozen at version 0.
    await commit(store, seed);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: seed.id, overlay: 0 });
    await rebase(store, seed.id);
    await observe(store, 1);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: seed.id, overlay: 5 });
  });

  it("PX1.37 a head whose record is a revert, or does not descend from the pinned core, re-pins under 'never'", async () => {
    const { store, seed, pin } = await world();
    const next = revision(1, [seed.id]);
    await commit(store, next);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: next.id });
    const reverted = revision(2, [next.id], "revert");
    await commit(store, reverted);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: reverted.id });
    const imported = revision(3, [], "import");
    await commit(store, imported);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: imported.id });
    // A head whose record is missing cannot be shown to descend from the pin.
    const orphan = revision(4, [imported.id]);
    await store.heads.set(GRAPH, imported.id, orphan.id);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: orphan.id });
    // A merge descends from each of its parents; ancestry is followed through several generations.
    await store.revisions.put(orphan);
    const side = revision(5, [], "import");
    await store.revisions.put(side);
    const merge = revision(6, [side.id, revision(7, [orphan.id]).id], "merge");
    await store.revisions.put(revision(7, [orphan.id]));
    await commit(store, merge);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: orphan.id });
  });

  it("PX1.43 ancestry stops at a missing record and survives a cycle of parents", async () => {
    const { store, pin } = await world();
    const pinned = revision(10);
    await commit(store, pinned);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: pinned.id });
    const gap = revision(11, [revision(12, [pinned.id]).id]);
    await commit(store, gap);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: gap.id });
    const [a, b] = [revision(13, [revision(14).id]), revision(14, [revision(13).id])];
    await store.revisions.put(a);
    await store.revisions.put(b);
    const looped = revision(15, [a.id]);
    await commit(store, looped);
    expect(await pin({ repinOnDream: "never" })).toMatchObject({ core: looped.id });
  });

  it("PX1.44 a session moved to another graph with the same core document is pinned to that graph", async () => {
    const { store, seed, pin } = await world();
    await pin();
    const other = GraphIdSchema.parse("other");
    await commit(store, revision(0, [], "seed", other));
    expect(await pin({ graph: other })).toMatchObject({ graph: other, core: seed.id });
    expect((await store.pins.get("s1"))?.graph).toBe(other);
  });

  it("PX1.38 while a new head's rebase is pending, a session pins it with the empty overlay, never the old core's overlay", async () => {
    const { store, seed, pin } = await world();
    await observe(store, 2);
    await pin();
    const next = revision(1, [seed.id]);
    await commit(store, next);
    expect(await pin()).toMatchObject({ core: next.id, overlay: 0 });
    expect(await pinSession({ store, session: "fresh", graph: GRAPH, entropy: new SeededEntropy(1), clock: new ManualClock(), repinOnDream: "turn" })).toMatchObject({ core: next.id, overlay: 0 });
    await rebase(store, next.id);
    expect(await pin()).toMatchObject({ core: next.id, overlay: 3 });
  });

  it("PX1.39 a session resolved to another graph is pinned afresh there, keeping its salt", async () => {
    const { store, entropy, pin } = await world();
    const first = await pin();
    const other = GraphIdSchema.parse("other");
    const root = revision(9, [], "seed", other);
    await commit(store, root);
    await observe(store, 1, other);
    expect(await pin({ graph: other })).toEqual({ graph: other, core: root.id, overlay: 1, salt: first.salt, at: 1_000 });
    expect(entropy.draws).toEqual([SALT_BYTES]);
  });

  it("PX1.40 a graph without a head cannot be pinned", async () => {
    const { pin } = await world();
    await expect(pin({ graph: GraphIdSchema.parse("none") })).rejects.toThrow(new RangeError("graph none has no head to pin"));
  });

  it("PX1.41 readOverlay folds the log to exactly the pinned version, on the pinned core", async () => {
    const { store, seed, pin } = await world();
    await observe(store, 2);
    const pinned = await pin({ overlayRefresh: "session" });
    await observe(store, 3);
    const state = await readOverlay(store, pinned);
    expect(state).toMatchObject({ base: seed.id, version: 2, turns: ["s/0", "s/1"] });
    // An event ignored by the fold (a repeated turn) does not count toward the version.
    await store.overlay(GRAPH).append([turn("s/0")]);
    expect((await readOverlay(store, { ...pinned, overlay: 5 })).turns).toEqual(["s/0", "s/1", "s/2", "s/3", "s/4"]);
    expect(overlayAt(seed.id, [turn("a/1"), turn("a/1"), turn("a/2")], 2).turns).toEqual(["a/1", "a/2"]);
    expect(overlayAt(seed.id, [turn("a/1")], 0).version).toBe(0);
  });

  it("PX1.42 overlayBases names the core each overlay version is built on, and latestOn the last version on a core", async () => {
    const [a, b] = [revision(0).id, revision(1).id];
    const rebased = (core: string, frozenAt: number) => ({ kind: "rebased" as const, core: revision(core === "a" ? 0 : 1).id, absorbed: [], dropped: [], frozenAt });
    const events = [turn("s/1"), turn("s/1"), turn("s/2"), rebased("b", 2), turn("s/3"), rebased("a", 4)];
    const bases = overlayBases(a, events);
    expect(bases).toEqual([a, a, a, b, b, a]);
    expect(latestOn(bases, a)).toBe(5);
    expect(latestOn(bases, b)).toBe(4);
    expect(latestOn(bases, revision(2).id)).toBe(0);
    expect(latestOn([a], a)).toBe(0);
  });

  it("PX1.45 on the snapshot store, a pin survives a reopen, and the extension's revert re-pins even under 'never'", async () => {
    const storage = new MemoryStorage();
    const clock = new ManualClock(50);
    const entropy = new CountingEntropy(5);
    const imported = await importGraph({ store: new SnapshotProceduralStore(storage), graph: GRAPH, document: hotpot(), clock });
    if (imported.status !== "head") throw new Error("import");
    const store = new SnapshotProceduralStore(storage);
    await observe(store, 1);
    const dreamt = revision(1, [imported.revision]);
    await commit(store, dreamt);
    await rebase(store, dreamt.id);
    const request = { session: "s1", graph: GRAPH, entropy, clock, repinOnDream: "never" } as const;
    const first = await pinSession({ store, ...request });
    expect(first).toMatchObject({ core: dreamt.id, overlay: 2, at: 50 });
    const reopened = new SnapshotProceduralStore(storage);
    clock.advance(1);
    expect(await pinSession({ store: reopened, ...request })).toEqual(first);
    expect(entropy.draws).toEqual([SALT_BYTES]);
    expect(await revertGraph({ store: reopened, graph: GRAPH, clock })).toMatchObject({ status: "reverted", to: imported.revision });
    expect(await pinSession({ store: reopened, ...request })).toEqual({ ...first, core: imported.revision, overlay: 3, at: 51 });
  });
});
