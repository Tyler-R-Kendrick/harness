import { describe, expect, it } from "vitest";
import { daemonFacts, hookSourceOver, permissionFactsOf } from "../src/plugin.ts";
import type { DaemonReads, ToolCallLike } from "../src/plugin.ts";

describe("permissionFactsOf", () => {
  const call = (patch: Partial<ToolCallLike> = {}): ToolCallLike => ({ toolCallId: "call-1", ...patch });

  it("DPL8.1 the tool is the call's title (its id when it has none), the kind its kind, and the session and working directory come from the daemon", () => {
    expect(permissionFactsOf("s1", "/w", call({ title: "Run tests", kind: "execute" }))).toStrictEqual({ tool: "Run tests", kind: "execute", cwd: "/w", session: "s1" });
    expect(permissionFactsOf("s1", undefined, call())).toStrictEqual({ tool: "call-1", session: "s1" });
    expect(permissionFactsOf("s1", "/w", call({ title: null, kind: null }))).toStrictEqual({ tool: "call-1", cwd: "/w", session: "s1" });
    expect(permissionFactsOf("s1", "/w", call({ title: "", kind: "" }))).toStrictEqual({ tool: "call-1", cwd: "/w", session: "s1" });
  });

  it("DPL8.2 the command, path and url are what the tool was given", () => {
    const facts = permissionFactsOf("s1", "/w", call({ title: "t", rawInput: { command: "ls", path: "/w/a", url: "https://x.test" } }));
    expect(facts).toStrictEqual({ tool: "t", command: "ls", path: "/w/a", url: "https://x.test", cwd: "/w", session: "s1", input: { command: "ls", path: "/w/a", url: "https://x.test" } });
    expect(permissionFactsOf("s1", "/w", call({ rawInput: { other: 1 } }))).toStrictEqual({ tool: "call-1", cwd: "/w", session: "s1", input: { other: 1 } });
  });

  it("DPL8.3 a path may be called file_path or filePath, or be the first location of the call; an input's path comes first", () => {
    expect(permissionFactsOf("s", "/", call({ rawInput: { file_path: "/a" } })).path).toBe("/a");
    expect(permissionFactsOf("s", "/", call({ rawInput: { filePath: "/b" } })).path).toBe("/b");
    expect(permissionFactsOf("s", "/", call({ locations: [{ path: "/c" }, { path: "/d" }] })).path).toBe("/c");
    expect(permissionFactsOf("s", "/", call({ rawInput: { path: "/e", file_path: "/f" }, locations: [{ path: "/g" }] })).path).toBe("/e");
    expect(permissionFactsOf("s", "/", call({ rawInput: { path: 5 }, locations: [] })).path).toBeUndefined();
    expect("path" in permissionFactsOf("s", "/", call({ locations: null }))).toBe(false);
  });

  it("DPL8.4 what the tool was given is kept as JSON, and anything that is not JSON is null; an input that is not an object is left out", () => {
    const facts = permissionFactsOf("s", "/", call({ rawInput: { n: 1, f: () => 1, u: undefined, inf: Number.POSITIVE_INFINITY, list: [1, "a", null], nested: { ok: true } } }));
    expect(facts.input).toEqual({ n: 1, f: null, u: null, inf: null, list: [1, "a", null], nested: { ok: true } });
    expect("input" in permissionFactsOf("s", "/", call({ rawInput: "ls -la" }))).toBe(false);
    expect("input" in permissionFactsOf("s", "/", call({ rawInput: ["a"] }))).toBe(false);
    expect("input" in permissionFactsOf("s", "/", call({ rawInput: null }))).toBe(false);
  });

  it("DPL8.5 nothing deeper than eight levels is kept, in objects or in arrays", () => {
    let nested: unknown = { x: 1 };
    for (let i = 0; i < 8; i++) nested = { n: nested };
    // nine objects: the ninth is at depth 8
    expect(permissionFactsOf("s", "/", call({ rawInput: nested })).input).toEqual({ n: { n: { n: { n: { n: { n: { n: { n: null } } } } } } } });
    let eight: unknown = { x: 1 };
    for (let i = 0; i < 7; i++) eight = { n: eight };
    expect(JSON.stringify(permissionFactsOf("s", "/", call({ rawInput: eight })).input)).toContain('{"x":1}');
    let listed: unknown = ["leaf"];
    for (let i = 0; i < 8; i++) listed = [listed];
    let kept: unknown = null;
    for (let i = 0; i < 7; i++) kept = [kept];
    expect(permissionFactsOf("s", "/", call({ rawInput: { list: listed } })).input).toEqual({ list: kept });
  });
});

describe("hookSourceOver", () => {
  function recorder(results: Record<string, unknown> = {}) {
    const calls: [string, Record<string, unknown>][] = [];
    const source = hookSourceOver(async (method, params) => (calls.push([method, params]), results[method] ?? {}));
    return { calls, source };
  }

  it("DPL9.1 subscribing, polling and acknowledging are the daemon's hook methods with their parameters", async () => {
    const { calls, source } = recorder({ "_harness/hooks/poll": { events: [] } });
    await source.subscribe({ types: ["a.b"] });
    await source.subscribe({ types: ["a.b"] }, 4);
    await source.poll();
    await source.poll(10);
    await source.ack(7);
    expect(calls).toStrictEqual([
      ["_harness/hooks/subscribe", { types: ["a.b"] }],
      ["_harness/hooks/subscribe", { types: ["a.b"], from: 4 }],
      ["_harness/hooks/poll", {}],
      ["_harness/hooks/poll", { max: 10 }],
      ["_harness/hooks/ack", { offset: 7 }],
    ]);
  });

  it("DPL9.2 the events a poll gives are passed on with everything they carry", async () => {
    const event = { eventId: "evt-0", offset: 0, type: "turn.ended", source: "daemon", sessionId: "s1", correlationId: "cor-0", causationId: "x", depth: 0, at: 5, payload: { a: 1 } };
    const { source } = recorder({ "_harness/hooks/poll": { events: [event] } });
    expect((await source.poll()).events).toEqual([event]);
  });

  it("DPL9.3 a poll result that is not a list of events is refused, saying so", async () => {
    for (const bad of [{}, { events: "no" }, { events: [{ offset: 1 }] }, { events: [{ eventId: "e", offset: -1, type: "t" }] }]) {
      const { source } = recorder({ "_harness/hooks/poll": bad });
      await expect(source.poll()).rejects.toThrow("the daemon's poll result is not a list of events");
    }
  });

  it("DPL9.4 a failing call fails the method", async () => {
    const source = hookSourceOver(async () => {
      throw new Error("not a plugin");
    });
    await expect(source.subscribe({ types: [] })).rejects.toThrow("not a plugin");
    await expect(source.poll()).rejects.toThrow("not a plugin");
    await expect(source.ack(1)).rejects.toThrow("not a plugin");
  });
});

describe("daemonFacts", () => {
  const reads = (): DaemonReads & { readonly asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      pendingPermission: (s, r) =>
        (asked.push(`pending ${s}/${r}`),
        (s === "s1" || s === "s2") && r === "p1" ? { toolCall: { toolCallId: "t", title: "Bash", rawInput: { command: "ls" } }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" } as { optionId: string; kind: string }] } : undefined),
      readLog: (s, from) => (asked.push(`log ${s} ${from}`), [{ offset: 0, at: 1, kind: "event", payload: {} }]),
      sessions: () => [{ id: "s1", cwd: "/work" }, { id: "s2", cwd: "/other" }],
    };
  };

  it("DPL10.1 an open request is the facts of its tool call in its session's working directory; a request that is not open has none", () => {
    const facts = daemonFacts(reads());
    expect(facts.permission("s1", "p1")).toEqual({ tool: "Bash", command: "ls", cwd: "/work", session: "s1", input: { command: "ls" } });
    expect(facts.permission("s2", "p1")).toEqual({ tool: "Bash", command: "ls", cwd: "/other", session: "s2", input: { command: "ls" } });
    expect(facts.permission("s1", "nope")).toBeUndefined();
  });

  it("DPL10.2 the options offered are their ids and kinds only", () => {
    const facts = daemonFacts(reads());
    expect(facts.permissionOptions!("s1", "p1")).toEqual([{ optionId: "allow", kind: "allow_once" }]);
    expect(facts.permissionOptions!("s1", "nope")).toBeUndefined();
  });

  it("DPL10.3 the log is read after the offset given, and the sessions are listed by id", () => {
    const r = reads();
    const facts = daemonFacts(r);
    expect(facts.log("s1", 3)).toEqual([{ offset: 0, at: 1, kind: "event", payload: {} }]);
    facts.log("s1");
    expect(r.asked).toEqual(["log s1 4", "log s1 0"]);
    expect(facts.sessions()).toEqual([{ id: "s1" }, { id: "s2" }]);
  });

  it("DPL10.4 a request in a session the daemon does not list has no working directory", () => {
    const r = reads();
    const facts = daemonFacts({ ...r, sessions: () => [] });
    expect("cwd" in facts.permission("s1", "p1")!).toBe(false);
  });
});
