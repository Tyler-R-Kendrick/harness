import { describe, expect, it } from "vitest";
import { decodeBase64, Ensemble, invokeCognitive, mirrorCapabilities } from "@harness/cognitive";
import type { ModelDescriptor, TaskCategory } from "@harness/cognitive";
import { HashEmbedder, HeuristicCompressor, KeywordRouter, ScriptedJudge, StubDocumentParser } from "@harness/testkit";

function d(id: string, tasks: readonly TaskCategory[], ports: ModelDescriptor["ports"]): ModelDescriptor {
  return { id, name: `Model ${id}`, publisher: "t", tasks, ports, locality: "local", runtime: "transformers.js", platforms: ["native"], license: "MIT", downloadBytes: 1, benchmarks: [] };
}

function ensemble() {
  const e = new Ensemble({ platform: "native" });
  e.register(d("jev", ["judgment"], ["judge"]), async () => ({ judge: new ScriptedJudge(() => ({ type: "boolean", probability: 0.8 })) }));
  e.register(d("needle", ["tool-calling"], ["router"]), async () => ({ router: new KeywordRouter() }));
  e.register(d("gemma", ["text-embedding"], ["embedder"]), async () => ({ embedder: new HashEmbedder(8) }));
  e.register(d("lingua", ["prompt-compression"], ["compressor"]), async () => ({ compressor: new HeuristicCompressor() }));
  e.register(d("ocr", ["document-parsing"], ["document-parser"]), async () => ({ "document-parser": new StubDocumentParser() }));
  return e;
}

const tools = [{ name: "set_timer", description: "Start a timer", parameters: { type: "object" } }];

describe("cognitive service (ACP operations on the ensemble)", () => {
  it("CS1.1 every result names the model that served it", async () => {
    const e = ensemble();
    expect(await invokeCognitive(e, "judge", { state: "s", questions: { ok: { type: "boolean", instructions: "?" } } })).toEqual({ model: "jev", answers: { ok: { type: "boolean", probability: 0.8 } } });
    expect(await invokeCognitive(e, "route", { input: "start a timer", tools })).toMatchObject({ model: "needle", calls: [{ name: "set_timer" }] });
    expect(await invokeCognitive(e, "decide-tools", { input: "start a timer", tools })).toMatchObject({ calls: [{ name: "set_timer" }], decidedBy: expect.any(String) });
  });

  it("CS1.2 embeddings come back as plain arrays, truncated when asked", async () => {
    const r = (await invokeCognitive(ensemble(), "embed", { inputs: [{ kind: "query", text: "hi there" }], dimensions: 4 })) as { model: string; vectors: number[][] };
    expect(r.model).toBe("gemma");
    expect(Array.isArray(r.vectors[0])).toBe(true);
    expect(r.vectors[0]).toHaveLength(4);
  });

  it("CS1.3 compression and document parsing work from JSON (pages as base64)", async () => {
    const e = ensemble();
    expect(await invokeCognitive(e, "compress", { text: "the meeting is on Thursday at noon", rate: 0.5 })).toMatchObject({ model: "lingua", originalTokens: 7 });
    const parsed = (await invokeCognitive(e, "parse", { pages: [{ mediaType: "image/png", data: "AQID" }] })) as { model: string; pages: { markdown: string }[] };
    expect(parsed.model).toBe("ocr");
    expect(parsed.pages[0]!.markdown).toContain("3 bytes");
  });

  it("CS1.4 malformed input is rejected with a message saying what is wrong", async () => {
    const e = ensemble();
    await expect(invokeCognitive(e, "embed", { inputs: "nope" })).rejects.toThrow(/inputs/);
    await expect(invokeCognitive(e, "route", { input: 3, tools })).rejects.toThrow(/input/);
    await expect(invokeCognitive(e, "compress", { text: "x" })).rejects.toThrow(/rate/);
    await expect(invokeCognitive(e, "parse", { pages: [{ mediaType: "image/png" }] })).rejects.toThrow(/data/);
    await expect(invokeCognitive(e, "judge", { state: "s" })).rejects.toThrow(/questions/);
  });

  it("CS1.5 status lists every member and the ranking for each task", async () => {
    const e = ensemble();
    e.revoke("ocr", "no GPU");
    const status = (await invokeCognitive(e, "status", {})) as { platform: string; members: { id: string; state: string; reason?: string }[]; tasks: Record<string, { id: string }[]> };
    expect(status.platform).toBe("native");
    expect(status.members.find((m) => m.id === "ocr")).toMatchObject({ state: "revoked", reason: "no GPU", name: "Model ocr" });
    expect(status.tasks["judgment"]!.map((r) => r.id)).toEqual(["jev"]);
    expect(status.tasks["document-parsing"]).toEqual([]);
  });

  it("CS1.6 base64 decoding round-trips bytes and rejects garbage", () => {
    expect(Array.from(decodeBase64("AQID"))).toEqual([1, 2, 3]);
    expect(Array.from(decodeBase64("aGk="))).toEqual([104, 105]);
    expect(Array.from(decodeBase64(""))).toEqual([]);
    expect(() => decodeBase64("a$b=")).toThrow(/base64/);
  });
});

describe("cognitive service input handling", () => {
  function recording() {
    const seen: Record<string, unknown[]> = { route: [], embed: [], compress: [], parse: [] };
    const e = new Ensemble({ platform: "native" });
    e.register(d("needle", ["tool-calling"], ["router"]), async () => ({ router: { route: async (r) => (seen["route"]!.push(r), { calls: [], confidence: 1, reasoning: "" }) } }));
    e.register(d("gemma", ["text-embedding"], ["embedder"]), async () => ({ embedder: { dimensions: 2, embed: async (i, o) => (seen["embed"]!.push([i, o]), i.map(() => Float32Array.from([1, 0]))) } }));
    e.register(d("lingua", ["prompt-compression"], ["compressor"]), async () => ({ compressor: { compress: async (r) => (seen["compress"]!.push(r), { text: r.text, originalTokens: 1, compressedTokens: 1 }) } }));
    e.register(d("ocr", ["document-parsing"], ["document-parser"]), async () => ({ "document-parser": { parse: async (r) => (seen["parse"]!.push(r), { pages: [] }) } }));
    return { e, seen };
  }

  it("CS2.1 each malformed field is named in the error", async () => {
    const e = ensemble();
    const cases: [Parameters<typeof invokeCognitive>[1], unknown, string][] = [
      ["route", "text", "input must be an object"],
      ["route", [], "input must be an object"],
      ["route", null, "input.input must be a string"],
      ["route", { input: "x", tools: "no" }, "tools must be an array"],
      ["route", { input: "x", tools: [3] }, "tools[0] must be an object"],
      ["route", { input: "x", tools: [{}] }, "tools[0].name must be a string"],
      ["route", { input: "x", tools: [{ name: "t", parameters: [] }] }, "tools[0].parameters must be an object"],
      ["decide-tools", { tools: [] }, "input.input must be a string"],
      ["decide-tools", { input: "x", tools: [], policy: 3 }, "policy must be an object"],
      ["embed", { inputs: [5] }, "inputs[0] must be an object"],
      ["embed", { inputs: [{ kind: "query" }] }, "inputs[0].text must be a string"],
      ["embed", { inputs: [{ kind: "summary", text: "a" }] }, "inputs[0].kind must be query or document"],
      ["compress", { text: "x", rate: 0.5, forceTokens: [1] }, "forceTokens[0] must be a string"],
      ["compress", { rate: 0.5 }, "text must be a string"],
      ["parse", { pages: "x" }, "pages must be an array of { mediaType, data (base64) }"],
      ["parse", { pages: [1] }, "pages[0] must be an object"],
      ["parse", { pages: [{ data: "AQID" }] }, "pages[0].mediaType must be a string"],
      ["parse", { pages: [{ mediaType: "image/png" }] }, "pages[0].data must be a string"],
    ];
    for (const [op, input, message] of cases) await expect(invokeCognitive(e, op, input), `${op} ${JSON.stringify(input)}`).rejects.toThrow(message);
  });

  it("CS2.2 tools pass through with description and parameters, defaulting both when absent or not usable", async () => {
    const { e, seen } = recording();
    await invokeCognitive(e, "route", { input: "go", tools: [{ name: "t", description: "d", parameters: { type: "object" } }, { name: "u" }, { name: "v", description: 5 }] });
    expect(seen["route"]).toEqual([
      {
        input: "go",
        tools: [
          { name: "t", description: "d", parameters: { type: "object" } },
          { name: "u", description: "", parameters: {} },
          { name: "v", description: "", parameters: {} },
        ],
      },
    ]);
  });

  it("CS2.3 optional fields are forwarded only when present and well-typed", async () => {
    const { e, seen } = recording();
    await invokeCognitive(e, "embed", { inputs: [{ kind: "document", text: "a" }], dimensions: 2 });
    await invokeCognitive(e, "embed", { inputs: [{ kind: "query", text: "a" }], dimensions: "2" });
    expect(seen["embed"]).toEqual([
      [[{ kind: "document", text: "a" }], { dimensions: 2 }],
      [[{ kind: "query", text: "a" }], {}],
    ]);
    await invokeCognitive(e, "compress", { text: "a b", rate: 0.5, forceTokens: ["b"] });
    await invokeCognitive(e, "compress", { text: "a b", rate: 0.5 });
    expect(seen["compress"]).toEqual([{ text: "a b", rate: 0.5, forceTokens: ["b"] }, { text: "a b", rate: 0.5 }]);
    await invokeCognitive(e, "parse", { pages: [{ mediaType: "image/png", data: "AQ==" }], instruction: "tables only" });
    await invokeCognitive(e, "parse", { pages: [{ mediaType: "image/png", data: "AQ==" }], instruction: 7 });
    expect(seen["parse"]).toEqual([
      { pages: [{ mediaType: "image/png", data: Uint8Array.from([1]) }], instruction: "tables only" },
      { pages: [{ mediaType: "image/png", data: Uint8Array.from([1]) }] },
    ]);
  });

  it("CS2.4 a policy is handed to the cascade; members without a reason report none", async () => {
    const e = ensemble();
    // a policy that never trusts the router alone sends it to the judge (0.8 here)
    expect(await invokeCognitive(e, "decide-tools", { input: "start a timer", tools, policy: { act: 1, verify: 0, accept: 0.5 } })).toMatchObject({ decidedBy: "router+judge", confidence: 0.8 });
    const status = (await invokeCognitive(e, "status", {})) as { members: Record<string, unknown>[] };
    expect(status.members.every((m) => !("reason" in m))).toBe(true);
  });

  it("CS2.5 base64 padding and length are checked exactly", () => {
    expect(Array.from(decodeBase64("aGk=="))).toEqual([104, 105]);
    expect(Array.from(decodeBase64("aGk"))).toEqual([104, 105]);
    expect(() => decodeBase64("aGk=a")).toThrow(/base64/);
    expect(() => decodeBase64("aGkhY")).toThrow(/base64/);
    expect(Array.from(decodeBase64("aGkhYQ"))).toEqual([104, 105, 33, 97]);
  });
});

describe("capability mirror", () => {
  it("CM1.1 offers a capability per task some member can serve, and follows revocations and failures", async () => {
    const e = new Ensemble({ platform: "native" });
    const offered = new Set<string>();
    const log: string[] = [];
    e.register(d("a", ["text-embedding", "classification"], ["embedder", "router"]), async () => ({ embedder: new HashEmbedder(8) }));
    e.register(d("b", ["text-embedding"], ["embedder"]), async () => {
      throw new Error("weights missing");
    });
    const stop = mirrorCapabilities(e, {
      offer: (name) => (offered.add(name), log.push(`+${name}`)),
      withdraw: (name) => (offered.delete(name), log.push(`-${name}`)),
    });
    expect([...offered].sort()).toEqual(["cognitive.classification", "cognitive.text-embedding"]);
    e.revoke("a", "platform withdrew WebGPU");
    expect([...offered].sort()).toEqual(["cognitive.text-embedding"]);
    await e.embed([{ kind: "query", text: "x" }]).catch(() => undefined);
    expect(offered.has("cognitive.text-embedding")).toBe(false);
    e.restore("a");
    expect([...offered].sort()).toEqual(["cognitive.classification", "cognitive.text-embedding"]);
    stop();
    e.revoke("a", "again");
    expect(offered.has("cognitive.classification")).toBe(true);
    expect(log.filter((l) => l === "+cognitive.classification")).toHaveLength(2);
    // a capability still offered is not offered again
    expect(log.filter((l) => l === "+cognitive.text-embedding")).toHaveLength(2);
  });
});
