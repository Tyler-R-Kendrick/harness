import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ATTENTION_KINDS, attentionFork, parseAttentionSettings, rankInbox } from "../src/attention.ts";
import type { AttentionItem } from "../src/attention.ts";
import { lazy, levels } from "./loops-fixtures.ts";

const settings = lazy(() => parseAttentionSettings(JSON.parse(readFileSync(new URL("../data/attention.json", import.meta.url), "utf8"))));
const fork = lazy(() => attentionFork(settings));

const itemArb = fc
  .record({
    id: fc.constantFrom("a", "b", "c", "d", "e"),
    session: fc.constantFrom("s1", "s2"),
    kind: fc.constantFrom(...ATTENTION_KINDS),
    since: fc.integer({ min: 0, max: 10_000_000 }),
    blocked: fc.boolean(),
    urgency: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
    text: fc.option(fc.constantFrom("x", "y", "z"), { nil: undefined }),
  })
  .map((r): AttentionItem => ({ id: r.id, session: r.session, kind: r.kind, since: r.since, blocked: r.blocked, ...(r.urgency === undefined ? {} : { urgency: r.urgency }), ...(r.text === undefined ? {} : { text: r.text }) }));
const inbox = fc.array(itemArb, { maxLength: 12 });
const now = fc.integer({ min: 0, max: 20_000_000 });

const key = (i: AttentionItem) => JSON.stringify(i);

describe("attention properties", () => {
  test.prop([inbox, now])("ATT4.1 the ranking is a permutation of the inbox, best first", (items, at) => {
    const ranked = rankInbox(items, settings, at);
    expect(ranked.map((r) => key(r.item)).sort()).toEqual(items.map(key).sort());
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1]!.priority).toBeGreaterThanOrEqual(ranked[i]!.priority);
  });

  test.prop([inbox, now, fc.infiniteStream(fc.nat())])("ATT4.2 the ranking is the same whatever order the inbox came in", (items, at, stream) => {
    const shuffled = [...items];
    const picks = stream[Symbol.iterator]();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = picks.next().value % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    expect(rankInbox(shuffled, settings, at).map((r) => key(r.item))).toEqual(rankInbox(items, settings, at).map((r) => key(r.item)));
  });

  test.prop([itemArb, now, fc.integer({ min: 0, max: 10_000_000 })])("ATT4.3 waiting longer never lowers an item's priority", (item, at, extra) => {
    const before = rankInbox([item], settings, at)[0]!.priority;
    const after = rankInbox([item], settings, at + extra)[0]!.priority;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test.prop([itemArb, now])("ATT4.4 blocked, and more urgency, never lower priority", (item, at) => {
    const plain = rankInbox([{ ...item, blocked: false }], settings, at)[0]!.priority;
    expect(rankInbox([{ ...item, blocked: true }], settings, at)[0]!.priority).toBeGreaterThanOrEqual(plain);
    const low = rankInbox([{ ...item, urgency: 0.2 }], settings, at)[0]!.priority;
    expect(rankInbox([{ ...item, urgency: 0.8 }], settings, at)[0]!.priority).toBeGreaterThanOrEqual(low);
  });

  test.prop([itemArb, now])("ATT4.5 the priority is the sum of its reasons", (item, at) => {
    const r = rankInbox([item], settings, at)[0]!;
    const total = r.reasons.reduce((sum, reason) => sum + Number(reason.slice(reason.lastIndexOf(": ") + 2)), 0);
    expect(total).toBeCloseTo(r.priority, 2);
  });

  test.prop([fc.array(fc.double({ min: 0.001, max: 1, noNaN: true }), { minLength: 4, maxLength: 4 }), itemArb])("ATT4.6 the fork's verdict is a label with a probability, and the floor is one of the labels", (weights, item) => {
    const verdict = fork.interpret({ urgency: levels(weights) }, item);
    expect(fork.actions!(item)).toContain(verdict!.action);
    expect(verdict!.confidence).toBeGreaterThanOrEqual(0);
    expect(verdict!.confidence).toBeLessThanOrEqual(1);
    const floor = fork.floor!(item);
    if (floor !== undefined) expect(fork.actions!(item)).toContain(floor);
    if (item.kind === "permission") expect(floor).toBe("high");
    if (item.kind === "failure") expect(floor).toBe("normal");
  });
});
