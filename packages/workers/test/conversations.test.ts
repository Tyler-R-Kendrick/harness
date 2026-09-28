import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import type { SnapshotStorage } from "@harness/core";
import { MemoryStorage } from "@harness/testkit";
import { storedConversations } from "@harness/workers";

const said = (text: string): ModelMessage[] => [{ role: "user", content: [{ type: "text", text }] }];

/** One JSON cell per session, as files or IndexedDB keys would be. */
function cells() {
  const all = new Map<string, { value: string | undefined }>();
  const cell = (id: string) => all.get(id) ?? (all.set(id, { value: undefined }), all.get(id)!);
  return { all, storageFor: (id: string): SnapshotStorage => new MemoryStorage(cell(id)) };
}

describe("conversations kept in snapshot storage, a record per session", () => {
  it("AW2.1 each session's conversation is saved in its own record, and a new store on the same storage (after a restart) loads it", async () => {
    const { all, storageFor } = cells();
    await storedConversations(storageFor).save("s1", said("one"));
    const again = storedConversations(storageFor);
    expect(await again.load("s1")).toEqual(said("one"));
    expect(await again.load("s2")).toBeUndefined();
    expect([...all.keys()]).toEqual(["s1", "s2"]);
  });

  it("AW2.2 saves of one session land in the order made; other sessions' records are not written", async () => {
    const { all, storageFor } = cells();
    const store = storedConversations(storageFor);
    await Promise.all([store.save("s1", said("one")), store.save("s1", said("two")), store.save("s2", said("other"))]);
    expect(await storedConversations(storageFor).load("s1")).toEqual(said("two"));
    await store.save("s2", said("again"));
    expect(JSON.parse(all.get("s1")!.value!)).toEqual({ version: 1, messages: said("two") });
  });

  it("AW2.3 what is stored is plain JSON-shaped data; anything else there is no conversation", async () => {
    for (const junk of [["x"], { version: 2, messages: [] }, { version: 1, messages: {} }, "text"]) {
      expect(await storedConversations(() => new MemoryStorage({ value: JSON.stringify(junk) })).load("s1")).toBeUndefined();
    }
  });

  it("AW2.4 a load that fails fails that load only: the next one reads again", async () => {
    let fail = true;
    const inner = new MemoryStorage({ value: JSON.stringify({ version: 1, messages: said("kept") }) });
    const store = storedConversations(() => ({ load: () => (fail ? Promise.reject(new Error("busy")) : inner.load()), save: (v) => inner.save(v) }));
    await expect(store.load("s1")).rejects.toThrow("busy");
    fail = false;
    expect(await store.load("s1")).toEqual(said("kept"));
  });

  it("AW2.5 a save that fails does not stop later saves of that session", async () => {
    let fail = true;
    const inner = new MemoryStorage();
    const store = storedConversations(() => ({ load: () => inner.load(), save: (v) => (fail ? Promise.reject(new Error("disk full")) : inner.save(v)) }));
    await expect(store.save("s1", said("lost"))).rejects.toThrow("disk full");
    fail = false;
    await store.save("s1", said("kept"));
    expect(await store.load("s1")).toEqual(said("kept"));
  });
});
