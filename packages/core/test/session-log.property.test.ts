import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { SessionLog } from "@harness/core";

describe("SessionLog properties", () => {
  test.prop([fc.array(fc.integer(), { maxLength: 60 }), fc.nat(), fc.integer({ min: 1, max: 7 })])(
    "SL4.1 paging from any retained offset yields exactly the tail, once, in order",
    (payloads, cut, page) => {
      const log = new SessionLog<number>();
      payloads.forEach((p, i) => log.append("u", p, i));
      const compactTo = payloads.length === 0 ? 0 : cut % (payloads.length + 1);
      log.compact(compactTo, "snap");
      const seen: number[] = [];
      let from = compactTo;
      for (;;) {
        const r = log.read(from, page);
        if (r.kind !== "entries") throw new Error(`unexpected ${r.kind}`);
        if (r.entries.length === 0) break;
        seen.push(...r.entries.map((e) => e.offset));
        from = r.next;
      }
      expect(seen).toEqual(payloads.map((_, i) => i).slice(compactTo));
    },
  );

  test.prop([fc.array(fc.integer({ min: 0, max: 1_000 }), { minLength: 1, maxLength: 40 })])(
    "SL4.2 recorded timestamps are non-decreasing whatever the clock does",
    (times) => {
      const log = new SessionLog<null>();
      const ats = times.map((t) => log.append("u", null, t).at);
      for (let i = 1; i < ats.length; i++) expect(ats[i]!).toBeGreaterThanOrEqual(ats[i - 1]!);
    },
  );
});
