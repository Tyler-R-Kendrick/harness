import { describe, expect, it } from "vitest";
import { WorkQueue } from "@harness/core";
import type { SourceConnection, SourceEvent, SourcePage } from "@harness/core";

/** A scripted external source: tests drop and resume it, and can redeliver an event. */
class ScriptedSource implements SourceConnection {
  dropped = false;
  /** When set, the next open read returns these events instead of the cursor slice. */
  replay: readonly SourceEvent[] | undefined;
  readonly #events: SourceEvent[] = [];
  /** Every cursor the queue asked to read from, including a dropped read. */
  readonly reads: (string | undefined)[] = [];

  emit(event: SourceEvent): void {
    this.#events.push(event);
  }

  read(cursor: string | undefined): SourcePage {
    this.reads.push(cursor);
    if (this.dropped) return { open: false };
    if (this.replay !== undefined) {
      const events = this.replay;
      this.replay = undefined;
      return { open: true, cursor: String(this.#events.length), events };
    }
    const from = cursor === undefined ? 0 : Number(cursor);
    return { open: true, cursor: String(this.#events.length), events: this.#events.slice(from) };
  }
}

const OUTCOME = "the release notes name the button";

/** Accepts a result that states the outcome, and rejects one that contradicts it. */
function scriptedVerifier(outcome: string, result: string): boolean {
  return outcome === OUTCOME && result.includes(outcome) && !result.includes(`not: ${outcome}`);
}

describe("WorkQueue", () => {
  it("WQ1.1 an item keeps the outcome description it was added with", () => {
    const queue = new WorkQueue();
    expect(queue.add({ id: "item-1", outcome: OUTCOME }).ok).toBe(true);
    expect(queue.item("item-1")?.outcome).toBe(OUTCOME);
    expect(queue.inbox()).toEqual([]);
  });

  it("WQ1.3 checking an unknown item is refused", () => {
    const queue = new WorkQueue();
    const checked = queue.check("missing", "shipped: " + OUTCOME, scriptedVerifier);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.code).toBe("unknown_item");
  });

  it("WQ1.4 adding an item id twice is refused and the first outcome stays", () => {
    const queue = new WorkQueue();
    queue.add({ id: "item-1", outcome: OUTCOME });
    const again = queue.add({ id: "item-1", outcome: "a different outcome" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("duplicate_item");
    expect(queue.item("item-1")?.outcome).toBe(OUTCOME);
  });

  it("WQ1.2 a scripted verifier accepts a result that meets the outcome and rejects one that contradicts it", () => {
    const queue = new WorkQueue();
    queue.add({ id: "item-1", outcome: "the release notes name the button" });
    const met = queue.check("item-1", "shipped: the release notes name the button", scriptedVerifier);
    const contradicted = queue.check("item-1", "not: the release notes name the button", scriptedVerifier);
    expect(met.ok && met.value).toBe(true);
    expect(contradicted.ok && contradicted.value).toBe(false);
  });

  it("WQ2.1 a source filter keeps a matching event and drops one it rejects", () => {
    const queue = new WorkQueue();
    const source = new ScriptedSource();
    expect(queue.connect("issues", source, (event) => event.body.startsWith("bug:")).ok).toBe(true);
    source.emit({ id: "e1", body: "bug: login fails" });
    source.emit({ id: "e2", body: "chore: readme" });
    const accepted = queue.ingest("issues");
    expect(accepted.ok && accepted.value.map((item) => item.id)).toEqual(["e1"]);
    expect(queue.inbox().map((item) => item.outcome)).toEqual(["bug: login fails"]);
    expect(queue.item("e1")?.outcome).toBe("bug: login fails");
  });

  it("WQ2.2 after the connection drops and resumes, a new matching event arrives once and a delivered event is not duplicated", () => {
    const queue = new WorkQueue();
    const source = new ScriptedSource();
    queue.connect("issues", source, (event) => event.body.startsWith("bug:"));
    source.emit({ id: "e1", body: "bug: login fails" });
    expect(queue.ingest("issues").ok).toBe(true);

    source.dropped = true;
    source.emit({ id: "e3", body: "bug: later" });
    const dropped = queue.ingest("issues");
    expect(dropped.ok && dropped.value).toEqual([]);

    source.dropped = false;
    source.replay = [
      { id: "e1", body: "bug: login fails" },
      { id: "e3", body: "bug: later" },
    ];
    const resumed = queue.ingest("issues");
    expect(resumed.ok && resumed.value.map((item) => item.id)).toEqual(["e3"]);
    expect(queue.inbox().map((item) => item.id)).toEqual(["e1", "e3"]);

    const again = queue.ingest("issues");
    expect(again.ok && again.value).toEqual([]);
    expect(queue.inbox().map((item) => item.id)).toEqual(["e1", "e3"]);
  });

  it("WQ2.3 a dropped read does not move the cursor, and the resumed read asks for what follows it", () => {
    const queue = new WorkQueue();
    const source = new ScriptedSource();
    queue.connect("issues", source, () => true);
    source.emit({ id: "e1", body: "bug: one" });
    expect(queue.ingest("issues").ok).toBe(true);

    source.dropped = true;
    source.emit({ id: "e2", body: "bug: two" });
    const dropped = queue.ingest("issues");
    expect(dropped.ok && dropped.value).toEqual([]);

    source.dropped = false;
    const resumed = queue.ingest("issues");
    expect(resumed.ok && resumed.value.map((item) => item.id)).toEqual(["e2"]);
    expect(source.reads).toEqual([undefined, "1", "1"]);
  });

  it("WQ2.4 a source with no filter keeps every event", () => {
    const queue = new WorkQueue();
    const source = new ScriptedSource();
    expect(queue.connect("issues", source).ok).toBe(true);
    source.emit({ id: "e1", body: "anything" });
    source.emit({ id: "e2", body: "else" });
    const accepted = queue.ingest("issues");
    expect(accepted.ok && accepted.value.map((item) => item.id)).toEqual(["e1", "e2"]);
  });

  it("WQ2.5 ingesting an unknown source is refused", () => {
    const ingested = new WorkQueue().ingest("missing");
    expect(ingested.ok).toBe(false);
    if (!ingested.ok) expect(ingested.error.code).toBe("unknown_source");
  });

  it("WQ2.6 connecting a source id twice is refused", () => {
    const queue = new WorkQueue();
    const source = new ScriptedSource();
    const connected = queue.connect("issues", source);
    expect(connected.ok && connected.value).toBe(true);
    const again = queue.connect("issues", new ScriptedSource());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("duplicate_source");
  });

  it("WQ2.7 the cursor advances past events the filter rejected", () => {
    const queue = new WorkQueue();
    const source = new ScriptedSource();
    queue.connect("issues", source, (event) => event.body.startsWith("bug:"));
    source.emit({ id: "e1", body: "bug: login fails" });
    source.emit({ id: "e2", body: "chore: readme" });
    expect(queue.ingest("issues").ok).toBe(true);
    source.emit({ id: "e3", body: "bug: later" });
    const next = queue.ingest("issues");
    expect(next.ok && next.value.map((item) => item.id)).toEqual(["e3"]);
    expect(source.reads).toEqual([undefined, "2"]);
  });

  it("WQ3.1 a restored queue keeps outcomes, the cursor, delivered events, and the attached filter", () => {
    const queue = new WorkQueue();
    const source = new ScriptedSource();
    queue.add({ id: "item-1", outcome: OUTCOME });
    queue.connect("issues", source, (event) => event.body.startsWith("bug:"));
    source.emit({ id: "e1", body: "bug: one" });
    source.emit({ id: "e2", body: "chore: skip" });
    expect(queue.ingest("issues").ok).toBe(true);

    const restored = WorkQueue.fromJSON(queue.toJSON());
    expect(restored.item("item-1")?.outcome).toBe(OUTCOME);
    expect(restored.inbox().map((item) => item.id)).toEqual(["e1"]);

    const again = new ScriptedSource();
    again.replay = [
      { id: "e1", body: "bug: one" },
      { id: "e4", body: "chore: no" },
      { id: "e5", body: "bug: more" },
    ];
    expect(restored.attach("issues", again, (event) => event.body.startsWith("bug:")).ok).toBe(true);
    const ingested = restored.ingest("issues");
    expect(ingested.ok && ingested.value.map((item) => item.id)).toEqual(["e5"]);
    expect(again.reads).toEqual(["2"]);
    expect(restored.inbox().map((item) => item.id)).toEqual(["e1", "e5"]);
  });

  it("WQ3.2 a snapshot that is not queue data is refused", () => {
    const invalid: unknown[] = [
      null,
      {},
      { items: null, inbox: [], sources: [] },
      { items: [null], inbox: [], sources: [] },
      { items: [{ id: 1, outcome: "x" }], inbox: [], sources: [] },
      { items: [{ id: "a", outcome: 1 }], inbox: [], sources: [] },
      { items: [{ id: "a", outcome: "x" }, { id: "a", outcome: "y" }], inbox: [], sources: [] },
      { items: [], inbox: [1], sources: [] },
      { items: [], inbox: ["missing"], sources: [] },
      { items: [{ id: "a", outcome: "x" }], inbox: ["a", "a"], sources: [] },
      { items: [], inbox: [], sources: [null] },
      { items: [], inbox: [], sources: [{ id: 1, cursor: null, delivered: [] }] },
      { items: [], inbox: [], sources: [{ id: "s", cursor: 1, delivered: [] }] },
      { items: [], inbox: [], sources: [{ id: "s", cursor: null, delivered: [1] }] },
      {
        items: [],
        inbox: [],
        sources: [
          { id: "s", cursor: null, delivered: [] },
          { id: "s", cursor: null, delivered: [] },
        ],
      },
    ];
    for (const data of invalid) expect(() => WorkQueue.fromJSON(data)).toThrow("invalid work queue data");
  });

  it("WQ3.3 ingest before the restored source is reattached is refused", () => {
    const queue = new WorkQueue();
    queue.connect("issues", new ScriptedSource());
    const restored = WorkQueue.fromJSON(queue.toJSON());
    const ingested = restored.ingest("issues");
    expect(ingested.ok).toBe(false);
    if (!ingested.ok) expect(ingested.error.code).toBe("detached");
  });

  it("WQ3.4 attaching a source the snapshot does not have is refused", () => {
    const restored = WorkQueue.fromJSON({ items: [], inbox: [], sources: [] });
    const attached = restored.attach("issues", new ScriptedSource());
    expect(attached.ok).toBe(false);
    if (!attached.ok) expect(attached.error.code).toBe("unknown_source");
  });

  it("WQ3.5 attaching a source that is already attached is refused", () => {
    const queue = new WorkQueue();
    queue.connect("issues", new ScriptedSource());
    const restored = WorkQueue.fromJSON(queue.toJSON());
    const attached = restored.attach("issues", new ScriptedSource());
    expect(attached.ok && attached.value).toBe(true);
    const again = restored.attach("issues", new ScriptedSource());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("duplicate_source");
  });

  it("WQ3.6 reattaching without a filter keeps every later event", () => {
    const queue = new WorkQueue();
    queue.connect("issues", new ScriptedSource(), () => false);
    const restored = WorkQueue.fromJSON(queue.toJSON());
    const next = new ScriptedSource();
    next.emit({ id: "e1", body: "anything" });
    expect(restored.attach("issues", next).ok).toBe(true);
    const ingested = restored.ingest("issues");
    expect(ingested.ok && ingested.value.map((item) => item.id)).toEqual(["e1"]);
    expect(next.reads).toEqual([undefined]);
  });

  it("WQ3.7 a restored delivered id is not ingested even when that id is not an item", () => {
    const restored = WorkQueue.fromJSON({
      items: [],
      inbox: [],
      sources: [{ id: "issues", cursor: "1", delivered: ["e1"] }],
    });
    const source = new ScriptedSource();
    source.replay = [{ id: "e1", body: "bug: one" }];
    expect(restored.attach("issues", source).ok).toBe(true);
    const ingested = restored.ingest("issues");
    expect(ingested.ok && ingested.value).toEqual([]);
    expect(restored.inbox()).toEqual([]);
  });

  it("WQ4.1 the first event with a repeated id is kept and the later copy is not a second inbox item", () => {
    const queue = new WorkQueue();
    const source = new ScriptedSource();
    source.emit({ id: "e1", body: "first body" });
    source.emit({ id: "e1", body: "second body" });
    queue.connect("issues", source);
    const ingested = queue.ingest("issues");
    expect(ingested.ok && ingested.value.map((item) => item.outcome)).toEqual(["first body"]);
    expect(queue.inbox().map((item) => item.id)).toEqual(["e1"]);
    expect(queue.item("e1")?.outcome).toBe("first body");
  });

  it("WQ4.2 an event whose id is already a work item does not replace that item or enter the inbox", () => {
    const queue = new WorkQueue();
    expect(queue.add({ id: "e1", outcome: "manual outcome" }).ok).toBe(true);
    const source = new ScriptedSource();
    source.emit({ id: "e1", body: "from the source" });
    queue.connect("issues", source);
    const ingested = queue.ingest("issues");
    expect(ingested.ok && ingested.value).toEqual([]);
    expect(queue.inbox()).toEqual([]);
    expect(queue.item("e1")?.outcome).toBe("manual outcome");
    source.replay = [{ id: "e1", body: "from the source" }];
    const replayed = queue.ingest("issues");
    expect(replayed.ok && replayed.value).toEqual([]);
    expect(queue.item("e1")?.outcome).toBe("manual outcome");
    expect(queue.toJSON().sources[0]?.delivered).toEqual(["e1"]);
  });

  it("WQ4.3 the same event id from a second source is not a second inbox item", () => {
    const queue = new WorkQueue();
    const first = new ScriptedSource();
    const second = new ScriptedSource();
    first.emit({ id: "e1", body: "from the first source" });
    second.emit({ id: "e1", body: "from the second source" });
    queue.connect("issues", first);
    queue.connect("mail", second);
    expect(queue.ingest("issues").ok).toBe(true);
    const ingested = queue.ingest("mail");
    expect(ingested.ok && ingested.value).toEqual([]);
    expect(queue.inbox().map((item) => item.outcome)).toEqual(["from the first source"]);
    expect(queue.item("e1")?.outcome).toBe("from the first source");
  });
});
