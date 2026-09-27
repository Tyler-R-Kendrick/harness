import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import type { ToolExecutionOptions, ToolSet } from "ai";
import { checkWorkflow, MemoryLibrary, parseWorkflow, WorkflowHost, workflowTools } from "@harness/workflows";
import type { Workflow, WorkflowLibrary } from "@harness/workflows";
import { MemoryStorage } from "@harness/testkit";
import {
  compilePath,
  composeCandidate,
  compositionJsonSchema,
  CompositionSettingsSchema,
  NodeNameSchema,
  OverlayEventSchema,
  parseCompositionSettings,
  parseGraph,
  pathCandidates,
  recordedRuns,
  revisionId,
  revisionTools,
  sha256Hex,
  StagingLibrary,
  workflowBinding,
} from "@harness/procedural";
import type { NodeName, RecordedCall } from "@harness/procedural";
import { chain, chainDoc, graphOf, observed, PATH, RUNS, settings, SPECS, turn } from "./compose-fixtures.ts";

const file = JSON.parse(readFileSync(new URL("../data/composition.json", import.meta.url), "utf8")) as Record<string, unknown>;
const names = (path: readonly string[]): NodeName[] => path.map((n) => NodeNameSchema.parse(n));
const g = chain();
const FULL = ["search", "Fetch_Page", "summarize", "review"];

const compiled = (runs: readonly (readonly RecordedCall[])[] = RUNS, path: readonly string[] = PATH): Workflow => {
  const result = compilePath(names(path), runs, SPECS);
  if (!result.ok) throw new Error(result.error);
  return result.workflow;
};
const opts = (toolCallId: string): ToolExecutionOptions<unknown> => ({ toolCallId, messages: [], context: undefined });

describe("composition settings", () => {
  it("PC1.1 the settings file parses, names its schema, and the schema matches the zod schema (drift)", async () => {
    expect(parseCompositionSettings(file)).toMatchObject({ support: 3, minScore: 0.7, maxLength: 6 });
    expect(file["$schema"]).toBe("./composition.schema.json");
    await expect(`${JSON.stringify(compositionJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/composition.schema.json");
  });

  it("PC1.2 invalid settings throw, naming where: support ≥ 1, a probability as minScore, paths of at least two nodes", () => {
    expect(() => parseCompositionSettings({ support: 0, minScore: 0.5, maxLength: 3 })).toThrow(/invalid composition settings[\s\S]*support/);
    expect(() => parseCompositionSettings({ support: 1, minScore: 1.5, maxLength: 3 })).toThrow(/minScore/);
    expect(() => parseCompositionSettings({ support: 1, minScore: 0.5, maxLength: 1 })).toThrow(/maxLength/);
    expect(CompositionSettingsSchema.safeParse({ support: 1, minScore: 0.5, maxLength: 2 }).success).toBe(true);
  });
});

describe("pathCandidates", () => {
  it("PC1.3 a chain of action nodes traversed by enough distinct sessions, scoring well, is a candidate; its sub-paths are not offered again", () => {
    const events = [observed("s1/t1", ["search", "Fetch_Page", "summarize"], 0.9), observed("s2/t1", ["search", "Fetch_Page", "summarize"], 0.7)];
    expect(pathCandidates(g, events, settings())).toEqual([{ path: ["search", "Fetch_Page", "summarize"], support: 2, turns: 2, meanScore: 0.8 }]);
  });

  it("PC1.4 support counts distinct sessions, not turns", () => {
    const events = [observed("s1/t1", PATH, 1), observed("s1/t2", PATH, 1), observed("s1/t3", PATH, 1)];
    expect(pathCandidates(g, events, settings())).toEqual([]);
    expect(pathCandidates(g, events, settings({ support: 1 }))).toEqual([{ path: [...PATH], support: 1, turns: 3, meanScore: 1 }]);
  });

  it("PC1.5 the mean is over scored turns; below minScore, or with no scored turn, a path is not a candidate", () => {
    const low = [observed("s1/t1", PATH, 0.4), observed("s2/t1", PATH, 0.5)];
    expect(pathCandidates(g, low, settings({ minScore: 0.5 }))).toEqual([]);
    expect(pathCandidates(g, low, settings({ minScore: 0.45 }))).toEqual([{ path: [...PATH], support: 2, turns: 2, meanScore: 0.45 }]);
    const unscored = [observed("s1/t1", PATH, null), observed("s2/t1", PATH, null)];
    expect(pathCandidates(g, unscored, settings({ minScore: 0 }))).toEqual([]);
    const mixed = [observed("s1/t1", PATH, null), observed("s2/t1", PATH, 0.6)];
    expect(pathCandidates(g, mixed, settings())).toEqual([{ path: [...PATH], support: 2, turns: 2, meanScore: 0.6 }]);
  });

  it("PC1.6 an interior node must have out-degree 1: a path through summarize (two ways out) stops there", () => {
    const events = [observed("s1/t1", FULL, 1), observed("s2/t1", FULL, 1)];
    expect(pathCandidates(g, events, settings()).map((c) => c.path)).toEqual([["search", "Fetch_Page", "summarize"]]);
  });

  it("PC1.7 every edge on the path is unconditional: summarize → review (conditional) is never a candidate", () => {
    const events = [observed("s1/t1", ["summarize", "review"], 1), observed("s2/t1", ["summarize", "review"], 1)];
    expect(pathCandidates(g, events, settings())).toEqual([]);
    const doc = chainDoc();
    doc.edges = doc.edges.map((e) => (e.from === "search" ? { ...e, condition: "when there are hits" } : e));
    const conditional = graphOf(doc);
    const both = [observed("s1/t1", PATH, 1), observed("s2/t1", PATH, 1)];
    expect(pathCandidates(conditional, both, settings()).map((c) => c.path)).toEqual([["Fetch_Page", "summarize"]]);
    const late = chainDoc();
    late.edges = late.edges.map((e) => (e.from === "Fetch_Page" ? { ...e, condition: "when it loaded" } : e));
    expect(pathCandidates(graphOf(late), both, settings()).map((c) => c.path)).toEqual([["search", "Fetch_Page"]]);
  });

  it("PC1.8 an unconditional edge among several between two nodes links them; interior out-degree still counts every edge", () => {
    const doc = chainDoc();
    doc.edges.push({ from: "search", relation: "TRIGGERS", to: "Fetch_Page", condition: "when asked", guidance: "", pitfalls: "" });
    const events = [observed("s1/t1", PATH, 1), observed("s2/t1", PATH, 1)];
    expect(pathCandidates(graphOf(doc), events, settings()).map((c) => c.path)).toEqual([[...PATH]]);
    doc.edges.push({ from: "Fetch_Page", relation: "TRIGGERS", to: "summarize", condition: null, guidance: "", pitfalls: "" });
    expect(pathCandidates(graphOf(doc), events, settings()).map((c) => c.path)).toEqual([["Fetch_Page", "summarize"], ["search", "Fetch_Page"]]);
  });

  it("PC1.9 only action nodes form paths; a node absent from the core, a missing edge or a repeated node ends one", () => {
    const events = (path: string[]) => [observed("s1/t1", path, 1), observed("s2/t1", path, 1)];
    expect(pathCandidates(g, events(["Start", "search", "Fetch_Page"]), settings()).map((c) => c.path)).toEqual([["search", "Fetch_Page"]]);
    expect(pathCandidates(g, events(["plan", "search", "Fetch_Page"]), settings()).map((c) => c.path)).toEqual([["search", "Fetch_Page"]]);
    expect(pathCandidates(g, events(["search", "Ghost", "Fetch_Page", "summarize"]), settings()).map((c) => c.path)).toEqual([["Fetch_Page", "summarize"]]);
    expect(pathCandidates(g, events(["search", "summarize"]), settings())).toEqual([]);
    // Fetch_Page's one way out leads to summarize, not review.
    expect(pathCandidates(g, events(["search", "Fetch_Page", "review"]), settings()).map((c) => c.path)).toEqual([["search", "Fetch_Page"]]);
    const cycle = chainDoc();
    cycle.nodes.push({ id: "x", type: "ACTION", description: "x" }, { id: "y", type: "ACTION", description: "y" }, { id: "z", type: "ACTION", description: "z" });
    for (const [from, to] of [["Start", "x"], ["x", "y"], ["y", "z"], ["z", "x"], ["x", "End"]] as const) cycle.edges.push({ from, relation: "LEADS_TO", to, condition: null, guidance: "", pitfalls: "" });
    // y and z have one way out each, so only the repeated x ends x → y → z → x.
    const walked = pathCandidates(graphOf(cycle), events(["x", "y", "z", "x"]), settings());
    expect(walked.map((c) => c.path)).toEqual([["x", "y", "z"], ["y", "z", "x"]]);
  });

  it("PC1.10 maxLength bounds a path", () => {
    const events = [observed("s1/t1", PATH, 1), observed("s2/t1", PATH, 1)];
    expect(pathCandidates(g, events, settings({ maxLength: 2 })).map((c) => c.path)).toEqual([["Fetch_Page", "summarize"], ["search", "Fetch_Page"]]);
  });

  it("PC1.11 a redelivered turn counts once, a path twice in one turn counts that turn once, and other events are ignored", () => {
    const status = OverlayEventSchema.parse({ kind: "status", entry: "a".repeat(64), to: "active", reason: "x" });
    const twice = ["search", "Fetch_Page", "summarize", "End"];
    const events = [observed("s1/t1", PATH, 1), observed("s1/t1", PATH, 1), observed("s2/t1", [...PATH, ...twice], 0.5), status];
    expect(pathCandidates(g, events, settings())).toEqual([{ path: [...PATH], support: 2, turns: 2, meanScore: 0.75 }]);
    // The first delivery of a turn is the one counted.
    const redelivered = [observed("s1/t1", PATH, 1), observed("s1/t1", PATH, 0), observed("s2/t1", PATH, 1)];
    expect(pathCandidates(g, redelivered, settings())[0]!.meanScore).toBe(1);
  });

  it("PC1.12 candidates come longest first, then by support, then by mean score, then by path", () => {
    const doc = chainDoc();
    doc.nodes.push({ id: "archive", type: "ACTION", description: "Archive." }, { id: "notify", type: "ACTION", description: "Notify." }, { id: "zip", type: "ACTION", description: "Zip." });
    doc.edges.push(
      { from: "Start", relation: "LEADS_TO", to: "archive", condition: null, guidance: "", pitfalls: "" },
      { from: "archive", relation: "LEADS_TO", to: "notify", condition: null, guidance: "", pitfalls: "" },
      { from: "notify", relation: "LEADS_TO", to: "End", condition: null, guidance: "", pitfalls: "" },
      { from: "Start", relation: "LEADS_TO", to: "zip", condition: null, guidance: "", pitfalls: "" },
      { from: "zip", relation: "LEADS_TO", to: "notify", condition: null, guidance: "", pitfalls: "" },
    );
    const h = graphOf(doc);
    const events = [
      observed("s1/t1", PATH, 0.6),
      observed("s2/t1", PATH, 0.6),
      observed("s1/t2", ["archive", "notify"], 0.9),
      observed("s2/t2", ["archive", "notify"], 0.9),
      observed("s3/t2", ["archive", "notify"], 0.9),
      observed("s1/t3", ["zip", "notify"], 0.9),
      observed("s2/t3", ["zip", "notify"], 0.9),
      observed("s1/t4", ["search", "Fetch_Page"], 0.9),
    ];
    const ordered = pathCandidates(h, events, settings()).map((c) => c.path.join(">"));
    expect(ordered).toEqual(["search>Fetch_Page>summarize", "archive>notify", "zip>notify"]);
    const tie = [observed("s1/t3", ["zip", "notify"], 0.9), observed("s2/t3", ["zip", "notify"], 0.9), observed("s1/t2", ["archive", "notify"], 0.9), observed("s2/t2", ["archive", "notify"], 0.9)];
    expect(pathCandidates(h, tie, settings()).map((c) => c.path.join(">"))).toEqual(["archive>notify", "zip>notify"]);
    const lower = [observed("s1/t2", ["archive", "notify"], 0.8), observed("s2/t2", ["archive", "notify"], 0.8), ...tie.slice(0, 2)];
    expect(pathCandidates(h, lower, settings()).map((c) => c.path.join(">"))).toEqual(["zip>notify", "archive>notify"]);
  });

  it("PC1.13 a sub-path is dropped only when it lies inside a kept candidate", () => {
    const events = [observed("s1/t1", PATH, 1), observed("s2/t1", PATH, 1), observed("s3/t1", ["Fetch_Page", "summarize"], 1)];
    expect(pathCandidates(g, events, settings()).map((c) => c.path)).toEqual([[...PATH]]);
    const alone = [observed("s1/t1", ["search", "Fetch_Page", "summarize"], 1), observed("s2/t1", ["Fetch_Page", "summarize"], 1)];
    expect(pathCandidates(g, alone, settings())).toEqual([{ path: ["Fetch_Page", "summarize"], support: 2, turns: 2, meanScore: 1 }]);
  });
});

describe("recordedRuns", () => {
  it("PC1.14 each window of consecutive tool calls whose matched nodes are the path is a run, matched by id or binding name", () => {
    const t1 = turn(g, "s1", [{ name: "plan_it", arguments: {} }, ...RUNS[0]!], [{ role: "user", content: "Who was Ada?" }]);
    const t2 = turn(g, "s2", [...RUNS[1]!, ...RUNS[0]!]);
    const t3 = turn(g, "s3", [RUNS[0]![0]!, { name: "other", arguments: {} }, RUNS[0]![1]!, RUNS[0]![2]!]);
    expect(recordedRuns(g, [t1, t2, t3], names(PATH), "exact")).toEqual([RUNS[0], RUNS[1], RUNS[0]]);
  });

  it("PC1.15 the match mode decides whether a call's name matches ignoring case", () => {
    const shouted = RUNS[0]!.map((c) => ({ ...c, name: c.name.toUpperCase() }));
    const t = turn(g, "s1", shouted);
    expect(recordedRuns(g, [t], names(PATH), "exact")).toEqual([]);
    expect(recordedRuns(g, [t], names(PATH), "case-insensitive")).toEqual([shouted]);
  });
});

describe("compilePath", () => {
  it("PC1.16 constant arguments are written in; the first call's varying ones are the inputs, typed by the tool's schema and required when every run had them", () => {
    const w = compiled();
    expect(w.inputs).toStrictEqual({
      type: "object",
      properties: { query: { type: "string" }, site: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    });
    expect(w.code.split("\n")).toEqual([
      `// ${w.name}: search → Fetch_Page → summarize, compiled by dream from 2 recorded runs.`,
      "// Constant arguments are written in; the first call's others are the inputs; each later call's others are asked of the model.",
      "const given = (keys) => Object.fromEntries(keys.filter((k) => input != null && input[k] !== undefined).map((k) => [k, input[k]]));",
      "const steps = [];",
      "// 1. search: tool search",
      'steps.push(await tools["search"]({ ...{"limit":5}, ...given(["query","site"]) }));',
      "// 2. Fetch_Page: tool fetch",
      expect.stringMatching(/^steps\.push\(await tools\["fetch"\]\(\{ \.\.\.JSON\.parse\(await tools\.ask\(.*\)\), \.\.\.\{"format":"md"\} \}\)\);$/),
      "// 3. summarize: tool summarize",
      expect.stringMatching(/^steps\.push\(await tools\["summarize"\]\(\{ \.\.\.JSON\.parse\(await tools\.ask\(.*\)\), \.\.\.\{"words":50\} \}\)\);$/),
      "return { steps };",
      "",
    ]);
    expect(checkWorkflow(w.code)).toEqual({ ok: true });
    expect(parseWorkflow(w)).toEqual(w);
  });

  it("PC1.17 each later call's varying arguments are asked, constrained to that tool's input schema, with the input and the results so far", () => {
    const w = compiled();
    expect(w.code).toContain(
      'tools.ask({ prompt: "Fill in the arguments of tool fetch, step 2 of 3 of search → Fetch_Page → summarize. Answer with JSON that follows the schema. The workflow\'s input and the results so far:\\n" + JSON.stringify({ input, steps }), constraint: {"type":"json-schema","schema":{"type":"object","properties":{"url":{"type":"string","format":"uri"}},"required":["url"],"additionalProperties":false}} })',
    );
    expect(w.code).toContain('"schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}');
  });

  it("PC1.18 a later call with nothing varying asks nothing; a key only some runs have is varying and optional; an unknown key is typed as anything", () => {
    const runs: RecordedCall[][] = [
      [{ name: "search", arguments: { query: "x" } }, { name: "fetch", arguments: { url: "u", extra: 1 } }],
      [{ name: "search", arguments: { query: "x" } }, { name: "fetch", arguments: { url: "u" } }],
    ];
    const w = compiled(runs, ["search", "Fetch_Page"]);
    expect(w.inputs).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
    expect(w.code).toContain('tools["search"]({ ...{"query":"x"}, ...given([]) })');
    expect(w.code).toContain('"schema":{"type":"object","properties":{"extra":{}},"required":[],"additionalProperties":false}');
    const constant = compiled([runs[1]!, runs[1]!], ["search", "Fetch_Page"]);
    expect(constant.code).not.toContain("tools.ask");
    expect(constant.code).toContain('steps.push(await tools["fetch"]({"url":"u"}));');
  });

  it("PC1.19 a tool schema's definitions travel with the schemas cut from it; a tool with no input schema types every argument as anything", () => {
    const defs = { $defs: { Url: { type: "string" } } };
    const specs = { search: { inputSchema: { type: "object", properties: { query: { $ref: "#/$defs/Url" } }, ...defs } }, fetch: {} };
    const runs: RecordedCall[][] = [
      [{ name: "search", arguments: { query: "a" } }, { name: "fetch", arguments: { url: "1" } }],
      [{ name: "search", arguments: { query: "b" } }, { name: "fetch", arguments: { url: "2" } }],
    ];
    const result = compilePath(names(["search", "Fetch_Page"]), runs, specs);
    if (!result.ok) throw new Error(result.error);
    expect(result.workflow.inputs).toEqual({ type: "object", properties: { query: { $ref: "#/$defs/Url" } }, required: ["query"], additionalProperties: false, ...defs });
    expect(result.workflow.code).toContain('"schema":{"type":"object","properties":{"url":{}},"required":["url"],"additionalProperties":false}');
    const legacy = { search: { inputSchema: { type: "object", properties: { query: { type: "string" } }, definitions: { X: {} } } }, fetch: { inputSchema: { properties: "none" } } };
    const empty = compilePath(names(["search", "Fetch_Page"]), runs, { search: { inputSchema: { properties: null } }, fetch: {} });
    expect(empty.ok && empty.workflow.inputs).toEqual({ type: "object", properties: { query: {} }, required: ["query"], additionalProperties: false });
    const old = compilePath(names(["search", "Fetch_Page"]), runs, legacy);
    if (!old.ok) throw new Error(old.error);
    expect(old.workflow.inputs).toMatchObject({ definitions: { X: {} } });
    expect(old.workflow.code).toContain('"properties":{"url":{}}');
  });

  it("PC1.20 the name is kebab-case with a hash of the path, the same for the same path; the description names the path and the runs", () => {
    const w = compiled();
    expect(w.name).toBe(`search-fetch-page-summarize-${sha256Hex(JSON.stringify(PATH)).slice(0, 8)}`);
    expect(compiled().name).toBe(w.name);
    expect(compiled(RUNS.map((r) => r.slice(0, 2)), ["search", "Fetch_Page"]).name).not.toBe(w.name);
    expect(w.description).toBe("Runs search → Fetch_Page → summarize in one call (compiled from 2 recorded runs).");
    const long = compiled([[{ name: "search", arguments: {} }]], ["A".repeat(60) + "_B"]);
    expect(long.name).toMatch(/^a{48}-[0-9a-f]{8}$/);
    const edge = compiled([[{ name: "search", arguments: {} }]], ["A".repeat(47) + "_B"]);
    expect(edge.name).toMatch(/^a{47}-[0-9a-f]{8}$/);
    expect(compiled([[{ name: "search", arguments: {} }]], ["A__b.C"]).name).toMatch(/^a-b-c-[0-9a-f]{8}$/);
  });

  it("PC1.21 errors are values: no runs, a run of another length, runs that call other tools, a tool without a spec, a tool named ask, an empty path", () => {
    const path = names(PATH);
    expect(compilePath(path, [], SPECS)).toEqual({ ok: false, error: "no recorded runs of the path" });
    expect(compilePath(path, [RUNS[0]!.slice(0, 2)], SPECS)).toEqual({ ok: false, error: "recorded run 1 has 2 calls for a path of 3 nodes" });
    const swapped = [RUNS[0]!, [RUNS[1]![0]!, { name: "crawl", arguments: {} }, RUNS[1]![2]!]];
    expect(compilePath(path, swapped, SPECS)).toEqual({ ok: false, error: "step 2 calls fetch in one run and crawl in another" });
    expect(compilePath(path, RUNS, { search: {}, fetch: {} })).toEqual({ ok: false, error: "no input schema is known for tool summarize" });
    expect(compilePath(names(["search"]), [[{ name: "ask", arguments: {} }]], { ask: {} })).toEqual({ ok: false, error: "a tool named ask cannot be called: tools.ask is the model" });
    expect(compilePath([], [[]], SPECS)).toEqual({ ok: false, error: "the path is empty" });
  });
});

describe("the staging library", () => {
  it("PC1.22 staging never writes the shared library: workflowTools over the shared host does not see a staged workflow", async () => {
    const shared = new MemoryLibrary();
    const put = vi.spyOn(shared, "put");
    const staging = new StagingLibrary();
    const w = compiled();
    await staging.put(w);
    expect(await staging.get(w.name)).toEqual(w);
    expect(await staging.list()).toEqual([w]);
    expect(put).not.toHaveBeenCalled();
    expect(await shared.list()).toEqual([]);
    const host = new WorkflowHost({ library: shared, journal: () => new MemoryStorage(), ask: async () => "", codeMode: async () => null });
    expect(Object.keys(await workflowTools(host))).toEqual([]);
  });

  it("PC1.23 a staged workflow is immutable: the same code again is a no-op, other code under its name is refused, code that does not compile is refused", async () => {
    const backing = new MemoryLibrary();
    const put = vi.spyOn(backing, "put");
    const staging = new StagingLibrary(backing);
    const w = compiled();
    await staging.put(w);
    await staging.put({ ...w });
    expect(put).toHaveBeenCalledTimes(1);
    await expect(staging.put({ ...w, code: "return 1;" })).rejects.toThrow(`staged workflow ${w.name} is immutable: stage changed code under a new name`);
    await expect(staging.put({ ...w, name: "broken", code: "return (;" })).rejects.toThrow(/^staged workflow broken does not compile: SyntaxError/);
    await expect(staging.put({ ...w, name: "Bad Name" })).rejects.toThrow(/invalid workflow/);
    expect(await backing.list()).toEqual([w]);
  });

  it("PC1.24 stage keeps a workflow and returns its binding, the sha256 of its code", async () => {
    const staging = new StagingLibrary();
    const w = compiled();
    expect(await staging.stage(w)).toEqual({ kind: "workflow", name: w.name, code: sha256Hex(w.code) });
    expect(workflowBinding(w)).toEqual({ kind: "workflow", name: w.name, code: sha256Hex(w.code) });
    expect(await staging.get(w.name)).toEqual(w);
  });
});

describe("composeCandidate", () => {
  it("PC1.25 the candidate adds the bound node pred → W → succ, copying each edge's relation and condition, and keeps the old path", () => {
    const w = compiled();
    const c = composeCandidate(g, names(PATH), w);
    if (!c.ok) throw new Error(c.error);
    expect(c.node).toBe(w.name);
    expect(c.binding).toEqual(workflowBinding(w));
    expect(c.edits.add_nodes).toEqual([{ id: w.name, type: "ACTION", description: w.description }]);
    expect(c.edits.delete_nodes).toEqual([]);
    expect(c.edits.delete_edges).toEqual([]);
    const via = `Call ${w.name}: it runs search → Fetch_Page → summarize in one call.`;
    expect(c.edits.add_edges).toEqual([
      { source: "plan", target: w.name, relation: "TRIGGERS", condition: null, guidance: via, pitfalls: "Do not skip search." },
      { source: "Start", target: w.name, relation: "LEADS_TO", condition: null, guidance: via, pitfalls: "Do not skip search." },
      { source: w.name, target: "End", relation: "CONVERGES_TO", condition: null, guidance: "After summarize, go to End.", pitfalls: "Do not skip End." },
      { source: w.name, target: "review", relation: "LEADS_TO", condition: "when a reviewer is needed", guidance: "After summarize, go to review.", pitfalls: "Do not skip review." },
    ]);
    const parsed = parseGraph(c.document);
    expect(parsed.ok).toBe(true);
    expect(c.document.nodes.find((n) => n.id === w.name)).toEqual({ id: w.name, type: "ACTION", description: w.description, binding: c.binding });
    for (const e of g.edges) expect(c.document.edges).toContainEqual(e);
    for (const n of g.nodes) expect(c.document.nodes).toContainEqual(n);
    expect(revisionId(c.document)).not.toBe(revisionId(g));
  });

  it("PC1.26 the bound node takes the first node's type", () => {
    const doc = chainDoc();
    doc.nodeTypes.push("TOOL");
    doc.nodes = doc.nodes.map((n) => (n.id === "search" ? { ...n, type: "TOOL" } : n));
    const c = composeCandidate(graphOf(doc), names(PATH), compiled());
    expect(c.ok && c.edits.add_nodes[0]!.type).toBe("TOOL");
  });

  it("PC1.27 errors are values: a path that is not a chain of the core, a node already there, a name that is not a node name", () => {
    const w = compiled();
    expect(composeCandidate(g, names(["search", "summarize"]), w)).toEqual({ ok: false, error: "search → summarize is not an edge of the core" });
    expect(composeCandidate(g, names(["search", "Ghost"]), w)).toEqual({ ok: false, error: "Ghost is not a node of the core" });
    expect(composeCandidate(g, [], w)).toEqual({ ok: false, error: "the path is empty" });
    // summarize has two ways out; one of them is the path's.
    expect(composeCandidate(g, names(["summarize", "review"]), w).ok).toBe(true);
    const c = composeCandidate(g, names(PATH), w);
    if (!c.ok) throw new Error(c.error);
    const again = parseGraph(c.document);
    if (!again.ok) throw new Error("unparsed");
    expect(composeCandidate(again.graph, names(PATH), w)).toEqual({ ok: false, error: `the core already has a node ${w.name}` });
    expect(composeCandidate(g, names(PATH), { ...w, name: "9-lives" })).toEqual({ ok: false, error: "9-lives is not a node name" });
  });
});

describe("revisionTools", () => {
  const base = (): ToolSet => ({ search: tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "hits" }) });

  async function setup(library: WorkflowLibrary = new StagingLibrary()) {
    const w = compiled();
    await library.put(w);
    const c = composeCandidate(g, names(PATH), w);
    if (!c.ok) throw new Error(c.error);
    const parsed = parseGraph(c.document);
    if (!parsed.ok) throw new Error("unparsed");
    const runs: string[] = [];
    const journals: MemoryStorage[] = [];
    const journal = (run: string) => {
      runs.push(run);
      journals.push(new MemoryStorage());
      return journals.at(-1)!;
    };
    const host = new WorkflowHost({ library, journal, ask: async () => "{}", codeMode: async () => ({ ran: true }) });
    return { w, core: parsed.graph, host, runs, journals, library };
  }

  it("PC1.28 a session gets its base tools plus exactly the workflows its pinned core binds", async () => {
    const { w, core, host } = await setup();
    await host.library.put(parseWorkflow({ name: "unbound", description: "", inputs: {}, code: "return 1;" }));
    const tools = await revisionTools({ base: base(), pinnedCore: core, staging: host });
    expect(Object.keys(tools).sort()).toEqual(["search", w.name].sort());
    expect(tools[w.name]!.description).toBe(w.description);
    expect(Object.keys(await revisionTools({ base: base(), pinnedCore: g, staging: host }))).toEqual(["search"]);
  });

  it("PC1.29 a binding whose code hash does not match the staged workflow, or whose workflow is missing, is not offered: the node is inert", async () => {
    const { w, core } = await setup();
    const other = new MemoryLibrary([{ ...w, code: `${w.code}\n// changed` }]);
    const host = new WorkflowHost({ library: other, journal: () => new MemoryStorage(), ask: async () => "", codeMode: async () => null });
    expect(Object.keys(await revisionTools({ base: base(), pinnedCore: core, staging: host }))).toEqual(["search"]);
    const empty = new WorkflowHost({ library: new MemoryLibrary(), journal: () => new MemoryStorage(), ask: async () => "", codeMode: async () => null });
    expect(Object.keys(await revisionTools({ base: base(), pinnedCore: core, staging: empty }))).toEqual(["search"]);
  });

  it("PC1.30 a base tool of the same name is kept, not replaced by the workflow", async () => {
    const { w, core, host } = await setup();
    const own = tool({ inputSchema: jsonSchema({ type: "object" }), execute: async () => "own" });
    const tools = await revisionTools({ base: { [w.name]: own }, pinnedCore: core, staging: host });
    expect(tools[w.name]).toBe(own);
  });

  it("PC1.31 calling the tool runs the workflow durably under run id tool/<toolCallId>, with {} for no input", async () => {
    const { w, core, host, runs, journals } = await setup();
    const tools = await revisionTools({ base: base(), pinnedCore: core, staging: host });
    expect(await tools[w.name]!.execute!(undefined, opts("c1"))).toEqual({ ran: true });
    expect(runs).toEqual(["tool/c1"]);
    expect(await journals[0]!.load()).toMatchObject({ workflow: w.name, input: {}, status: "completed" });
  });

  it("PC1.32 a failed run is a failed tool call; a workflow changed after the tools were built is refused", async () => {
    const library = new MemoryLibrary();
    const { w, core } = await setup(library);
    const failing = new WorkflowHost({ library, journal: () => new MemoryStorage(), ask: async () => "", codeMode: async () => { throw new Error("boom"); } });
    const tools = await revisionTools({ base: {}, pinnedCore: core, staging: failing });
    await expect(tools[w.name]!.execute!({ query: "x" }, opts("c2"))).rejects.toThrow(`workflow ${w.name} failed: Error: boom`);
    await library.put({ ...w, code: "return 2;" });
    await expect(tools[w.name]!.execute!({ query: "x" }, opts("c3"))).rejects.toThrow(`workflow ${w.name} no longer matches the revision that binds it`);
  });
});

describe("the package exports composition", () => {
  it("PC1.33 compose is exported from the package index", async () => {
    const pkg = await import("@harness/procedural");
    expect(Object.keys(pkg)).toEqual(expect.arrayContaining(["pathCandidates", "compilePath", "StagingLibrary", "revisionTools", "composeCandidate", "recordedRuns"]));
  });
});
