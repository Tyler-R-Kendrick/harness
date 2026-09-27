/**
 * Claude, reached through a published artifact's `sample` capability, as an AI SDK
 * `LanguageModelV4`. The capability takes plain user/assistant turns and returns text,
 * so a call's instructions, tools and conversation are rendered into turns, and Claude
 * is asked for one JSON object holding what it says and the tools it calls. The AI SDK
 * then runs the tools (through the daemon's approvals) and sends their results back on
 * the next call, exactly as with any other provider.
 */
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4ToolResultOutput } from "@ai-sdk/provider";
import { parsePartialJson } from "ai";
import { collectParts, finishReason, usage } from "@harness/cognitive";

export type ModelTier = "quick" | "default" | "complex";

export interface SampleMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export type SampleInput = string | SampleMessage[];

export interface SampleCallOptions {
  readonly onText?: (update: { readonly text: string; readonly delta: string }) => void;
  readonly signal?: AbortSignal;
  readonly modelTier?: ModelTier;
  readonly cache?: boolean;
}

/** The artifact runtime's `sample` function (`await claude.use("sample")`), as far as this model uses it. */
export type Sample = (input: SampleInput, options?: SampleCallOptions) => Promise<{ readonly text: string; readonly truncated: boolean }>;

export interface Reply {
  readonly text: string;
  readonly toolCalls: readonly { readonly toolName: string; readonly input: Record<string, unknown> }[];
}

const FORMAT = [
  'Reply with only one JSON object: {"text": string, "toolCalls": [{"toolName": string, "input": object}]}.',
  '"text" is what you say to the person. To use tools, list the calls in "toolCalls" and stop: their results come back in the next turn, and you continue from there. When you need no tool, "toolCalls" is [].',
].join("\n");

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function outputText(o: LanguageModelV4ToolResultOutput): string {
  switch (o.type) {
    case "text":
      return o.value;
    case "json":
      return JSON.stringify(o.value);
    case "error-text":
      return `error: ${o.value}`;
    case "error-json":
      return `error: ${JSON.stringify(o.value)}`;
    case "execution-denied":
      return `denied by the person${o.reason ? `: ${o.reason}` : ""}`;
    case "content":
      return o.value.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("");
  }
}

function leading(options: Pick<LanguageModelV4CallOptions, "prompt" | "tools" | "responseFormat">): string {
  const system = options.prompt.flatMap((m) => (m.role === "system" ? [m.content] : []));
  const tools = (options.tools ?? []).flatMap((t) => (t.type === "function" ? [`- ${t.name}: ${t.description ?? ""}\n  input schema: ${JSON.stringify(t.inputSchema)}`] : []));
  const json = options.responseFormat?.type === "json" ? [`The value of "text" must itself be JSON${options.responseFormat.schema ? ` matching this schema: ${JSON.stringify(options.responseFormat.schema)}` : ""}.`] : [];
  return [...system, tools.length ? `Tools you can call:\n${tools.join("\n")}` : "You have no tools.", ...json, FORMAT].join("\n\n");
}

/** A call as the turns `sample` takes: instructions, tools and the reply format lead as a user turn; the list ends on a user turn. */
export function sampleTurns(options: Pick<LanguageModelV4CallOptions, "prompt" | "tools" | "responseFormat">): SampleMessage[] {
  const turns: SampleMessage[] = [{ role: "user", content: leading(options) }];
  for (const m of options.prompt as LanguageModelV4Prompt) {
    switch (m.role) {
      case "system":
        break;
      case "user":
        turns.push({ role: "user", content: m.content.map((p) => (p.type === "text" ? p.text : `[a ${p.mediaType} file]`)).join("\n") });
        break;
      case "assistant": {
        const text = m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
        const toolCalls = m.content.flatMap((p) => (p.type === "tool-call" ? [{ toolName: p.toolName, input: p.input }] : []));
        turns.push({ role: "assistant", content: JSON.stringify({ text, toolCalls }) });
        break;
      }
      case "tool": {
        const results = m.content.flatMap((p) => (p.type === "tool-result" ? [`- ${p.toolName} (${p.toolCallId}): ${outputText(p.output)}`] : []));
        turns.push({ role: "user", content: `Tool results:\n${results.join("\n")}` });
        break;
      }
    }
  }
  if (turns.at(-1)!.role !== "user") turns.push({ role: "user", content: "Continue." });
  return turns;
}

function asReply(value: unknown): Reply | undefined {
  const r = record(value);
  if (!r || typeof r["text"] !== "string") return undefined;
  const calls = Array.isArray(r["toolCalls"]) ? r["toolCalls"] : [];
  const toolCalls = calls.flatMap((c) => {
    const call = record(c);
    return call && typeof call["toolName"] === "string" ? [{ toolName: call["toolName"], input: record(call["input"]) ?? {} }] : [];
  });
  return { text: r["text"], toolCalls };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A reply, read tolerantly: the whole reply as JSON, else a fenced block, else the object inside it; otherwise plain text. */
export function parseReply(raw: string): Reply {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(raw)?.[1];
  const start = raw.indexOf("{");
  const candidates = [raw, fenced, start < 0 ? undefined : raw.slice(start, raw.lastIndexOf("}") + 1)];
  for (const c of candidates) {
    const reply = c === undefined ? undefined : asReply(tryJson(c));
    if (reply) return reply;
  }
  return { text: raw, toolCalls: [] };
}

/** The `text` field of a reply still being written, if it has started. */
async function partialText(raw: string): Promise<string | undefined> {
  const start = raw.indexOf("{");
  if (start < 0) return undefined;
  const { value } = await parsePartialJson(raw.slice(start));
  const text = record(value)?.["text"];
  return typeof text === "string" ? text : undefined;
}

/** `sample` rejects with a plain `{code, message}` object; the AI SDK wants an Error. */
function sampleError(e: unknown): Error {
  if (e instanceof Error) return e;
  const r = record(e);
  return new Error(r ? `${String(r["code"])}: ${String(r["message"])}` : String(e));
}

/** Claude through the artifact's `sample` capability, as an AI SDK language model. */
export function sampleLanguageModel(sample: Sample, settings: { readonly tier?: () => ModelTier } = {}): LanguageModelV4 {
  let calls = 0;
  const run = async (options: LanguageModelV4CallOptions, emit: (part: LanguageModelV4StreamPart) => void) => {
    emit({ type: "stream-start", warnings: [] });
    let shown = "";
    const show = (text: string) => {
      if (text.length <= shown.length || !text.startsWith(shown)) return;
      if (shown === "") emit({ type: "text-start", id: "0" });
      emit({ type: "text-delta", id: "0", delta: text.slice(shown.length) });
      shown = text;
    };
    // Partial parses finish in order, so the text only ever grows.
    let parsing = Promise.resolve();
    const onText = ({ text }: { readonly text: string }) => {
      parsing = parsing.then(async () => {
        const partial = await partialText(text);
        if (partial !== undefined) show(partial);
      });
    };
    const result = await sample(sampleTurns(options), { onText, modelTier: settings.tier?.() ?? "default", cache: false, ...(options.abortSignal ? { signal: options.abortSignal } : {}) }).catch((e: unknown) => {
      throw sampleError(e);
    });
    await parsing;
    const reply = parseReply(result.text);
    show(reply.text);
    if (shown !== "") emit({ type: "text-end", id: "0" });
    for (const call of reply.toolCalls) emit({ type: "tool-call", toolCallId: `call-${++calls}`, toolName: call.toolName, input: JSON.stringify(call.input) });
    emit({ type: "finish", finishReason: finishReason(result.truncated ? "length" : reply.toolCalls.length ? "tool-calls" : "stop"), usage: usage() });
  };
  return {
    specificationVersion: "v4",
    provider: "claude.sample",
    modelId: "claude",
    supportedUrls: {},
    doGenerate: async (options) => {
      const parts: LanguageModelV4StreamPart[] = [];
      await run(options, (part) => parts.push(part));
      return collectParts(parts);
    },
    doStream: async (options) => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          return run(options, (part) => controller.enqueue(part)).then(
            () => controller.close(),
            (error: unknown) => {
              controller.enqueue({ type: "error", error });
              controller.close();
            },
          );
        },
      }),
    }),
  };
}
