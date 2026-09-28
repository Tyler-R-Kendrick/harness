import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { MemoryLibrary, parseWorkflow, quickjsCodeMode } from "@harness/workflows";
import type { Workflow } from "@harness/workflows";
import { MemoryStorage } from "@harness/testkit";
import { compilePath, composeCandidate, composer, composition, NodeNameSchema, parseGraph, sessionTools, staging, StagingLibrary, toolSpecs, workflowBinding } from "@harness/procedural";
import type { ProceduralGraph, StagingFiles, StepScope, ToolsScope } from "@harness/procedural";
import { chain, PATH, RUNS, settings, SPECS } from "./compose-fixtures.ts";

/** Staging files in memory: a library with a journal per run, as a host keeps them. */
function files(): StagingFiles & { journals: Map<string, MemoryStorage> } {
  const library = new MemoryLibrary();
  const journals = new Map<string, MemoryStorage>();
  return {
    journals,
    get: (name) => library.get(name),
    put: (w) => library.put(w),
    list: () => library.list(),
    journal: (run) => journals.get(run) ?? (journals.set(run, new MemoryStorage()), journals.get(run)!),
  };
}

const compiled = (): Workflow => {
  const result = compilePath(
    PATH.map((n) => NodeNameSchema.parse(n)),
    RUNS,
    SPECS,
  );
  if (!result.ok) throw new Error(result.error);
  return result.workflow;
};

/** The chain with the path bound to `w`: the core a session pins after dream commits the composition. */
function bound(w: Workflow): ProceduralGraph {
  const c = composeCandidate(chain(), PATH.map((n) => NodeNameSchema.parse(n)), w);
  if (!c.ok) throw new Error(c.error);
  const parsed = parseGraph(c.document);
  if (!parsed.ok) throw new Error("unparsed");
  return parsed.graph;
}

const scope = (sessionId: string): ToolsScope => ({ sessionId, turnId: "t1", report: () => {} });

describe("composition on a host", () => {
  it("PC1.36 staging keeps staged workflows in the host's files (checked and immutable, as the staging library), and its host runs one on the base tools it is given, journaled in those files", async () => {
    const store = files();
    const s = staging({ files: store, codeMode: quickjsCodeMode(), ask: async () => "" });
    expect(s.library).toBeInstanceOf(StagingLibrary);
    const w = parseWorkflow({ name: "twice", description: "Calls next twice.", inputs: { type: "object" }, code: "return [await tools.next({}), await tools.next({})];" });
    expect(await s.library.stage(w)).toEqual(workflowBinding(w));
    expect(await store.get("twice")).toEqual(w);
    await expect(s.library.put({ ...w, code: "return 1;" })).rejects.toThrow(/immutable/);
    let n = 0;
    const next = tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => ++n });
    expect(await s.host({ next }).run("twice", {}, "tool/c1")).toMatchObject({ status: "completed", output: [1, 2] });
    expect([...store.journals.keys()]).toEqual(["tool/c1"]);
    // Another turn's base tools: the host is built on them.
    const other = tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "other" });
    expect(await s.host({ next: other }).run("twice", {}, "tool/c2")).toMatchObject({ status: "completed", output: ["other", "other"] });
  });

  it("PC1.37 toolSpecs gives each tool's input JSON Schema, and its description when it has one as text", async () => {
    const tools: ToolSet = {
      contextual: tool({ description: () => "Depends on the call.", inputSchema: jsonSchema({ type: "object" }), execute: async () => "" }),
      search: tool({ description: "Search the web.", inputSchema: z.object({ query: z.string() }), execute: async () => [] }),
      fetch: tool({ inputSchema: jsonSchema({ type: "object", properties: { url: { type: "string" } }, required: ["url"] }), execute: async () => "" }),
    };
    expect(await toolSpecs(tools)).toEqual({
      contextual: { inputSchema: { type: "object" } },
      search: { description: "Search the web.", inputSchema: expect.objectContaining({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }) },
      fetch: { inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    });
    expect(await toolSpecs({})).toEqual({});
  });

  it("PC1.38 composer gives dream the composition settings, the session tools' specs and the staging library, and how many runs to read when given", async () => {
    const s = staging({ files: files(), codeMode: quickjsCodeMode(), ask: async () => "" });
    const tools: ToolSet = { search: tool({ description: "Search.", inputSchema: jsonSchema({ type: "object" }), execute: async () => [] }) };
    const c = await composer({ settings: settings(), staging: s, tools });
    expect(c).toStrictEqual({ settings: settings(), toolSpecs: { search: { description: "Search.", inputSchema: { type: "object" } } }, staging: s.library });
    expect(await composer({ settings: settings(), staging: s, tools, runs: 7 })).toMatchObject({ runs: 7 });
  });

  it("PC1.39 sessionTools gives a session its base tools plus exactly the workflows the core it reads this turn binds; a mismatching code hash stays inert, and no graph is the base alone", async () => {
    const store = files();
    const s = staging({ files: store, codeMode: quickjsCodeMode(), ask: async () => "" });
    const w = compiled();
    await s.library.stage(w);
    const cores: Record<string, ProceduralGraph | undefined> = { fresh: bound(w), old: chain(), none: undefined };
    const asked: StepScope[] = [];
    const step = { core: async (sc: StepScope) => (asked.push(sc), cores[sc.sessionId]) };
    const base = { search: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => [] }) };
    const tools = sessionTools({ step, staging: s, base });
    expect(Object.keys(await tools(scope("fresh"))).sort()).toEqual(["search", w.name].sort());
    expect(Object.keys(await tools(scope("old")))).toEqual(["search"]);
    expect(await tools(scope("none"))).toBe(base);
    expect(asked.map((a) => a.sessionId)).toEqual(["fresh", "old", "none"]);
    // Base tools given per turn are told the turn's scope; without any the base is empty.
    const perTurn = sessionTools({ step, staging: s, base: (sc) => (sc.sessionId === "fresh" ? base : {}) });
    expect(Object.keys(await perTurn(scope("fresh"))).sort()).toEqual(["search", w.name].sort());
    expect(Object.keys(await sessionTools({ step, staging: s })(scope("fresh")))).toEqual([w.name]);
    // A staged workflow whose code no longer hashes to the binding is not offered.
    await store.put({ ...w, code: `${w.code}// changed\n` });
    expect(Object.keys(await tools(scope("fresh")))).toEqual(["search"]);
  });

  it("PC1.41 sessionTools: a core the step hook cannot give (a missing pin, a store that fails) leaves the turn its base tools and a warning, never a failed turn", async () => {
    const s = staging({ files: files(), codeMode: quickjsCodeMode(), ask: async () => "" });
    const base = { search: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => [] }) };
    const reported: unknown[] = [];
    const failing = sessionTools({ step: { core: async () => Promise.reject(new Error("the pinned core revision is missing")) }, staging: s, base });
    expect(await failing({ sessionId: "s1", turnId: "t1", report: (u) => void reported.push(u) })).toBe(base);
    expect(reported).toEqual([{ sessionUpdate: "notice", severity: "warning", title: "Procedural tools failed", description: "the pinned core revision is missing" }]);
    // Base tools that fail are the host's own failure, and fail the turn.
    const broken = sessionTools({ step: { core: async () => undefined }, staging: s, base: () => Promise.reject(new Error("no tools")) });
    await expect(broken(scope("s1"))).rejects.toThrow("no tools");
    // The step hook is told the turn's conversation, by which it tells a resumed turn from a new one.
    const told: ToolsScope[] = [];
    const messages = [{ role: "user" as const, content: "q" }];
    await sessionTools({ step: { core: async (sc: ToolsScope) => void told.push(sc) }, staging: s, base })({ ...scope("s1"), messages });
    expect(told[0]!.messages).toBe(messages);
  });

  it("PC1.40 composition is what a host hands out: a session's per-turn tools, and for each dream a composer and a tool catalog over the base tools as they are then", async () => {
    const s = staging({ files: files(), codeMode: quickjsCodeMode(), ask: async () => "" });
    const w = compiled();
    await s.library.stage(w);
    let base: ToolSet = { search: tool({ description: "Search.", inputSchema: jsonSchema({ type: "object" }), execute: async () => [] }) };
    const c = composition({ staging: s, settings: settings(), step: { core: async () => bound(w) }, base: () => base });
    expect(c.staging).toBe(s);
    expect(Object.keys(await c.tools(scope("s1"))).sort()).toEqual(["search", w.name].sort());
    expect(await c.catalog()).toEqual(["search"]);
    expect(await c.composer()).toEqual({ settings: settings(), toolSpecs: { search: { description: "Search.", inputSchema: { type: "object" } } }, staging: s.library });
    base = {};
    expect(await c.catalog()).toEqual([]);
    expect(await c.composer()).toMatchObject({ toolSpecs: {} });
    const bare = composition({ staging: s, settings: settings(), step: { core: async () => undefined } });
    expect([await bare.tools(scope("s1")), await bare.catalog()]).toEqual([{}, []]);
  });
});
