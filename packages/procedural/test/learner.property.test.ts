import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { edgeKey } from "@harness/procedural";
import type { OverlayEvent } from "@harness/procedural";
import { preset, setup, turnEnded, turnOf } from "./learner-setup.ts";

const SESSIONS = ["s1", "s2", "s3", "s4"];
/** Turns over a small pool of sessions, each taking the path Start → First_Hop_Retrieve → Bridge_Extract (a transition the core lacks). */
const turns = fc.uniqueArray(fc.tuple(fc.constantFrom(...SESSIONS), fc.integer({ min: 1, max: 4 })), { minLength: 1, maxLength: 10, selector: ([s, t]) => `${s}/${t}` });
const TOOLS = ["first_hop_retrieve", "Bridge_Extract"];

const observedKeys = (events: readonly OverlayEvent[]) => events.flatMap((e) => (e.kind === "observed" && e.rescore === undefined ? [e.turnKey] : []));

describe("the live learner under at-least-once delivery", () => {
  test.prop([turns, fc.array(fc.nat(), { maxLength: 20 }), fc.boolean()], { numRuns: 60 })(
    "PL1.P3 redelivering turn.ended events (again, later, concurrently) gives the overlay log of delivering each once",
    async (keys, redeliveries, concurrent) => {
      const once = setup();
      const many = setup();
      for (const t of [once, many]) for (const [s, n] of keys) t.add(s, turnOf(`t${n}`, TOOLS));
      for (const [s, n] of keys) await once.learner.onHookEvent(turnEnded(s, `t${n}`));
      // Every event at least once, in order, with redeliveries of earlier ones mixed in.
      const deliveries: [string, number][] = [];
      keys.forEach((k, i) => {
        deliveries.push(k);
        for (const r of redeliveries.filter((x) => x % keys.length <= i).slice(0, 2)) deliveries.push(keys[r % keys.length]!);
      });
      if (concurrent) await Promise.all(deliveries.map(([s, n]) => many.learner.onHookEvent(turnEnded(s, `t${n}`))));
      else for (const [s, n] of deliveries) await many.learner.onHookEvent(turnEnded(s, `t${n}`));
      expect(observedKeys(many.store.events())).toEqual(keys.map(([s, n]) => `${s}/t${n}`));
      expect(many.state()).toEqual(once.state());
    },
  );

  test.prop([turns, fc.integer({ min: 1, max: 4 })], { numRuns: 60 })("PL1.P4 a missing transition is proposed exactly when its distinct sessions reach minSupport", async (keys, minSupport) => {
    const t = setup({ preset: preset({ minSupport }) });
    for (const [s, n] of keys) {
      t.add(s, turnOf(`t${n}`, TOOLS));
      await t.learner.onHookEvent(turnEnded(s, `t${n}`));
    }
    const sessions = new Set(keys.map(([s]) => s)).size;
    const proposed = t.store.events().filter((e) => e.kind === "proposed" && e.entry.kind === "edge");
    expect(proposed).toHaveLength(sessions >= minSupport ? 1 : 0);
    expect(t.state().transitions[edgeKey("First_Hop_Retrieve", "Bridge_Extract")]!.sessions).toHaveLength(sessions);
  });

  test.prop([turns, fc.array(fc.tuple(fc.nat(), fc.double({ min: 0, max: 1, noNaN: true })), { maxLength: 12 })], { numRuns: 60 })(
    "PL1.P5 feedback moves scores without traversals: the statistics equal observing each turn once with its last score",
    async (keys, feedback) => {
      const live = setup();
      const expected = setup();
      for (const t of [live, expected]) for (const s of SESSIONS) t.pin(s);
      for (const [s, n] of keys) {
        live.add(s, turnOf(`t${n}`, TOOLS));
        await live.learner.onHookEvent(turnEnded(s, `t${n}`));
      }
      const last = new Map<string, number>();
      for (const [i, score] of feedback) {
        const [s, n] = keys[i % keys.length]!;
        await live.learner.feedback(s, `t${n}`, score);
        last.set(`${s}/t${n}`, score);
      }
      for (const [s, n] of keys) {
        const score = last.get(`${s}/t${n}`);
        expected.add(s, turnOf(`t${n}`, TOOLS));
        await (score === undefined ? expected.learner.onHookEvent(turnEnded(s, `t${n}`)) : expected.learner.feedback(s, `t${n}`, score));
      }
      // Rounded, and "+ 0" makes a -0 left by withdrawn scores equal 0.
      const pick = (stats: Record<string, { traversals?: number; scored: number; scoreSum: number }>) =>
        Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { traversals: v.traversals, scored: v.scored, scoreSum: Math.round(v.scoreSum * 1e9) / 1e9 + 0 }]));
      expect(pick(live.state().stats)).toEqual(pick(expected.state().stats));
      expect(pick(live.state().transitions)).toEqual(pick(expected.state().transitions));
    },
  );
});
