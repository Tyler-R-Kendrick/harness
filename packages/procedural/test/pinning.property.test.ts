import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { ManualClock, SeededEntropy } from "@harness/testkit";
import { pinSession, readOverlay } from "@harness/procedural";
import type { RevisionId, RevisionRecord } from "@harness/procedural";
import { commit, FakeStore, GRAPH, observe, rebase, revision } from "./pin-store.ts";

/** What happens to a graph between turns, and the turns themselves. */
type Op =
  | { kind: "observe"; n: number }
  | { kind: "dream"; rebaseNow: boolean }
  | { kind: "revert"; rebaseNow: boolean }
  | { kind: "import" }
  | { kind: "land" }
  | { kind: "turn"; session: string; repinOnDream: "turn" | "never"; overlayRefresh: "turn" | "session" }
  | { kind: "restart" };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("observe"), n: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant("dream"), rebaseNow: fc.boolean() }),
  fc.record({ kind: fc.constant("revert"), rebaseNow: fc.boolean() }),
  fc.record({ kind: fc.constant("import") }),
  fc.record({ kind: fc.constant("land") }),
  fc.record({ kind: fc.constantFrom("turn"), session: fc.constantFrom("s1", "s2", "s3"), repinOnDream: fc.constantFrom("turn", "never"), overlayRefresh: fc.constantFrom("turn", "session") }),
  fc.record({ kind: fc.constant("restart") }),
);

describe("pinning properties", () => {
  test.prop([fc.array(op, { maxLength: 40 })], { numRuns: 150 })(
    "PX1.P5 a session never pairs a core with an overlay built on a different core, and keeps one salt",
    async (ops) => {
      let store = new FakeStore();
      const entropy = new SeededEntropy(3);
      const clock = new ManualClock();
      const seed = revision(0, [], "seed");
      await commit(store, seed);
      // The model: which core each overlay version was really built on, and the heads so far.
      const builtOn: RevisionId[] = [seed.id];
      let overlayCore = seed.id;
      let pending: RevisionId | undefined;
      const heads: RevisionRecord[] = [seed];
      let made = 1;
      const salts = new Map<string, string>();

      const move = async (record: RevisionRecord, rebaseNow: boolean) => {
        await commit(store, record);
        heads.push(record);
        pending = record.id;
        if (rebaseNow) await land();
      };
      const land = async () => {
        if (pending === undefined) return;
        await rebase(store, pending);
        builtOn.push(pending);
        overlayCore = pending;
        pending = undefined;
      };

      for (const step of ops) {
        clock.advance(1);
        switch (step.kind) {
          case "observe":
            await observe(store, step.n);
            for (let i = 0; i < step.n; i += 1) builtOn.push(overlayCore);
            break;
          case "dream":
            await move(revision(made++, [heads.at(-1)!.id]), step.rebaseNow);
            break;
          case "revert":
            if (heads.length > 1) await move(heads.at(-2)!, step.rebaseNow);
            break;
          case "import":
            await move(revision(made++, [], "import"), false);
            break;
          case "land":
            await land();
            break;
          case "restart":
            store = store.reopen();
            break;
          case "turn": {
            const pin = await pinSession({ store, session: step.session, graph: GRAPH, entropy, clock, repinOnDream: step.repinOnDream, overlayRefresh: step.overlayRefresh });
            const head = heads.at(-1)!.id;
            expect(pin.overlay).toBeLessThan(builtOn.length);
            if (pin.overlay > 0) expect(builtOn[pin.overlay]).toBe(pin.core);
            if (step.repinOnDream === "turn") expect(pin.core).toBe(head);
            expect(salts.get(step.session) ?? pin.salt).toBe(pin.salt);
            salts.set(step.session, pin.salt);
            const state = await readOverlay(store, pin);
            expect(state.version).toBe(pin.overlay);
            break;
          }
        }
      }
    },
  );
});
