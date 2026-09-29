import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { WorkQueue } from "@harness/core";
import type { SourceConnection, SourceEvent, SourcePage } from "@harness/core";

/**
 * A source that drops, replays events it already returned, and sometimes reports an earlier cursor.
 * The queue's inbox has to stay a set of the first filter match for each id.
 */
class FaultySource implements SourceConnection {
  dropped = false;
  replay: readonly SourceEvent[] = [];
  /** When set, the next open page reports this cursor instead of the log length. */
  regressTo: string | undefined;
  readonly log: SourceEvent[] = [];
  readonly pages: SourcePage[] = [];

  emit(event: SourceEvent): void {
    this.log.push(event);
  }

  read(cursor: string | undefined): SourcePage {
    if (this.dropped) {
      const page: SourcePage = { open: false };
      this.pages.push(page);
      return page;
    }
    const from = cursor === undefined ? 0 : Number(cursor);
    const start = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
    const events = [...this.replay, ...this.log.slice(start)];
    this.replay = [];
    const next = this.regressTo ?? String(this.log.length);
    this.regressTo = undefined;
    const page: SourcePage = { open: true, cursor: next, events };
    this.pages.push(page);
    return page;
  }
}

interface Spec {
  items: Map<string, string>;
  inbox: string[];
  delivered: Set<string>;
  cursor: string | null;
}

const keep = (event: SourceEvent): boolean => event.body.includes("k");

function applyPage(spec: Spec, page: SourcePage): void {
  if (!page.open) return;
  spec.cursor = page.cursor;
  for (const event of page.events) {
    if (spec.delivered.has(event.id) || !keep(event)) continue;
    spec.delivered.add(event.id);
    if (spec.items.has(event.id)) continue;
    spec.items.set(event.id, event.body);
    spec.inbox.push(event.id);
  }
}

const token = fc.stringMatching(/^[a-z]{1,2}$/);
const eventArb = fc.record({ id: token, body: token });
const opArb = fc.oneof(
  eventArb.map((event) => ({ kind: "emit" as const, event })),
  fc.constant({ kind: "drop" as const }),
  fc.constant({ kind: "resume" as const }),
  fc.constant({ kind: "ingest" as const }),
  fc.constant({ kind: "replay" as const }),
  fc.constant({ kind: "regress" as const }),
);

describe("WorkQueue chaos", () => {
  test.prop(
    [fc.uniqueArray(eventArb, { maxLength: 4, selector: (event) => event.id }), fc.array(opArb, { maxLength: 36 })],
    { numRuns: 40 },
  )("CH1.1 drops, replays, and cursor regressions keep one inbox row for the first matching event", (manuals, ops) => {
    const queue = new WorkQueue();
    const spec: Spec = { items: new Map(), inbox: [], delivered: new Set(), cursor: null };
    for (const manual of manuals) {
      const outcome = `manual ${manual.body}`;
      expect(queue.add({ id: manual.id, outcome }).ok).toBe(true);
      spec.items.set(manual.id, outcome);
    }
    const source = new FaultySource();
    expect(queue.connect("issues", source, keep).ok).toBe(true);

    for (const op of ops) {
      if (op.kind === "emit") source.emit(op.event);
      else if (op.kind === "drop") source.dropped = true;
      else if (op.kind === "resume") source.dropped = false;
      else if (op.kind === "replay") source.replay = source.log.slice(0, 3);
      else if (op.kind === "regress") source.regressTo = "0";
      else {
        const before = queue.inbox().length;
        expect(queue.ingest("issues").ok).toBe(true);
        if (source.dropped) expect(queue.inbox().length).toBe(before);
        const page = source.pages.at(-1);
        if (page !== undefined) applyPage(spec, page);
      }
    }

    expect(queue.inbox().map((item) => item.id)).toEqual(spec.inbox);
    for (const item of queue.inbox()) expect(item.outcome).toBe(spec.items.get(item.id));
    expect(new Set(queue.inbox().map((item) => item.id)).size).toBe(queue.inbox().length);
    for (const item of queue.inbox()) expect(keep({ id: item.id, body: item.outcome })).toBe(true);
    for (const manual of manuals) expect(queue.item(manual.id)?.outcome).toBe(`manual ${manual.body}`);
    const snapshot = queue.toJSON();
    expect(snapshot.sources[0]?.cursor).toBe(spec.cursor);
    expect(snapshot.sources[0]?.delivered).toEqual([...spec.delivered]);
  });
});
