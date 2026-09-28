import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { usage } from "@harness/cognitive";
import { askModel } from "@harness/workflows";
import { AgentWorker, sessionAgent } from "@harness/workers";
import { approvalInbox, approveCandidate, FORMAT, GraphIdSchema, importGraph, parseCompositionSettings, parseResolver, parseSettings, presetOf } from "@harness/procedural";
import type { DreamResult, RevisionId } from "@harness/procedural";
import {
  hostPorts,
  loadProceduralComposition,
  loadProceduralSettings,
  nativeComposition,
  nativeDream,
  nativeLiveLearner,
  nativeProceduralStep,
  NodeHost,
  proceduralStore,
  snapshotSessions,
} from "@harness/platform-native";

const graph = GraphIdSchema.parse("team/pages");
const EDIT_NOTHING = JSON.stringify({ add_nodes: [], delete_nodes: [], add_edges: [], delete_edges: [] });
const DOCUMENT = {
  format: FORMAT,
  nodeTypes: ["ACTION", "REASONING", "STATUS"],
  relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
  nodes: [
    { id: "Start", type: "STATUS", description: "The task begins." },
    { id: "fetch", type: "ACTION", description: "Fetch the page." },
    { id: "summarize", type: "ACTION", description: "Summarize the page." },
    { id: "End", type: "STATUS", description: "Answered." },
  ],
  edges: [
    { from: "Start", relation: "LEADS_TO", to: "fetch", condition: null, guidance: "Fetch the page first.", pitfalls: "" },
    { from: "fetch", relation: "PROVIDES_INPUT_FOR", to: "summarize", condition: null, guidance: "Summarize what was fetched.", pitfalls: "" },
    { from: "summarize", relation: "CONVERGES_TO", to: "End", condition: null, guidance: "Answer.", pitfalls: "" },
  ],
};

/** The text of a call's user messages. */
const promptOf = (options: LanguageModelV4CallOptions): string =>
  options.prompt.flatMap((m) => (m.role === "user" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [])).join("");
const generated = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: undefined }, usage: usage(1, 1), warnings: [] });
const finish = (unified: "stop" | "tool-calls"): LanguageModelV4StreamPart => ({ type: "finish", finishReason: { unified, raw: undefined }, usage: usage(1, 1) });

describe("composition data on the native host", () => {
  it("PX2.84 composition settings load from procedural's data file by default, or from a deployment's copy; an invalid file throws", () => {
    expect(loadProceduralComposition()).toEqual({ $schema: "./composition.schema.json", support: 3, minScore: 0.7, maxLength: 6 });
    const file = join(mkdtempSync(join(tmpdir(), "procedural-")), "composition.json");
    writeFileSync(file, JSON.stringify({ support: 2, minScore: 0.5, maxLength: 3 }));
    expect(loadProceduralComposition(file)).toEqual({ support: 2, minScore: 0.5, maxLength: 3 });
    writeFileSync(file, JSON.stringify({ support: 0, minScore: 0.5, maxLength: 3 }));
    expect(() => loadProceduralComposition(file)).toThrow(/invalid composition settings/);
  });
});

describe("composition on the native host", () => {
  it("PX2.85 staging lives in the procedural directory's staging/ (a file per workflow, run journals beside them), never in the shared workflow library, which may not be the same directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "procedural-"));
    const shared = join(dir, "workflows");
    const step = { core: async () => undefined };
    const composition = nativeComposition({ dir: join(dir, "procedural"), settings: loadProceduralComposition(), step, ask: async () => "", shared });
    const next = tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => 1 });
    const w = { name: "call-next", description: "Calls next.", inputs: { type: "object" }, code: "return await tools.next({});" };
    await composition.staging.library.stage(w);
    expect(await composition.staging.host({ next }).run("call-next", {}, "tool/c1")).toMatchObject({ status: "completed", output: 1 });
    expect(JSON.parse(readFileSync(join(dir, "procedural", "staging", "call-next.json"), "utf8"))).toEqual(w);
    expect(readdirSync(join(dir, "procedural", "staging", ".runs"))).toEqual(["tool%2Fc1.json"]);
    expect(existsSync(shared)).toBe(false);
    expect(() => nativeComposition({ dir: join(dir, "procedural"), settings: loadProceduralComposition(), step, ask: async () => "", shared: join(dir, "procedural", "staging", ".") })).toThrow(
      /the shared workflow library .* cannot be procedural's staging library/,
    );
    // Without a graph a session gets the base tools, and dream's composer has their specs.
    const withBase = nativeComposition({ dir: join(dir, "procedural"), settings: loadProceduralComposition(), step, ask: async () => "", base: () => ({ next }) });
    expect(Object.keys(await withBase.tools({ sessionId: "s", report: () => {} }))).toEqual(["next"]);
    expect(await withBase.composer()).toMatchObject({ settings: { support: 3 }, toolSpecs: { next: { inputSchema: { type: "object" } } }, staging: withBase.staging.library });
    // The session tools are dream's tool catalog.
    expect(await withBase.catalog()).toEqual(["next"]);
    expect(await composition.tools({ sessionId: "s", report: () => {} })).toEqual({});
    expect(await composition.catalog()).toEqual([]);
  });

  it("PX2.86 nativeDream takes a composer and a tool catalog made for each dream, so it sees the session tools as they are then", async () => {
    const store = proceduralStore(mkdtempSync(join(tmpdir(), "procedural-")));
    await importGraph({ store, graph, clock: hostPorts.clock });
    let made = 0;
    const composer = async () => ((made += 1), { settings: parseCompositionSettings({ support: 1, minScore: 0, maxLength: 4 }), toolSpecs: {}, staging: { stage: async () => Promise.reject(new Error("unused")) } });
    let listed = 0;
    const tools = async () => ((listed += 1), [`lookup_${listed}`]);
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({ doGenerate: async (o) => (prompts.push(promptOf(o)), generated(EDIT_NOTHING)) });
    const dream = nativeDream({ store, settings: loadProceduralSettings(), model, sessions: async () => [], composer, tools });
    const result = await dream(graph);
    expect(result).toMatchObject({ status: "done", rounds: [{}, {}, {}, { round: 4, outcome: "no-composition" }] });
    expect(prompts[0]).toContain("lookup_1");
    await dream(graph);
    expect([made, listed]).toEqual([2, 2]);
    expect(prompts.at(-1)).toContain("lookup_2");
  });

  it("PX2.87 end to end in the daemon: a dream composes a path sessions walked, and once approved the next session, pinned to the new head, is offered the workflow and runs it; a session on the old head is not, nor is anyone once the staged code no longer matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "procedural-"));
    const store = proceduralStore(join(dir, "procedural"));
    await importGraph({ store, graph, document: DOCUMENT, clock: hostPorts.clock });
    // A deployment keeps each session on the core it pinned (repinOnDream never), so old sessions stay on the old head.
    const file = loadProceduralSettings();
    const settings = parseSettings({ ...file, presets: { ...file.presets, harness: { ...file.presets["harness"], repinOnDream: "never" } } });
    const resolver = parseResolver({ rules: [{ when: {}, graph: "team/pages" }] });

    // The session tools: every call performed is recorded.
    const performed: [string, unknown][] = [];
    const base: ToolSet = {
      fetch: tool({ description: "Fetch a page.", inputSchema: jsonSchema({ type: "object", properties: { url: { type: "string" } }, required: ["url"] }), execute: async (a: unknown) => (performed.push(["fetch", a]), { text: `text of ${(a as { url: string }).url}` }) }),
      summarize: tool({ description: "Summarize text.", inputSchema: jsonSchema({ type: "object", properties: { text: { type: "string" } }, required: ["text"] }), execute: async (a: unknown) => (performed.push(["summarize", a]), { summary: "short" }) }),
    };
    // The session model: each turn follows the next script; guidance and workflow questions are generated.
    const offered: string[][] = [];
    const scripts: ((o: LanguageModelV4CallOptions) => LanguageModelV4StreamPart[])[] = [];
    let calls = 0;
    const toolCall = (toolName: string, input: unknown): LanguageModelV4StreamPart => ({ type: "tool-call", toolCallId: `call-${(calls += 1)}`, toolName, input: JSON.stringify(input) });
    const say = (text: string): LanguageModelV4StreamPart[] => [{ type: "text-start", id: "0" }, { type: "text-delta", id: "0", delta: text }, { type: "text-end", id: "0" }, finish("stop")];
    const model = new MockLanguageModelV4({
      doStream: async (o) => {
        offered.push((o.tools ?? []).map((t) => t.name).sort());
        return { stream: convertArrayToReadableStream([{ type: "stream-start", warnings: [] }, ...scripts.shift()!(o)]) };
      },
      doGenerate: async (o) => {
        const prompt = promptOf(o);
        if (!prompt.includes("Fill in the arguments")) return generated("Fetch the page, then summarize it.");
        const context = JSON.parse(prompt.slice(prompt.indexOf("so far:\n") + "so far:\n".length)) as { steps: { text: string }[] };
        return generated(JSON.stringify({ text: context.steps[0]!.text }));
      },
    });
    const step = nativeProceduralStep({ store, settings, resolver, principal: "me" });
    const composition = nativeComposition({ dir: join(dir, "procedural"), settings: loadProceduralComposition(), step, ask: askModel(model), base: () => base, shared: join(dir, "workflows") });
    const worker = new AgentWorker({ agent: sessionAgent({ model, step, tools: composition.tools }) });
    const host = await NodeHost.start({ worker, identity: { principal: "me", kind: "human" }, tickMs: 60_000 });
    const live = nativeLiveLearner({ runtime: host.runtime, store, settings, intervalMs: 60_000 });

    const replies = new Map<number, Record<string, unknown>>();
    const connection = host.runtime.connect({ principal: "me", kind: "human" }, (m) => void replies.set((m as { id: number }).id, m as Record<string, unknown>));
    let id = 0;
    const request = async (method: string, params: Record<string, unknown>) => {
      const mine = (id += 1);
      connection.receive({ jsonrpc: "2.0", id: mine, method, params });
      for (let i = 0; i < 4_000 && !replies.has(mine); i++) await new Promise((r) => setTimeout(r, 5));
      return replies.get(mine)!["result"] as Record<string, unknown>;
    };
    await request("initialize", { protocolVersion: 1 });
    const session = async () => ((await request("session/new", { cwd: "/", mcpServers: [] })) as { sessionId: string }).sessionId;
    const lastTurn = (sessionId: string): string => {
      const log = snapshotSessions(host.daemon.snapshot()).find((s) => s.id === sessionId)!.entries;
      const ended = log.flatMap((e) => ((e.payload as { event?: string }).event === "turn.ended" ? [(e.payload as { data: { turnId: string } }).data.turnId] : []));
      return ended.at(-1)!;
    };
    const prompt = (sessionId: string, text: string) => request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    /** A turn that walks fetch → summarize by hand. */
    const walk = (url: string) => {
      scripts.push(() => [toolCall("fetch", { url }), finish("tool-calls")]);
      scripts.push(() => [toolCall("summarize", { text: `text of ${url}` }), finish("tool-calls")]);
      scripts.push(() => say(`summarized ${url}`));
    };

    // Three sessions walk fetch → summarize, and each turn is scored well by feedback after it was observed.
    const old: string[] = [];
    for (const url of ["https://a.example/1", "https://a.example/2", "https://a.example/3"]) {
      const s = await session();
      old.push(s);
      walk(url);
      expect(await prompt(s, `Summarize ${url}`)).toMatchObject({ stopReason: "end_turn" });
      await live.drain();
      expect(await live.learner.feedback(s, lastTurn(s), 0.9)).toMatchObject({ kind: "rescored" });
    }
    const seedHead = (await store.heads.get(graph))!.revision;
    expect(offered).toEqual(Array.from({ length: 9 }, () => ["fetch", "summarize"]));

    // Dream composes the path into a workflow, staged in the procedural directory; it waits for approval (a workflow may have side effects).
    const dream = nativeDream({
      store,
      settings,
      model: new MockLanguageModelV4({ doGenerate: async () => generated(EDIT_NOTHING) }),
      sessions: async () => snapshotSessions(host.daemon.snapshot()),
      inbox: approvalInbox(() => {}),
      composer: composition.composer,
      tools: composition.catalog,
    });
    const result = (await dream(graph)) as Extract<DreamResult, { status: "done" }>;
    const composed = result.rounds.at(-1) as { round: number; outcome: string; revision: RevisionId };
    expect(composed).toMatchObject({ round: 4, outcome: "pending-approval", gate: "approval-for-side-effects" });
    const record = (await store.revisions.get(composed.revision))!;
    const node = record.document.nodes.find((n) => n.binding?.kind === "workflow")!;
    const name = node.binding!.name;
    expect(record.evidence).toMatchObject({ composition: { path: ["fetch", "summarize"], node: name, support: 3 } });
    expect(existsSync(join(dir, "procedural", "staging", `${name}.json`))).toBe(true);
    expect(existsSync(join(dir, "workflows"))).toBe(false);
    expect(await approveCandidate({ store, record, preset: presetOf(settings, "harness"), clock: hostPorts.clock })).toMatchObject({ status: "committed", revision: composed.revision, previous: seedHead });

    // A new session pins the new head: it is offered the workflow, and calling it runs fetch → summarize with the data flow kept.
    const fresh = await session();
    scripts.push(() => [toolCall(name, { url: "https://b.example/4" }), finish("tool-calls")]);
    scripts.push(() => say("done in one call"));
    performed.length = 0;
    expect(await prompt(fresh, "Summarize https://b.example/4")).toMatchObject({ stopReason: "end_turn" });
    expect(offered.at(-2)).toEqual(["fetch", name, "summarize"].sort());
    expect(performed).toEqual([
      ["fetch", { url: "https://b.example/4" }],
      ["summarize", { text: "text of https://b.example/4" }],
    ]);
    expect(await store.pins.get(fresh)).toMatchObject({ core: composed.revision });
    expect(readdirSync(join(dir, "procedural", "staging", ".runs"))).toEqual([`tool%2Fcall-${calls}.json`]);

    // A session on the old head is not offered it.
    walk("https://a.example/5");
    await prompt(old[0]!, "Summarize https://a.example/5");
    expect(offered.slice(-3)).toEqual(Array.from({ length: 3 }, () => ["fetch", "summarize"]));
    expect(await store.pins.get(old[0]!)).toMatchObject({ core: seedHead });

    // Staged code that no longer hashes to the binding is not offered: the node is inert.
    const staged = join(dir, "procedural", "staging", `${name}.json`);
    writeFileSync(staged, JSON.stringify({ ...(JSON.parse(readFileSync(staged, "utf8")) as object), code: "return 1;" }));
    walk("https://b.example/6");
    await prompt(fresh, "Summarize https://b.example/6");
    expect(offered.slice(-3)).toEqual(Array.from({ length: 3 }, () => ["fetch", "summarize"]));

    live.close();
    connection.disconnect();
    await host.close();
  });
});
