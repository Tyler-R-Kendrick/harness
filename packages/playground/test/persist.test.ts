import { describe, expect, it } from "vitest";
import { Bash } from "just-bash";
import { Coalesced, parsePageState, parseTrace, reported, storableEvent, parseVfsSnapshot, resilient, restoreVfs, snapshotVfs } from "../src/persist.ts";
import { HOME, walk } from "../src/vfs.ts";

/** A walk's entries without their times (a restore writes files anew). */
const content = async (fs: Parameters<typeof walk>[0]) => new Map([...(await walk(fs, HOME))].map(([path, { mtime: _mtime, ...entry }]) => [path, entry]));

describe("the filesystem across reloads", () => {
  it("PS1.1 a snapshot keeps every file's bytes and every directory under the root; restoring it into a fresh shell reproduces them", async () => {
    const from = new Bash({ cwd: HOME, files: { [`${HOME}/a.txt`]: "alpha\n", [`${HOME}/d/e/f.md`]: "deep" } });
    await from.exec("mkdir -p empty/inner", { cwd: HOME });
    await from.fs.writeFile(`${HOME}/bin.dat`, new Uint8Array([0, 255, 7]));
    const snapshot = await snapshotVfs(from.fs, HOME);
    expect(Object.keys(snapshot.files).sort()).toEqual([`${HOME}/a.txt`, `${HOME}/bin.dat`, `${HOME}/d/e/f.md`]);
    expect(snapshot.dirs).toEqual([`${HOME}/d`, `${HOME}/d/e`, `${HOME}/empty`, `${HOME}/empty/inner`]);
    const to = new Bash({ cwd: HOME });
    await restoreVfs(to.fs, HOME, structuredClone(snapshot));
    expect(await content(to.fs)).toEqual(await content(from.fs));
    expect([...(await to.fs.readFileBuffer(`${HOME}/bin.dat`))]).toEqual([0, 255, 7]);
    expect((await to.fs.stat(`${HOME}/empty/inner`)).isDirectory).toBe(true);
  });

  it("PS1.2 restoring replaces what was under the root: what the snapshot lacks is removed", async () => {
    const bash = new Bash({ cwd: HOME, files: { [`${HOME}/keep.txt`]: "k" } });
    const snapshot = await snapshotVfs(bash.fs, HOME);
    await bash.exec("echo x > extra.txt; mkdir -p junk/sub; echo changed > keep.txt", { cwd: HOME });
    await restoreVfs(bash.fs, HOME, snapshot);
    expect([...(await walk(bash.fs, HOME)).keys()]).toEqual([`${HOME}/keep.txt`]);
    expect(await bash.readFile(`${HOME}/keep.txt`)).toBe("k");
    expect(await bash.fs.exists(`${HOME}/junk`)).toBe(false);
  });

  it("PS1.2b restoring creates the root when the shell has none yet (a shell started without files)", async () => {
    const snapshot = await snapshotVfs(new Bash({ cwd: HOME, files: { [`${HOME}/a.txt`]: "a" } }).fs, HOME);
    const bare = new Bash({ files: {} });
    await restoreVfs(bare.fs, HOME, snapshot);
    expect(await bare.readFile(`${HOME}/a.txt`)).toBe("a");
  });

  it("PS1.2c links are kept as links (dangling ones and ones to a parent too) and restored as links", async () => {
    const from = new Bash({ cwd: HOME, files: { [`${HOME}/a.txt`]: "a" } });
    await from.exec("mkdir d; ln -s ../a.txt d/alias; ln -s nowhere dangling; ln -s .. up", { cwd: HOME });
    const snapshot = await snapshotVfs(from.fs, HOME);
    expect(snapshot.links).toEqual({ [`${HOME}/d/alias`]: "../a.txt", [`${HOME}/dangling`]: "nowhere", [`${HOME}/up`]: ".." });
    const to = new Bash({ files: {} });
    await restoreVfs(to.fs, HOME, structuredClone(snapshot));
    expect(await to.fs.readlink(`${HOME}/up`)).toBe("..");
    expect(await to.readFile(`${HOME}/d/alias`)).toBe("a");
    expect(await content(to.fs)).toEqual(await content(from.fs));
  });

  it("PS1.3 a stored snapshot is parsed: anything but the current shape is no snapshot", () => {
    expect(parseVfsSnapshot({ version: 1, files: { "/a": new Uint8Array([1]) }, dirs: ["/d"] })).toEqual({ version: 1, files: { "/a": new Uint8Array([1]) }, dirs: ["/d"], links: {} });
    expect(parseVfsSnapshot({ version: 1, files: {}, dirs: [], links: { "/l": "t" } })?.links).toEqual({ "/l": "t" });
    for (const bad of [undefined, null, "x", { version: 2, files: {}, dirs: [] }, { version: 1, files: { "/a": "text" }, dirs: [] }, { version: 1, files: {}, dirs: [3] }, { version: 1, files: {}, dirs: [], links: { "/l": 1 } }]) expect(parseVfsSnapshot(bad)).toBeUndefined();
  });
});

describe("the page's own state across reloads", () => {
  const report = { stopReason: "end_turn", diff: { added: [], modified: ["/home/user/a"], removed: [] }, toolCalls: 1, modelCalls: 2, ms: 30 };

  it("PS2.1 the current session, the settings and the turns are parsed back; anything else is no state", () => {
    const state = { version: 1, sessionId: "ses_1", settings: { worker: "shell", tier: "quick", approval: "auto", generate: "off" }, turns: [{ prompt: "hi", report }] };
    expect(parsePageState(state)).toEqual(state);
    // A page kept before generation had a setting asks first.
    expect(parsePageState({ ...state, settings: { worker: "shell", tier: "quick", approval: "auto" } })?.settings.generate).toBe("ask");
    expect(parsePageState({ ...state, sessionId: undefined })).toEqual({ ...state, sessionId: undefined });
    for (const bad of [undefined, { ...state, version: 0 }, { ...state, settings: { ...state.settings, tier: "huge" } }, { ...state, settings: { ...state.settings, approval: "maybe" } }, { ...state, settings: { ...state.settings, generate: "always" } }, { ...state, turns: [{ prompt: 1, report }] }]) expect(parsePageState(bad)).toBeUndefined();
  });
});

describe("storage that may not work (a private window, a blocked site)", () => {
  it("PS4.1 a failed load is no state and a failed save is reported, never thrown", async () => {
    const errors: string[] = [];
    const broken = resilient({ load: () => Promise.reject(new Error("no IndexedDB")), save: async () => {} }, (e) => errors.push(e));
    expect(await broken.load()).toBeUndefined();
    const full = resilient({ load: async () => "kept", save: () => Promise.reject(new Error("quota")) }, (e) => errors.push(e));
    expect(await full.load()).toBe("kept");
    await full.save({});
    await full.clear();
    const odd = resilient({ load: () => Promise.reject("odd"), save: async () => {} }, (e) => errors.push(e));
    expect(await odd.load()).toBeUndefined();
    expect(errors).toEqual(["load failed: no IndexedDB", "save failed: quota", "save failed: quota", "load failed: odd"]);
  });

  it("PS4.2 storage that cannot even be opened is none", async () => {
    const errors: string[] = [];
    const none = resilient(() => {
      throw new Error("indexedDB is not defined");
    }, (e) => errors.push(e));
    expect(await none.load()).toBeUndefined();
    await none.save(1);
    expect(errors).toEqual(["storage unavailable: indexedDB is not defined"]);
  });
});

describe("storage whose reader has its own fallback (the agent worker's conversations)", () => {
  it("PS4.4 failures are reported and passed on, not turned into no state; storage that cannot be opened fails each call", async () => {
    const errors: string[] = [];
    const flaky = reported({ load: () => Promise.reject(new Error("busy")), save: () => Promise.reject(new Error("quota")) }, (e) => errors.push(e));
    await expect(flaky.load()).rejects.toThrow("busy");
    await expect(flaky.save(1)).rejects.toThrow("quota");
    let opened = 0;
    const none = reported(() => {
      opened++;
      throw new Error("indexedDB is not defined");
    }, (e) => errors.push(e));
    await expect(none.load()).rejects.toThrow("indexedDB is not defined");
    await expect(none.save(1)).rejects.toThrow("indexedDB is not defined");
    expect(opened).toBe(1);
    const fine = reported({ load: async () => "kept", save: async () => {} }, (e) => errors.push(e));
    expect(await fine.load()).toBe("kept");
    await fine.save(2);
    expect(errors).toEqual(["load failed: busy", "save failed: quota", "storage unavailable: indexedDB is not defined", "load failed: indexedDB is not defined", "save failed: indexedDB is not defined"]);
  });
});

describe("storage that could not be read", () => {
  it("PS4.3 after a failed load, saves are skipped (reported once), so what could not be read is not overwritten; clearing always writes", async () => {
    const errors: string[] = [];
    const writes: unknown[] = [];
    let failing = true;
    const storage = resilient({ load: () => (failing ? Promise.reject(new Error("busy")) : Promise.resolve("ok")), save: async (v) => void writes.push(v) }, (e) => errors.push(e));
    expect(await storage.load()).toBeUndefined();
    await storage.save(1);
    await storage.save(2);
    failing = false;
    expect(await storage.load()).toBe("ok");
    await storage.save(3);
    expect(writes).toEqual([3]);
    failing = true;
    await storage.load();
    await storage.clear();
    expect(writes).toEqual([3, undefined]);
    expect(errors).toEqual(["load failed: busy", "not saving: the stored value could not be read", "load failed: busy"]);
  });
});

describe("coalesced saves", () => {
  it("PS5.1 requests while a save runs become one more save, which sees the latest state; flush waits for them", async () => {
    let state = 0;
    const seen: number[] = [];
    let release: () => void = () => {};
    let first = true;
    let started: () => void = () => {};
    const running = new Promise<void>((r) => (started = r));
    const saver = new Coalesced(async () => {
      seen.push(state);
      if (first) {
        first = false;
        started();
        await new Promise<void>((r) => (release = r));
      }
    }, () => {});
    saver.request();
    await running;
    state = 1;
    saver.request();
    state = 2;
    saver.request();
    release();
    await saver.flush();
    expect(seen).toEqual([0, 2]);
    saver.request();
    await saver.flush();
    expect(seen).toEqual([0, 2, 2]);
  });

  it("PS5.2 a failed save is reported and does not stop later ones", async () => {
    const seen: string[] = [];
    const errors: string[] = [];
    let fail: unknown = new Error("once");
    const saver = new Coalesced(
      async () => {
        if (fail !== undefined) {
          const e = fail;
          fail = undefined;
          throw e;
        }
        seen.push("saved");
      },
      (e) => errors.push(e),
    );
    saver.request();
    await saver.flush();
    saver.request();
    await saver.flush();
    fail = "odd";
    saver.request();
    await saver.flush();
    expect(seen).toEqual(["saved"]);
    expect(errors).toEqual(["save failed: once", "save failed: odd"]);
  });
});

describe("the timeline across reloads", () => {
  const event = { seq: 3, at: 1000, kind: "acp" as const, name: "result #1", direction: "out" as const, sessionId: "s", detail: { jsonrpc: "2.0", id: 1, result: {} } };

  it("PS6.1 an event is stored as plain data: bytes are named by their size, and a detail too large to keep is cut to a preview", () => {
    expect(storableEvent(event)).toEqual(event);
    expect(storableEvent({ ...event, detail: { image: new Uint8Array(3) } }).detail).toEqual({ image: "[3 bytes]" });
    const big = storableEvent({ ...event, detail: "x".repeat(50) }, { maxDetail: 20 });
    expect(big.detail).toEqual({ cut: "52 characters", preview: `"${"x".repeat(19)}` });
    expect(storableEvent({ seq: 1, at: 0, kind: "host", name: "no detail" })).toEqual({ seq: 1, at: 0, kind: "host", name: "no detail" });
  });

  it("PS6.2 a detail that cannot be written as JSON is kept as a note; one JSON has no value for is left out", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(storableEvent({ ...event, detail: circular }).detail).toEqual({ unstorable: expect.stringMatching(/circular/i) });
    expect("detail" in storableEvent({ ...event, detail: () => 1 })).toBe(false);
  });

  it("PS6.3 a stored timeline is parsed back; anything else, or an event of the wrong shape, is no timeline", () => {
    expect(parseTrace({ version: 1, events: [event] })).toEqual([event]);
    for (const bad of [undefined, { version: 2, events: [] }, { version: 1, events: [{ ...event, kind: "nope" }] }, { version: 1, events: [{ ...event, seq: "3" }] }]) expect(parseTrace(bad)).toBeUndefined();
  });
});
