import { describe, expect, it } from "vitest";
import { MemoryProceduralStore, ProceduralStoreDocumentSchema, SnapshotProceduralStore, STORE_FORMAT } from "@harness/procedural";
import { graphA, ProbeStorage, record } from "./store-fixtures.ts";

describe("SnapshotProceduralStore", () => {
  it("PS1.28 nothing is loaded until the first operation, and the storage is loaded once", async () => {
    const storage = new ProbeStorage();
    const store = new SnapshotProceduralStore(storage);
    expect(storage.loads).toBe(0);
    await store.heads.get(graphA);
    await store.revisions.list(graphA);
    expect(storage.loads).toBe(1);
  });

  it("PS1.58 graphs are read from the saved store in issue order, and reading them saves nothing", async () => {
    const storage = new ProbeStorage();
    const store = new SnapshotProceduralStore(storage);
    const r = record([]);
    await store.revisions.put(r);
    const listed = store.graphs();
    await store.heads.set(graphA, undefined, r.id);
    expect(await listed).toEqual([]);
    const saves = storage.saves;
    expect(await store.graphs()).toEqual([graphA]);
    expect(storage.saves).toBe(saves);
    expect(await new SnapshotProceduralStore(storage).graphs()).toEqual([graphA]);
  });

  it("PS1.59 a guidance text already kept under its id (every cached step puts it again) saves nothing; another text under it saves", async () => {
    const storage = new ProbeStorage();
    const store = new SnapshotProceduralStore(storage);
    await expect(store.guidance.put("g", "text")).resolves.toBeUndefined();
    expect(storage.saves).toBe(1);
    await expect(store.guidance.put("g", "text")).resolves.toBeUndefined();
    expect(storage.saves).toBe(1);
    await store.guidance.put("g", "other");
    expect(storage.saves).toBe(2);
    expect(await store.guidance.get("g")).toBe("other");
  });

  it("PS1.29 every change saves the whole document; reads and operations that change nothing save nothing", async () => {
    const storage = new ProbeStorage();
    const store = new SnapshotProceduralStore(storage);
    const r = record([]);
    const saves = async (op: () => Promise<unknown>): Promise<number> => {
      const before = storage.saves;
      await op();
      return storage.saves - before;
    };
    expect(await saves(() => store.revisions.put(r))).toBe(1);
    expect(await saves(() => store.revisions.get(graphA, r.id))).toBe(0);
    expect(await saves(() => store.revisions.list(graphA))).toBe(0);
    expect(await saves(() => store.heads.set(graphA, r.id, r.id))).toBe(0);
    expect(await saves(() => store.heads.set(graphA, undefined, r.id))).toBe(1);
    expect(await saves(() => store.heads.get(graphA))).toBe(0);
    expect(await saves(() => store.overlay(graphA).append([]))).toBe(0);
    expect(await saves(() => store.dreams(graphA).append([{ n: 1 }]))).toBe(1);
    expect(await saves(() => store.dreams(graphA).read(0))).toBe(0);
    expect(await saves(() => store.dreams(graphA).head())).toBe(0);
    expect(await saves(() => store.pins.set("s", { graph: graphA, core: r.id, overlay: 0, salt: "x", at: 0 }))).toBe(1);
    expect(await saves(() => store.pins.get("s"))).toBe(0);
    expect(await saves(() => store.guidance.put("g", "text"))).toBe(1);
    expect(await saves(() => store.guidance.get("g"))).toBe(0);
    expect(await saves(() => store.lease.acquire(graphA, "h1"))).toBe(1);
    expect(await saves(() => store.lease.acquire(graphA, "h2"))).toBe(0);
    expect(await saves(() => store.lease.renew(graphA, "h1", 1))).toBe(0);
    expect(await saves(() => store.lease.release(graphA, "h1", 9))).toBe(0);
    expect(await saves(() => store.lease.release(graphA, "h1", 1))).toBe(1);
    expect(await saves(() => store.redact(r.id))).toBe(1);
    const saved = ProceduralStoreDocumentSchema.parse(await storage.inner.load());
    expect(saved.format).toBe(STORE_FORMAT);
    expect(saved).toEqual(JSON.parse(JSON.stringify(saved)));
    expect(saved.revisions.map((x) => x.redacted)).toEqual([true]);
    expect(saved.leases).toEqual([{ graph: graphA, holder: null, epoch: 1 }]);
  });

  it("PS1.30 a failed save rejects its operation, and the next operation sees what was last saved", async () => {
    const storage = new ProbeStorage();
    const store = new SnapshotProceduralStore(storage);
    const [r0, r1] = [record([]), record(["Plan"])];
    await store.heads.set(graphA, undefined, r0.id);
    storage.failSaves = 1;
    await expect(store.heads.set(graphA, r0.id, r1.id)).rejects.toThrow("save failed");
    expect(await store.heads.get(graphA)).toEqual({ revision: r0.id, history: [] });
    expect(await store.heads.set(graphA, r0.id, r1.id)).toBe(true);
    expect(await new SnapshotProceduralStore(storage.inner.reopen()).heads.get(graphA)).toEqual({ revision: r1.id, history: [r0.id] });
  });

  it("PS1.31 a failed load rejects its operation, and the next operation loads again", async () => {
    const storage = new ProbeStorage();
    await new SnapshotProceduralStore(storage).guidance.put("g", "kept");
    storage.failLoads = 1;
    const store = new SnapshotProceduralStore(storage);
    await expect(store.guidance.get("g")).rejects.toThrow("load failed");
    expect(await store.guidance.get("g")).toBe("kept");
  });

  it("PS1.32 a malformed saved store rejects every operation and is never overwritten", async () => {
    const storage = new ProbeStorage();
    await storage.inner.save({ format: "something/else" });
    const store = new SnapshotProceduralStore(storage);
    await expect(store.guidance.put("g", "text")).rejects.toThrow(/the saved procedural store is malformed/);
    await expect(store.guidance.get("g")).rejects.toThrow(/malformed/);
    expect(storage.saves).toBe(0);
    expect(await storage.inner.load()).toEqual({ format: "something/else" });
  });

  it("PS1.33 a saved revision whose id is not its document's is malformed", async () => {
    const storage = new ProbeStorage();
    const r = record([]);
    const other = record(["Plan"]);
    await storage.inner.save({ ...new MemoryProceduralStore().document(), revisions: [{ ...r, id: other.id }] });
    await expect(new SnapshotProceduralStore(storage).revisions.get(graphA, other.id)).rejects.toThrow(/id/);
  });

  it("PS1.34 operations take effect in the order they are issued", async () => {
    const store = new SnapshotProceduralStore(new ProbeStorage());
    const r = record([]);
    const put = store.revisions.put(r);
    const read = store.revisions.get(graphA, r.id);
    const log = store.overlay(graphA);
    const heads = [log.head(), log.append([]), log.head()];
    await put;
    expect(await read).toEqual(r);
    expect(await Promise.all(heads)).toEqual([0, 0, 0]);
  });

  it("PS1.35 a failure does not stop the operations queued behind it", async () => {
    const storage = new ProbeStorage();
    const store = new SnapshotProceduralStore(storage);
    storage.failSaves = 1;
    const failed = store.guidance.put("g", "lost");
    const next = store.guidance.put("g", "kept");
    await expect(failed).rejects.toThrow("save failed");
    await next;
    expect(await store.guidance.get("g")).toBe("kept");
  });
});
