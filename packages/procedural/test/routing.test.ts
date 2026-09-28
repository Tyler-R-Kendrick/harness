import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { HARNESS, probability, usage } from "@harness/cognitive";
import { explainResolve, explainRoute, GRAPH_TOOL, GraphIdSchema, modelGraphRouter, parseResolver, parseSettings, renderPrompt, resolverJsonSchema, routeGraph } from "@harness/procedural";
import type { GraphRouter, RouteRequest } from "@harness/procedural";

const id = (text: string) => GraphIdSchema.parse(text);
const resolver = (...rules: unknown[]) => parseResolver({ rules });
const routeRule = (candidates: unknown[], minConfidence: number, when: unknown = {}) => ({ when, route: { candidates, minConfidence } });

/** A router that answers `graph` at `confidence`, recording what it was asked. */
function router(graph: string | undefined, confidence: number): GraphRouter & { asked: RouteRequest[] } {
  const asked: RouteRequest[] = [];
  const answer = async (request: RouteRequest) => {
    asked.push(request);
    return { graph: graph === undefined ? undefined : id(graph), confidence: probability(confidence) };
  };
  return Object.assign(answer, { asked });
}

/** A router model (ai/test) that calls `choose_graph` with `input`, or nothing, at `confidence` when given. */
function routerModel(input: unknown, confidence?: number): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: input === undefined ? [] : [{ type: "tool-call", toolCallId: "call_0", toolName: GRAPH_TOOL, input: JSON.stringify(input) }],
      finishReason: { unified: input === undefined ? "stop" : "tool-calls", raw: undefined },
      usage: usage(),
      ...(confidence === undefined ? {} : { providerMetadata: { [HARNESS]: { confidence } } }),
      warnings: [],
    }),
  });
}

const settings = () => parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));

describe("the model graph router (the cognitive router's route with confidence)", () => {
  it("PX1.53 the router gets the first prompt and one tool, carrying the route prompt with the candidates, whose schema admits only the candidates", async () => {
    const model = routerModel({ graph: "team/web" }, 0.82);
    const answer = await modelGraphRouter({ model, settings: settings() })({ prompt: "Fix the header layout", candidates: [{ graph: id("repo/harness") }, { graph: id("team/web"), description: "Front-end work." }] });
    expect(answer).toEqual({ graph: "team/web", confidence: 0.82 });
    const call = model.doGenerateCalls[0]!;
    expect(call.prompt).toEqual([{ role: "user", content: [{ type: "text", text: "Fix the header layout" }] }]);
    expect(call.tools).toHaveLength(1);
    const tool = call.tools![0]! as { type: string; name: string; description: string; inputSchema: unknown };
    expect(tool.name).toBe(GRAPH_TOOL);
    expect(GRAPH_TOOL).toBe("choose_graph");
    expect(tool.description).toBe(renderPrompt(settings().prompts.route, { graphs: "- repo/harness\n- team/web: Front-end work." }));
    expect(tool.inputSchema).toEqual({ type: "object", properties: { graph: { type: "string", enum: ["repo/harness", "team/web"] } }, required: ["graph"], additionalProperties: false });
  });

  it("PX1.54 a call outside the candidates, a malformed call, or no call chooses nothing; without calibrated confidence the confidence is 0", async () => {
    const ask = (model: MockLanguageModelV4) => modelGraphRouter({ model, settings: settings() })({ prompt: "p", candidates: [{ graph: id("a") }] });
    expect(await ask(routerModel({ graph: "b" }, 0.9))).toEqual({ graph: undefined, confidence: 0.9 });
    expect(await ask(routerModel({ graph: 7 }, 0.9))).toEqual({ graph: undefined, confidence: 0.9 });
    expect(await ask(routerModel(undefined, 0.4))).toEqual({ graph: undefined, confidence: 0.4 });
    expect(await ask(routerModel({ graph: "a" }))).toEqual({ graph: "a", confidence: 0 });
  });

  it("PX1.55 a route rule on the model router: a confident router's choice is the session's graph, a hesitant one's is not", async () => {
    const r = resolver(routeRule(["a", "b"], 0.8));
    const context = { prompt: "p" };
    expect(await routeGraph(r, context, modelGraphRouter({ model: routerModel({ graph: "b" }, 0.85), settings: settings() }))).toBe("b");
    expect(await explainRoute(r, context, modelGraphRouter({ model: routerModel({ graph: "b" }, 0.5), settings: settings() }))).toMatchObject({ graph: undefined, reason: "rule 0: the router chose graph b at confidence 0.5, below 0.8" });
    const failing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("no router member");
      },
    });
    expect(await explainRoute(r, context, modelGraphRouter({ model: failing, settings: settings() }))).toMatchObject({ graph: undefined, reason: "rule 0 could not route: no router member" });
  });
});

describe("routing sessions to graphs by the router's confidence", () => {
  it("PX1.46 a route rule names candidate graphs (ids, or ids with what they are for) and a minimum confidence; its JSON Schema is generated from the parser", async () => {
    const r = resolver(routeRule(["repo/harness", { graph: "team/web", description: "Front-end work." }], 0.7));
    expect(r.rules[0]).toEqual({ when: {}, route: { candidates: ["repo/harness", { graph: "team/web", description: "Front-end work." }], minConfidence: 0.7 } });
    await expect(`${JSON.stringify(resolverJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../data/resolver.schema.json");
    expect(JSON.stringify(resolverJsonSchema())).toContain('"minConfidence":{"type":"number","minimum":0,"maximum":1}');
  });

  it("PX1.47 parsing refuses a route with no candidates, a repeated candidate, an invalid id, a confidence outside [0, 1], or both a graph and a route", () => {
    expect(() => resolver(routeRule([], 0.5))).toThrow(/rules\[0\]|rules\.0/);
    expect(() => resolver(routeRule(["a", { graph: "a", description: "again" }], 0.5))).toThrow(/candidate a is named twice[\s\S]*rules\[0\]\.route\.candidates/);
    expect(() => resolver({ when: {}, graph: "g" }, routeRule(["b", "c", "b"], 0.5))).toThrow(/candidate b is named twice[\s\S]*rules\[1\]/);
    expect(() => resolver(routeRule(["Bad"], 0.5))).toThrow(RangeError);
    expect(() => resolver(routeRule([{ graph: "a", description: "" }], 0.5))).toThrow(RangeError);
    expect(() => resolver(routeRule(["a"], 1.5))).toThrow(RangeError);
    expect(() => resolver(routeRule(["a"], -0.1))).toThrow(RangeError);
    expect(() => resolver({ when: {}, graph: "a", route: { candidates: ["a"], minConfidence: 0.5 } })).toThrow(RangeError);
    expect(() => resolver({ when: {}, route: { candidates: ["a"], minConfidence: 0.5, extra: 1 } })).toThrow(RangeError);
    expect(() => resolver({ when: {}, graph: "a", route: { candidates: ["a"], minConfidence: 0.5 } })).toThrow(/a rule names either a graph or a route[\s\S]*rules\[0\]/);
    expect(() => resolver({ when: {} })).toThrow(/a rule names either a graph or a route/);
    expect(resolver(routeRule(["a"], 0), routeRule(["b"], 1)).rules).toHaveLength(2);
  });

  it("PX1.48 the router is asked with the session's first prompt and the candidates, and its choice at or above the minimum confidence is the graph", async () => {
    const r = resolver(routeRule(["repo/harness", { graph: "team/web", description: "Front-end work." }], 0.7));
    const confident = router("team/web", 0.7);
    expect(await explainRoute(r, { prompt: "Fix the header layout" }, confident)).toEqual({ graph: "team/web", rule: 0, reason: "rule 0 routes to graph team/web at confidence 0.7" });
    expect(confident.asked).toEqual([{ prompt: "Fix the header layout", candidates: [{ graph: "repo/harness" }, { graph: "team/web", description: "Front-end work." }] }]);
    expect(await routeGraph(r, { prompt: "Fix the header layout" }, router("repo/harness", 0.95))).toBe("repo/harness");
  });

  it("PX1.49 a choice below the minimum confidence, no choice, or a choice outside the candidates is no graph, with the reason; the rule still decides", async () => {
    const r = resolver(routeRule(["a", "b"], 0.7), { when: {}, graph: "fallback" });
    expect(await explainRoute(r, { prompt: "p" }, router("a", 0.69))).toEqual({ graph: undefined, rule: 0, reason: "rule 0: the router chose graph a at confidence 0.69, below 0.7" });
    expect(await explainRoute(r, { prompt: "p" }, router(undefined, 0.9))).toEqual({ graph: undefined, rule: 0, reason: "rule 0: the router chose no graph (confidence 0.9)" });
    expect(await explainRoute(r, { prompt: "p" }, router("c", 0.99))).toEqual({ graph: undefined, rule: 0, reason: "rule 0: the router chose graph c, which is not a candidate" });
  });

  it("PX1.50 without a router, or before the session has a prompt, a route rule is no graph and the router is not asked; a failing router is no graph with its error", async () => {
    const r = resolver(routeRule(["a"], 0.5));
    expect(await explainRoute(r, { prompt: "p" })).toEqual({ graph: undefined, rule: 0, reason: "rule 0 routes among graphs, and there is no router" });
    const unasked = router("a", 1);
    for (const prompt of [undefined, "", "  \n"]) {
      expect(await explainRoute(r, prompt === undefined ? {} : { prompt }, unasked)).toEqual({ graph: undefined, rule: 0, reason: "rule 0 routes by the session's first prompt, which it does not have" });
    }
    expect(unasked.asked).toEqual([]);
    const failing: GraphRouter = async () => {
      throw new Error("no router member");
    };
    expect(await explainRoute(r, { prompt: "p" }, failing)).toEqual({ graph: undefined, rule: 0, reason: "rule 0 could not route: no router member" });
    const odd: GraphRouter = async () => {
      throw "down";
    };
    expect(await explainRoute(r, { prompt: "p" }, odd)).toEqual({ graph: undefined, rule: 0, reason: "rule 0 could not route: down" });
  });

  it("PX1.51 a session pinned to one of the candidates keeps that graph without asking the router, so a session is routed once", async () => {
    const r = resolver(routeRule(["a", "b"], 0.9));
    const unasked = router("a", 1);
    const kept = { graph: id("b"), rule: 0, reason: "rule 0 keeps the session's routed graph b" };
    expect(await explainRoute(r, { prompt: "p", pinned: id("b") }, unasked)).toEqual(kept);
    expect(explainResolve(r, { pinned: id("b") })).toEqual(kept);
    expect(unasked.asked).toEqual([]);
    const asked = router("a", 1);
    expect(await routeGraph(r, { prompt: "p", pinned: id("elsewhere") }, asked)).toBe("a");
    expect(asked.asked).toHaveLength(1);
  });

  it("PX1.52 resolving without routing (explainResolve) gives a route rule no graph; explainRoute resolves template rules as explainResolve does", async () => {
    const r = resolver(routeRule(["a"], 0.5, { cwdUnder: "/work" }), { when: {}, graph: "${principal}" });
    expect(explainResolve(r, { cwd: "/work/x" })).toEqual({ graph: undefined, rule: 0, reason: "rule 0 routes among graphs, which needs the router" });
    expect(await explainRoute(r, { cwd: "/else", principal: "ann" }, router("a", 1))).toEqual(explainResolve(r, { cwd: "/else", principal: "ann" }));
    expect(await explainRoute(r, { cwd: "/else" }, router("a", 1))).toEqual({ graph: undefined, rule: 1, reason: "rule 1 needs principal, which the session does not have" });
    expect(await explainRoute(resolver(), {}, router("a", 1))).toEqual({ graph: undefined, rule: undefined, reason: "no rule matches" });
  });
});
