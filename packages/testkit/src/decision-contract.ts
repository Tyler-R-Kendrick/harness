import { describe, expect, it } from "vitest";
import { probability } from "@harness/cognitive";
import { forkId } from "@harness/decision";
import type { DecisionId, DecisionLog, DecisionRecord, Outcome } from "@harness/decision";

export interface DecisionLogFixture {
  readonly log: DecisionLog;
  /**
   * A fresh log over the same backing store, as after a process restart. Without it the
   * persistence rules are not tested (a backend that is not durable has none).
   */
  reopen?(): Promise<DecisionLog>;
  /** Releases the backing store (deletes a temporary file, closes a database). */
  cleanup?(): Promise<void>;
}

const FORK = forkId("contract.fork");
const OTHER = forkId("contract.other");

function make(id: DecisionId, overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id,
    fork: FORK,
    forkVersion: "1",
    at: 1000,
    input: { text: "héllo \u{1F600}", nested: { list: [1, 2.5, null, true, { deep: "x" }] } },
    rung: "model",
    member: "m",
    memberVersion: "v1",
    policy: "policy-1",
    answers: { q: { type: "boolean", distribution: { true: probability(0.75), false: probability(0.25) }, top: "true" } },
    action: { calls: [{ name: "x", arguments: { a: 1 } }] },
    confidence: probability(0.75),
    propensity: probability(1),
    explored: false,
    mode: "active",
    trace: [{ rung: "model", member: "m", outcome: "accepted", confidence: probability(0.75) }],
    ...overrides,
  };
}

const outcome = (overrides: Partial<Outcome> = {}): Outcome => ({ at: 2000, source: "human", kind: "approved", ...overrides });
const numberOf = (id: DecisionId): number => Number(id.slice(4));

/**
 * The DecisionLog contract. Every backend (memory, a file, IndexedDB) runs this suite so
 * the decider and the loops that learn from records can rely on identical semantics
 * everywhere: ids are issued in order and never reused, records are validated and copied,
 * outcomes replace one another, queries compose and come back in id order, and (for a
 * durable backend) what was appended survives a restart.
 */
export function decisionLogContract(label: string, make_: () => Promise<DecisionLogFixture>): void {
  const run = async (body: (fixture: DecisionLogFixture) => Promise<void>): Promise<void> => {
    const fixture = await make_();
    try {
      await body(fixture);
    } finally {
      await fixture.cleanup?.();
    }
  };

  /** A log holding records dec-0 .. dec-(n-1), each shaped by `shape(i)`. */
  const filled = async (log: DecisionLog, n: number, shape: (i: number) => Partial<DecisionRecord> = () => ({})): Promise<DecisionId[]> => {
    const ids: DecisionId[] = [];
    for (let i = 0; i < n; i++) {
      const id = await log.next();
      ids.push(id);
      await log.append(make(id, shape(i)));
    }
    return ids;
  };

  describe(`DecisionLog contract: ${label}`, () => {
    it("DLG9.1 next issues ids in order, each greater than the last", () =>
      run(async ({ log }) => {
        const ids = [await log.next(), await log.next(), await log.next()];
        expect(ids.map(numberOf)).toEqual([...ids.map(numberOf)].sort((a, b) => a - b));
        expect(new Set(ids).size).toBe(3);
        expect(ids).toEqual(["dec-0", "dec-1", "dec-2"]);
      }));

    it("DLG9.2 an id issued and never used is not issued again", () =>
      run(async ({ log }) => {
        await log.next();
        const second = await log.next();
        await log.append(make(second));
        expect(numberOf(await log.next())).toBeGreaterThan(numberOf(second));
      }));

    it("DLG9.3 an appended record comes back equal, and the log counts it", () =>
      run(async ({ log }) => {
        const [id] = await filled(log, 1);
        expect(await log.get(id!)).toEqual(make(id!));
        expect(await log.size()).toBe(1);
      }));

    it("DLG9.4 an unknown id has no record and an empty log has none at all", () =>
      run(async ({ log }) => {
        expect(await log.get("dec-0")).toBeUndefined();
        expect(await log.query()).toEqual([]);
        expect(await log.size()).toBe(0);
      }));

    it("DLG9.5 a record whose id was never issued is refused", () =>
      run(async ({ log }) => {
        await expect(log.append(make("dec-3"))).rejects.toThrow();
        expect(await log.size()).toBe(0);
      }));

    it("DLG9.6 a second record with an id already in the log is refused and the first stays", () =>
      run(async ({ log }) => {
        const [id] = await filled(log, 1, () => ({ action: "first" }));
        await expect(log.append(make(id!, { action: "second" }))).rejects.toThrow();
        expect((await log.get(id!))?.action).toBe("first");
        expect(await log.size()).toBe(1);
      }));

    it("DLG9.7 a record that is not valid is refused", () =>
      run(async ({ log }) => {
        const id = await log.next();
        await expect(log.append({ ...make(id), at: -5 })).rejects.toThrow();
        await expect(log.append({ ...make(id), confidence: 1.5 as never })).rejects.toThrow();
        expect(await log.size()).toBe(0);
      }));

    it("DLG9.8 what a caller changes after appending, or in what it read, does not change the log", () =>
      run(async ({ log }) => {
        const id = await log.next();
        const mine = make(id);
        await log.append(mine);
        (mine.input as { nested: { list: unknown[] } }).nested.list.push(99);
        mine.trace.push({ rung: "human", outcome: "x" });
        expect(await log.get(id)).toEqual(make(id));
        const read = (await log.get(id))!;
        read.trace.length = 0;
        (read.input as { nested: { list: unknown[] } }).nested.list.length = 0;
        expect(await log.get(id)).toEqual(make(id));
        (await log.query())[0]!.trace.length = 0;
        expect(await log.get(id)).toEqual(make(id));
      }));

    it("DLG9.9 an outcome attaches to its decision, and a second one replaces it", () =>
      run(async ({ log }) => {
        const ids = await filled(log, 2);
        expect(await log.outcome(ids[1]!, outcome({ correct: true }))).toBe(true);
        expect((await log.get(ids[1]!))?.outcome).toEqual(outcome({ correct: true }));
        expect((await log.get(ids[0]!))?.outcome).toBeUndefined();
        expect(await log.outcome(ids[1]!, outcome({ kind: "denied", at: 3000 }))).toBe(true);
        expect((await log.get(ids[1]!))?.outcome).toEqual(outcome({ kind: "denied", at: 3000 }));
      }));

    it("DLG9.10 an outcome for a decision the log does not have is false and changes nothing", () =>
      run(async ({ log }) => {
        await filled(log, 1);
        expect(await log.outcome("dec-9", outcome())).toBe(false);
        expect(await log.size()).toBe(1);
      }));

    it("DLG9.11 an outcome that is not valid is refused", () =>
      run(async ({ log }) => {
        const [id] = await filled(log, 1);
        await expect(log.outcome(id!, { at: 1, source: "nobody", kind: "approved" } as unknown as Outcome)).rejects.toThrow();
        expect((await log.get(id!))?.outcome).toBeUndefined();
      }));

    it("DLG9.12 a query with no filter returns every record in id order, whatever order they were appended in", () =>
      run(async ({ log }) => {
        const a = await log.next();
        const b = await log.next();
        const c = await log.next();
        for (const id of [c, a, b]) await log.append(make(id));
        expect((await log.query()).map((r) => r.id)).toEqual([a, b, c]);
      }));

    it("DLG9.13 fork, session, mode and outcome filters each select their records", () =>
      run(async ({ log }) => {
        const ids = await filled(log, 6, (i) => ({ fork: i % 2 === 0 ? FORK : OTHER, session: i < 3 ? "s1" : "s2", mode: i === 1 || i === 4 ? "shadow" : "active" }));
        await log.outcome(ids[2]!, outcome());
        const q = async (filter: Parameters<DecisionLog["query"]>[0]) => (await log.query(filter)).map((r) => r.id);
        expect(await q({ fork: OTHER })).toEqual([ids[1], ids[3], ids[5]]);
        expect(await q({ session: "s2" })).toEqual([ids[3], ids[4], ids[5]]);
        expect(await q({ mode: "shadow" })).toEqual([ids[1], ids[4]]);
        expect(await q({ hasOutcome: true })).toEqual([ids[2]]);
        expect(await q({ hasOutcome: false })).toEqual([ids[0], ids[1], ids[3], ids[4], ids[5]]);
      }));

    it("DLG9.14 since includes its instant, until excludes it, after excludes its own id, and limit keeps the first", () =>
      run(async ({ log }) => {
        const ids = await filled(log, 6, (i) => ({ at: 100 + i * 10 }));
        const q = async (filter: Parameters<DecisionLog["query"]>[0]) => (await log.query(filter)).map((r) => r.id);
        expect(await q({ since: 120 })).toEqual(ids.slice(2));
        expect(await q({ until: 120 })).toEqual(ids.slice(0, 2));
        expect(await q({ since: 110, until: 130 })).toEqual([ids[1], ids[2]]);
        expect(await q({ after: ids[3]! })).toEqual(ids.slice(4));
        expect(await q({ limit: 2 })).toEqual(ids.slice(0, 2));
        expect(await q({ limit: 0 })).toEqual([]);
      }));

    it("DLG9.15 filters compose, and limit counts the records that matched", () =>
      run(async ({ log }) => {
        const ids = await filled(log, 6, (i) => ({ fork: i % 2 === 0 ? FORK : OTHER, session: i < 3 ? "s1" : "s2" }));
        const q = async (filter: Parameters<DecisionLog["query"]>[0]) => (await log.query(filter)).map((r) => r.id);
        expect(await q({ fork: FORK, session: "s1" })).toEqual([ids[0], ids[2]]);
        expect(await q({ fork: FORK, after: ids[0]!, limit: 1 })).toEqual([ids[2]]);
        expect(await q({ fork: OTHER, session: "s1", since: 5000 })).toEqual([]);
      }));

    it("DLG9.16 size counts the records", () =>
      run(async ({ log }) => {
        await filled(log, 4);
        expect(await log.size()).toBe(4);
      }));

    it("DLG9.17 records, outcomes and the order of ids survive a restart", () =>
      run(async ({ log, reopen }) => {
        if (!reopen) return;
        const ids = await filled(log, 3, (i) => ({ at: 100 + i }));
        await log.outcome(ids[1]!, outcome({ correct: false, label: { x: [1] }, by: "alice" }));
        const before = await log.query();
        const again = await reopen();
        expect(await again.query()).toEqual(before);
        expect(await again.size()).toBe(3);
        expect((await again.get(ids[1]!))?.outcome).toEqual(outcome({ correct: false, label: { x: [1] }, by: "alice" }));
      }));

    it("DLG9.18 after a restart ids continue past every record and none is reused", () =>
      run(async ({ log, reopen }) => {
        if (!reopen) return;
        const ids = await filled(log, 3);
        const again = await reopen();
        const next = await again.next();
        expect(numberOf(next)).toBeGreaterThan(Math.max(...ids.map(numberOf)));
        await again.append(make(next));
        await expect(again.append(make(ids[0]!, { action: "again" }))).rejects.toThrow();
        expect(await again.size()).toBe(4);
      }));

    it("DLG9.19 an outcome given after a restart is kept by the next restart", () =>
      run(async ({ log, reopen }) => {
        if (!reopen) return;
        const [id] = await filled(log, 1);
        const again = await reopen();
        expect(await again.outcome(id!, outcome({ kind: "rated-good" }))).toBe(true);
        const third = await reopen();
        expect((await third.get(id!))?.outcome?.kind).toBe("rated-good");
      }));
  });
}
