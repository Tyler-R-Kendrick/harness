import { describe, expect, it } from "vitest";
import { CactusWasmEngine } from "@harness/models";
import type { ToolSpec } from "@harness/cognitive";
import { routerContract } from "@harness/testkit";
import { FakeCactusModule } from "./fake-cactus.ts";

const weather: ToolSpec = { name: "get_weather", description: "Weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } };
const timer: ToolSpec = { name: "set_timer", description: "Start a timer.", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } };
const weights = new Uint8Array([1, 2, 3, 4, 5]);

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
    const routing = await engine.route({ input: "weather in Lagos?", tools: [weather] });
    expect(routing).toEqual({ calls: [{ name: "get_weather", arguments: { city: "Lagos" } }], confidence: 0.97, reasoning: "city named" });
    const init = m.log.find((l) => l.startsWith("init:"))!;
    expect(JSON.parse(init.split("|")[1]!)).toEqual([{ name: "get_weather", description: "Weather for a city.", parameters: weather.parameters }]);
    expect(m.log.slice(1)).toEqual([init, "reset", "complete:weather in Lagos?:256"]);
  });

  it("ND1.3 the same tools are initialized once; different tools re-initialize", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    await engine.route({ input: "a", tools: [weather] });
    await engine.route({ input: "b", tools: [weather] });
    expect(m.log.filter((l) => l.startsWith("init:"))).toHaveLength(1);
    expect(m.log.filter((l) => l === "reset")).toHaveLength(2);
    await engine.route({ input: "c", tools: [weather, timer] });
    expect(m.log.filter((l) => l.startsWith("init:"))).toHaveLength(2);
  });

  it("ND1.4 engine failures are errors that carry the engine's reason", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    m.reply = () => ({ success: false, error: "tool schema too large" });
    await expect(engine.route({ input: "x", tools: [weather] })).rejects.toThrow(/tool schema too large/);
    m.completeResult = -3;
    await expect(engine.route({ input: "x", tools: [weather] })).rejects.toThrow(/-3/);
    const m2 = new FakeCactusModule();
    m2.initResult = -1;
    await expect((await CactusWasmEngine.create(m2, weights, m2.prefix)).route({ input: "x", tools: [weather] })).rejects.toThrow(/init/);
  });

  it("ND1.5 with no tools offered nothing is called and the engine is not asked", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    expect(await engine.route({ input: "x", tools: [] })).toMatchObject({ calls: [], confidence: 1 });
    expect(m.log.some((l) => l.startsWith("complete"))).toBe(false);
  });

  it("ND1.6 embeddings have the engine's dimension and unit length", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    expect(engine.dimensions).toBe(4);
    const [v] = await engine.embed([{ kind: "query", text: "hello" }]);
    expect(v!.length).toBe(4);
    expect(Math.hypot(...v!)).toBeCloseTo(1, 5);
    expect(m.log).toContain("embed:hello");
  });

  it("ND1.7 a malformed engine reply is an error, not a silent empty routing", async () => {
    const m = new FakeCactusModule();
    const engine = await CactusWasmEngine.create(m, weights, m.prefix);
    m.reply = () => ({ success: true, confidence: 2, function_calls: [] });
    await expect(engine.route({ input: "x", tools: [weather] })).rejects.toThrow(/confidence/);
  });

  it("ND1.8 the C API is found under the catalog's prefix; a module without it is an error", async () => {
    const m = new FakeCactusModule("tiny_router");
    const engine = await CactusWasmEngine.create(m, weights, "tiny_router");
    await engine.route({ input: "a", tools: [weather] });
    expect(m.log).toContain("reset");
    await expect(CactusWasmEngine.create(new FakeCactusModule("tiny_router"), weights, "other")).rejects.toThrow("the module exports no _other_load");
  });
});

routerContract("Cactus WASM engine over the fake module", async () => {
  const m = new FakeCactusModule();
  m.reply = (input) => ({ success: true, function_calls: input.includes("timer") ? [{ name: "set_timer", arguments: { minutes: 5 } }] : [], reasoning: "", confidence: 0.9 });
  return CactusWasmEngine.create(m, weights, m.prefix);
});
