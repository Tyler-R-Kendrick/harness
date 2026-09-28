import { describe, expect, it } from "vitest";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { jsonSchema, tool } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { HARNESS, usage } from "@harness/cognitive";
import type { WorkerEvent } from "@harness/core";
import { GUIDANCE_LABEL, MemoryProceduralStore, parseGraph, parseSettings, proceduralStep, SnapshotProceduralStore, StepRecordSchema } from "@harness/procedural";
import type { ProceduralStepDeps, ProceduralStore, Settings, StepRecord } from "@harness/procedural";
import { ManualClock, MemoryStorage, nullSandbox, scriptedHarness, SeededEntropy } from "@harness/testkit";
import { AgentWorker, harnessSessions, sessionAgent } from "@harness/workers";
import { hotpot } from "../../procedural/test/fixtures.ts";
import { GRAPH, hotpotGraph, resolver, seed, settingsFile, variant } from "../../procedural/test/step-fixtures.ts";

const finish = (unified: "stop" | "tool-calls" = "stop"): LanguageModelV4StreamPart => ({ type: "finish", finishReason: { unified, raw: undefined }, usage: usage() });
const text = (t: string): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "0" },
  { type: "text-delta", id: "0", delta: t },
  { type: "text-end", id: "0" },
];
const call = (toolName: string, toolCallId = "c1"): LanguageModelV4StreamPart => ({ type: "tool-call", toolCallId, toolName, input: JSON.stringify({ q: "film" }) });

function scripted(...turns: LanguageModelV4StreamPart[][]) {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "solver",
    doStream: async () => ({ stream: convertArrayToReadableStream([{ type: "stream-start", warnings: [] }, ...turns[Math.min(n++, turns.length - 1)]!]) }),
  });
}

/** The guidance model: "advice <n>" for its n-th call. */
function guidance() {
  let n = 0;
  return new MockLanguageModelV4({
    modelId: "guide",
    doGenerate: async () => ({ content: [{ type: "text", text: `advice ${n++}` }], finishReason: { unified: "stop", raw: undefined }, usage: usage(10, 2), warnings: [] }),
  });
}


async function deps(preset: string, settings: Settings = settingsFile): Promise<ProceduralStepDeps & { store: ProceduralStore; model: ReturnType<typeof guidance> }> {
  const s = new MemoryProceduralStore();
  await seed(s, hotpotGraph());
  return { store: s, resolver, settings, preset, model: guidance(), clock: new ManualClock(), entropy: new SeededEntropy(3) };
}

const retrieve = tool({ inputSchema: z.object({ q: z.string() }), execute: async () => "passages" });

function run(worker: AgentWorker, prompt: string, turnId = "t1", onEvent?: (e: WorkerEvent) => void) {
  const events: WorkerEvent[] = [];
  const done = worker.run({ type: "prompt", sessionId: "s1", turnId, prompt: [{ type: "text", text: prompt }], cwd: "/repo" }, (e) => {
    events.push(e);
    onEvent?.(e);
  });
  return { events, done };
}
const updates = (events: WorkerEvent[]) => events.flatMap((e) => (e.type === "update" ? [e.update] : []));
const records = (events: WorkerEvent[]): StepRecord[] =>
  updates(events).flatMap((u) => {
    const step = (u as { _meta?: { harness?: { procedural?: { step?: unknown } } } })._meta?.harness?.procedural?.step;
    return step === undefined ? [] : [StepRecordSchema.parse(step)];
  });
const contents = (m: LanguageModelV4CallOptions["prompt"][number]): string => (typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : "")).join(""));
const advisories = (o: LanguageModelV4CallOptions) => o.prompt.filter((m) => m.role === "user" && contents(m).startsWith(GUIDANCE_LABEL));

describe("procedural guidance in a session worker (sessionAgent + proceduralStep)", () => {
  it("PW1.75 successor-only delivery offers each step only the tools of its node's successor actions, and every tool where there are none", async () => {
    const successors = parseSettings({ ...settingsFile, presets: { ...settingsFile.presets, strict: { ...settingsFile.presets.harness, delivery: { to: "trailing-message", activeTools: "successors" } } } });
    const d = await deps("strict", successors);
    const model = scripted([call("first_hop_retrieve"), finish("tool-calls")], [call("Scan_Index", "c2"), finish("tool-calls")], [...text("Answer."), finish()]);
    const tools = { first_hop_retrieve: retrieve, Scan_Index: retrieve, grep: retrieve };
    const worker = new AgentWorker({ agent: sessionAgent({ model, tools, step: proceduralStep(d) }) });
    const { events, done } = run(worker, "Who directed the film?");
    await done;
    expect(model.doStreamCalls.map((c) => (c.tools ?? []).map((t) => t.name))).toEqual([["first_hop_retrieve"], ["Scan_Index"], ["first_hop_retrieve", "Scan_Index", "grep"]]);
    expect(records(events).map((r) => r.activeTools)).toEqual([["first_hop_retrieve"], ["Scan_Index"], undefined]);
  });

  it("PW1.15 the paper preset puts the guidance in the system prompt of every step, once, and each step's record lands before its tool call", async () => {
    const d = await deps("paper");
    const model = scripted([call("first_hop_retrieve"), finish("tool-calls")], [...text("Answer."), finish()]);
    const worker = new AgentWorker({ agent: sessionAgent({ model, tools: { first_hop_retrieve: retrieve }, instructions: "Be brief.", step: proceduralStep(d) }) });
    const { events, done } = run(worker, "Who directed the film?");
    await done;
    const systems = model.doStreamCalls.map((c) => c.prompt.filter((m) => m.role === "system").map(contents));
    expect(systems).toEqual([[`Be brief.\n\n${GUIDANCE_LABEL}advice 0`], [`Be brief.\n\n${GUIDANCE_LABEL}advice 1`]]);
    expect(updates(events).map((u) => u.sessionUpdate)).toEqual(["notice", "tool_call", "tool_call_update", "notice", "agent_message_chunk"]);
    expect(records(events).map((r) => [r.node, r.action])).toEqual([
      ["Start", null],
      ["First_Hop_Retrieve", "first_hop_retrieve"],
    ]);
  });

  it("PW1.16 the harness preset adds one tagged advisory message per model call, never stacked, and never kept in the conversation", async () => {
    const d = await deps("harness");
    const model = scripted([call("first_hop_retrieve"), finish("tool-calls")], [call("Scan_Index", "c2"), finish("tool-calls")], [...text("Answer."), finish()]);
    const worker = new AgentWorker({ agent: sessionAgent({ model, tools: { first_hop_retrieve: retrieve, Scan_Index: retrieve }, instructions: "Be brief.", step: proceduralStep(d) }) });
    await run(worker, "Who directed the film?").done;
    await run(worker, "And the year?", "t2").done;
    for (const c of model.doStreamCalls) {
      expect(advisories(c)).toHaveLength(1);
      expect(c.prompt.at(-1)).toBe(advisories(c)[0]);
      expect(advisories(c)[0]!.providerOptions?.[HARNESS]).toEqual({ advisory: "procedural" });
      expect(c.prompt.filter((m) => m.role === "system").map(contents)).toEqual(["Be brief."]);
    }
    expect(model.doStreamCalls).toHaveLength(4);
  });

  it("PW1.17 after an approval round the node is not reset to Start: the step after it is at the approved call's node", async () => {
    const d = await deps("paper");
    const model = scripted([call("first_hop_retrieve"), finish("tool-calls")], [...text("Answer."), finish()]);
    const worker = new AgentWorker({ agent: sessionAgent({ model, tools: { first_hop_retrieve: retrieve }, toolApproval: { first_hop_retrieve: "user-approval" }, step: proceduralStep(d) }) });
    const { events, done } = run(worker, "Who directed the film?", "t1", (e) => {
      if (e.type === "permission") queueMicrotask(() => worker.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: e.requestId, outcome: { outcome: "selected", optionId: "allow" } }));
    });
    await done;
    expect(records(events).map((r) => r.node)).toEqual(["Start", "First_Hop_Retrieve"]);
  });

  it("PW1.18 one version pair per step: a head moved during a turn is read from the next turn, and every step of a turn names the same pair", async () => {
    const d = await deps("harness");
    const before = (await d.store.heads.get(GRAPH))!.revision;
    let moved = false;
    const tools = {
      first_hop_retrieve: tool({
        inputSchema: z.object({ q: z.string() }),
        execute: async () => {
          if (!moved) await seed(d.store, variant("!"), GRAPH, "dream");
          moved = true;
          return "passages";
        },
      }),
    };
    const model = scripted([call("first_hop_retrieve"), finish("tool-calls")], [...text("Answer."), finish()], [...text("Again."), finish()]);
    const worker = new AgentWorker({ agent: sessionAgent({ model, tools, step: proceduralStep(d) }) });
    const first = run(worker, "q");
    await first.done;
    const second = run(worker, "q2", "t2");
    await second.done;
    const after = (await d.store.heads.get(GRAPH))!.revision;
    expect(records(first.events).map((r) => r.core)).toEqual([before, before]);
    expect(records(second.events).map((r) => r.core)).toEqual([after]);
  });

  it("PW1.19 a pin survives a restart: a new worker and hook on the same store keep the session's core (repinOnDream never) and its exposure salt", async () => {
    const settings = parseSettings({ ...settingsFile, presets: { ...settingsFile.presets, kept: { ...settingsFile.presets.harness, repinOnDream: "never" } } });
    const d = await deps("kept", settings);
    const worker = () => new AgentWorker({ agent: sessionAgent({ model: scripted([...text("ok"), finish()]), step: proceduralStep({ ...d, model: guidance() }) }) });
    const first = run(worker(), "q");
    await first.done;
    const pin = await d.store.pins.get("s1");
    await seed(d.store, variant("?"), GRAPH, "dream");
    // the daemon restarts: a new worker, a new hook, the same store
    const second = run(worker(), "q", "t2");
    await second.done;
    expect(records(second.events)[0]!.core).toBe(records(first.events)[0]!.core);
    expect(await d.store.pins.get("s1")).toEqual(pin);
  });

  it("PW1.23 on the persistent snapshot store, a pin survives a daemon restart: a new store over the same storage keeps the session's core, and the guidance texts are there", async () => {
    const storage = new MemoryStorage();
    const settings = parseSettings({ ...settingsFile, presets: { ...settingsFile.presets, kept: { ...settingsFile.presets.harness, repinOnDream: "never" } } });
    const hook = (store: SnapshotProceduralStore) => proceduralStep({ store, resolver, settings, preset: "kept", model: guidance(), clock: new ManualClock(), entropy: new SeededEntropy(5) });
    const before = new SnapshotProceduralStore(storage);
    await seed(before, hotpotGraph());
    const first = run(new AgentWorker({ agent: sessionAgent({ model: scripted([...text("ok"), finish()]), step: hook(before) }) }), "q");
    await first.done;
    await seed(before, variant("?"), GRAPH, "dream");
    const after = new SnapshotProceduralStore(storage);
    const second = run(new AgentWorker({ agent: sessionAgent({ model: scripted([...text("ok"), finish()]), step: hook(after) }) }), "q", "t2");
    await second.done;
    const [a, b] = [records(first.events)[0]!, records(second.events)[0]!];
    expect(b.core).toBe(a.core);
    expect(await after.pins.get("s1")).toEqual(await before.pins.get("s1"));
    expect(await after.guidance.get(a.guidanceId)).toBe("advice 0");
  });

  it("PW1.20 a session the resolver maps to no graph runs unguided", async () => {
    const d = await deps("harness");
    const model = scripted([...text("ok"), finish()]);
    const worker = new AgentWorker({ agent: sessionAgent({ model, instructions: "Be brief.", step: proceduralStep(d) }) });
    const events: WorkerEvent[] = [];
    await worker.run({ type: "prompt", sessionId: "s1", turnId: "t1", prompt: [{ type: "text", text: "hi" }], cwd: "/", sessionMeta: { procedural: "off" } }, (e) => events.push(e));
    expect(records(events)).toEqual([]);
    expect(model.doStreamCalls[0]!.prompt.map((m) => m.role)).toEqual(["system", "user"]);
  });
});

const weather = tool({ description: "Weather for a city.", inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }), execute: async ({ city }) => ({ city, sky: "clear" }) });

describe("procedural guidance for an opaque harness (harnessSessions + proceduralStep's turn variant)", () => {
  it("PW1.21 each turn's prompt carries guidance localized at the previous turn's last tool call, and a record is reported", async () => {
    const d = await deps("harness");
    const graph = parseGraph({ ...hotpot(), nodes: [...hotpot().nodes, { id: "weather", type: "ACTION", description: "Look at the sky." }], edges: [...hotpot().edges, { from: "Start", relation: "LEADS_TO", to: "weather", condition: null, guidance: "", pitfalls: "" }, { from: "weather", relation: "LEADS_TO", to: "End", condition: null, guidance: "", pitfalls: "" }] });
    if (!graph.ok) throw new Error("fixture");
    await seed(d.store, graph.graph, GRAPH, "dream");
    const harness = scriptedHarness((p) => (p.includes("weather?") ? { text: "Lagos:", tool: { name: "weather", input: { city: "Lagos" } } } : "ok"));
    const worker = new AgentWorker({ agent: harnessSessions(new HarnessAgent({ harness, tools: { weather } }), { sandboxSession: nullSandbox, step: proceduralStep(d) }) });
    const first = run(worker, "weather?");
    await first.done;
    const second = run(worker, "thanks", "t2");
    await second.done;
    expect(harness.log.turns.map((t) => (t.prompt as { content: { text: string }[] }).content[0]!.text)).toEqual([`${GUIDANCE_LABEL}advice 0\n\n`, `${GUIDANCE_LABEL}advice 1\n\n`]);
    expect([...records(first.events), ...records(second.events)].map((r) => [r.node, r.action])).toEqual([
      ["Start", null],
      ["weather", "weather"],
    ]);
  });

  it("PW1.70 under a state-tracker preset a coarse harness tool is localized by its arguments, or where its result declares", async () => {
    const d = await deps("tracker", parseSettings({ ...settingsFile, presets: { ...settingsFile.presets, tracker: { ...settingsFile.presets.harness, match: "state-tracker" } } }));
    const tests = { type: "object", properties: { command: { type: "string", pattern: "^npm test" } }, required: ["command"] };
    const graph = parseGraph({
      ...hotpot(),
      nodes: [
        { id: "Start", type: "STATUS", description: "Begin." },
        { id: "Shell", type: "ACTION", description: "Any command.", binding: { kind: "tool", name: "sh" } },
        { id: "Run_Tests", type: "ACTION", description: "Run the tests.", binding: { kind: "tool", name: "sh", arguments: tests } },
        { id: "Review", type: "REASONING", description: "Read the failures." },
        { id: "End", type: "STATUS", description: "Done." },
      ],
      edges: [
        { from: "Start", relation: "LEADS_TO", to: "Shell", condition: null, guidance: "", pitfalls: "" },
        { from: "Shell", relation: "LEADS_TO", to: "Run_Tests", condition: null, guidance: "", pitfalls: "" },
        { from: "Run_Tests", relation: "LEADS_TO", to: "Review", condition: null, guidance: "", pitfalls: "" },
        { from: "Review", relation: "LEADS_TO", to: "End", condition: null, guidance: "", pitfalls: "" },
      ],
    });
    if (!graph.ok) throw new Error("fixture");
    await seed(d.store, graph.graph, GRAPH, "dream");
    // The environment's tool says where the agent is after reading a log.
    const sh = tool({
      inputSchema: jsonSchema<{ command: string }>({ type: "object", properties: { command: { type: "string" } }, required: ["command"] }),
      execute: async ({ command }) => (command.startsWith("cat") ? { stdout: "2 failed", _meta: { harness: { procedural: { node: "Review" } } } } : { stdout: "ok" }),
    });
    // The prompt arrives with the turn's guidance prepended.
    const harness = scriptedHarness((p) => {
      const command = /run (.*)$/.exec(p)?.[1];
      return command === undefined ? "ok" : { text: "ran", tool: { name: "sh", input: { command } } };
    });
    const worker = new AgentWorker({ agent: harnessSessions(new HarnessAgent({ harness, tools: { sh } }), { sandboxSession: nullSandbox, step: proceduralStep(d) }) });
    const all: WorkerEvent[] = [];
    for (const [i, prompt] of ["run npm test", "next", "run cat log", "next", "run ls", "next"].entries()) {
      const turn = run(worker, prompt, `t${i}`);
      await turn.done;
      all.push(...turn.events);
    }
    expect(records(all).map((r) => r.node)).toEqual(["Start", "Run_Tests", "Run_Tests", "Review", "Review", "Shell"]);
  });
});
