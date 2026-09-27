import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { FlowController } from "@harness/core";

describe("FlowController properties", () => {
  test.prop([fc.integer({ min: 1, max: 8 }), fc.array(fc.oneof(fc.constant("route" as const), fc.nat(3), fc.constant("resync" as const)), { maxLength: 120 })])(
    "MX2.11 outstanding never exceeds capacity and each subscriber sees strictly increasing offsets",
    (capacity, ops) => {
      const flow = new FlowController(capacity);
      const subs = ["a", "b", "c"];
      subs.forEach((s) => flow.subscribe(s, 0));
      const received = new Map<string, number[]>(subs.map((s) => [s, []]));
      let head = 0;
      for (const op of ops) {
        if (op === "route") {
          for (const s of flow.route(head).send) received.get(s)!.push(head);
          head++;
        } else if (op === "resync") {
          for (const s of subs) if (flow.state(s)?.mode === "snapshot") flow.resync(s, head);
        } else {
          const s = subs[op % subs.length]!;
          flow.ack(s, flow.state(s)!.next);
        }
        for (const s of subs) {
          const st = flow.state(s)!;
          expect(st.next - st.acked).toBeLessThanOrEqual(capacity);
        }
      }
      for (const offsets of received.values()) for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
    },
  );
});
