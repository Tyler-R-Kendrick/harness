import { IDBDatabase, IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probability } from "@harness/cognitive";
import { DecisionError, forkId } from "@harness/decision";
import type { DecisionId, DecisionRecord, Outcome } from "@harness/decision";
import { IndexedDbDecisionLog } from "@harness/platform-browser";

const record = (id: DecisionId, overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  fork: forkId("test.fork"),
  forkVersion: "1",
  at: 100,
  input: { q: "x" },
  rung: "model",
  policy: "policy-1",
  answers: {},
  action: "go",
  confidence: probability(0.75),
  propensity: probability(1),
  explored: false,
  mode: "active",
  trace: [],
  ...overrides,
});
const outcome = (overrides: Partial<Outcome> = {}): Outcome => ({ at: 200, source: "human", kind: "approved", ...overrides });

const opened: IndexedDbDecisionLog[] = [];
const open = (factory: IDBFactory, options: { name?: string; maxRecords?: number } = {}): IndexedDbDecisionLog => {
  const log = new IndexedDbDecisionLog({ factory, ...options });
  opened.push(log);
  return log;
};
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((log) => log.close().catch(() => {})));
});

async function fill(log: IndexedDbDecisionLog, n: number, shape: (i: number) => Partial<DecisionRecord> = () => ({})): Promise<DecisionId[]> {
  const ids: DecisionId[] = [];
  for (let i = 0; i < n; i++) {
    const id = await log.next();
    ids.push(id);
    await log.append(record(id, shape(i)));
  }
  return ids;
}
const ids = async (log: IndexedDbDecisionLog) => (await log.query()).map((r) => r.id);

/** The raw contents of a database: its stores, the records' keys and the meta entries. */
async function inspect(factory: IDBFactory, name: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve) => void (request.onsuccess = () => resolve(request.result)));
  const tx = db.transaction([...db.objectStoreNames], "readonly");
  const result = {
    stores: [...db.objectStoreNames].sort(),
    keys: await read(tx.objectStore("records").getAllKeys()),
    meta: Object.fromEntries(await Promise.all(["next", "seq"].map(async (k) => [k, await read(tx.objectStore("meta").get(k))] as const))),
  };
  db.close();
  return result;
}

describe("IndexedDbDecisionLog: storage", () => {
  it("DBR1.1 records are kept in an object store keyed by their id number, and the id counter in a meta store", async () => {
    const factory = new IDBFactory();
    const log = open(factory, { name: "mine" });
    await fill(log, 3);
    await log.close();
    expect(await inspect(factory, "mine")).toEqual({ stores: ["meta", "records"], keys: [0, 1, 2], meta: { next: 3, seq: 3 } });
  });

  it("DBR1.2 by default it uses the context's IndexedDB, in a database named harness-decisions", async () => {
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const log = new IndexedDbDecisionLog();
    opened.push(log);
    await fill(log, 1);
    expect((await factory.databases()).map((d) => d.name)).toEqual(["harness-decisions"]);
  });

  it("DBR1.3 logs in databases of different names do not see each other", async () => {
    const factory = new IDBFactory();
    const a = open(factory, { name: "a" });
    const b = open(factory, { name: "b" });
    await fill(a, 2);
    expect(await b.size()).toBe(0);
    expect(await b.next()).toBe("dec-0");
  });

  it("DBR1.4 two logs on one database (two tabs) share the records and never issue the same id", async () => {
    const factory = new IDBFactory();
    const a = open(factory);
    const b = open(factory);
    const issued = await Promise.all([a.next(), b.next(), a.next(), b.next()]);
    expect(new Set(issued).size).toBe(4);
    await a.append(record(issued[0]!));
    expect((await b.get(issued[0]!))?.id).toBe(issued[0]);
    // An id belongs to the log that issued it.
    await expect(b.append(record(issued[2]!))).rejects.toMatchObject({ code: "refused" });
  });

  it("DBR1.5 a query reads in id order, whatever order the records were appended in", async () => {
    const log = open(new IDBFactory());
    const [a, b, c] = [await log.next(), await log.next(), await log.next()];
    for (const id of [c, a, b]) await log.append(record(id));
    expect(await ids(log)).toEqual([a, b, c]);
  });

  it("DBR1.6 an id the log never issued, or issued before another log used it, is refused with the reason", async () => {
    const log = open(new IDBFactory());
    const [id] = await fill(log, 1);
    await expect(log.append(record(id!))).rejects.toThrow(/already in the log/);
    await expect(log.append(record("dec-9"))).rejects.toThrow(/not issued/);
  });

  it("DBR1.8 the same record appended twice at once is stored once: the second call is refused and writes nothing", async () => {
    const log = open(new IDBFactory());
    const id = await log.next();
    const results = await Promise.allSettled([log.append(record(id, { action: "first" })), log.append(record(id, { action: "second" }))]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "refused", message: expect.stringContaining("already in the log") });
    expect((await log.get(id))?.action).toBe("first");
    expect(await log.size()).toBe(1);
  });

  it("DBR1.7 a record or outcome that is not valid, and a limit that is not a count, are refused with DecisionError", async () => {
    const log = open(new IDBFactory());
    const id = await log.next();
    await expect(log.append({ ...record(id), at: -1 })).rejects.toMatchObject({ name: "DecisionError", code: "invalid" });
    await log.append(record(id));
    await expect(log.outcome(id, { at: 1, source: "nobody", kind: "approved" } as unknown as Outcome)).rejects.toMatchObject({ code: "invalid" });
    await expect(log.query({ limit: -1 })).rejects.toBeInstanceOf(DecisionError);
    await expect(log.query({ limit: 1.5 })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("IndexedDbDecisionLog: the cap", () => {
  it("DBR2.1 past maxRecords the oldest records without an outcome go first, as in the memory log, and what is left survives a reopen", async () => {
    const factory = new IDBFactory();
    const log = open(factory, { maxRecords: 3 });
    const all = await fill(log, 3);
    await log.outcome(all[0]!, outcome());
    await fill(log, 2);
    expect(await ids(log)).toEqual(["dec-0", "dec-3", "dec-4"]);
    expect(await ids(open(factory, { maxRecords: 3 }))).toEqual(["dec-0", "dec-3", "dec-4"]);
  });

  it("DBR2.2 when everything is labelled the oldest goes, and the newest never does", async () => {
    const log = open(new IDBFactory(), { maxRecords: 2 });
    for (const id of await fill(log, 2)) await log.outcome(id, outcome());
    await fill(log, 1);
    expect(await ids(log)).toEqual(["dec-1", "dec-2"]);
    const solo = open(new IDBFactory(), { maxRecords: 1 });
    await fill(solo, 3);
    expect(await ids(solo)).toEqual(["dec-2"]);
  });

  it("DBR2.3 oldest means first appended, not lowest id", async () => {
    const log = open(new IDBFactory(), { maxRecords: 2 });
    const [a, b, c] = [await log.next(), await log.next(), await log.next()];
    await log.append(record(c));
    await log.append(record(a));
    await log.append(record(b));
    expect(await ids(log)).toEqual([a, b]);
  });

  it("DBR2.4 a labelled record that is the only one older than the newest is dropped last, and an outcome given later protects a record", async () => {
    const log = open(new IDBFactory(), { maxRecords: 2 });
    const [first] = await fill(log, 2);
    await log.outcome(first!, outcome());
    await fill(log, 1);
    expect(await ids(log)).toEqual(["dec-0", "dec-2"]);
  });

  it("DBR2.5 a cap lowered at a reopen is applied at the next append, down to the cap", async () => {
    const factory = new IDBFactory();
    await fill(open(factory), 6);
    const log = open(factory, { maxRecords: 2 });
    await fill(log, 1);
    expect(await ids(log)).toEqual(["dec-5", "dec-6"]);
  });

  it("DBR2.6 a maxRecords that is not a whole number from 1 is refused", () => {
    for (const maxRecords of [0, -1, 1.5, Number.NaN]) expect(() => new IndexedDbDecisionLog({ factory: new IDBFactory(), maxRecords }), String(maxRecords)).toThrow(DecisionError);
  });

  it("DBR2.7 a cap of 1 keeps only the newest, and an outcome for a record that is gone is false", async () => {
    const log = open(new IDBFactory(), { maxRecords: 1 });
    await fill(log, 2);
    expect(await log.outcome("dec-0", outcome())).toBe(false);
    expect(await ids(log)).toEqual(["dec-1"]);
  });
});

describe("IndexedDbDecisionLog: failures", () => {
  it("DBR3.1 a transaction that aborts fails the call and changes nothing, and the id can be appended again", async () => {
    const log = open(new IDBFactory());
    const id = await log.next();
    const transaction = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args: Parameters<typeof transaction>) {
      const tx = transaction.apply(this, args);
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    });
    await expect(log.append(record(id))).rejects.toThrow();
    spy.mockRestore();
    expect(await log.size()).toBe(0);
    await log.append(record(id));
    expect(await log.size()).toBe(1);
  });

  it("DBR3.2 a database that cannot be opened fails every call", async () => {
    const factory = new IDBFactory();
    const first = open(factory, { name: "versioned" });
    await fill(first, 1);
    // Bump the database past the version the log opens, so opening it is refused (the first connection has to let go first).
    await first.close();
    await new Promise<void>((resolve) => {
      const request = factory.open("versioned", 2);
      request.onsuccess = () => (request.result.close(), resolve());
    });
    const stale = new IndexedDbDecisionLog({ factory, name: "versioned" });
    await expect(stale.next()).rejects.toBeDefined();
    await expect(stale.query()).rejects.toBeDefined();
    await expect(stale.size()).rejects.toBeDefined();
    await expect(stale.get("dec-0")).rejects.toBeDefined();
    await expect(stale.outcome("dec-0", outcome())).rejects.toBeDefined();
  });
});
