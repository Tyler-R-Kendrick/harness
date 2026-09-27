import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { Deduper, HookBus } from "@harness/core";

describe("HookBus at-least-once delivery", () => {
  test.prop([fc.integer({ min: 1, max: 40 }), fc.array(fc.record({ batch: fc.integer({ min: 1, max: 5 }), crashBeforeAck: fc.boolean() }), { maxLength: 80 })])(
    "HK5.1 with crashes before ack, a deduping plugin applies every event exactly once",
    (count, rounds) => {
      const bus = new HookBus({ maxDepth: 4 });
      bus.subscribe("p", { types: ["*"] }, 0);
      for (let i = 0; i < count; i++) bus.publish({ type: "x", source: "d", payload: i }, i);
      let durable = bus.toJSON();
      const dedupe = new Deduper(1_000);
      const applied = new Map<string, number>();
      let live = HookBus.fromJSON(durable, { maxDepth: 4 });
      const drain = (b: HookBus) => {
        for (;;) {
          const r = b.poll("p", 5);
          if (!r.ok || r.value.length === 0) return;
          for (const e of r.value) if (!dedupe.seen(e.eventId)) applied.set(e.eventId, (applied.get(e.eventId) ?? 0) + 1);
          b.ack("p", r.value.at(-1)!.offset);
        }
      };
      for (const round of rounds) {
        const r = live.poll("p", round.batch);
        if (!r.ok) throw new Error("unreachable");
        for (const e of r.value) if (!dedupe.seen(e.eventId)) applied.set(e.eventId, (applied.get(e.eventId) ?? 0) + 1);
        if (round.crashBeforeAck) {
          live = HookBus.fromJSON(durable, { maxDepth: 4 }); // lose everything since the last durable save
        } else if (r.value.length > 0) {
          live.ack("p", r.value.at(-1)!.offset);
          durable = live.toJSON();
        }
      }
      drain(live);
      expect(applied.size).toBe(count);
      for (const n of applied.values()) expect(n).toBe(1);
    },
  );
});
