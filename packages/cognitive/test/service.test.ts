import { describe, expect, it } from "vitest";
import { Ensemble, invokeCognitive, mirrorCapabilities } from "@harness/cognitive";
import type { ModelDescriptor, TaskCategory } from "@harness/cognitive";
import { HashEmbedder, HeuristicCompressor, KeywordRouter, ScriptedJudge, StubDocumentParser } from "@harness/testkit";

function d(id: string, tasks: readonly TaskCategory[], ports: ModelDescriptor["ports"]): ModelDescriptor {
  return { id, name: `Model ${id}`, publisher: "t", tasks, ports, locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["native"], license: "MIT", downloadBytes: 1, benchmarks: [] };
}

function ensemble() {
  const e = new Ensemble({ platform: "native" });
  e.register(d("judge-a", ["judgment"], ["judge"]), async () => ({ judge: new ScriptedJudge(() => ({ type: "boolean", probability: 0.8 })) }));
  e.register(d("router-a", ["tool-calling"], ["router"]), async () => ({ router: new KeywordRouter() }));
  e.register(d("embedder-a", ["text-embedding"], ["embedder"]), async () => ({ embedder: new HashEmbedder(8) }));
  e.register(d("compressor-a", ["prompt-compression"], ["compressor"]), async () => ({ compressor: new HeuristicCompressor() }));
  e.register(d("ocr", ["document-parsing"], ["document-parser"]), async () => ({ "document-parser": new StubDocumentParser() }));
  return e;
}

const tools = [{ name: "set_timer", description: "Start a timer", parameters: { type: "object" } }];

describe("cognitive service (ACP operations on the ensemble)", () => {
  it("CS1.1 every result names the model that served it", async () => {
    const e = ensemble();
    expect(await invokeCognitive(e, "judge", { state: "s", questions: { ok: { type: "boolean", instructions: "?" } } })).toEqual({ model: "judge-a", answers: { ok: { type: "boolean", probability: 0.8 } } });
    expect(await invokeCognitive(e, "route", { input: "start a timer", tools })).toMatchObject({ model: "router-a", calls: [{ name: "set_timer" }] });
    expect(await invokeCognitive(e, "decide-tools", { input: "start a timer", tools })).toMatchObject({ calls: [{ name: "set_timer" }], decidedBy: expect.any(String) });
  });

  it("CS1.2 embeddings come back as plain arrays, truncated when asked", async () => {
    const r = (await invokeCognitive(ensemble(), "embed", { inputs: [{ kind: "query", text: "hi there" }], dimensions: 4 })) as { model: string; vectors: number[][] };
    expect(r.model).toBe("embedder-a");
    expect(Array.isArray(r.vectors[0])).toBe(true);
    expect(r.vectors[0]).toHaveLength(4);
  });

  it("CS1.3 compression and document parsing work from JSON (pages as base64)", async () => {
    const e = ensemble();
    expect(await invokeCognitive(e, "compress", { text: "the meeting is on Thursday at noon", rate: 0.5 })).toMatchObject({ model: "compressor-a", originalTokens: 7 });
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
    expect(status.tasks["judgment"]!.map((r) => r.id)).toEqual(["judge-a"]);
    expect(status.tasks["document-parsing"]).toEqual([]);
  });
});

describe("cognitive service input handling", () => {
  function recording() {
    const seen: Record<string, unknown[]> = { route: [], embed: [], compress: [], parse: [] };
    const e = new Ensemble({ platform: "native" });
    e.register(d("router-a", ["tool-calling"], ["router"]), async () => ({ router: { route: async (r) => (seen["route"]!.push(r), { calls: [], confidence: 1, reasoning: "" }) } }));
    e.register(d("embedder-a", ["text-embedding"], ["embedder"]), async () => ({ embedder: { dimensions: 2, embed: async (i, o) => (seen["embed"]!.push([i, o]), i.map(() => Float32Array.from([1, 0]))) } }));
    e.register(d("compressor-a", ["prompt-compression"], ["compressor"]), async () => ({ compressor: { compress: async (r) => (seen["compress"]!.push(r), { text: r.text, originalTokens: 1, compressedTokens: 1 }) } }));
    e.register(d("ocr", ["document-parsing"], ["document-parser"]), async () => ({ "document-parser": { parse: async (r) => (seen["parse"]!.push(r), { pages: [] }) } }));
    return { e, seen };
  }

  it("CS2.1 input is parsed before any model runs, and every problem names where it is", async () => {
    const e = ensemble();
    const cases: [Parameters<typeof invokeCognitive>[1], unknown, RegExp][] = [
      ["route", "text", /invalid route input[\s\S]*expected object/],
      ["route", [], /expected object/],
      ["route", null, /at input/],
      ["route", { input: "x", tools: "no" }, /at tools/],
      ["route", { input: "x", tools: [3] }, /at tools\[0\]/],
      ["route", { input: "x", tools: [{}] }, /at tools\[0\]\.name/],
      ["route", { input: "x", tools: [{ name: "t", description: 5 }] }, /at tools\[0\]\.description/],
      ["route", { input: "x", tools: [{ name: "t", parameters: [] }] }, /at tools\[0\]\.parameters/],
      ["decide-tools", { tools: [] }, /at input/],
      ["decide-tools", { input: "x", tools: [], policy: 3 }, /at policy/],
      ["judge", { questions: { ok: { type: "vote", instructions: "?" } } }, /at questions\.ok\.type/],
      ["embed", { inputs: [5] }, /at inputs\[0\]/],
      ["embed", { inputs: [{ kind: "query" }] }, /at inputs\[0\]\.text/],
      ["embed", { inputs: [{ kind: "summary", text: "a" }] }, /at inputs\[0\]\.kind/],
      ["embed", { inputs: [], dimensions: "2" }, /at dimensions/],
      ["compress", { text: "x", rate: 0.5, forceTokens: [1] }, /at forceTokens\[0\]/],
      ["compress", { text: "x", rate: 0 }, /at rate/],
      ["compress", { rate: 0.5 }, /at text/],
      ["parse", { pages: "x" }, /at pages/],
      ["parse", { pages: [{ data: "AQID" }] }, /at pages\[0\]\.mediaType/],
      ["parse", { pages: [{ mediaType: "image/png", data: "a$b=" }] }, /not valid base64\n  → at pages\[0\]\.data/],
      ["parse", { pages: [], instruction: 7 }, /at instruction/],
    ];
    for (const [op, input, message] of cases) await expect(invokeCognitive(e, op, input), `${op} ${JSON.stringify(input)}`).rejects.toThrow(message);
  });

  it("CS2.2 tools default their description and parameters when absent", async () => {
    const { e, seen } = recording();
    await invokeCognitive(e, "route", { input: "go", tools: [{ name: "t", description: "d", parameters: { type: "object" } }, { name: "u" }] });
    expect(seen["route"]).toEqual([
      {
        input: "go",
        tools: [
          { name: "t", description: "d", parameters: { type: "object" } },
          { name: "u", description: "", parameters: {} },
        ],
      },
    ]);
  });

  it("CS2.3 optional fields reach the port only when the client sent them", async () => {
    const { e, seen } = recording();
    await invokeCognitive(e, "embed", { inputs: [{ kind: "document", text: "a" }], dimensions: 2 });
    await invokeCognitive(e, "embed", { inputs: [{ kind: "query", text: "a" }] });
    expect(seen["embed"]).toEqual([
      [[{ kind: "document", text: "a" }], { dimensions: 2 }],
      [[{ kind: "query", text: "a" }], {}],
    ]);
    await invokeCognitive(e, "compress", { text: "a b", rate: 0.5, forceTokens: ["b"] });
    await invokeCognitive(e, "compress", { text: "a b", rate: 0.5 });
    expect(seen["compress"]).toStrictEqual([{ text: "a b", rate: 0.5, forceTokens: ["b"] }, { text: "a b", rate: 0.5 }]);
    await invokeCognitive(e, "parse", { pages: [{ mediaType: "image/png", data: "AQ==" }], instruction: "tables only" });
    await invokeCognitive(e, "parse", { pages: [{ mediaType: "image/png", data: "AQ==" }] });
    expect(seen["parse"]).toStrictEqual([
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
});

describe("extension operations", () => {
  it("CS3.1 a namespaced operation runs on the installed extension; one no extension serves is refused", async () => {
    const e = ensemble();
    await expect(invokeCognitive(e, "memory.recall", { query: "x" })).rejects.toThrow("no installed extension serves memory.recall");
    e.install({ id: "memory", models: [{ descriptor: d("memory-embedder", ["text-embedding"], ["embedder"]), load: async () => ({ embedder: new HashEmbedder(8) }) }], operations: { recall: async (input) => ({ got: input }) } });
    expect(await invokeCognitive(e, "memory.recall", { query: "x" })).toEqual({ got: { query: "x" } });
    expect(((await invokeCognitive(e, "status", {})) as { extensions: string[] }).extensions).toEqual(["memory"]);
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
