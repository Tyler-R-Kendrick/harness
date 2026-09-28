import { describe, expect, it, vi } from "vitest";
import type { ModelMessage, SystemModelMessage, ToolResultPart } from "ai";
import { HARNESS } from "@harness/cognitive";
import { ManualClock, promptText, SeededEntropy } from "@harness/testkit";
import {
  ADVISORY,
  canonicalJson,
  GraphIdSchema,
  GUIDANCE_LABEL,
  MemoryProceduralStore,
  parseGraph,
  parseResolver,
  parseSettings,
  proceduralStep,
  RevisionIdSchema,
  sha256Hex,
  StepRecordSchema,
} from "@harness/procedural";
import type { OverlayEvent, Pin, ProceduralStepDeps, Resolver, Settings, StepInput, StepNotice, StepRecord } from "@harness/procedural";
import { answering } from "./models.ts";
import { cautionOnCore, idOf, noteOnCore, proposed, saltWhere, shortcut, status, toVerify, verifyNode } from "./overlay-fixtures.ts";
import { GRAPH, hotpotGraph, resolver, seed, settingsFile, variant } from "./step-fixtures.ts";
import { edge, hotpot } from "./fixtures.ts";

/** Settings with an extra preset built from `base` (paper or harness). */
function withPreset(base: "paper" | "harness", changes: Record<string, unknown>): Settings {
  return parseSettings({ ...settingsFile, presets: { ...settingsFile.presets, custom: { ...settingsFile.presets[base], ...changes } } });
}

interface Setup {
  store: MemoryProceduralStore;
  guidance: ReturnType<typeof answering>;
  deps: ProceduralStepDeps;
  records: StepRecord[];
  notices: StepNotice[];
}

async function setup(preset = "paper", options: { settings?: Settings; resolver?: Resolver } = {}): Promise<Setup> {
  const store = new MemoryProceduralStore();
  await seed(store, hotpotGraph());
  const guidance = answering((n) => `advice ${n}`, { input: 30, output: 5 });
  const deps: ProceduralStepDeps = {
    store,
    resolver: options.resolver ?? resolver,
    settings: options.settings ?? settingsFile,
    preset,
    model: guidance,
    clock: new ManualClock(1000),
    entropy: new SeededEntropy(7),
  };
  return { store, guidance, deps, records: [], notices: [] };
}

const user = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
const calls = (...names: string[]): ModelMessage => ({ role: "assistant", content: names.map((n, i) => ({ type: "tool-call" as const, toolCallId: `c${i}`, toolName: n, input: { q: n } })) });
const result = (name: string, value: unknown = "ok"): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "c0", toolName: name, output: typeof value === "string" ? { type: "text", value } : { type: "json", value: value as never } }] });

function input(s: Setup, messages: readonly ModelMessage[], more: Partial<StepInput> = {}): StepInput {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: "/repo",
    messages,
    initialInstructions: "Be brief.",
    stepNumber: 0,
    model: s.guidance,
    report: (n) => {
      s.notices.push(n);
      s.records.push(StepRecordSchema.parse(n._meta.harness.procedural.step));
    },
    ...more,
  };
}

const append = (s: Setup, ...events: OverlayEvent[]) => s.store.overlay(GRAPH).append(events);
/** Counts the session pins taken (each reads the session's pin once). */
const pinCount = (s: Setup) => vi.spyOn(s.store.pins, "get");
/** A session's pin, set before its first step. */
async function pinned(s: Setup, session: string, pin: Partial<Pin>): Promise<void> {
  const head = (await s.store.heads.get(GRAPH))!.revision;
  await s.store.pins.set(session, { graph: GRAPH, core: head, overlay: 0, salt: "salt", at: 0, ...pin });
}

const prompts = (s: Setup) => s.guidance.doGenerateCalls.map((c) => promptText(c.prompt));

describe("proceduralStep: the live path as a worker step hook (plan §5)", () => {
  it("PW1.30 a session the resolver maps to no graph is left unguided, with no record and no guidance call", async () => {
    const s = await setup("paper", { resolver: parseResolver({ rules: [{ when: {}, graph: null }] }) });
    const hook = proceduralStep(s.deps);
    expect(await hook.prepare(input(s, [user("q")]))).toBeUndefined();
    expect(await hook.turn({ ...input(s, [user("q")]), lastAction: undefined })).toBeUndefined();
    expect(s.guidance.doGenerateCalls).toHaveLength(0);
    expect(s.notices).toEqual([]);
  });

  it("PW1.31 the resolver sees the session's meta and cwd", async () => {
    const byRepo = parseResolver({ rules: [{ when: { meta: { team: "*" }, cwdUnder: "/repo" }, graph: "${meta.team}/retrieval" }, { when: {}, graph: null }] });
    const s = await setup("paper", { resolver: byRepo });
    const hook = proceduralStep(s.deps);
    await hook.prepare(input(s, [user("q")], { sessionMeta: { team: "team" } }));
    expect(s.records.map((r) => r.graph)).toEqual(["team/retrieval"]);
    await hook.prepare(input(s, [user("q")], { sessionId: "s2", sessionMeta: { team: "team" }, cwd: "/elsewhere" }));
    await hook.prepare(input(s, [user("q")], { sessionId: "s3" }));
    const { cwd: _, ...noCwd } = input(s, [user("q")], { sessionId: "s4", sessionMeta: { team: "team" } });
    await hook.prepare(noCwd);
    expect(s.records).toHaveLength(1);
    const byOwner = parseResolver({ rules: [{ when: { principal: "me" }, graph: "${principal}/retrieval" }, { when: {}, graph: null }] });
    const mine = await setup("paper", { resolver: byOwner });
    await seed(mine.store, hotpotGraph(), GraphIdSchema.parse("me/retrieval"));
    await proceduralStep({ ...mine.deps, principal: "me" }).prepare(input(mine, [user("q")]));
    await proceduralStep(mine.deps).prepare(input(mine, [user("q")], { sessionId: "s2" }));
    expect(mine.records.map((r) => r.graph)).toEqual(["me/retrieval"]);
  });

  it("PW1.32 the first step is at Start: its two-hop neighborhood, the query and the local context words go to the guidance model", async () => {
    const s = await setup("paper");
    await proceduralStep(s.deps).prepare(input(s, [user("Who directed the film?")]));
    const [prompt] = prompts(s);
    expect(prompt).toContain("Active Cognitive Node: [Start] (Type: STATUS)");
    expect(prompt).toContain("Immediate Transition Options (Hop 1):\n- Transition: [Start] → [First_Hop_Retrieve]");
    expect(prompt).toContain("Subsequent Horizon (Hop 2):\n- Transition: [First_Hop_Retrieve] → [Scan_Index]");
    expect(prompt).not.toContain("[Scan_Index] → [Bridge_Extract]");
    expect(prompt).toContain(`Here is ${settingsFile.graphContext.local.desc}:`);
    expect(prompt).toContain("Here is the current active query / observation: Who directed the film?");
    expect(prompt).toContain("solving the task: Who directed the film?");
    expect(s.guidance.doGenerateCalls[0]).toMatchObject({ temperature: 0, topK: 1 });
  });

  it("PW1.33 the step record names the version pair, the node and the action, and holds a digest of the guidance, never its text", async () => {
    const s = await setup("paper");
    await proceduralStep(s.deps).prepare(input(s, [user("q")]));
    const [record] = s.records;
    expect(record).toMatchObject({ graph: "team/retrieval", overlay: null, node: "Start", action: null, matched: true, others: [], cached: false, exposure: [], usage: { inputTokens: 30, outputTokens: 5 } });
    expect(record!.core).toBe((await s.store.heads.get(GRAPH))!.revision);
    expect(record!.digest).toBe(sha256Hex("advice 0"));
    expect(JSON.stringify(s.notices[0])).not.toContain("advice 0");
    expect(s.notices[0]).toMatchObject({ sessionUpdate: "notice", severity: "info", title: "Procedural step", description: "At Start" });
  });

  it("PW1.34 the guidance text is kept in the store's guidance texts under the record's guidance id", async () => {
    const s = await setup("paper");
    await proceduralStep(s.deps).prepare(input(s, [user("q")]));
    const [record] = s.records;
    expect(await s.store.guidance.get(record!.guidanceId)).toBe("advice 0");
    expect(s.store.document().guidance).toHaveLength(1);
  });

  it("PW1.35 the last action is the last tool call of the last assistant message; parallel calls record the rest in order", async () => {
    const s = await setup("paper");
    const hook = proceduralStep(s.deps);
    await hook.prepare(input(s, [user("q"), calls("first_hop_retrieve"), result("first_hop_retrieve"), calls("Bridge_Extract", "Scan_Index"), result("Scan_Index")], { stepNumber: 2 }));
    expect(s.records[0]).toMatchObject({ node: "Scan_Index", action: "Scan_Index", matched: true, others: ["Bridge_Extract"] });
    expect(prompts(s)[0]).toContain("Active Cognitive Node: [Scan_Index] (Type: ACTION)");
    // a node's binding names it too
    await hook.prepare(input(s, [user("q"), calls("first_hop_retrieve"), result("first_hop_retrieve")], { stepNumber: 1 }));
    expect(s.records[1]).toMatchObject({ node: "First_Hop_Retrieve", action: "first_hop_retrieve", others: [] });
  });

  it("PW1.36 an action that matches no node falls back to the whole graph with the full context words", async () => {
    const s = await setup("paper");
    await proceduralStep(s.deps).prepare(input(s, [user("q"), calls("grep"), result("grep")]));
    const [prompt] = prompts(s);
    expect(prompt).toContain(`Here is ${settingsFile.graphContext.full.desc}:`);
    expect(prompt).toContain("Procedural Graph Nodes:");
    expect(prompt).toContain(`Analyze this ${settingsFile.graphContext.full.source}`);
    expect(s.records[0]).toMatchObject({ node: null, action: "grep", matched: false });
    expect(s.notices[0]!.description).toBe("No node matched: the whole graph");
  });

  it("PW1.37 the paper's system delivery rebuilds the instructions from the turn's own, so guidance never stacks", async () => {
    const s = await setup("paper");
    const hook = proceduralStep(s.deps);
    const first = await hook.prepare(input(s, [user("q")]));
    expect(first).toEqual({ instructions: `Be brief.\n\n${GUIDANCE_LABEL}advice 0` });
    const second = await hook.prepare(input(s, [user("q"), calls("first_hop_retrieve"), result("first_hop_retrieve")], { stepNumber: 1 }));
    expect(second).toEqual({ instructions: `Be brief.\n\n${GUIDANCE_LABEL}advice 1` });
  });

  it("PW1.38 system delivery keeps instructions given as system messages, adding the guidance as one more, and fills none when there were none", async () => {
    const s = await setup("paper");
    const hook = proceduralStep(s.deps);
    const one: SystemModelMessage = { role: "system", content: "Be brief." };
    expect(await hook.prepare(input(s, [user("q")], { initialInstructions: one }))).toEqual({ instructions: [one, { role: "system", content: `${GUIDANCE_LABEL}advice 0` }] });
    expect(await hook.prepare(input(s, [user("q")], { initialInstructions: [one, one] }))).toEqual({ instructions: [one, one, { role: "system", content: `${GUIDANCE_LABEL}advice 1` }] });
    expect(await hook.prepare(input(s, [user("q")], { initialInstructions: undefined }))).toEqual({ instructions: `${GUIDANCE_LABEL}advice 2` });
  });

  it("PW1.39 trailing-message delivery replaces the one tagged advisory message, at the end, so guidance never stacks", async () => {
    const s = await setup("harness");
    const hook = proceduralStep(s.deps);
    const first = await hook.prepare(input(s, [user("q")]));
    const advisory = (text: string): ModelMessage => ({ role: "user", content: `${GUIDANCE_LABEL}${text}`, providerOptions: { [HARNESS]: ADVISORY } });
    expect(first).toEqual({ messages: [user("q"), advisory("advice 0")] });
    const carried = [...first!.messages!, calls("first_hop_retrieve"), result("first_hop_retrieve")];
    const second = await hook.prepare(input(s, carried, { stepNumber: 1 }));
    expect(second).toEqual({ messages: [user("q"), calls("first_hop_retrieve"), result("first_hop_retrieve"), advisory("advice 1")] });
    expect(second).not.toHaveProperty("instructions");
  });

  it("PW1.40 advisory and system messages are neither the query nor part of the trajectory window", async () => {
    const s = await setup("harness");
    const hook = proceduralStep(s.deps);
    const first = await hook.prepare(input(s, [{ role: "system", content: "sys" }, user("the question")]));
    await hook.prepare(input(s, [...first!.messages!, calls("first_hop_retrieve"), result("first_hop_retrieve", "passages")], { stepNumber: 1 }));
    const prompt = prompts(s)[1]!;
    expect(prompt).toContain("active query / observation: the question\n");
    expect(prompt).toContain('Here is the agent’s recent execution trajectory: Action: first_hop_retrieve(q="first_hop_retrieve")\nObservation: passages\n');
    expect(prompt).not.toContain(GUIDANCE_LABEL);
    expect(prompt).not.toContain("sys");
  });

  it("PW1.41 the window renders the scoped conversation: text and reasoning as thoughts, calls with their arguments, results as observations", async () => {
    const s = await setup("paper");
    const said: ModelMessage = { role: "assistant", content: [{ type: "reasoning", text: "Think. " }, { type: "text", text: "Retrieving." }, { type: "tool-call", toolCallId: "c0", toolName: "first_hop_retrieve", input: "plain" }] };
    const denied: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "c0", toolName: "first_hop_retrieve", output: { type: "execution-denied", reason: "no" } }, { type: "tool-approval-response", approvalId: "a", approved: false }] };
    await proceduralStep(s.deps).prepare(input(s, [user("q"), { role: "assistant", content: "Plain words." }, said, result("x", { k: [1] }), denied, { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "x", output: { type: "error-text", value: "failed" } }] }]));
    expect(prompts(s)[0]).toContain(
      'Here is the agent’s recent execution trajectory: Thought: Plain words.\nThought: Think. Retrieving.\nAction: first_hop_retrieve(input="plain")\nObservation: {"k":[1]}\nObservation: {"reason":"no","type":"execution-denied"}\nObservation: failed\n',
    );
  });

  it("PW1.42 under turnBoundary start each turn begins at Start; under carry it keeps the previous turn's last action", async () => {
    const earlier = [user("first"), calls("Scan_Index"), result("Scan_Index"), { role: "assistant", content: [{ type: "text", text: "done" }] } as ModelMessage, user("second")];
    const paper = await setup("paper");
    await proceduralStep(paper.deps).prepare(input(paper, earlier, { turnId: "t2" }));
    expect(paper.records[0]).toMatchObject({ node: "Start", action: null });
    expect(prompts(paper)[0]).toContain("solving the task: first\n");
    expect(prompts(paper)[0]).toContain("active query / observation: second\n");
    expect(prompts(paper)[0]).toContain("recent execution trajectory: \n");
    const harness = await setup("harness");
    await proceduralStep(harness.deps).prepare(input(harness, earlier, { turnId: "t2" }));
    expect(harness.records[0]).toMatchObject({ node: "Scan_Index", action: "Scan_Index" });
    expect(prompts(harness)[0]).toContain("recent execution trajectory: Action: Scan_Index");
  });

  it("PW1.43 a conversation with no user message has an empty task and query", async () => {
    const s = await setup("paper");
    await proceduralStep(s.deps).prepare(input(s, []));
    expect(prompts(s)[0]).toContain("solving the task: \n");
    expect(prompts(s)[0]).toContain("active query / observation: \n");
  });

  it("PW1.58 text in string content and in parts reads the same, other parts adding nothing, and a call opening the conversation is still the last action", async () => {
    const s = await setup("harness");
    const hook = proceduralStep(s.deps);
    const file: ModelMessage = { role: "user", content: [{ type: "file", data: new Uint8Array([1]), mediaType: "image/png" }, { type: "text", text: "and this?" }] };
    await hook.prepare(input(s, [calls("Scan_Index"), result("Scan_Index"), { role: "assistant", content: "Plain words." }, { role: "user", content: "the question" }, file]));
    expect(s.records[0]).toMatchObject({ node: "Scan_Index", action: "Scan_Index" });
    expect(prompts(s)[0]).toContain("solving the task: the question\n");
    expect(prompts(s)[0]).toContain("active query / observation: and this?\n");
    expect(prompts(s)[0]).toContain("recent execution trajectory: Action: Scan_Index(q=\"Scan_Index\")\nObservation: ok\nThought: Plain words.\nUser: the question\nUser: and this?\n");
  });

  it("PW1.63 a step at an action node whose tool the session lacks is inert: neither its id nor its binding names an offered tool", async () => {
    const s = await setup("paper");
    const hook = proceduralStep(s.deps);
    const at = (tool: string, tools?: string[]) => hook.prepare(input(s, [user("q"), calls(tool), result(tool)], { ...(tools ? { tools } : {}), turnId: `${tool}-${String(tools)}` }));
    await at("Scan_Index", ["first_hop_retrieve"]); // an action node, named by its id only
    await at("Scan_Index", ["Scan_Index"]);
    await at("first_hop_retrieve", ["first_hop_retrieve"]); // named by its binding
    await at("First_Hop_Retrieve", ["First_Hop_Retrieve"]); // named by its id
    await at("First_Hop_Retrieve", ["grep"]);
    await at("Bridge_Extract", []); // not an action node
    await at("Scan_Index"); // tools unknown
    await at("grep", []); // no node
    expect(s.records.map((r) => r.inert)).toEqual([true, false, false, false, true, false, false, false]);
    await hook.turn({ ...input(s, [user("q")], { tools: [] }), lastAction: "Scan_Index" });
    expect(s.records.at(-1)).toMatchObject({ node: "Start", inert: false });
  });

  it("PW1.64 a preset counting hops in actions shows the next tool that two reasoning nodes hide from edge hops", async () => {
    const hiding = parseGraph({
      ...hotpot(),
      nodes: [
        { id: "Start", type: "STATUS", description: "Begin." },
        { id: "Retrieve", type: "ACTION", description: "Retrieve." },
        { id: "Scan_Index", type: "REASONING", description: "Scan." },
        { id: "Decide_Capital", type: "REASONING", description: "Decide." },
        { id: "Answer_Lookup", type: "ACTION", description: "Look up." },
        { id: "End", type: "STATUS", description: "Done." },
      ],
      edges: [edge("Start", "Retrieve"), edge("Retrieve", "Scan_Index"), edge("Scan_Index", "Decide_Capital"), edge("Decide_Capital", "Answer_Lookup"), edge("Answer_Lookup", "End")],
    });
    if (!hiding.ok) throw new Error("fixture");
    const at = async (preset: string, settings?: Settings) => {
      const s = await setup(preset, settings ? { settings } : {});
      await seed(s.store, hiding.graph);
      await proceduralStep(s.deps).prepare(input(s, [user("q"), calls("Retrieve"), result("Retrieve")]));
      return prompts(s)[0]!;
    };
    const edges = await at("paper");
    expect(edges).not.toContain("[Decide_Capital] → [Answer_Lookup]");
    const actions = await at("custom", withPreset("paper", { hopUnit: "action" }));
    expect(actions).toContain("Immediate Transition Options (Hop 1):\n- Transition: [Retrieve] → [Scan_Index]");
    expect(actions).toContain("- Transition: [Decide_Capital] → [Answer_Lookup]");
    expect(actions).toContain("Subsequent Horizon (Hop 2):\n- Transition: [Answer_Lookup] → [End]");
  });

  describe("state-tracker localization", () => {
    const tests = { type: "object", properties: { command: { type: "string", pattern: "^npm test" } }, required: ["command"] };
    const tracked = parseGraph({
      ...hotpot(),
      nodes: [
        { id: "Start", type: "STATUS", description: "Begin." },
        { id: "Shell", type: "ACTION", description: "Any command.", binding: { kind: "tool", name: "Bash" } },
        { id: "Run_Tests", type: "ACTION", description: "Run the tests.", binding: { kind: "tool", name: "Bash", arguments: tests } },
        { id: "Review", type: "REASONING", description: "Read the failures." },
        { id: "End", type: "STATUS", description: "Done." },
      ],
      edges: [edge("Start", "Shell"), edge("Shell", "Run_Tests"), edge("Run_Tests", "Review"), edge("Review", "End")],
    });
    if (!tracked.ok) throw new Error("fixture");
    const bash = (command: string): ModelMessage => ({ role: "assistant", content: [{ type: "tool-call", toolCallId: "b1", toolName: "Bash", input: { command } }] });
    const bashResult = (output: ToolResultPart["output"], toolCallId = "b1"): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId, toolName: "Bash", output }] });
    const declaring = (node: string | number): ToolResultPart["output"] => ({ type: "json", value: { stdout: "ok", _meta: { harness: { procedural: { node } } } } });
    const nodeAt = async (preset: string, messages: ModelMessage[]) => {
      const s = await setup("custom", { settings: withPreset(preset === "harness" ? "harness" : "paper", preset === "paper" || preset === "harness" ? {} : { match: preset }) });
      await seed(s.store, tracked.graph);
      await proceduralStep(s.deps).prepare(input(s, [user("q"), ...messages]));
      return s.records[0]!.node;
    };

    it("PW1.65 a state-tracker preset localizes a coarse tool's call by its arguments, where exact takes the bare binding", async () => {
      expect(await nodeAt("state-tracker", [bash("npm test -w procedural"), bashResult({ type: "text", value: "ok" })])).toBe("Run_Tests");
      expect(await nodeAt("state-tracker", [bash("ls"), bashResult({ type: "text", value: "ok" })])).toBe("Shell");
      expect(await nodeAt("paper", [bash("npm test -w procedural"), bashResult({ type: "text", value: "ok" })])).toBe("Shell");
    });

    it("PW1.66 a node the call's tool result declares under _meta.harness.procedural.node is the active node, in a JSON result, error or not", async () => {
      expect(await nodeAt("state-tracker", [bash("ls"), bashResult(declaring("Review"))])).toBe("Review");
      expect(await nodeAt("state-tracker", [bash("ls"), bashResult({ type: "error-json", value: { _meta: { harness: { procedural: { node: "Review" } } } } })])).toBe("Review");
      // Only the last call's own result declares; a declaration that is not a string, or a result of another call, says nothing.
      expect(await nodeAt("state-tracker", [bash("ls"), bashResult(declaring("Review"), "other")])).toBe("Shell");
      expect(await nodeAt("state-tracker", [bash("ls"), bashResult(declaring(7))])).toBe("Shell");
      expect(await nodeAt("state-tracker", [bash("ls"), bashResult({ type: "json", value: ["Review"] })])).toBe("Shell");
      expect(await nodeAt("state-tracker", [bash("ls")])).toBe("Shell");
      // The paper's exact Match ignores the declaration.
      expect(await nodeAt("paper", [bash("ls"), bashResult(declaring("Review"))])).toBe("Shell");
    });
  });

  it("PW1.59 a message tagged by another provider is not an advisory", async () => {
    const s = await setup("harness");
    const other: ModelMessage = { role: "user", content: "keep me", providerOptions: { other: { advisory: "procedural" } } };
    const out = await proceduralStep(s.deps).prepare(input(s, [other]));
    expect(out!.messages![0]).toBe(other);
    expect(out!.messages).toHaveLength(2);
  });

  it("PW1.60 without a preset name the hook runs the harness preset", async () => {
    const s = await setup("paper");
    const { preset: _, ...deps } = s.deps;
    const out = await proceduralStep(deps).prepare(input(s, [user("q")]));
    expect(out).toHaveProperty("messages");
    expect(s.records[0]!.overlay).toBe(0);
  });

  it("PW1.61 a preset without an overlay reads the core alone, even with live settings", async () => {
    const settings = withPreset("harness", { overlay: false });
    const s = await setup("custom", { settings });
    await append(s, proposed(noteOnCore, ["a"]));
    await proceduralStep(s.deps).prepare(input(s, [user("q")]));
    expect(s.records[0]!.overlay).toBeNull();
  });

  it("PW1.62 call arguments that are not an object are rendered as one input argument", async () => {
    const s = await setup("paper");
    const odd: ModelMessage = { role: "assistant", content: [{ type: "tool-call", toolCallId: "c0", toolName: "grep", input: null }, { type: "tool-call", toolCallId: "c1", toolName: "grep", input: [1, 2] }] };
    const errors: ModelMessage = { role: "tool", content: [{ type: "tool-result", toolCallId: "c0", toolName: "grep", output: { type: "error-json", value: { code: 2 } } }] };
    await proceduralStep(s.deps).prepare(input(s, [user("q"), odd, errors]));
    expect(prompts(s)[0]).toContain("recent execution trajectory: Action: grep(input=null)\nAction: grep(input=[1,2])\nObservation: {\"code\":2}\n");
  });

  it("PW1.44 the harness preset caches guidance per session: the same node, query and window reuse it with no model call", async () => {
    const s = await setup("harness");
    const hook = proceduralStep(s.deps);
    await hook.prepare(input(s, [user("q")]));
    await hook.prepare(input(s, [user("q")], { stepNumber: 1 }));
    expect(s.guidance.doGenerateCalls).toHaveLength(1);
    expect(s.records[1]).toMatchObject({ cached: true, usage: { inputTokens: 0, outputTokens: 0 }, guidanceId: s.records[0]!.guidanceId, digest: s.records[0]!.digest });
    // another session has its own cache
    await hook.prepare(input(s, [user("q")], { sessionId: "s2" }));
    expect(s.guidance.doGenerateCalls).toHaveLength(2);
    // a different query is a different entry (PG4: two queries at Start never share guidance)
    await hook.prepare(input(s, [user("another")], { stepNumber: 2 }));
    expect(s.guidance.doGenerateCalls).toHaveLength(3);
  });

  it("PW1.45 the paper preset asks the guidance model at every step", async () => {
    const s = await setup("paper");
    const hook = proceduralStep(s.deps);
    await hook.prepare(input(s, [user("q")]));
    await hook.prepare(input(s, [user("q")], { stepNumber: 1 }));
    expect(s.guidance.doGenerateCalls).toHaveLength(2);
    expect(s.records.map((r) => r.cached)).toEqual([false, false]);
    expect(s.records[0]!.guidanceId).not.toBe(s.records[1]!.guidanceId);
  });

  it("PW1.46 one version pair per turn: a head moved mid-turn is read at the next turn, and an approval round (same turn, steps restarted) does not re-pin", async () => {
    const s = await setup("harness");
    const hook = proceduralStep(s.deps);
    const before = (await s.store.heads.get(GRAPH))!.revision;
    const pins = pinCount(s);
    await hook.prepare(input(s, [user("q")]));
    const after = await seed(s.store, variant("?"), GRAPH, "dream");
    await hook.prepare(input(s, [user("q"), calls("first_hop_retrieve"), result("first_hop_retrieve")], { stepNumber: 1 }));
    await hook.prepare(input(s, [user("q"), calls("first_hop_retrieve"), result("first_hop_retrieve")], { stepNumber: 0 }));
    expect(s.records.map((r) => r.core)).toEqual([before, before, before]);
    expect(s.records.map((r) => r.node)).toEqual(["Start", "First_Hop_Retrieve", "First_Hop_Retrieve"]);
    expect(pins).toHaveBeenCalledTimes(1);
    await hook.prepare(input(s, [user("q")], { turnId: "t2" }));
    expect(s.records[3]!.core).toBe(after);
    expect(pins).toHaveBeenCalledTimes(2);
  });

  it("PW1.47 without a turn id, the first step of a stream is the turn boundary", async () => {
    const s = await setup("paper");
    const pins = pinCount(s);
    const hook = proceduralStep(s.deps);
    const { turnId: _, ...rest } = input(s, [user("q")]);
    await hook.prepare(rest);
    await hook.prepare({ ...rest, stepNumber: 1 });
    await hook.prepare({ ...rest, stepNumber: 2 });
    expect(pins).toHaveBeenCalledTimes(1);
    await hook.prepare({ ...rest, stepNumber: 0 });
    expect(pins).toHaveBeenCalledTimes(2);
  });

  it("PW1.48 the pinned core is read even after the head moves, with repinOnDream never; its revision must exist and parse", async () => {
    const settings = withPreset("paper", { repinOnDream: "never" });
    const s = await setup("custom", { settings });
    const hook = proceduralStep(s.deps);
    const pinned = (await s.store.heads.get(GRAPH))!.revision;
    await hook.prepare(input(s, [user("q")]));
    await seed(s.store, variant("!"), GRAPH, "dream");
    await hook.prepare(input(s, [user("q")], { turnId: "t2" }));
    expect(s.records.map((r) => r.core)).toEqual([pinned, pinned]);
    const missing = await setup("paper");
    await missing.store.heads.set(GRAPH, (await missing.store.heads.get(GRAPH))!.revision, RevisionIdSchema.parse("a".repeat(64)));
    await expect(proceduralStep(missing.deps).prepare(input(missing, [user("q")]))).rejects.toThrow(/pinned core revision a{64} of graph team\/retrieval is missing/);
    const broken = await setup("paper");
    const id = (await broken.store.heads.get(GRAPH))!.revision;
    const record = (await broken.store.revisions.get(id))!;
    const document = { ...record.document, nodes: record.document.nodes.filter((n) => n.id !== "Start" && n.id !== "End") };
    await broken.store.revisions.put({ ...record, document });
    const bad = parseGraph(document);
    const reasons = bad.ok ? [] : bad.diagnostics.map((d) => d.message);
    expect(reasons.length).toBeGreaterThan(1);
    await expect(proceduralStep(broken.deps).prepare(input(broken, [user("q")]))).rejects.toThrow(`the pinned core revision ${id} of graph team/retrieval does not parse: ${reasons.join("; ")}`);
  });

  it("PW1.49 the guidance model is the step's own unless the hook was given one; the turn variant needs one", async () => {
    const s = await setup("paper");
    const own = answering("own advice");
    const { model: _, ...deps } = s.deps;
    const hook = proceduralStep(deps);
    await hook.prepare(input(s, [user("q")], { model: own }));
    expect(own.doGenerateCalls).toHaveLength(1);
    expect(s.guidance.doGenerateCalls).toHaveLength(0);
    await expect(hook.turn({ ...input(s, [user("q")]), lastAction: undefined })).rejects.toThrow(/needs a guidance model/);
  });

  it("PW1.50 the turn variant guides a harness turn once, from the previous turn's last tool call under carry, and returns the labeled guidance", async () => {
    const s = await setup("harness");
    const hook = proceduralStep(s.deps);
    const text = await hook.turn({ ...input(s, [user("q")]), lastAction: "Scan_Index" });
    expect(text).toBe(`${GUIDANCE_LABEL}advice 0`);
    expect(s.records[0]).toMatchObject({ node: "Scan_Index", action: "Scan_Index", others: [] });
    await hook.turn({ ...input(s, [user("q")], { turnId: "t2" }), lastAction: undefined });
    expect(s.records[1]).toMatchObject({ node: "Start", action: null });
    const paper = await setup("paper");
    await proceduralStep(paper.deps).turn({ ...input(paper, [user("q")]), lastAction: "Scan_Index" });
    expect(paper.records[0]).toMatchObject({ node: "Start", action: null });
  });

  it("PW1.51 the turn variant re-pins every turn", async () => {
    const s = await setup("harness");
    const pins = pinCount(s);
    const hook = proceduralStep(s.deps);
    await hook.turn({ ...input(s, [user("q")]), lastAction: undefined });
    await hook.turn({ ...input(s, [user("q")]), lastAction: undefined });
    expect(pins).toHaveBeenCalledTimes(2);
  });
});

describe("proceduralStep with an overlay (plan §5.1, §6.3)", () => {
  async function overlaid(preset = "harness", settings?: Settings) {
    const s = await setup(preset, settings ? { settings } : {});
    await append(s, proposed(noteOnCore, ["a", "b", "c"]), proposed(cautionOnCore, ["a"]), proposed(verifyNode, ["a"]), proposed(toVerify, ["a"]), proposed(shortcut, ["a"]));
    return s;
  }

  it("PW1.52 a session exposed to probationary entries is shown them, labeled, and the record's exposure names exactly those shown", async () => {
    const s = await overlaid();
    const share = settingsFile.presets.harness.live!.probationShare;
    const salt = saltWhere(idOf(noteOnCore), share, true);
    await pinned(s, "s1", { overlay: 5, salt });
    const hook = proceduralStep(s.deps);
    await hook.prepare(input(s, [user("q")]));
    const prompt = prompts(s)[0]!;
    expect(prompt).toContain("  * Learned note (provisional): Retrieve before reasoning.");
    expect(s.records[0]!.overlay).toBe(5);
    expect(s.records[0]!.exposure).toContain(idOf(noteOnCore));
    // the caution sits on Bridge_Extract → End, beyond Start's two hops: not shown, so not exposure
    expect(s.records[0]!.exposure).not.toContain(idOf(cautionOnCore));
  });

  it("PW1.53 exposure covers edges, nodes, notes and cautions shown in the whole-graph fallback, and never active entries", async () => {
    const s = await overlaid();
    const everything = withPreset("harness", { live: { ...settingsFile.presets.harness.live, probationShare: 1 } });
    const hook = proceduralStep({ ...s.deps, settings: everything, preset: "custom" });
    await hook.prepare(input(s, [user("q"), calls("unknown_tool")]));
    expect(new Set(s.records[0]!.exposure)).toEqual(new Set([idOf(noteOnCore), idOf(cautionOnCore), idOf(verifyNode), idOf(toVerify), idOf(shortcut)]));
    await append(s, status(idOf(noteOnCore), "active"), status(idOf(cautionOnCore), "active"));
    await hook.prepare(input(s, [user("q"), calls("unknown_tool")], { turnId: "t2" }));
    expect(new Set(s.records[1]!.exposure)).toEqual(new Set([idOf(verifyNode), idOf(toVerify), idOf(shortcut)]));
    expect(prompts(s)[1]).toContain("  * Learned note: Retrieve before reasoning.");
  });

  it("PW1.54 exposure names an overlay node shown as the active node or as an endpoint", async () => {
    const s = await overlaid();
    const everything = withPreset("harness", { live: { ...settingsFile.presets.harness.live, probationShare: 1 } });
    const hook = proceduralStep({ ...s.deps, settings: everything, preset: "custom" });
    // at Start only the note on Start → First_Hop_Retrieve is within two hops; the Verify node is not shown
    await hook.prepare(input(s, [user("q")], { sessionId: "s0" }));
    expect(s.records.pop()!.exposure).toEqual([idOf(noteOnCore)]);
    await hook.prepare(input(s, [user("q"), calls("Verify")]));
    expect(s.records[0]).toMatchObject({ node: "Verify", exposure: [idOf(verifyNode)] });
    await hook.prepare(input(s, [user("q"), calls("Bridge_Extract")], { stepNumber: 1 }));
    expect(new Set(s.records[1]!.exposure)).toEqual(new Set([idOf(verifyNode), idOf(toVerify), idOf(cautionOnCore)]));
  });

  it("PW1.55 overlayRefresh turn reads the newest overlay at each turn boundary; session keeps the pinned version", async () => {
    for (const [refresh, versions] of [
      ["turn", [5, 6]],
      ["session", [5, 5]],
    ] as const) {
      const settings = withPreset("harness", { overlayRefresh: refresh });
      const s = await overlaid("custom", settings);
      const hook = proceduralStep(s.deps);
      await hook.prepare(input(s, [user("q")]));
      await append(s, status(idOf(noteOnCore), "active"));
      await hook.prepare(input(s, [user("q")], { turnId: "t2" }));
      expect(s.records.map((r) => r.overlay)).toEqual(versions);
    }
  });

  it("PW1.56 a session pinned to a core the overlay has been rebased past reads the overlay frozen at its pinned version, never one on another core", async () => {
    const settings = withPreset("harness", { repinOnDream: "never" });
    const s = await overlaid("custom", settings);
    const hook = proceduralStep(s.deps);
    await hook.prepare(input(s, [user("q")]));
    const next = await seed(s.store, variant("."), GRAPH, "dream");
    await append(s, { kind: "rebased", core: next, absorbed: [], dropped: [], frozenAt: 5 }, status(idOf(noteOnCore), "active"));
    await hook.prepare(input(s, [user("q")], { turnId: "t2" }));
    expect(s.records[1]).toMatchObject({ core: s.records[0]!.core, overlay: 5 });
    // a pin (kept by overlayRefresh session) whose version already includes the rebase gets no overlay rather than one on another core
    await pinned(s, "s9", { core: s.records[0]!.core, overlay: 7 });
    const late = proceduralStep({ ...s.deps, settings: withPreset("harness", { repinOnDream: "never", overlayRefresh: "session" }) });
    await late.prepare(input(s, [user("q")], { sessionId: "s9" }));
    expect(s.records[2]).toMatchObject({ core: s.records[0]!.core, overlay: 0, exposure: [] });
  });
});

describe("step records", () => {
  it("PW1.57 a record parses as StepRecordSchema, and a malformed one does not", async () => {
    const s = await setup("paper");
    await proceduralStep(s.deps).prepare(input(s, [user("q")]));
    const record = s.notices[0]!._meta.harness.procedural.step;
    expect(StepRecordSchema.parse(JSON.parse(canonicalJson(record)))).toEqual(record);
    expect(StepRecordSchema.safeParse({ ...record, text: "advice" }).success).toBe(false);
    expect(StepRecordSchema.safeParse({ ...record, digest: "short" }).success).toBe(false);
  });
});
