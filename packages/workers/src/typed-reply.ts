import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4Middleware, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { f } from "@ax-llm/ax";
import { wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";
import { constrain, constraintOf, HARNESS, sessionOf, usage } from "@harness/cognitive";
import type { Dialogue } from "@harness/dialogue";
import { dialogueMiddleware } from "./dialogue.ts";
import { citedBody, recalledLines, visibleWordings, voiceAnswer } from "./voice.ts";
import type { CitationBook, SessionVoice } from "./voice.ts";

/**
 * A conversation turn as an Ax signature. Constrained decoding enforces the output
 * half (the `reply` the person reads). The input names the utterance the turn is about.
 */
export const replySignature = f()
  .input("utterance", f.string("What the person just said."))
  .output("reply", f.string("The sentence the person reads back."))
  .description("A conversation turn. The reply is the words the person hears, with no markup.")
  .useStructured()
  .build();

/** The signature's output object: what a generator that enforces JSON Schema must produce. */
function replySchema(): Record<string, unknown> {
  const full = replySignature.toJSONSchema();
  const names = new Set(replySignature.getOutputFields().map((field) => field.name));
  const properties = Object.fromEntries(Object.entries(full.properties ?? {}).filter(([name]) => names.has(name)));
  return {
    type: "object",
    ...(full.title === undefined ? {} : { title: full.title }),
    properties,
    required: (full.required ?? []).filter((name) => names.has(name)),
    additionalProperties: false,
  };
}

const schema = replySchema();

/** A call the reply schema may cover: nothing else has already given it a shape, and it is not choosing a tool. */
function openCall(params: LanguageModelV4CallOptions): boolean {
  if (constraintOf(params) !== undefined) return false;
  return params.tools === undefined || params.tools.length === 0;
}

function withReply(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  if (!openCall(params)) return params;
  const added = constrain({ type: "json-schema", schema }).providerOptions[HARNESS];
  return {
    ...params,
    providerOptions: { ...params.providerOptions, [HARNESS]: { ...params.providerOptions?.[HARNESS], ...added } },
  };
}

function carriesReply(params: LanguageModelV4CallOptions): boolean {
  const constraint = constraintOf(params);
  return constraint?.type === "json-schema" && JSON.stringify(constraint.schema) === JSON.stringify(schema);
}

/** The reply field of a constrained object, or nothing when the text is not that object. */
function sentenceOf(text: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (!("reply" in value) || typeof value.reply !== "string") return undefined;
  return value.reply;
}

function rewrite(content: readonly LanguageModelV4Content[]): LanguageModelV4Content[] {
  const text = content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const sentence = sentenceOf(text);
  if (sentence === undefined) return [...content];
  const next: LanguageModelV4Content[] = [];
  let written = false;
  for (const part of content) {
    if (part.type !== "text") {
      next.push(part);
      continue;
    }
    if (written) continue;
    next.push({ type: "text", text: sentence });
    written = true;
  }
  return next;
}

/** Holds text until the block ends, then emits the reply sentence instead of the JSON. */
function unwrapStream(stream: ReadableStream<LanguageModelV4StreamPart>): ReadableStream<LanguageModelV4StreamPart> {
  let raw = "";
  let id = "reply";
  const held: LanguageModelV4StreamPart[] = [];
  const flush = (controller: TransformStreamDefaultController<LanguageModelV4StreamPart>) => {
    if (raw === "" && held.length === 0) return;
    const sentence = sentenceOf(raw);
    if (sentence === undefined) for (const part of held) controller.enqueue(part);
    else controller.enqueue({ type: "text-delta", id, delta: sentence });
    raw = "";
    held.length = 0;
  };
  return stream.pipeThrough(
    new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
      transform(part, controller) {
        if (part.type === "text-delta") {
          raw += part.delta;
          id = part.id;
          held.push(part);
          return;
        }
        if (part.type === "text-end" || part.type === "finish") flush(controller);
        controller.enqueue(part);
      },
    }),
  );
}

/** Replace joined text with harness wording. A citation in that wording reads back the joined text. */
function voiceOf(content: readonly LanguageModelV4Content[], voice: SessionVoice, modelId: string, lines: readonly string[]): LanguageModelV4Content[] {
  const raw = content.map((part) => (part.type === "text" ? part.text : "")).join("");
  if (raw === "") return [...content];
  const text = voiceAnswer(raw, { kind: "model", id: modelId }, voice.voice, voice.book, lines).text;
  const next: LanguageModelV4Content[] = [];
  let written = false;
  for (const part of content) {
    if (part.type !== "text") {
      next.push(part);
      continue;
    }
    if (written) continue;
    next.push({ type: "text", text });
    written = true;
  }
  return next;
}

/** Hold text deltas and emit one harness-worded delta when the block ends. */
function voiceStream(stream: ReadableStream<LanguageModelV4StreamPart>, voice: SessionVoice, modelId: string, lines: readonly string[]): ReadableStream<LanguageModelV4StreamPart> {
  let raw = "";
  let id = "reply";
  const emit = (controller: TransformStreamDefaultController<LanguageModelV4StreamPart>) => {
    if (raw === "") return;
    controller.enqueue({ type: "text-delta", id, delta: voiceAnswer(raw, { kind: "model", id: modelId }, voice.voice, voice.book, lines).text });
    raw = "";
  };
  return stream.pipeThrough(
    new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
      transform(part, controller) {
        if (part.type === "text-delta") {
          raw += part.delta;
          id = part.id;
          return;
        }
        if (part.type === "text-end" || part.type === "finish") emit(controller);
        controller.enqueue(part);
      },
    }),
  );
}

/**
 * Middleware that asks a tool-less, unconstrained call for the reply schema and returns that field as text.
 * When `foreign` is set, that text (or the prose, when it is not the reply object) is rewritten in the harness voice.
 */
export function typedReply(foreign?: { readonly voice: SessionVoice; readonly modelId: string }): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }) => withReply(foreign === undefined ? params : withoutSharedPrompt(params)),
    wrapGenerate: async ({ doGenerate, params }) => {
      const lines = foreign === undefined ? undefined : await recalledLines(foreign.voice.voice, foreign.voice.memoryStore, askedText(params), sessionOf(params.providerOptions));
      const result = await doGenerate();
      const content = carriesReply(params) ? rewrite(result.content) : result.content;
      if (foreign === undefined || lines === undefined) return carriesReply(params) ? { ...result, content } : result;
      return { ...result, content: voiceOf(content, foreign.voice, foreign.modelId, lines) };
    },
    wrapStream: async ({ doStream, params }) => {
      const lines = foreign === undefined ? undefined : await recalledLines(foreign.voice.voice, foreign.voice.memoryStore, askedText(params), sessionOf(params.providerOptions));
      const result = await doStream();
      const stream = carriesReply(params) ? unwrapStream(result.stream) : result.stream;
      if (foreign === undefined || lines === undefined) return carriesReply(params) ? { ...result, stream } : result;
      return { ...result, stream: voiceStream(stream, foreign.voice, foreign.modelId, lines) };
    },
  };
}

/** The latest user text, past a tool result that closed the previous step. */
function askedText(params: LanguageModelV4CallOptions): string {
  for (let i = params.prompt.length - 1; i >= 0; i -= 1) {
    const message = params.prompt[i];
    if (message === undefined || message.role !== "user") continue;
    return typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  return "";
}

/** Stored harness wordings become their citations. Text that is not a full wording stays. */
function redactWording(text: string): string {
  try {
    const wordings = visibleWordings(text);
    if (wordings.length === 0) return text;
    return wordings.map((holes) => holes["citation"] ?? "").join("\n");
  } catch {
    return text;
  }
}

/** Drop the system prompt, and prior harness wording, before a foreign model sees the call. */
function withoutSharedPrompt(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  const prompt: LanguageModelV4CallOptions["prompt"] = [];
  for (const message of params.prompt) {
    if (message.role === "system") continue;
    if (message.role !== "assistant") {
      prompt.push(message);
      continue;
    }
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "text") return part;
      const text = redactWording(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    prompt.push(changed ? { ...message, content } : message);
  }
  return { ...params, prompt };
}

/** The raw body named by a prompt that is only `cite:<id>`. */
function citedRaw(params: LanguageModelV4CallOptions, book: CitationBook): string | undefined {
  return citedBody(askedText(params), book);
}

/** A turn whose whole prompt is a citation: the stored raw body, with no model call. */
function openCitation(book: CitationBook): LanguageModelV4Middleware {
  const generate = (text: string) => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(0, 0),
    warnings: [],
  });
  const stream = (text: string): ReadableStream<LanguageModelV4StreamPart> => {
    const id = "cite";
    const parts: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id },
      { type: "text-delta", id, delta: text },
      { type: "text-end", id },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage(0, 0) },
    ];
    return new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
  };
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params }) => {
      const raw = citedRaw(params, book);
      return raw === undefined ? doGenerate() : generate(raw);
    },
    wrapStream: async ({ doStream, params }) => {
      const raw = citedRaw(params, book);
      return raw === undefined ? doStream() : { stream: stream(raw) };
    },
  };
}

/**
 * The session's model. The reply schema sits inside the dialogue, so a script still sees an
 * unshaped turn and answers before any schema is added. Without a dialogue, the schema still applies.
 * A voice binding rewrites a model that is not the harness's own, and a prompt that is only a citation
 * returns that raw body before the dialogue or the model sees it.
 */
export function sessionModel(model: Exclude<LanguageModel, string>, dialogue?: Dialogue, voice?: SessionVoice): LanguageModelV4 {
  const foreign = voice !== undefined && model.modelId !== voice.ownModelId ? { voice, modelId: model.modelId } : undefined;
  const typed = wrapLanguageModel({ model, middleware: typedReply(foreign) });
  const answered = dialogue ? wrapLanguageModel({ model: typed, middleware: dialogueMiddleware(dialogue) }) : typed;
  return voice === undefined ? answered : wrapLanguageModel({ model: answered, middleware: openCitation(voice.book) });
}
