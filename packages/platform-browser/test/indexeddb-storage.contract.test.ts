import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbStorage } from "@harness/platform-browser";
import { storageContract } from "@harness/testkit";

let databases = 0;

storageContract("IndexedDbStorage", () => {
  const factory = new IDBFactory();
  const name = `harness-${++databases}`;
  return { storage: new IndexedDbStorage({ factory, name }), reopen: () => new IndexedDbStorage({ factory, name }) };
});

describe("IndexedDbStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("IDB1.4 by default it uses the context's IndexedDB, in a database named harness", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const storage = new IndexedDbStorage();
    await storage.save({ n: 1 });
    await storage.close();
    expect((await factory.databases()).map((d) => d.name)).toEqual(["harness"]);
    expect(await new IndexedDbStorage({ factory, name: "harness", key: "daemon" }).load()).toEqual({ n: 1 });
  });

  it("IDB1.1 stores under separate keys do not see each other's snapshots", async () => {
    const factory = new IDBFactory();
    const a = new IndexedDbStorage({ factory, key: "a" });
    const b = new IndexedDbStorage({ factory, key: "b" });
    await a.save({ who: "a" });
    expect(await b.load()).toBeUndefined();
    expect(await a.load()).toEqual({ who: "a" });
    await a.close();
    await b.close();
  });

  it("IDB1.2 a snapshot that cannot be cloned fails the save, and the stored one is kept", async () => {
    const factory = new IDBFactory();
    const storage = new IndexedDbStorage({ factory });
    await storage.save({ n: 1 });
    await expect(storage.save({ f: () => 1 })).rejects.toThrow();
    expect(await storage.load()).toEqual({ n: 1 });
  });

  it("IDB1.3 a database that cannot be opened fails loads and saves", async () => {
    const factory = new IDBFactory();
    const newer = new IndexedDbStorage({ factory, name: "versioned" });
    await newer.save({ n: 1 });
    await newer.close();
    // Bump the database past the version the storage opens, so opening it is refused.
    await new Promise<void>((resolve) => {
      const open = factory.open("versioned", 2);
      open.onsuccess = () => (open.result.close(), resolve());
    });
    const stale = new IndexedDbStorage({ factory, name: "versioned" });
    await expect(stale.load()).rejects.toBeDefined();
    await expect(stale.save({ n: 2 })).rejects.toBeDefined();
  });

  it("IDB1.5 a save whose transaction aborts fails, and the stored snapshot is kept", async () => {
    const storage = new IndexedDbStorage({ factory: new IDBFactory() });
    await storage.save({ n: 1 });
    const transaction = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args: Parameters<typeof transaction>) {
      const tx = transaction.apply(this, args);
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    });
    await expect(storage.save({ n: 2 })).rejects.toThrow(/aborted/);
    spy.mockRestore();
    expect(await storage.load()).toEqual({ n: 1 });
  });
});
