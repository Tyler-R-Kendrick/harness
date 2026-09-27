import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { MemoryProceduralStore, redactRecord, SnapshotProceduralStore } from "@harness/procedural";
import type { ProceduralStore, RevisionId } from "@harness/procedural";
import { MemoryStorage } from "@harness/testkit";
import { graphA, record } from "./store-fixtures.ts";

const IMPLEMENTATIONS: readonly [string, () => ProceduralStore][] = [
  ["memory", () => new MemoryProceduralStore()],
  ["snapshot", () => new SnapshotProceduralStore(new MemoryStorage())],
];

const REVISIONS: readonly RevisionId[] = [[], ["A"], ["B"], ["A", "B"]].map((steps) => record(steps).id);

const logOp = fc.oneof(
  fc.record({ kind: fc.constant("append" as const), events: fc.array(fc.integer(), { maxLength: 4 }) }),
  fc.record({ kind: fc.constant("read" as const), from: fc.nat(12), limit: fc.option(fc.nat(6), { nil: undefined }) }),
);

const leaseOp = fc.record({
  kind: fc.constantFrom("acquire" as const, "renew" as const, "release" as const),
  holder: fc.constantFrom("h1", "h2", "h3"),
  epoch: fc.nat(6),
});

const headOp = fc.record({ expected: fc.option(fc.constantFrom(...REVISIONS), { nil: undefined }), next: fc.constantFrom(...REVISIONS) });

describe.each(IMPLEMENTATIONS)("stores: %s", (_name, make) => {
  test.prop([fc.array(logOp, { maxLength: 20 })])("PS1.42 an append log behaves as a dense array under any appends and reads", async (ops) => {
    const log = make().dreams(graphA);
    const model: number[] = [];
    for (const op of ops) {
      if (op.kind === "append") {
        model.push(...op.events);
        expect(await log.append(op.events)).toBe(model.length);
      } else {
        const end = op.limit === undefined ? model.length : Math.min(model.length, op.from + op.limit);
        const want = model.slice(op.from, end).map((event, i) => ({ offset: op.from + i, event }));
        expect(await log.read(op.from, op.limit)).toEqual(want);
      }
      expect(await log.head()).toBe(model.length);
    }
  });

  test.prop([fc.array(leaseOp, { maxLength: 25 })])("PS1.43 a lease has at most one holder, grants strictly growing epochs, and honors only the current epoch", async (ops) => {
    const store = make();
    let holder: string | undefined;
    let epoch = 0;
    for (const op of ops) {
      const current = holder === op.holder && epoch === op.epoch;
      if (op.kind === "acquire") {
        const lease = await store.lease.acquire(graphA, op.holder);
        if (holder !== undefined && holder !== op.holder) expect(lease).toBeUndefined();
        else {
          expect(lease).toEqual({ epoch: epoch + 1 });
          epoch += 1;
          holder = op.holder;
        }
      } else if (op.kind === "renew") {
        expect(await store.lease.renew(graphA, op.holder, op.epoch)).toBe(current);
      } else {
        expect(await store.lease.release(graphA, op.holder, op.epoch)).toBe(current);
        if (current) holder = undefined;
      }
    }
  });

  test.prop([fc.array(headOp, { maxLength: 20 })])("PS1.44 a head moves only from its expected revision, and its history lists earlier heads most recent first", async (ops) => {
    const store = make();
    const model: RevisionId[] = [];
    for (const op of ops) {
      const moved = await store.heads.set(graphA, op.expected, op.next);
      expect(moved).toBe(model[0] === op.expected);
      if (moved && model[0] !== op.next) model.unshift(op.next);
      expect(await store.heads.get(graphA)).toEqual(model.length === 0 ? undefined : { revision: model[0], history: model.slice(1) });
    }
  });
});

describe("store durability", () => {
  const op = fc.oneof(
    logOp.map((o) => ({ ...o, log: "dreams" as const })),
    leaseOp.map((o) => ({ ...o, log: "lease" as const })),
    headOp.map((o) => ({ ...o, log: "head" as const })),
  );

  test.prop([fc.array(op, { maxLength: 20 })])("PS1.45 after any operations, a reopened snapshot store holds exactly the memory store's document", async (ops) => {
    const storage = new MemoryStorage();
    const durable = new SnapshotProceduralStore(storage);
    const reference = new MemoryProceduralStore();
    for (const o of ops) {
      for (const store of [durable, reference]) {
        if (o.log === "head") await store.heads.set(graphA, o.expected, o.next);
        else if (o.log === "lease") await store.lease[o.kind](graphA, o.holder, o.epoch);
        else if (o.kind === "append") await store.dreams(graphA).append(o.events);
      }
    }
    const reopened = new SnapshotProceduralStore(storage.reopen());
    expect(await reopened.heads.get(graphA)).toEqual(await reference.heads.get(graphA));
    expect(await reopened.dreams(graphA).read(0)).toEqual(await reference.dreams(graphA).read(0));
    // Nothing saved is the empty store.
    expect((await storage.load()) ?? new MemoryProceduralStore().document()).toEqual(JSON.parse(JSON.stringify(reference.document())));
  });
});

describe("redaction", () => {
  const secret = fc.string({ minLength: 1, maxLength: 8 }).map((s) => `§${s}`);

  test.prop([secret, fc.array(secret, { maxLength: 3 }), secret])("PS1.46 a redacted record keeps none of its texts and still parses", (text, evidence, reason) => {
    const r = record(["Plan"], { evidence: { list: evidence, one: reason }, decision: { kind: "rejected-gate", gate: "g", reason } }, text);
    const redacted = redactRecord(r);
    expect(JSON.stringify(redacted)).not.toContain("§");
    expect(redacted.id).toBe(r.id);
    expect(redacted.document.nodes.map((n) => n.id)).toEqual(r.document.nodes.map((n) => n.id));
  });
});
