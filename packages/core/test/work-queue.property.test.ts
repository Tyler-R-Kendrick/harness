import { describe, expect } from "vitest";
import { test } from "@fast-check/vitest";
import fc from "fast-check";
import { WorkQueue } from "@harness/core";
import type { SourceConnection, SourceEvent, SourcePage } from "@harness/core";

/** Append-only log. The cursor is the count of events already read, and one read can replay a chosen prefix. */
class LogSource implements SourceConnection {
  replay: readonly SourceEvent[] | undefined;
  readonly #events: SourceEvent[] = [];

  emit(event: SourceEvent): void {
    this.#events.push(event);
  }

  read(cursor: string | undefined): SourcePage {
    if (this.replay !== undefined) {
      const events = this.replay;
      this.replay = undefined;
      return { open: true, cursor: String(this.#events.length), events };
    }
    const from = cursor === undefined ? 0 : Number(cursor);
    return { open: true, cursor: String(this.#events.length), events: this.#events.slice(from) };
  }
}

const word = fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/);

const verifier = (outcome: string, result: string): boolean => result.includes(outcome) && !result.includes(`not: ${outcome}`);

describe("WorkQueue properties", () => {
  test.prop(
    [
      fc.array(fc.record({ id: word, body: word }), { maxLength: 12 }),
      fc.integer({ min: 0, max: 12 }),
    ],
    { numRuns: 50 },
  )("WQ5.1 a restored queue keeps a matching event once and does not replay one it already delivered", (events, splitAt) => {
    const queue = new WorkQueue();
    const source = new LogSource();
    const keep = (event: SourceEvent): boolean => event.body.includes("a");
    expect(queue.connect("issues", source, keep).ok).toBe(true);
    const split = splitAt % (events.length + 1);
    for (const event of events.slice(0, split)) source.emit(event);
    expect(queue.ingest("issues").ok).toBe(true);
    const restored = WorkQueue.fromJSON(queue.toJSON());
    const resumed = new LogSource();
    for (const event of events) resumed.emit(event);
    expect(restored.attach("issues", resumed, keep).ok).toBe(true);
    const ingested = restored.ingest("issues");
    expect(ingested.ok).toBe(true);
    if (!ingested.ok) return;

    const accepted = new Map<string, string>();
    for (const event of events) {
      if (!keep(event) || accepted.has(event.id)) continue;
      accepted.set(event.id, event.body);
    }
    const manual = new Set(queue.toJSON().items.filter((item) => !queue.toJSON().inbox.includes(item.id)).map((item) => item.id));
    for (const id of manual) accepted.delete(id);
    expect(ingested.value.map((item) => item.id)).toEqual([...accepted.keys()].filter((id) => !queue.inbox().some((item) => item.id === id)));
    expect(new Set(restored.inbox().map((item) => item.id)).size).toBe(restored.inbox().length);
    for (const item of restored.inbox()) expect(item.outcome).toBe(accepted.get(item.id));

    const replayed = events.filter((event) => restored.inbox().some((item) => item.id === event.id));
    resumed.replay = replayed;
    const again = restored.ingest("issues");
    expect(again.ok && again.value).toEqual([]);
    expect(restored.toJSON()).toEqual(WorkQueue.fromJSON(restored.toJSON()).toJSON());
  });

  test.prop(
    [word, fc.stringMatching(/^[a-z0-9 ]{0,24}$/)],
    { numRuns: 50 },
  )("WQ5.2 a check answers with the verifier's judgment of the stored outcome", (outcome, result) => {
    const queue = new WorkQueue();
    expect(queue.add({ id: "item", outcome }).ok).toBe(true);
    const checked = queue.check("item", result, verifier);
    expect(checked.ok && checked.value).toBe(verifier(outcome, result));
    expect(queue.item("item")?.outcome).toBe(outcome);
  });
});
