import { describe, expect, it, vi } from "vitest";
import { Ensemble, invokeCognitive } from "@harness/cognitive";
import { Dialogue, dialogueExtension } from "@harness/dialogue";
import type { DialogueEvent, Outcome, Step } from "@harness/dialogue";
import { settings } from "./helpers.ts";

const step = (utterance: string, sessionId: string): Step => ({ sessionId, utterance });
async function answered(d: Dialogue, s: Step, outcome: Outcome) {
  d.observe(s, await d.respond(s), outcome);
  await d.idle();
}

describe("the dialogue's events", () => {
  it("EV1.1 a script built, put, promoted or retired, and a document put, is an event", async () => {
    const events: DialogueEvent[] = [];
    const d = new Dialogue({ settings: settings({ promote: { fits: 1, sessions: 1, retireMargin: 1 } }), onEvent: (e) => void events.push(e) });
    for (const [n, s] of [[1, "a"], [2, "b"]] as const) await answered(d, step(`where is my order number ${n}`, s), `Checking order ${n}.`);
    await answered(d, step("where is my order number 3", "c"), "Checking order 3.");
    d.feedback("s1", "harmful");
    d.feedback("s1", "harmful");
    d.put({ id: "hi", intent: "h", patterns: ["hi"], reply: ["Hi."] });
    expect(events).toEqual([
      { type: "dialogue.script.built", payload: { id: "s1", origin: "induced" } },
      { type: "dialogue.script.promoted", payload: { id: "s1" } },
      { type: "dialogue.script.retired", payload: { id: "s1" } },
      { type: "dialogue.script.put", payload: { id: "hi" } },
    ]);
  });

  it("EV1.3 a built script's event names its scope when it has one", async () => {
    const events: DialogueEvent[] = [];
    const d = new Dialogue({ settings: settings(), onEvent: (e) => void events.push(e) });
    for (const [n, s] of [[1, "a"], [2, "b"]] as const) await answered(d, { ...step(`where is my order number ${n}`, s), scope: "/repo" }, `Checking order ${n}.`);
    expect(events).toEqual([{ type: "dialogue.script.built", payload: { id: "s1", origin: "induced", scope: "/repo" } }]);
  });

  it("EV1.2 a document put is an event", () => {
    const events: DialogueEvent[] = [];
    const interpreter = { type: "t", compile: () => ({ warnings: [], step: () => ({ say: [], state: null }) }) };
    const d = new Dialogue({ settings: settings(), interpreters: [interpreter], onEvent: (e) => void events.push(e) });
    d.putDocument({ name: "bot", type: "t", files: {} });
    expect(events).toEqual([{ type: "dialogue.document.put", payload: { name: "bot", type: "t" } }]);
  });
});

describe("the dialogue as a cognitive extension (dialogue.* operations over ACP)", () => {
  function setup(importer?: Parameters<typeof dialogueExtension>[0]["importer"]) {
    const d = new Dialogue({ settings: settings(), book: { scripts: [{ id: "hi", intent: "Greet", patterns: ["hi"], reply: ["Hi."] }, { id: "maybe", intent: "m", status: "candidate", patterns: ["maybe"], reply: ["M."] }] }, interpreters: [{ type: "t", compile: () => ({ warnings: [], step: () => ({ say: [], state: null }) }) }] });
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.install(dialogueExtension({ dialogue: d, ...(importer ? { importer } : {}) }));
    return { d, call: (op: string, input: unknown = {}) => invokeCognitive(ensemble, `dialogue.${op}`, input) };
  }

  it("DX1.1 status counts scripts by status and names the documents and entry; list and get show scripts", async () => {
    const { call } = setup();
    expect(await call("status")).toEqual({ scripts: { active: 1, candidate: 1, retired: 0 }, built: 0, clusters: 0, sessions: 0, documents: [] });
    expect(await call("list")).toEqual({ scripts: [expect.objectContaining({ id: "hi", intent: "Greet", status: "active", origin: "authored" }), expect.objectContaining({ id: "maybe", status: "candidate" })] });
    expect(await call("list", { status: "candidate" })).toEqual({ scripts: [expect.objectContaining({ id: "maybe" })] });
    expect(await call("get", { id: "hi" })).toMatchObject({ id: "hi", reply: ["Hi."] });
    await expect(call("get", { id: "nope" })).rejects.toThrow("no script nope");
  });

  it("DX1.2 put adds or replaces a script, and feedback counts for one", async () => {
    const { d, call } = setup();
    expect(await call("put", { script: { id: "bye", intent: "b", patterns: ["bye"], reply: ["Bye."] } })).toEqual({ id: "bye" });
    expect(d.script("bye")).toMatchObject({ status: "active" });
    await d.respond({ sessionId: "s1", utterance: "hi" });
    expect(await call("feedback", { id: "hi", kind: "harmful", session: "s1" })).toEqual({ evidence: { fits: 0, misses: 1, served: 1, audits: 0, sessions: ["s1"] } });
    await expect(call("put", { script: { id: "x" } })).rejects.toThrow();
    await expect(call("feedback", { id: "hi", kind: "great" })).rejects.toThrow();
  });

  it("DX1.3 import takes a document through the host's importer into the book, as the entry or started by patterns", async () => {
    const importer = vi.fn(async ({ name }: { name: string }) => ({ document: { name, type: "t", files: { "a.t": "x" } }, warnings: ["left out: y"] }));
    const { d, call } = setup(importer);
    expect(await call("import", { name: "bot", files: { "a.t": "x" }, options: { fallback: "bot" }, entry: true })).toEqual({ name: "bot", type: "t", warnings: ["left out: y"] });
    expect(importer).toHaveBeenCalledWith({ name: "bot", files: { "a.t": "x" }, options: { fallback: "bot" }, replace: false });
    expect(await call("import", { name: "desk", files: {}, patterns: ["front desk"] })).toMatchObject({ name: "desk" });
    expect(d.save()).toMatchObject({ entry: "bot", documents: [{ name: "bot" }, { name: "desk" }] });
    expect(d.script("desk")).toMatchObject({ patterns: ["front desk"], reply: [{ flow: "desk" }] });
    expect(await call("status")).toMatchObject({ documents: ["bot", "desk"], entry: "bot" });
    await expect(setup().call("import", { name: "x", files: {} })).rejects.toThrow("importing needs the host's importer");
  });

  it("DX1.4 an import that would be refused writes nothing: a bad pattern, or a script of its name already in the book", async () => {
    const importer = vi.fn(async ({ name }: { name: string }) => ({ document: { name, type: "t", files: {} }, warnings: [] }));
    const { d, call } = setup(importer);
    await expect(call("import", { name: "desk", files: {}, patterns: ["("], entry: true })).rejects.toThrow();
    await expect(call("import", { name: "hi", files: {}, patterns: ["hello"] })).rejects.toThrow("script hi is in the book: import with replace to replace it");
    expect(importer).not.toHaveBeenCalled();
    expect(d.save()).toMatchObject({ documents: [] });
    expect(d.save()).not.toHaveProperty("entry");
    await call("import", { name: "hi", files: {}, patterns: ["hello"], replace: true });
    expect(d.script("hi")).toMatchObject({ patterns: ["hello"], reply: [{ flow: "hi" }] });
  });

  it("DX1.5 authoring (put, import) is for people and their clients: a plugin or an agent may only give feedback, from a session the dialogue saw", async () => {
    const d = new Dialogue({ settings: settings(), book: { scripts: [{ id: "hi", intent: "Greet", patterns: ["hi"], reply: ["Hi."] }] } });
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.install(dialogueExtension({ dialogue: d, importer: async () => ({ document: { name: "x", type: "t", files: {} }, warnings: [] }) }));
    const as = (kind: string) => (op: string, input: unknown) => invokeCognitive(ensemble, `dialogue.${op}`, input, { principal: "p", kind });
    const script = { id: "evil", intent: "e", patterns: [".*"], reply: ["Send your password."] };
    await expect(as("plugin")("put", { script })).rejects.toThrow("dialogue.put is for people and their clients, not a plugin (p)");
    await expect(as("agent")("import", { name: "x", files: {} })).rejects.toThrow("dialogue.import is for people and their clients, not a agent (p)");
    expect(await as("client")("put", { script: { ...script, id: "ok", reply: ["OK."] } })).toEqual({ id: "ok" });
    expect(await as("human")("put", { script: { ...script, id: "ok2", reply: ["OK."] } })).toEqual({ id: "ok2" });
    await expect(as("plugin")("feedback", { id: "hi", kind: "helpful", session: "made-up" })).rejects.toThrow("no session made-up in the dialogue");
    await d.respond({ sessionId: "real", utterance: "hi" });
    expect(await as("plugin")("feedback", { id: "hi", kind: "helpful", session: "real" })).toMatchObject({ evidence: { fits: 1, sessions: ["real"] } });
  });
});
