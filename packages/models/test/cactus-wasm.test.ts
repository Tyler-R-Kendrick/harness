import { describe, expect, it } from "vitest";
import { embedMany, generateText } from "ai";
import { CactusWasmEngine } from "@harness/models";
import { HARNESS, toolSet } from "@harness/cognitive";
import type { ToolSpec } from "@harness/cognitive";
import { embedderContract, routerContract } from "@harness/testkit";
import { FakeCactusModule } from "./fake-cactus.ts";

const weather: ToolSpec = { name: "get_weather", description: "Weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const timer: ToolSpec = { name: "set_timer", description: "Start a timer.", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } };
const weights = new Uint8Array([1, 2, 3, 4, 5]);

/** Route a prompt through the engine's router model the way consumers do. */
async function route(engine: CactusWasmEngine, prompt: string, tools: readonly ToolSpec[]) {
  const r = await generateText({ model: engine.router("router"), prompt, tools: toolSet(tools), maxRetries: 0 });
  return { calls: r.toolCalls.map((c) => ({ name: c.toolName, arguments: c.input })), confidence: r.providerMetadata?.[HARNESS]?.["confidence"], reasoning: r.reasoningText, finishReason: r.finishReason };
}

describe("Cactus WASM engine", () => {
  it("ND1.1 copies the weights into the module and loads them; a failed load is an error", async () => {
    const m = new FakeCactusModule();
    await CactusWasmEngine.create(m, weights, m.prefix);
    expect(m.log[0]).toBe("load:5");
    const bad = new FakeCactusModule();
    bad.loadResult = -1;
    await expect(CactusWasmEngine.create(bad, weights, bad.prefix)).rejects.toThrow(/load/);
  });

  it("ND1.2 routing initializes the offered tools, resets state, and returns the calls, confidence and reasoning", async () => {
    const m = new FakeCactusModule();
    m.reply = () => ({ success: true, function_calls: [{ name: "get_weather", arguments: { city: "Lagos" } }], reasoning: "city named", confidence: 0.97 });
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    expect(await route(engine, "weather in Lagos?", [weather])).toEqual({ calls: [{ name: "get_weather", arguments: { city: "Lagos" } }], confidence: 0.97, reasoning: "city named", finishReason: "tool-calls" });
    const init = m.log.find((l) => l.startsWith("init:"))!;
    expect(JSON.parse(init.split("|")[1]!)).toEqual([{ name: "get_weather", description: "Weather for a city.", parameters: weather.parameters }]);
    expect(m.log.slice(1)).toEqual([init, "reset", "complete:weather in Lagos?:256"]);
    const model = engine.router("tiny-router");
    expect([model.provider, model.modelId]).toEqual(["harness.local", "tiny-router"]);
  });

  it("ND1.3 the same tools are initialized once; different tools re-initialize", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    await route(engine, "a", [weather]);
    await route(engine, "b", [weather]);
    expect(m.log.filter((l) => l.startsWith("init:"))).toHaveLength(1);
    expect(m.log.filter((l) => l === "reset")).toHaveLength(2);
    await route(engine, "c", [weather, timer]);
    expect(m.log.filter((l) => l.startsWith("init:"))).toHaveLength(2);
  });

  it("ND1.4 engine failures are errors that carry the engine's reason", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    m.reply = () => ({ success: false, error: "tool schema too large" });
    await expect(route(engine, "x", [weather])).rejects.toThrow(/tool schema too large/);
    // without a reason, the whole reply is the reason
    m.reply = () => ({ success: false, error: null });
    await expect(route(engine, "x", [weather])).rejects.toThrow(/could not route: .*"success":false/);
    m.completeResult = -3;
    await expect(route(engine, "x", [weather])).rejects.toThrow(/-3/);
    const m2 = new FakeCactusModule();
    m2.initResult = -1;
    await expect(route(await CactusWasmEngine.create(m2, weights, m2.prefix), "x", [weather])).rejects.toThrow(/init/);
  });

  it("ND1.5 with no tools offered nothing is called and the engine is not asked", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    expect(await route(engine, "x", [])).toMatchObject({ calls: [], confidence: 1, finishReason: "stop" });
    expect(m.log.some((l) => l.startsWith("complete"))).toBe(false);
  });

  it("ND1.6 embeddings have the engine's dimension and unit length", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    expect(engine.dimensions).toBe(4);
    const model = engine.embedder("tiny-embedder");
    expect([model.provider, model.modelId]).toEqual(["harness.local", "tiny-embedder"]);
    const { embeddings } = await embedMany({ model, values: ["hello", "hi"], maxRetries: 0 });
    expect(embeddings).toHaveLength(2);
    for (const v of embeddings) {
      expect(v.length).toBe(4);
      expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    }
    expect(m.log).toContain("embed:hello");
    expect(m.log).toContain("embed:hi");
    // the scratch buffer is freed after the call
    expect(m.log.some((l) => l.startsWith("free:"))).toBe(true);
  });

  it("ND1.7 a malformed engine reply is an error, not a silent empty routing", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    m.reply = () => ({ success: true, confidence: 2, function_calls: [] });
    await expect(route(engine, "x", [weather])).rejects.toThrow(/confidence/);
    // missing calls and reasoning are none, not errors
    m.reply = () => ({ success: true, confidence: 0.5 });
    expect(await route(engine, "x", [weather])).toEqual({ calls: [], confidence: 0.5, reasoning: undefined, finishReason: "stop" });
  });

  it("ND1.8 the C API is found under the catalog's prefix; a module without it is an error", async () => {
    const m = new FakeCactusModule("tiny_router");
    const engine = await CactusWasmEngine.create(m, weights, "tiny_router");
    await route(engine, "a", [weather]);
    expect(m.log).toContain("reset");
    await expect(CactusWasmEngine.create(new FakeCactusModule("tiny_router"), weights, "other")).rejects.toThrow("the module exports no _other_load");
  });

  it("ND1.9 the last user message's text is what is routed; a prompt with no user message routes empty text", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    await generateText({
      model: engine.router("router"),
      tools: toolSet([weather]),
      maxRetries: 0,
      system: "Route carefully.",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "an answer" },
        { role: "user", content: [{ type: "text", text: "weather in " }, { type: "text", text: "Lagos?" }] },
      ],
    });
    expect(m.log.filter((l) => l.startsWith("complete"))).toEqual(["complete:weather in Lagos?:256"]);
    await engine.router("router").doGenerate({ prompt: [{ role: "system", content: "Only a system message." }], tools: [{ type: "function", name: "get_weather", description: "w", inputSchema: {} }] });
    expect(m.log.filter((l) => l.startsWith("complete")).at(-1)).toBe("complete::256");
  });

  it("ND1.10 a routed call streams as reasoning, tool calls and a finish carrying the confidence", async () => {
    const m = new FakeCactusModule();
    m.reply = () => ({ success: true, function_calls: [{ name: "set_timer" }], reasoning: "timer asked", confidence: 0.8 });
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    const { stream } = await engine.router("router").doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "timer" }] }], tools: [{ type: "function", name: "set_timer", description: "t", inputSchema: {} }] });
    const parts: unknown[] = [];
    for await (const p of stream) parts.push(p);
    expect(parts.map((p) => (p as { type: string }).type)).toEqual(["stream-start", "reasoning-start", "reasoning-delta", "reasoning-end", "tool-call", "finish"]);
    // a call without arguments has empty ones
    expect(parts[4]).toMatchObject({ toolName: "set_timer", input: "{}" });
    expect(parts[5]).toMatchObject({ finishReason: { unified: "tool-calls" }, providerMetadata: { [HARNESS]: { confidence: 0.8 } } });
  });
});

routerContract("Cactus WASM engine over the fake module", async () => {
  const m = new FakeCactusModule();
  m.reply = (input) => ({ success: true, function_calls: input.includes("timer") ? [{ name: "set_timer", arguments: { minutes: 5 } }] : [], reasoning: "", confidence: 0.9 });
  return (await CactusWasmEngine.create(m, weights, m.prefix)).router("router");
});

embedderContract(
  "Cactus WASM engine over the fake module",
  async () => {
    const m = new FakeCactusModule();
    return (await CactusWasmEngine.create(m, weights, m.prefix)).embedder("embedder");
  },
  { size: 4 },
);
