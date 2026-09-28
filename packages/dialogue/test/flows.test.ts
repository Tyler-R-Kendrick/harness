import { describe, expect, it, vi } from "vitest";
import { Dialogue } from "@harness/dialogue";
import type { Decision, ScriptInput, Step } from "@harness/dialogue";
import { MemoryLibrary, parseWorkflow, WorkflowHost } from "@harness/workflows";
import { aiCodeMode } from "@harness/workflows/node";
import { MemoryStorage } from "@harness/testkit";
import { settings, supportBook } from "./helpers.ts";

const step = (utterance: string, sessionId = "s-1"): Step => ({ sessionId, utterance });

/** A shirt order: asks for a size until it hears S or M, then confirms. */
const orderFlow = parseWorkflow({
  name: "order-flow",
  kind: "flow",
  description: "Takes a shirt order.",
  inputs: { type: "object" },
  code: `await tools.say({ text: "Which size? We have S and M." });
let size;
for (;;) {
  const { utterance } = await tools.hear({});
  if (/^(s|m)$/i.test(utterance.trim())) { size = utterance.trim().toUpperCase(); break; }
  await tools.say({ text: "S or M?" });
}
await tools.say({ text: "Ordered " + input.slots.item + " in " + size + "." });
return size;`,
});

/** A bot for a whole session: echoes "say ..." with a count it keeps, and passes anything else on. */
const echoBot = parseWorkflow({
  name: "echo-bot",
  kind: "flow",
  description: "Echoes what it is told to say.",
  inputs: { type: "object" },
  code: `let u = input.utterance;
let count = 0;
for (;;) {
  if (u.startsWith("say ")) { count++; await tools.say({ text: u.slice(4) + " (" + count + ")" }); }
  else await tools.pass({});
  ({ utterance: u } = await tools.hear({}));
}`,
});

const flow = (name: string, code: string) => parseWorkflow({ name, kind: "flow", description: name, inputs: { type: "object" }, code });

/** A workflow host over a library, with journals that outlive any one dialogue (as files do). */
function workflows(...flows: ReturnType<typeof parseWorkflow>[]) {
  const journals = new Map<string, MemoryStorage>();
  return {
    journals,
    host: new WorkflowHost({
      codeMode: aiCodeMode,
      library: new MemoryLibrary(flows),
      journal: (run) => journals.get(run) ?? (journals.set(run, new MemoryStorage()), journals.get(run)!),
      ask: async () => "",
    }),
  };
}

const ordering: ScriptInput = { id: "order", intent: "Order something", patterns: ["order a (?<item>\\w+)"], slots: { item: {} }, reply: [{ flow: "order-flow" }] };
const bookWith = (...scripts: ScriptInput[]) => ({ scripts: [...(supportBook() as { scripts: ScriptInput[] }).scripts, ...scripts] });

describe("flows: dialogues as durable workflows", () => {
  it("FL1.1 a script whose reply is a flow starts it: each turn the flow hears one utterance and what it says is the reply; when it ends, scripts answer again", async () => {
    const { host } = workflows(orderFlow);
    const d = new Dialogue({ settings: settings(), book: bookWith(ordering), flows: host });
    expect(await d.respond(step("order a shirt"))).toEqual({ kind: "flow", flow: "order-flow", script: "order", text: "Which size? We have S and M.", match: { by: "pattern" } });
    expect(d.script("order")!.evidence.served).toBe(1);
    expect(await d.respond(step("L"))).toEqual({ kind: "flow", flow: "order-flow", script: "order", text: "S or M?", match: { by: "flow" } });
    expect(await d.respond(step("m"))).toMatchObject({ kind: "flow", text: "Ordered shirt in M." });
    expect(await d.respond(step("where is order 7"))).toMatchObject({ kind: "reply", script: "order-status" });
    expect(d.script("order")!.evidence.served).toBe(1);
  });

  it("FL1.2 a flow in progress survives a restart: the new dialogue, from the save and the journals, goes on where it was", async () => {
    const { host, journals } = workflows(orderFlow);
    const first = new Dialogue({ settings: settings(), book: bookWith(ordering), flows: host });
    await first.respond(step("order a hat"));
    await first.respond(step("XL"));
    const second = new Dialogue({ settings: settings(), book: JSON.parse(JSON.stringify(first.save())), flows: workflows(orderFlow).host });
    const restored = new Dialogue({ settings: settings(), book: JSON.parse(JSON.stringify(first.save())), flows: new WorkflowHost({ codeMode: aiCodeMode, library: new MemoryLibrary([orderFlow]), journal: (run) => journals.get(run)!, ask: async () => "" }) });
    expect(await restored.respond(step("s"))).toMatchObject({ kind: "flow", text: "Ordered hat in S." });
    // Without its journal the flow starts over (and hears "s" as its first answer): the journal is the flow's state.
    expect(await second.respond(step("s"))).toMatchObject({ kind: "flow", text: "Which size? We have S and M.\nOrdered hat in S." });
  });

  it("FL1.3 an entry flow takes every session's first utterance as its input and keeps its state; a turn it passes on goes to scripts, then the model", async () => {
    const { host } = workflows(echoBot);
    const d = new Dialogue({ settings: settings(), book: { ...bookWith(), entry: "echo-bot" }, flows: host });
    expect(await d.respond(step("say hi"))).toStrictEqual({ kind: "flow", flow: "echo-bot", text: "hi (1)", match: { by: "flow" } });
    expect(await d.respond(step("where is order 5"))).toMatchObject({ kind: "reply", script: "order-status" });
    expect(await d.respond(step("tell me a joke"))).toMatchObject({ kind: "pass", reason: "no script matches" });
    expect(await d.respond(step("say bye"))).toMatchObject({ kind: "flow", text: "bye (2)" });
    expect(await d.respond(step("say again", "s-2"))).toMatchObject({ kind: "flow", text: "again (1)" });
  });

  it("FL1.4 a transfer ends the flow and hands the turn to the model; so does a failure, which is reported; a turn the flow says nothing on is handed on", async () => {
    const onError = vi.fn();
    const { host } = workflows(
      flow("handoff", `await tools.transfer({}); await tools.hear({}); await tools.say({ text: "never" });`),
      flow("broken", `throw new Error("no way");`),
      flow("quiet", `await tools.hear({}); return 1;`),
    );
    const d = new Dialogue({
      settings: settings(),
      book: bookWith(
        { id: "handoff", intent: "h", patterns: ["agent"], reply: [{ flow: "handoff" }] },
        { id: "broken", intent: "b", patterns: ["break"], reply: [{ flow: "broken" }] },
        { id: "quiet", intent: "q", patterns: ["hush"], reply: [{ flow: "quiet" }] },
      ),
      flows: host,
      onError,
    });
    expect(await d.respond(step("agent"))).toEqual({ kind: "pass", reason: "the flow handed the person to the model" });
    expect(await d.respond(step("where is order 3"))).toMatchObject({ kind: "reply", script: "order-status" });
    expect(await d.respond(step("break"))).toMatchObject({ kind: "pass", reason: "flow broken handed the turn on" });
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual([expect.stringMatching(/^flow broken failed: .*no way/)]);
    expect(await d.respond(step("hush"))).toMatchObject({ kind: "pass", reason: "flow quiet handed the turn on" });
    // The running flow hears this, says nothing and ends: the turn goes on to the scripts.
    expect(await d.respond(step("where is order 3"))).toMatchObject({ kind: "reply", script: "order-status" });
  });

  it("FL1.5 a flow needs a session and a flow runner; without either its script hands the turn on", async () => {
    expect(await new Dialogue({ settings: settings(), book: bookWith(ordering) }).respond(step("order a shirt"))).toMatchObject({ kind: "pass", reason: "flow order-flow needs a session and a flow runner" });
    expect(await new Dialogue({ settings: settings(), book: bookWith(ordering), flows: workflows(orderFlow).host }).respond({ utterance: "order a shirt" })).toMatchObject({
      kind: "pass",
      reason: "flow order-flow needs a session and a flow runner",
    });
  });

  it("FL1.6 each flow run has its own id, never reused, across sessions and restarts", async () => {
    const { host, journals } = workflows(orderFlow);
    const d = new Dialogue({ settings: settings(), book: bookWith(ordering), flows: host });
    await d.respond(step("order a shirt", "a"));
    await d.respond(step("order a hat", "b"));
    const again = new Dialogue({ settings: settings(), book: JSON.parse(JSON.stringify(d.save())), flows: host });
    await again.respond(step("s", "a"));
    await again.respond(step("order a cap", "a"));
    expect([...journals.keys()]).toEqual(["dialogue/a/1", "dialogue/b/2", "dialogue/a/3"]);
  });

  it("FL1.7 what a flow says after passing a turn on is not said", async () => {
    const { host } = workflows(flow("chatty", `await tools.pass({}); await tools.say({ text: "late" }); await tools.hear({});`));
    const d = new Dialogue({ settings: settings(), book: bookWith({ id: "chatty", intent: "c", patterns: ["chat"], reply: [{ flow: "chatty" }] }), flows: host });
    expect(await d.respond(step("chat"))).toMatchObject({ kind: "pass", reason: "flow chatty handed the turn on" });
  });

  it("FL1.8 a flow started from a result step is a flow like any other", async () => {
    const { host } = workflows(flow("readback", `await tools.say({ text: "Order " + input.result.input.id + " found." }); return 1;`));
    const d = new Dialogue({ settings: settings(), book: { scripts: [{ id: "rb", intent: "rb", result: { tool: "track" }, reply: [{ flow: "readback" }] }] }, flows: host });
    const decision: Decision = await d.respond({ sessionId: "s-1", utterance: "where is 9", result: { tool: "track", input: { id: 9 }, output: {} } });
    expect(decision).toMatchObject({ kind: "flow", text: "Order 9 found.", match: { by: "result" } });
  });
});

describe("flows hand turns on", () => {
  it("FL1.9 a run started is saved, even by a turn that changes nothing else, so a restart never reuses its id", async () => {
    const { host, journals } = workflows(flow("hello", `await tools.say({ text: "Hello." }); return 1;`));
    const saves: unknown[] = [];
    const d = new Dialogue({ settings: settings(), book: { scripts: [], entry: "hello" }, flows: host, onChange: (x) => void saves.push(JSON.parse(JSON.stringify(x.save()))) });
    expect(await d.respond(step("hi"))).toMatchObject({ kind: "flow", text: "Hello." });
    expect(saves.at(-1)).toMatchObject({ runs: 1 });
    const again = new Dialogue({ settings: settings(), book: saves.at(-1), flows: host });
    expect(await again.respond(step("hi"))).toMatchObject({ kind: "flow", text: "Hello." });
    expect([...journals.keys()]).toEqual(["dialogue/s-1/1", "dialogue/s-1/2"]);
  });

  it("FL1.10 a transfer hands the person to the model: the scripts do not answer, the entry flow does not take them back, and what it said first is said", async () => {
    const { host } = workflows(flow("desk", `if (input.utterance === "agent") { await tools.say({ text: "Transferring." }); await tools.transfer({}); return 1; } await tools.say({ text: "Desk here." }); return 1;`));
    const d = new Dialogue({ settings: settings(), book: { ...bookWith(), entry: "desk" }, flows: host });
    expect(await d.respond(step("hello"))).toMatchObject({ kind: "flow", text: "Desk here." });
    expect(await d.respond(step("agent"))).toEqual({ kind: "pass", reason: "the flow handed the person to the model", said: "Transferring." });
    expect(d.save()).toMatchObject({ sessions: [{ id: "s-1", transferred: true }] });
    expect(await d.respond(step("where is order 7"))).toMatchObject({ kind: "reply", script: "order-status" });
    const restored = new Dialogue({ settings: settings(), book: JSON.parse(JSON.stringify(d.save())), flows: host });
    expect(await restored.respond(step("thanks"))).toMatchObject({ kind: "pass", reason: "no script matches" });
  });

  it("FL1.11 what a flow says before passing a turn on comes before the answer the turn gets", async () => {
    const { host } = workflows(flow("chatty", `await tools.say({ text: "One moment." }); await tools.pass({}); await tools.say({ text: "late" }); await tools.hear({});`));
    const d = new Dialogue({ settings: settings(), book: { ...bookWith(), entry: "chatty" }, flows: host });
    expect(await d.respond(step("where is order 3"))).toMatchObject({ kind: "reply", script: "order-status", text: "One moment.\nLet me look up order 3." });
    const e = new Dialogue({ settings: settings(), book: { ...bookWith(), entry: "chatty" }, flows: workflows(flow("chatty", `await tools.say({ text: "One moment." }); await tools.pass({}); await tools.hear({});`)).host });
    expect(await e.respond(step("tell me a joke"))).toMatchObject({ kind: "pass", reason: "no script matches", said: "One moment." });
  });

  it("FL1.12 a run nothing will resume is forgotten: one that ended, and one another flow took the place of", async () => {
    const journals = new Map<string, MemoryStorage>();
    const forgotten: string[] = [];
    const host = new WorkflowHost({
      codeMode: aiCodeMode,
      library: new MemoryLibrary([orderFlow, echoBot]),
      journal: (run) => journals.get(run) ?? (journals.set(run, new MemoryStorage()), journals.get(run)!),
      forget: async (run) => void forgotten.push(run),
      ask: async () => "",
    });
    const d = new Dialogue({ settings: settings(), book: { ...bookWith(ordering), entry: "echo-bot" }, flows: host });
    await d.respond(step("order a shirt"));
    expect(forgotten).toEqual(["dialogue/s-1/1"]);
    await d.respond(step("s"));
    expect(forgotten).toEqual(["dialogue/s-1/1", "dialogue/s-1/2"]);
    const other = workflows(orderFlow).host;
    const onError = vi.fn();
    const failing = new Dialogue({ settings: settings(), book: bookWith(ordering), flows: { run: other.run.bind(other), forget: async () => Promise.reject(new Error("disk")) }, onError });
    await failing.respond(step("order a hat"));
    expect(await failing.respond(step("m"))).toMatchObject({ kind: "flow", text: "Ordered hat in M." });
    expect(onError.mock.calls.map(([e]) => (e as Error).message)).toEqual(["disk"]);
  });
});

describe("how flows end", () => {
  it("FL1.13 a flow that completes leaves its session, with nothing reported", async () => {
    const onError = vi.fn();
    const d = new Dialogue({ settings: settings(), book: bookWith(ordering), flows: workflows(orderFlow).host, onError });
    await d.respond(step("order a shirt"));
    expect(d.save()).toMatchObject({ sessions: [{ id: "s-1", flow: { name: "order-flow" } }] });
    await d.respond(step("s"));
    expect((d.save() as { sessions: object[] }).sessions.map((s) => Object.keys(s))).toEqual([["id", "last"]]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("FL1.14 a flow the runner cannot run is reported, and its session is not left in it", async () => {
    const onError = vi.fn();
    const d = new Dialogue({ settings: settings(), book: bookWith({ id: "ghost", intent: "g", patterns: ["ghost"], reply: [{ flow: "no-such-flow" }] }), flows: workflows().host, onError });
    expect(await d.respond(step("ghost"))).toMatchObject({ kind: "pass" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((d.save() as { sessions: { flow?: unknown }[] }).sessions.every((s) => s.flow === undefined)).toBe(true);
  });
});

describe("flows that go on as new runs", () => {
  const counter = flow("counter", `const n = (input.state ?? 0) + 1;
if (input.utterance === "skip") await tools.pass({});
else await tools.say({ text: "Turn " + n + ": " + input.utterance });
return input.utterance === "stop" ? "done" : { continue: n };`);

  it("FL2.1 a flow that ends a turn with { continue: state } goes on from that state with the next utterance, as a new run; a turn it passes on still counts", async () => {
    const { host, journals } = workflows(counter);
    const d = new Dialogue({ settings: settings(), book: bookWith({ id: "count", intent: "c", patterns: ["count"], reply: [{ flow: "counter" }] }), flows: host });
    expect(await d.respond(step("count"))).toMatchObject({ kind: "flow", flow: "counter", script: "count", text: "Turn 1: count", match: { by: "pattern" } });
    expect(d.save()).toMatchObject({ sessions: [{ id: "s-1", next: { name: "counter", script: "count", state: 1 } }] });
    expect(await d.respond(step("skip"))).toMatchObject({ kind: "pass" });
    expect(await d.respond(step("again"))).toMatchObject({ kind: "flow", script: "count", text: "Turn 3: again", match: { by: "flow" } });
    expect(await d.respond(step("stop"))).toMatchObject({ text: "Turn 4: stop" });
    expect(await d.respond(step("where is order 3"))).toMatchObject({ kind: "reply", script: "order-status" });
    expect([...journals.keys()]).toEqual(["dialogue/s-1/1", "dialogue/s-1/2", "dialogue/s-1/3", "dialogue/s-1/4"]);
  });

  it("FL2.2 a flow a script starts replaces one the session was going on with; a flow that transfers does not go on", async () => {
    const relay = flow("relay", `await tools.pass({}); return { continue: 1 };`);
    const bye = flow("bye", `await tools.say({ text: "Bye." }); await tools.transfer({}); return { continue: 1 };`);
    const { host, journals } = workflows(relay, bye);
    const d = new Dialogue({ settings: settings(), book: bookWith({ id: "relay", intent: "r", patterns: ["relay"], reply: [{ flow: "relay" }] }, { id: "bye", intent: "b", patterns: ["bye"], reply: [{ flow: "bye" }] }), flows: host });
    await d.respond(step("relay"));
    expect(d.save()).toMatchObject({ sessions: [{ next: { name: "relay" } }] });
    // The relay hears "bye" first and hands it on; the script it matches starts its own flow in the relay's place.
    expect(await d.respond(step("bye"))).toMatchObject({ kind: "pass" });
    expect((d.save() as { sessions: { next?: unknown }[] }).sessions.every((s) => s.next === undefined)).toBe(true);
    await d.respond(step("hello"));
    expect([...journals.keys()]).toEqual(["dialogue/s-1/1", "dialogue/s-1/2", "dialogue/s-1/3"]);
  });
});

describe("sessions are durable", () => {
  it("DG3.5 a form in progress and the session's context survive a restart", async () => {
    const d = new Dialogue({ settings: settings(), book: supportBook() });
    await d.respond(step("where is order 5"));
    const restored = new Dialogue({ settings: settings(), book: JSON.parse(JSON.stringify(d.save())) });
    expect(await restored.respond(step("yes please"))).toMatchObject({ kind: "generate", script: "confirm-cancel" });
    const table = { id: "table", intent: "t", patterns: ["book a table"], slots: { time: { prompts: ["When?", "What time?"] } }, reply: ["Booked for ", { slot: "time" }, "."] } as const;
    const forms = new Dialogue({ settings: settings(), book: { scripts: [table] } });
    await forms.respond(step("book a table"));
    const back = new Dialogue({ settings: settings(), book: JSON.parse(JSON.stringify(forms.save())) });
    expect(await back.respond(step("7pm"))).toMatchObject({ kind: "reply", text: "Booked for 7pm." });
  });

  it("DG3.6 a change to a session's state is reported, and a step that changes nothing is not", async () => {
    const onChange = vi.fn();
    const d = new Dialogue({ settings: settings(), book: { scripts: [{ id: "hi", intent: "hi", patterns: ["hi"], reply: ["Hi."] }] }, onChange });
    await d.respond(step("nothing"));
    expect(onChange).toHaveBeenCalledTimes(0);
    await d.respond(step("hi"));
    expect(onChange.mock.calls.length).toBeGreaterThan(0);
    expect(d.save()).toMatchObject({ sessions: [{ id: "s-1", last: "hi" }] });
  });
});
