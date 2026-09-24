import { describe, expect, it } from "vitest";
import { NeedleEngine } from "@harness/models";
import type { ToolSpec } from "@harness/cognitive";
import { loadNeedleModule } from "@harness/platform-native";
import { embedderContract, routerContract } from "@harness/testkit";
import { artifacts, catalogEntry } from "./models-env.ts";

const needle = catalogEntry("Cactus-Compute/needle3");
let engine: Promise<NeedleEngine> | undefined;
/** One engine per process: the Needle module is a single global instance. */
function load(): Promise<NeedleEngine> {
  engine ??= (async () => {
    process.env["NEEDLE_TELEMETRY"] = "0";
    process.env["DO_NOT_TRACK"] = "1";
    const [js, wasm, weights] = await Promise.all(["wasm/needle.js", "wasm/needle.wasm", "needle3.cact"].map((p) => artifacts.file(needle.artifact, p)));
    return NeedleEngine.create(await loadNeedleModule(js!, wasm!), weights!);
  })();
  return engine;
}

const tools: ToolSpec[] = [
  { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  { name: "set_timer", description: "Start a countdown timer.", parameters: { type: "object", properties: { minutes: { type: "integer" } }, required: ["minutes"] } },
];

describe("Needle 3, real weights", () => {
  it("NM1.1 routes a request to the right tool with its argument", async () => {
    const r = await (await load()).route({ input: "what's it like in Lagos right now?", tools });
    expect(r.calls).toEqual([{ name: "get_weather", arguments: { city: "Lagos" } }]);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it("NM1.2 two requests in one sentence give two calls in order", async () => {
    const r = await (await load()).route({ input: "set a timer for 5 minutes and tell me the weather in Paris", tools });
    expect(r.calls).toEqual([
      { name: "set_timer", arguments: { minutes: 5 } },
      { name: "get_weather", arguments: { city: "Paris" } },
    ]);
  });

  it("NM1.3 a request no tool covers gets no calls", async () => {
    expect((await (await load()).route({ input: "write me a poem about cats", tools })).calls).toEqual([]);
  });
});

routerContract("Needle 3, real weights", load);
embedderContract("Needle 3, real weights", load);
