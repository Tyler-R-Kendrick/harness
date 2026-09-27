import { describe, expect, it } from "vitest";
import type { SnapshotStorage } from "@harness/core";

export interface StorageFixture {
  readonly storage: SnapshotStorage;
  /** A fresh instance over the same backing store, as after a process restart. */
  reopen(): SnapshotStorage;
}

/**
 * The SnapshotStorage contract. Every platform's storage implementation runs this
 * same suite, so the daemon can rely on identical semantics everywhere.
 */
export function storageContract(label: string, make: () => Promise<StorageFixture> | StorageFixture): void {
  describe(`SnapshotStorage contract: ${label}`, () => {
    it("SC1 an empty store loads as undefined", async () => {
      const { storage } = await make();
      expect(await storage.load()).toBeUndefined();
    });

    it("SC2 a saved snapshot loads back equal", async () => {
      const { storage } = await make();
      const snap = { version: 1, sessions: [{ id: "ses_1", text: "héllo \u{1F600}", n: [1, 2.5, null, true] }] };
      await storage.save(snap);
      expect(await storage.load()).toEqual(snap);
    });

    it("SC3 the latest save wins", async () => {
      const { storage } = await make();
      await storage.save({ n: 1 });
      await storage.save({ n: 2 });
      expect(await storage.load()).toEqual({ n: 2 });
    });

    it("SC4 overlapping saves settle on the last one issued", async () => {
      const { storage } = await make();
      await Promise.all([1, 2, 3, 4, 5].map((n) => storage.save({ n })));
      expect(await storage.load()).toEqual({ n: 5 });
    });

    it("SC5 saved data survives a restart", async () => {
      const fixture = await make();
      await fixture.storage.save({ durable: true });
      expect(await fixture.reopen().load()).toEqual({ durable: true });
    });

    it("SC6 later mutation of the saved object does not change what was stored", async () => {
      const { storage } = await make();
      const snap = { list: [1] };
      await storage.save(snap);
      snap.list.push(2);
      expect(await storage.load()).toEqual({ list: [1] });
    });
  });
}

/** In-memory reference implementation of SnapshotStorage. */
export class MemoryStorage implements SnapshotStorage {
  readonly #cell: { value: string | undefined };

  constructor(cell: { value: string | undefined } = { value: undefined }) {
    this.#cell = cell;
  }

  async load(): Promise<unknown> {
    return this.#cell.value === undefined ? undefined : JSON.parse(this.#cell.value);
  }

  async save(snapshot: unknown): Promise<void> {
    this.#cell.value = JSON.stringify(snapshot);
  }

  /** Another instance sharing this backing cell. */
  reopen(): MemoryStorage {
    return new MemoryStorage(this.#cell);
  }
}
