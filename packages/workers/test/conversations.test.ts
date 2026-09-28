import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { MemoryStorage } from "@harness/testkit";
import { storedConversations } from "@harness/workers";

const said = (text: string): ModelMessage[] => [{ role: "user", content: [{ type: "text", text }] }];

describe("conversations kept in snapshot storage", () => {
  it("AW2.1 each session's conversation is saved, and a new store on the same storage (after a restart) loads it", async () => {
    const cell = { value: undefined as string | undefined };
    const first = storedConversations(new MemoryStorage(cell));
    await first.save("s1", said("one"));
    expect(await first.load("s1")).toEqual(said("one"));
    const again = storedConversations(new MemoryStorage(cell));
    expect(await again.load("s1")).toEqual(said("one"));
    expect(await again.load("s2")).toBeUndefined();
  });

  it("AW2.2 saves for different sessions at once all land: each save stores every session", async () => {
    const cell = { value: undefined as string | undefined };
    const store = storedConversations(new MemoryStorage(cell));
    await Promise.all([store.save("s1", said("one")), store.save("s2", said("two")), store.save("s1", said("three"))]);
    const again = storedConversations(new MemoryStorage(cell));
    expect([await again.load("s1"), await again.load("s2")]).toEqual([said("three"), said("two")]);
  });

  it("AW2.3 what is stored is plain JSON-shaped data; anything else there is no conversations", async () => {
    const cell = { value: undefined as string | undefined };
    await storedConversations(new MemoryStorage(cell)).save("s1", said("one"));
    expect(JSON.parse(cell.value!)).toEqual({ version: 1, sessions: { s1: said("one") } });
    for (const junk of [["x"], { version: 2, sessions: {} }, { version: 1, sessions: [] }, "text"]) {
      expect(await storedConversations(new MemoryStorage({ value: JSON.stringify(junk) })).load("s1")).toBeUndefined();
    }
  });

  it("AW2.4 a load that fails is tried again next time, not remembered as failed", async () => {
    let fail = true;
    const inner = new MemoryStorage({ value: JSON.stringify({ version: 1, sessions: { s1: said("kept") } }) });
    const storage = { load: () => (fail ? Promise.reject(new Error("busy")) : inner.load()), save: (v: unknown) => inner.save(v) };
    const store = storedConversations(storage);
    await expect(store.load("s1")).rejects.toThrow("busy");
    fail = false;
    expect(await store.load("s1")).toEqual(said("kept"));
  });
});
