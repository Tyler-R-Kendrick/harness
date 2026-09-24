import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerationEvent } from "@harness/cognitive";
import { LlamaServerDocumentParser, LlamaServerGenerator } from "@harness/models";
import { LlamaServerProcess, ModelFiles } from "@harness/platform-native";
import { generatorContract } from "@harness/testkit";
import { catalogEntry, modelCacheDir } from "./models-env.ts";

// Needs llama.cpp's llama-server: set LLAMA_SERVER to its path (CI downloads the release).
// Without it these tests fail rather than pass silently.
function binary(): string {
  const path = process.env["LLAMA_SERVER"];
  if (!path) throw new Error("LLAMA_SERVER is not set: point it at a llama.cpp llama-server binary to run the native GGUF model tests");
  return path;
}
const files = new ModelFiles({ dir: join(modelCacheDir, "gguf") });
const servers: LlamaServerProcess[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});
const once = <T>(make: () => Promise<T>) => {
  let p: Promise<T> | undefined;
  return () => (p ??= make());
};
async function collect(stream: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const ornith = once(async () => {
  const m = catalogEntry("ornith-ai/Ornith-1.5-9B");
  const server = await LlamaServerProcess.start({ binary: binary(), model: await files.path(m.artifact, m.artifact.files[0]!.path), contextSize: 8192 });
  servers.push(server);
  return new LlamaServerGenerator({ baseUrl: server.baseUrl });
});

describe("Ornith 1.5 9B on llama-server, real weights", () => {
  it("OM1.1 calls the offered tool with the argument from the request", async () => {
    const events = await collect(
      (await ornith()).generate({
        messages: [{ role: "user", content: "What's the weather in Lagos? Use the tool." }],
        tools: [{ name: "get_weather", description: "Get the weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
        maxTokens: 1024,
      }),
    );
    expect(events.filter((e) => e.type === "tool-call")).toEqual([{ type: "tool-call", call: { name: "get_weather", arguments: { city: "Lagos" } } }]);
  });
});
generatorContract("Ornith 1.5 9B on llama-server, real weights", ornith);

const ovis = once(async () => {
  const m = catalogEntry("ATH-MaaS/OvisOCR2");
  const [model, mmproj] = await Promise.all(m.artifact.files.map((f) => files.path(m.artifact, f.path)));
  const server = await LlamaServerProcess.start({ binary: binary(), model: model!, mmproj: mmproj!, contextSize: 8192 });
  servers.push(server);
  return new LlamaServerDocumentParser({ baseUrl: server.baseUrl, maxTokens: 1024 });
});

describe("OvisOCR2 on llama-server, real weights", () => {
  it("OV1.1 reads a rendered invoice into Markdown with its text and numbers", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500"><rect width="100%" height="100%" fill="white"/>
      <g font-family="DejaVu Sans" font-size="28"><text x="60" y="90" font-size="44" font-weight="bold">Invoice 4521</text>
      <text x="70" y="200">Widget</text><text x="600" y="200">3</text><text x="780" y="200">30.00</text>
      <text x="70" y="260">Gadget</text><text x="600" y="260">1</text><text x="780" y="260">45.50</text>
      <text x="70" y="330">Total</text><text x="780" y="330">75.50</text></g></svg>`;
    const page = { mediaType: "image/png", data: new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer()) };
    const { pages } = await (await ovis()).parse({ pages: [page] });
    for (const s of ["Invoice 4521", "Widget", "Gadget", "45.50", "75.50"]) expect(pages[0]!.markdown).toContain(s);
  });
});
