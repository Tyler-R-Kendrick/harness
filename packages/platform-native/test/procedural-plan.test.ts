import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { usage } from "@harness/cognitive";
import type { HookEvent } from "@harness/core";
import { EchoWorker } from "@harness/workers";
import { FORMAT, GraphIdSchema, importGraph, planFromSubgraph, readGraph } from "@harness/procedural";
import { PlanRunIdSchema } from "@harness/procedural";
import type { PlanNotice, PlanRunOutcome } from "@harness/procedural";
import { buildNativeEnsemble, describePlanRun, hookNotifier, hostPorts, loadProceduralSettings, nativePlanRunner, NodeHost, planRunsStore, proceduralStore, pumpHookEvents } from "@harness/platform-native";

const graph = GraphIdSchema.parse("team/pages");
const DOCUMENT = {
  format: FORMAT,
  nodeTypes: ["ACTION", "REASONING", "STATUS"],
  relations: ["LEADS_TO", "TRIGGERS", "PROVIDES_INPUT_FOR", "CONVERGES_TO"],
  nodes: [
    { id: "Start", type: "STATUS", description: "The task begins." },
    { id: "fetch", type: "ACTION", description: "Fetch the page.", binding: { kind: "tool", name: "fetch" } },
    { id: "summarize", type: "ACTION", description: "Summarize the page.", binding: { kind: "tool", name: "summarize" } },
    { id: "End", type: "STATUS", description: "Answered." },
  ],
  edges: [
    { from: "Start", relation: "LEADS_TO", to: "fetch", condition: null, guidance: "Fetch the page first.", pitfalls: "" },
    { from: "fetch", relation: "PROVIDES_INPUT_FOR", to: "summarize", condition: null, guidance: "Summarize what was fetched.", pitfalls: "" },
    { from: "summarize", relation: "CONVERGES_TO", to: "End", condition: null, guidance: "Answer.", pitfalls: "" },
  ],
};

/** The session tools: every call is recorded. */
function sessionTools(performed: [string, unknown][] = []): ToolSet {
  return {
    fetch: tool({ inputSchema: jsonSchema({ type: "object", properties: { url: { type: "string" } } }), execute: async (a: unknown) => (performed.push(["fetch", a]), { text: "page text" }) }),
    summarize: tool({ inputSchema: jsonSchema({ type: "object", properties: { text: { type: "string" } } }), execute: async (a: unknown) => (performed.push(["summarize", a]), { summary: "short" }) }),
  };
}

/** A model that calls the one tool it is offered, with arguments for it. */
function caller(offered: string[][] = []) {
  return new MockLanguageModelV4({
    doGenerate: async (o: LanguageModelV4CallOptions) => {
      const name = o.tools![0]!.name;
      offered.push((o.tools ?? []).map((t) => t.name));
      const input = name === "fetch" ? { url: "https://a.example" } : { text: "page text" };
      return { content: [{ type: "tool-call" as const, toolCallId: `call-${name}`, toolName: name, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: usage(1, 1), warnings: [] };
    },
  });
}

async function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "procedural-plans-"));
  const store = proceduralStore(dir);
  await importGraph({ store, graph, document: DOCUMENT, clock: hostPorts.clock });
  const view = await readGraph({ store, graph });
  if (view.status !== "ok") throw new Error("fixture");
  const built = planFromSubgraph(view.effective, "Start", "End");
  if (!built.ok) throw new Error("fixture");
  return { dir, store, plan: built.plan };
}

describe("plans on the native host", () => {
  it("PX2.138 nativePlanRunner runs a plan on the model with the host's tools, each task offered its bound tool, keeping the run in plan-runs.json beside the store until it ends", async () => {
    const { dir, store, plan } = await seeded();
    const performed: [string, unknown][] = [];
    const offered: string[][] = [];
    let kept: unknown;
    const tools = sessionTools(performed);
    const runner = nativePlanRunner({
      dir,
      store,
      settings: loadProceduralSettings(),
      model: caller(offered),
      tools: (context) => {
        kept = JSON.parse(readFileSync(join(dir, "plan-runs.json"), "utf8"));
        expect(context.view?.core.nodes.map((n) => n.id)).toEqual(["Start", "fetch", "summarize", "End"]);
        return tools;
      },
    });
    const outcome = await runner.run(graph, plan);
    expect(outcome).toMatchObject({ graph, status: "succeeded", tasks: [{ id: "fetch", output: { text: "page text" } }, { id: "summarize", output: { summary: "short" } }] });
    expect(outcome.run).toMatch(/^[0-9a-f]{16}$/);
    expect(offered).toEqual([["fetch"], ["summarize"]]);
    expect(performed).toEqual([
      ["fetch", { url: "https://a.example" }],
      ["summarize", { text: "page text" }],
    ]);
    expect(kept).toMatchObject({ runs: [{ id: outcome.run, graph }] });
    expect(JSON.parse(readFileSync(join(dir, "plan-runs.json"), "utf8"))).toEqual({ runs: [] });
  });

  it("PX2.126 a run left in plan-runs.json (a daemon that stopped mid-run) is resumed by the next runner over the directory, from where it stopped", async () => {
    const { dir, store, plan } = await seeded();
    plan.start("fetch");
    plan.complete("fetch", "succeeded");
    writeFileSync(join(dir, "plan-runs.json"), JSON.stringify({ runs: [{ id: "00000000000000aa", graph, state: { plan: plan.toJSON(), outcomes: { fetch: { ok: true, output: { text: "kept text" } } } } }] }));
    const performed: [string, unknown][] = [];
    const notices: PlanNotice[] = [];
    const runner = nativePlanRunner({ dir, store, settings: loadProceduralSettings(), model: caller(), tools: sessionTools(performed), notify: (n) => void notices.push(n) });
    const [resumed] = (await runner.resume()) as PlanRunOutcome[];
    expect(resumed).toMatchObject({ run: "00000000000000aa", status: "succeeded", tasks: [{ id: "fetch", output: { text: "kept text" } }, { id: "summarize", output: { summary: "short" } }] });
    expect(performed.map(([name]) => name)).toEqual(["summarize"]);
    expect(notices).toEqual([{ type: "procedural.plan.completed", payload: resumed }]);
    expect(await planRunsStore(dir).list()).toEqual([]);
    // Without tools, a bound task has nothing to call and fails.
    const bare = nativePlanRunner({ dir, store, settings: loadProceduralSettings(), model: caller() });
    expect((await bare.run(graph, (await seeded()).plan)).tasks[0]).toEqual({ id: "fetch", status: "failed", error: "tool fetch is not available to plans" });
  });

  it("PX2.127 the ensemble serves procedural.plan and procedural.run with the host's runner, and the run's end is announced on the hook bus as procedural.plan.completed", async () => {
    const { dir, store } = await seeded();
    const settings = loadProceduralSettings();
    const live: { notify?: (notice: PlanNotice) => void } = {};
    const plans = nativePlanRunner({ dir, store, settings, model: caller(), tools: sessionTools(), notify: (n) => live.notify?.(n) });
    const cognitive = buildNativeEnsemble({ cacheDir: join(dir, "models"), allowHosted: false, catalog: { models: [], preferences: {} }, procedural: { dir, store, settings, plans } });
    const host = await NodeHost.start({ worker: new EchoWorker(), identity: { principal: "me", kind: "human" }, cognitive: cognitive.ensemble, tickMs: 60_000 });
    live.notify = hookNotifier(host.runtime);
    const events: HookEvent[] = [];
    const watcher = pumpHookEvents(host.runtime, { plugin: "plans-watcher", types: ["procedural.plan.*"], onEvent: async (e) => void events.push(e), intervalMs: 60_000 });
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
    expect(await invoke("procedural.plan", { graph, from: "Start", to: "End" })).toMatchObject({ status: "ok", plan: { nodes: [{ id: "fetch" }, { id: "summarize" }] } });
    const outcome = (await invoke("procedural.run", { graph, from: "fetch", to: "summarize" })) as PlanRunOutcome;
    expect(outcome).toMatchObject({ status: "succeeded", tasks: [{ id: "fetch" }, { id: "summarize" }] });
    await watcher.drain();
    expect(events.map((e) => [e.source, e.type, e.payload])).toEqual([["procedural", "procedural.plan.completed", outcome]]);
    watcher.close();
    await host.close();
    await cognitive.close();
    expect(existsSync(join(dir, "plan-runs.json"))).toBe(true);
  });

  it("PX2.128 a plan run's end is logged in a line: its status and how many tasks ended how, or why a kept run could not be resumed", () => {
    const run = PlanRunIdSchema.parse("00000000000000ab");
    expect(describePlanRun({ run, graph, status: "succeeded", tasks: [{ id: "a", status: "succeeded" }, { id: "b", status: "succeeded" }] })).toBe("procedural: plan run 00000000000000ab on team/pages succeeded: 2 succeeded");
    expect(describePlanRun({ run, graph, status: "failed", tasks: [{ id: "a", status: "failed", error: "x" }, { id: "b", status: "skipped" }, { id: "c", status: "skipped" }] })).toBe(
      "procedural: plan run 00000000000000ab on team/pages failed: 1 failed, 2 skipped",
    );
    expect(describePlanRun({ run, graph, status: "succeeded", tasks: [] })).toBe("procedural: plan run 00000000000000ab on team/pages succeeded: no tasks");
    expect(describePlanRun({ run, graph, status: "invalid", reason: "task z is not in the plan" })).toBe("procedural: plan run 00000000000000ab on team/pages could not be resumed and was dropped: task z is not in the plan");
  });
});
