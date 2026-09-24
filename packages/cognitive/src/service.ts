import { decideToolCalls } from "./cascade.ts";
import type { CascadePolicy } from "./cascade.ts";
import type { EmbedInput } from "./embedding.ts";
import type { Ensemble } from "./ensemble.ts";
import { TASK_CATEGORIES } from "./models.ts";
import type { JudgeQuestion, JudgeState, ToolSpec } from "./ports.ts";

/**
 * The cognitive core's operations as JSON in, JSON out: what the daemon's
 * `_harness/cognitive/*` methods run on the host's ensemble. Every result names the
 * model that produced it.
 */
export type CognitiveOperation = "judge" | "route" | "decide-tools" | "embed" | "compress" | "parse" | "status";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(clean) || clean.length % 4 === 1) throw new Error("data is not valid base64");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of clean) {
    value = (value << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

function record(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function string(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} must be a string`);
  return v;
}

function tools(v: unknown): ToolSpec[] {
  if (!Array.isArray(v)) throw new Error("tools must be an array");
  return v.map((t, i) => {
    const r = record(t, `tools[${i}]`);
    return { name: string(r["name"], `tools[${i}].name`), description: typeof r["description"] === "string" ? r["description"] : "", parameters: record(r["parameters"] ?? {}, `tools[${i}].parameters`) };
  });
}

export async function invokeCognitive(ensemble: Ensemble, op: CognitiveOperation, rawInput: unknown): Promise<unknown> {
  const input = record(rawInput ?? {}, "input");
  switch (op) {
    case "judge": {
      const questions = record(input["questions"], "questions") as Record<string, JudgeQuestion>;
      const { id, port } = await ensemble.resolve("judgment", "judge");
      return { model: id, answers: await port.evaluate({ state: (input["state"] ?? "") as JudgeState, questions }) };
    }
    case "route": {
      const request = { input: string(input["input"], "input.input"), tools: tools(input["tools"]) };
      const { id, port } = await ensemble.resolve("tool-calling", "router");
      return { model: id, ...(await port.route(request)) };
    }
    case "decide-tools": {
      const request = { input: string(input["input"], "input.input"), tools: tools(input["tools"]) };
      return input["policy"] === undefined ? decideToolCalls(ensemble, request) : decideToolCalls(ensemble, request, record(input["policy"], "policy") as unknown as CascadePolicy);
    }
    case "embed": {
      if (!Array.isArray(input["inputs"])) throw new Error("inputs must be an array of { kind, text }");
      const inputs = input["inputs"].map((x, i) => {
        const r = record(x, `inputs[${i}]`);
        string(r["text"], `inputs[${i}].text`);
        if (r["kind"] !== "query" && r["kind"] !== "document") throw new Error(`inputs[${i}].kind must be query or document`);
        return r as unknown as EmbedInput;
      });
      const { id, port } = await ensemble.resolve("text-embedding", "embedder");
      const vectors = await port.embed(inputs, typeof input["dimensions"] === "number" ? { dimensions: input["dimensions"] } : {});
      return { model: id, vectors: vectors.map((v) => Array.from(v)) };
    }
    case "compress": {
      if (typeof input["rate"] !== "number") throw new Error("rate must be a number in (0, 1]");
      const forceTokens = Array.isArray(input["forceTokens"]) ? input["forceTokens"].map((t, i) => string(t, `forceTokens[${i}]`)) : undefined;
      const { id, port } = await ensemble.resolve("prompt-compression", "compressor");
      return { model: id, ...(await port.compress({ text: string(input["text"], "text"), rate: input["rate"], ...(forceTokens ? { forceTokens } : {}) })) };
    }
    case "parse": {
      if (!Array.isArray(input["pages"])) throw new Error("pages must be an array of { mediaType, data (base64) }");
      const pages = input["pages"].map((p, i) => {
        const r = record(p, `pages[${i}]`);
        return { mediaType: string(r["mediaType"], `pages[${i}].mediaType`), data: decodeBase64(string(r["data"], `pages[${i}].data`)) };
      });
      const { id, port } = await ensemble.resolve("document-parsing", "document-parser");
      const instruction = typeof input["instruction"] === "string" ? input["instruction"] : undefined;
      return { model: id, ...(await port.parse(instruction === undefined ? { pages } : { pages, instruction })) };
    }
    case "status":
      return {
        platform: ensemble.platform,
        members: ensemble.members().map((m) => ({
          id: m.id,
          name: m.descriptor.name,
          state: m.state,
          ...(m.reason === undefined ? {} : { reason: m.reason }),
          tasks: m.descriptor.tasks,
          locality: m.descriptor.locality,
          runtime: m.descriptor.runtime,
        })),
        tasks: Object.fromEntries(TASK_CATEGORIES.map((t) => [t, ensemble.candidates(t).map((r) => ({ id: r.id, wins: r.wins, losses: r.losses }))])),
      };
  }
}

/**
 * Keep `cognitive.<task>` capabilities in step with the ensemble: offered while some
 * member in service can serve the task, withdrawn when revocation or failure leaves
 * none. Returns a function that stops mirroring.
 */
export function mirrorCapabilities(ensemble: Ensemble, sink: { offer(name: string): void; withdraw(name: string): void }): () => void {
  let offered = new Set<string>();
  const sync = () => {
    const now = new Set(TASK_CATEGORIES.filter((t) => ensemble.candidates(t).length > 0).map((t) => `cognitive.${t}`));
    for (const name of offered) if (!now.has(name)) sink.withdraw(name);
    for (const name of now) if (!offered.has(name)) sink.offer(name);
    offered = now;
  };
  sync();
  return ensemble.onChange(sync);
}
