import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { usage } from "@harness/cognitive";
import { ScriptedEnvironment } from "@harness/testkit";
import { EchoWorker } from "@harness/workers";
import type { HookEvent } from "@harness/core";
import { approvalInbox, applyEdits, EditSetSchema, FORMAT, GraphIdSchema, MemoryProceduralStore, parseCompositionSettings, parseGraph, revisionId, RevisionRecordSchema } from "@harness/procedural";
import type { ApprovalNotice, RevisionRecord } from "@harness/procedural";
import { buildNativeEnsemble, hookNotifier, loadProceduralSettings, nativeDream, NodeHost, pumpHookEvents, snapshotSessions, terminalApprover } from "@harness/platform-native";

const settings = loadProceduralSettings();
const graph = GraphIdSchema.parse("team/search");
const parsed = parseGraph({
  format: FORMAT,
  nodeTypes: ["ACTION", "REASONING", "STATUS"],
  relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
  nodes: [
    { id: "Start", type: "STATUS", description: "The task begins." },
    { id: "search", type: "ACTION", description: "Search the index." },
    { id: "End", type: "STATUS", description: "Answered." },
  ],
  edges: [
    { from: "Start", relation: "LEADS_TO", to: "search", condition: null, guidance: "Search the index before anything else.", pitfalls: "" },
    { from: "search", relation: "LEADS_TO", to: "End", condition: null, guidance: "Answer.", pitfalls: "" },
  ],
});
if (!parsed.ok) throw new Error("fixture");
const seed = parsed.graph;
/** The refiner's answer: the first edge's guidance, shorter (the evidence gate's rewrite rule). */
const shorter = { add_nodes: [], delete_nodes: [], delete_edges: [{ source: "Start", target: "search" }], add_edges: [{ source: "Start", target: "search", relation: "LEADS_TO", condition: null, guidance: "Search first.", pitfalls: "" }] };

const promptOf = (options: LanguageModelV4CallOptions): string => JSON.stringify(options.prompt);

describe("dream on the native host", () => {
  it("PX2.58 nativeDream refines with the model over the daemon's session logs, and commits what the gates and the approver accept", async () => {
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" }, tickMs: 60_000 });
    const connection = host.runtime.connect({ principal: "me", kind: "human" }, () => {});
    const store = new MemoryProceduralStore();
    await store.revisions.put(RevisionRecordSchema.parse({ id: revisionId(seed), graph, parents: [], document: seed, edits: null, origin: "import", evidence: {}, decision: { kind: "head" }, at: 0 }));
    await store.heads.set(graph, undefined, revisionId(seed));
    connection.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    connection.receive({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/", mcpServers: [] } });
    const sessionId = host.daemon.snapshot().sessions[0]!.id;
    await store.pins.set(sessionId, { graph, core: revisionId(seed), overlay: 0, salt: "s", at: 0 });
    connection.receive({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "find the release notes" }] } });
    for (let i = 0; i < 400 && !JSON.stringify(host.daemon.snapshot()).includes("turn.ended"); i++) await new Promise((r) => setTimeout(r, 5));

    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(promptOf(options));
        return { content: [{ type: "text", text: JSON.stringify(shorter) }], finishReason: { unified: "stop", raw: undefined }, usage: usage(1, 1), warnings: [] };
      },
    });
    const asked: RevisionRecord[] = [];
    const dream = nativeDream({
      store,
      settings,
      model,
      sessions: async () => snapshotSessions(host.daemon.snapshot()),
      approver: { approve: async ({ candidate }) => (asked.push(candidate), true) },
      tools: ["search"],
    });
    const result = await dream(graph);
    // The harness preset runs three rounds; the model proposes the same edit, which the later rounds already have.
    expect(result).toMatchObject({ status: "done", rounds: [{ round: 1, outcome: "committed" }, { outcome: "unchanged" }, { outcome: "unchanged" }] });
    expect(prompts[0]).toContain("find the release notes");
    expect(asked).toHaveLength(1);
    const head = await store.heads.get(graph);
    expect(head?.history).toEqual([revisionId(seed)]);
    expect((await store.revisions.get(graph, head!.revision))?.document.edges[1]).toMatchObject({ from: "Start", to: "search", guidance: "Search first." });
    connection.disconnect();
    await host.close();
  });

  it("PX2.59 session logs come from a daemon snapshot, or a state file's; anything else has none", () => {
    expect(snapshotSessions({ version: 1, sessions: [{ id: "s1", log: { entries: [{ offset: 0, at: 1, kind: "event", payload: {} }] } }, { id: "s2", log: {} }], hooks: {} })).toEqual([
      { id: "s1", entries: [{ offset: 0, at: 1, kind: "event", payload: {} }] },
      { id: "s2", entries: [] },
    ]);
    expect(snapshotSessions(undefined)).toEqual([]);
    expect(snapshotSessions({ sessions: "no" })).toEqual([]);
  });

  it("PX2.60 the terminal approver names the candidate and its tools, and approves only on yes", async () => {
    const ask = async (answer: string, tools: string[]) => {
      const input = new PassThrough();
      const output = new PassThrough();
      let shown = "";
      output.on("data", (d: Buffer) => (shown += d.toString()));
      const decided = terminalApprover(input, output).approve({ graph, candidate: { id: revisionId(seed) } as RevisionRecord, tools });
      input.write(`${answer}\n`);
      return { approved: await decided, shown };
    };
    expect(await ask("y", ["search"])).toEqual({ approved: true, shown: `Approve dream candidate ${revisionId(seed).slice(0, 12)} of graph team/search, routing into tools search? [y/N] ` });
    expect((await ask(" YES ", [])).approved).toBe(true);
    expect(await ask("", [])).toMatchObject({ approved: false, shown: expect.stringContaining("routing into no tools") });
    expect((await ask("yess", [])).approved).toBe(false);
  });

  it("PX2.65 nativeDream hands runDream the evaluator, the composer, the task and the tools declared free of side effects it is given", async () => {
    const seeded = async () => {
      const store = new MemoryProceduralStore();
      await store.revisions.put(RevisionRecordSchema.parse({ id: revisionId(seed), graph, parents: [], document: seed, edits: null, origin: "import", evidence: {}, decision: { kind: "head" }, at: 0 }));
      await store.heads.set(graph, undefined, revisionId(seed));
      return store;
    };
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(promptOf(options));
        return { content: [{ type: "text", text: JSON.stringify(shorter) }], finishReason: { unified: "stop", raw: undefined }, usage: usage(1, 1), warnings: [] };
      },
    });
    const route = { query: "find the changelog", route: ["Start", "search", "End"] };
    const evaluator = new ScriptedEnvironment({ train: [{ id: "t1", ...route }], validation: [{ id: "v1", ...route }] });
    const staged: unknown[] = [];
    const composer = { settings: parseCompositionSettings({ support: 1, minScore: 0, maxLength: 4 }), toolSpecs: {}, staging: { stage: async (w: unknown) => (staged.push(w), Promise.reject(new Error("no staging"))) } };
    const base = { settings, model, sessions: async () => [], tools: ["search"] };
    // The evaluator gates the candidate (one validation task cannot show non-inferiority), the task reaches the refiner, and the composer gets its round.
    const evaluated = await nativeDream({ ...base, store: await seeded(), evaluator, composer, task: "Answer from the release notes." })(graph);
    expect(evaluator.calls.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain("Answer from the release notes.");
    expect(evaluated).toMatchObject({ status: "done", rounds: [{ round: 1, outcome: "rejected", gate: "evaluator-anchored-noninferiority" }, {}, {}, { round: 4, outcome: "no-composition", reason: "no path has the support and score to compile" }] });
    expect(staged).toEqual([]);
    // A candidate routing into a tool declared free of side effects needs no approver.
    expect(await nativeDream({ ...base, store: await seeded(), sideEffectFree: ["search"] })(graph)).toMatchObject({ status: "done", rounds: [{ round: 1, outcome: "committed" }, {}, {}] });
    // Without them: the candidate needs an approver there is not, and there is no composition round.
    const bare = await nativeDream({ ...base, store: await seeded() })(graph);
    expect(bare).toMatchObject({ status: "done", rounds: [{ round: 1, outcome: "rejected", gate: "approval-for-side-effects" }, {}, {}] });
    expect((bare as { rounds: unknown[] }).rounds).toHaveLength(3);
  });

  it("PX2.111 in the native daemon, a dream with no approver leaves a candidate needing approval in the inbox and announces it on the hook bus; procedural.approve over ACP commits it on the head and announces the decision", async () => {
    const store = new MemoryProceduralStore();
    await store.revisions.put(RevisionRecordSchema.parse({ id: revisionId(seed), graph, parents: [], document: seed, edits: null, origin: "import", evidence: {}, decision: { kind: "head" }, at: 0 }));
    await store.heads.set(graph, undefined, revisionId(seed));
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: "text", text: JSON.stringify(shorter) }], finishReason: { unified: "stop", raw: undefined }, usage: usage(1, 1), warnings: [] }),
    });
    // As main.ts wires it: the extension and dream announce through the host, which starts after them.
    const live: { notify?: (notice: ApprovalNotice) => void } = {};
    const notify = (notice: ApprovalNotice) => live.notify?.(notice);
    const dream = nativeDream({ store, settings, model, sessions: async () => [], tools: ["search"], inbox: approvalInbox(notify) });
    const dir = mkdtempSync(join(tmpdir(), "harness-approvals-"));
    const cognitive = buildNativeEnsemble({ cacheDir: join(dir, "models"), allowHosted: false, procedural: { dir, store, settings, dream, notify } });
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" }, cognitive: cognitive.ensemble, tickMs: 60_000 });
    live.notify = hookNotifier(host.runtime);
    const events: HookEvent[] = [];
    const watcher = pumpHookEvents(host.runtime, { plugin: "approvals-watcher", types: ["procedural.approval.*"], onEvent: async (e) => void events.push(e), intervalMs: 60_000 });

    const replies = new Map<number, { result?: unknown; error?: { message: string } }>();
    const client = host.runtime.connect({ principal: "me", kind: "human" }, (m) => void replies.set((m as { id: number }).id, m as { result?: unknown }));
    let next = 0;
    const invoke = async (op: string, input: unknown): Promise<unknown> => {
      const id = (next += 1);
      client.receive({ jsonrpc: "2.0", id, method: "_harness/cognitive/invoke", params: { op, input } });
      for (let i = 0; i < 2_000 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 5));
      const reply = replies.get(id)!;
      if (reply.error) throw new Error(reply.error.message);
      return reply.result;
    };
    client.receive({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } });

    const candidate = revisionId(applyEdits(seed, EditSetSchema.parse(shorter)));
    expect(await invoke("procedural.dream", { graph })).toMatchObject({
      status: "done",
      result: { status: "done", head: revisionId(seed), rounds: [{ round: 1, outcome: "pending-approval", revision: candidate, gate: "approval-for-side-effects" }, { outcome: "pending-approval" }, { outcome: "pending-approval" }] },
    });
    expect(await invoke("procedural.approvals", { graph })).toMatchObject({ head: revisionId(seed), approvals: [{ candidate, origin: "dream", onHead: true, gate: "approval-for-side-effects", tools: ["search"] }] });
    await watcher.drain();
    expect(events.map((e) => [e.type, e.source, e.payload])).toEqual([["procedural.approval.requested", "procedural", expect.objectContaining({ graph, candidate, tools: ["search"] })]]);

    expect(await invoke("procedural.approve", { graph, candidate })).toEqual({ status: "committed", graph, candidate, revision: candidate, previous: revisionId(seed) });
    expect(await store.heads.get(graph)).toEqual({ revision: candidate, history: [revisionId(seed)] });
    expect((await invoke("procedural.approvals", { graph })) as { approvals: unknown[] }).toMatchObject({ approvals: [] });
    await watcher.drain();
    expect(events.at(-1)).toMatchObject({ type: "procedural.approval.decided", source: "procedural", payload: { graph, candidate, decision: "approved", revision: candidate } });
    // The notices are in the daemon's snapshot, so they survive a restart.
    expect(JSON.stringify(host.daemon.snapshot())).toContain("procedural.approval.decided");
    watcher.close();
    client.disconnect();
    await host.close();
    await cognitive.close();
  });
});
