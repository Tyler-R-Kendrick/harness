import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateText, streamText, tool } from "ai";
import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type { WorkerEvent } from "@harness/core";
import { collectParts, inSession, readTemplate, usage } from "@harness/cognitive";
import { Dialogue, parseSettings } from "@harness/dialogue";
import { AgentWorker, citationBook, citedBody, DialogueWorker, sessionAgent, sessionModel, textChunk, visibleWordings, voiceTemplate, voiceWorker } from "@harness/workers";
import type { CitationBook, HarnessVoice, PromptCommand, Worker } from "@harness/workers";

const settingsFile = JSON.parse(readFileSync(new URL("../../dialogue/data/settings.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
const settings = parseSettings(settingsFile);
const greeting = {
  scripts: [
    { id: "hi", intent: "Greet", patterns: ["hi"], reply: ["Hello there."] },
    { id: "yes", intent: "Confirm", patterns: ["yes"], reply: ["Done: ", { generate: "what" }, "."] },
  ],
};

const PERSONALITY = "PERSONALITY-7k";
const SKILLS = ["SKILL-3m", "SKILL-8n"];
const MEMORY = ["MEMORY-9q", "MEMORY-2w"];
/** Distinctive raw tokens. The middle one sits past the opening; the tail sits past any short preview. */
const LEAKS = ["OPEN-4k", "RAW-TOKEN-4p", "TAIL-9z", "FOREIGN-PERSONALITY-1x", "FOREIGN-SKILL-2y", "FOREIGN-MEMORY-3z"];

function rawBody(tail: string): string {
  return `OPEN-4k frontier RAW-TOKEN-4p FOREIGN-PERSONALITY-1x FOREIGN-SKILL-2y FOREIGN-MEMORY-3z ${tail} TAIL-9z`;
}

function voiceOf(): HarnessVoice {
  return { personality: PERSONALITY, skills: [...SKILLS], memory: [...MEMORY] };
}

function leaks(text: string): void {
  for (const token of LEAKS) expect(text).not.toContain(token);
}

function spoken(text: string, source: string, book: CitationBook, raw: string): void {
  expect(text).not.toBe(raw);
  leaks(text);
  const holes = readTemplate(voiceTemplate, text);
  expect(holes["personality"]).toBe(PERSONALITY);
  expect(holes["skills"]).toBe(SKILLS.join(", "));
  expect(holes["memory"]).toBe(MEMORY.join(", "));
  expect(holes["source"]).toBe(source);
  expect(holes["citation"]?.startsWith("cite:")).toBe(true);
  const id = holes["citation"]?.slice("cite:".length) ?? "";
  expect(id).not.toContain("RAW-TOKEN-4p");
  expect(book.read(id)).toBe(raw);
}

let turn = 0;
async function say(worker: Worker, text: string, sessionId = "s1") {
  const events: WorkerEvent[] = [];
  await worker.run({ type: "prompt", sessionId, turnId: `t${++turn}`, prompt: [{ type: "text", text }], cwd: "/repo" }, (event) => events.push(event));
  const messages = events.flatMap((event) => (event.type === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text" ? [event.update.content.text] : []));
  return { events, messages, reply: messages.join(""), end: events.at(-1) };
}

function scripted(answer: (text: string) => string, options?: { readonly tool?: boolean }): Worker & { prompts: PromptCommand["prompt"][]; permissions: string[] } {
  const prompts: PromptCommand["prompt"][] = [];
  const permissions: string[] = [];
  return {
    prompts,
    permissions,
    async run(command, emit) {
      prompts.push(command.prompt);
      const text = command.prompt.filter((block) => (block as { type: string }).type === "text").map((block) => (block as { text: string }).text).join("\n");
      const base = { sessionId: command.sessionId, turnId: command.turnId };
      if (options?.tool) emit({ type: "update", ...base, update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "run", status: "completed" } });
      const body = answer(text);
      const cut = Math.max(1, body.indexOf("RAW-TOKEN-4p"));
      emit({ type: "update", ...base, update: textChunk(body.slice(0, cut)) });
      emit({ type: "update", ...base, update: textChunk(body.slice(cut)) });
      emit({ type: "end", ...base, stopReason: "end_turn" });
    },
    cancel() {},
    permission(command) {
      permissions.push(command.requestId);
    },
  };
}

function answering(text: string | readonly string[], modelId?: string): MockLanguageModelV4 & { readonly calls: LanguageModelV4CallOptions[] } {
  const calls: LanguageModelV4CallOptions[] = [];
  const deltas = typeof text === "string" ? [text] : text;
  const parts = (): LanguageModelV4StreamPart[] => [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "0", delta })),
    { type: "text-end", id: "0" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: usage() },
  ];
  const model = new MockLanguageModelV4({
    ...(modelId === undefined ? {} : { modelId }),
    doGenerate: async (call) => {
      calls.push(call);
      return collectParts(parts());
    },
    doStream: async (call) => {
      calls.push(call);
      return { stream: convertArrayToReadableStream(parts()) };
    },
  });
  return Object.assign(model, { calls });
}

function bound(book: CitationBook, ownModelId: string) {
  return { voice: voiceOf(), book, ownModelId };
}

describe("harness voice for user-visible answers", () => {
  it("VW1.1 a foreign worker's raw answer is shown as harness wording", async () => {
    const raw = rawBody("worker-turn");
    const book = citationBook();
    const voice = voiceOf();
    const inner = scripted(() => raw);
    const worker = new DialogueWorker(inner, new Dialogue({ settings }), { voice: { voice, book, producer: { kind: "harness", id: "external-harness" } } });
    const spokenTurn = await say(worker, "what time is it");
    expect(spokenTurn.messages).toHaveLength(1);
    spoken(spokenTurn.reply, "harness:external-harness", book, raw);
    expect(spokenTurn.end).toMatchObject({ type: "end", stopReason: "end_turn" });
    expect(voice).toEqual(voiceOf());
  });

  it("VW1.2 a different harness is cited in full and is not given the harness voice", async () => {
    const first = rawBody("first-body");
    const again = rawBody("first-body");
    const second = rawBody("second-body");
    const hole = rawBody("hole-body");
    const answers = [first, again, second, hole];
    let n = 0;
    const book = citationBook();
    const voice = voiceOf();
    const inner = scripted(() => answers[n++] ?? second, { tool: true });
    const dialogue = new Dialogue({ settings, book: greeting });
    const worker = new DialogueWorker(inner, dialogue, { voice: { voice, book, producer: { kind: "harness", id: "external-harness" } } });
    const greeted = await say(worker, "hi");
    expect(greeted.reply).toBe("Hello there.");
    expect(greeted.reply).not.toContain("cite:");
    expect(inner.prompts).toEqual([]);
    const once = await say(worker, "what time is it");
    const twice = await say(worker, "what time is it now");
    const other = await say(worker, "where is the vessel");
    spoken(once.reply, "harness:external-harness", book, first);
    spoken(twice.reply, "harness:external-harness", book, again);
    expect(readTemplate(voiceTemplate, once.reply)["citation"]).toBe(readTemplate(voiceTemplate, twice.reply)["citation"]);
    spoken(other.reply, "harness:external-harness", book, second);
    expect(readTemplate(voiceTemplate, other.reply)["citation"]).not.toBe(readTemplate(voiceTemplate, once.reply)["citation"]);
    spoken((await say(worker, "yes")).reply, "harness:external-harness", book, hole);
    expect(book.read("absent")).toBeUndefined();
    const sent = JSON.stringify(inner.prompts);
    for (const fixture of [PERSONALITY, ...SKILLS, ...MEMORY, "Hello there.", "Earlier in this conversation"]) expect(sent).not.toContain(fixture);
    for (const token of ["RAW-TOKEN-4p", "FOREIGN-PERSONALITY-1x"]) expect(sent).not.toContain(token);
    expect(sent).toContain("what time is it");
    expect(sent).toContain("where is the vessel");
    expect(voice.skills).toEqual(SKILLS);
    expect(voice.memory).toEqual(MEMORY);
    expect(JSON.stringify(voice)).not.toContain("FOREIGN-SKILL-2y");
    expect(once.events.some((event) => event.type === "update" && event.update.sessionUpdate === "tool_call")).toBe(true);
    await dialogue.idle();
    expect(JSON.stringify(dialogue.save())).not.toContain("RAW-TOKEN-4p");
    worker.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: "r1", outcome: { outcome: "cancelled" } } as never);
    expect(inner.permissions).toEqual(["r1"]);
  });

  it("VW1.3 a model that is not the harness's own is cited in full and is not given the harness voice", async () => {
    const sentence = rawBody("json-body");
    const prose = rawBody("prose-body");
    const tooled = rawBody("tool-body");
    const book = citationBook();
    const voice = voiceOf();
    const inner = answering(JSON.stringify({ reply: sentence }));
    const model = sessionModel(inner, undefined, bound(book, `${inner.modelId}/harness`));
    const result = await generateText({ model, prompt: "Where is the vessel q-7?", maxRetries: 0 });
    spoken(result.text, `model:${inner.modelId}`, book, sentence);
    const plain = answering(prose);
    const plainModel = sessionModel(plain, undefined, bound(book, `${plain.modelId}/harness`));
    const proseResult = await generateText({ model: plainModel, prompt: "Where is the vessel q-8?", maxRetries: 0 });
    spoken(proseResult.text, `model:${plain.modelId}`, book, prose);
    const withTools = answering(tooled);
    const toolModel = sessionModel(withTools, undefined, bound(book, `${withTools.modelId}/harness`));
    const toolResult = await generateText({
      model: toolModel,
      prompt: "Where is the vessel q-9?",
      tools: { lookup: tool({ inputSchema: z.object({ id: z.string() }) }) },
      maxRetries: 0,
    });
    spoken(toolResult.text, `model:${withTools.modelId}`, book, tooled);
    const sent = JSON.stringify([...inner.calls, ...plain.calls, ...withTools.calls]);
    for (const fixture of [PERSONALITY, ...SKILLS, ...MEMORY]) expect(sent).not.toContain(fixture);
    expect(sent).toContain("Where is the vessel q-7?");
    expect(voice).toEqual(voiceOf());
    const dialogue = new Dialogue({ settings });
    const learned = answering(JSON.stringify({ reply: sentence }));
    const learning = sessionModel(learned, dialogue, bound(book, `${learned.modelId}/harness`));
    await generateText({ model: learning, prompt: "Where is the vessel q-10?", ...inSession("s1"), maxRetries: 0 });
    await dialogue.idle();
    expect(JSON.stringify(dialogue.save())).not.toContain("RAW-TOKEN-4p");
  });

  it("VW1.4 a streamed foreign model is cited in full, including text past the first delta", async () => {
    const sentence = rawBody("stream-json");
    const prose = rawBody("stream-prose");
    const book = citationBook();
    const json = answering([`{"reply":"`, sentence, `"}`]);
    const jsonModel = sessionModel(json, undefined, bound(book, `${json.modelId}/harness`));
    const jsonText = await streamText({ model: jsonModel, prompt: "Where is the vessel q-11?", maxRetries: 0 }).text;
    spoken(jsonText, `model:${json.modelId}`, book, sentence);
    expect(jsonText.match(/personality/g)).toHaveLength(1);
    const plain = answering(["OPEN-4k frontier ", prose.slice("OPEN-4k frontier ".length)]);
    const plainModel = sessionModel(plain, undefined, bound(book, `${plain.modelId}/harness`));
    const proseText = await streamText({ model: plainModel, prompt: "Where is the vessel q-12?", maxRetries: 0 }).text;
    spoken(proseText, `model:${plain.modelId}`, book, prose);
    expect(proseText.match(/personality/g)).toHaveLength(1);
    const sent = JSON.stringify([...json.calls, ...plain.calls]);
    for (const fixture of [PERSONALITY, ...SKILLS, ...MEMORY]) expect(sent).not.toContain(fixture);
  });

  it("VW1.5 the harness's own model and a template with no external producer carry no foreign citation", async () => {
    const book = citationBook();
    const voice = voiceOf();
    const own = answering('{"reply":"The Atlantic Ocean."}');
    const ownModel = sessionModel(own, undefined, bound(book, own.modelId));
    const ownText = await generateText({ model: ownModel, prompt: "Which ocean is west of Portugal?", maxRetries: 0 });
    expect(ownText.text).toBe("The Atlantic Ocean.");
    expect(ownText.text).not.toContain("cite:");
    const ownProse = answering("The Atlantic Ocean.");
    const ownProseModel = sessionModel(ownProse, undefined, bound(book, ownProse.modelId));
    expect((await generateText({ model: ownProseModel, prompt: "Which ocean is west of Portugal?", maxRetries: 0 })).text).toBe("The Atlantic Ocean.");
    const ownStream = answering(['{"reply":"', "The Atlantic Ocean.", '"}']);
    const ownStreamModel = sessionModel(ownStream, undefined, bound(book, ownStream.modelId));
    expect(await streamText({ model: ownStreamModel, prompt: "Which ocean is west of Portugal?", maxRetries: 0 }).text).toBe("The Atlantic Ocean.");
    const dialogue = new Dialogue({ settings, book: greeting });
    const foreign = answering('{"reply":"should-not-be-called RAW-TOKEN-4p"}');
    const scriptedModel = sessionModel(foreign, dialogue, bound(book, `${foreign.modelId}/harness`));
    const scriptedText = await generateText({ model: scriptedModel, prompt: "hi", ...inSession("s1"), maxRetries: 0 });
    expect(scriptedText.text).toBe("Hello there.");
    expect(scriptedText.text).not.toContain("cite:");
    expect(foreign.calls).toEqual([]);
    const inner = scripted(() => rawBody("unused"));
    const worker = new DialogueWorker(inner, new Dialogue({ settings, book: greeting }), { voice: { voice, book, producer: { kind: "harness", id: "external-harness" } } });
    const greeted = await say(worker, "hi");
    expect(greeted.reply).toBe("Hello there.");
    expect(greeted.reply).not.toContain("cite:");
    expect(inner.prompts).toEqual([]);
    const sent = JSON.stringify([...own.calls, ...ownProse.calls, ...ownStream.calls]);
    for (const fixture of [PERSONALITY, ...SKILLS, ...MEMORY]) expect(sent).not.toContain(fixture);
    expect(book.read("absent")).toBeUndefined();
  });

  it("VW1.6 following a citation returns the raw body and does not ask the producer again", async () => {
    const raw = rawBody("follow-worker");
    const book = citationBook();
    const inner = scripted(() => raw);
    const worker = new DialogueWorker(inner, new Dialogue({ settings }), { voice: { voice: voiceOf(), book, producer: { kind: "harness", id: "external-harness" } } });
    const spokenTurn = await say(worker, "what time is it");
    const citation = readTemplate(voiceTemplate, spokenTurn.reply)["citation"] ?? "";
    expect(inner.prompts).toHaveLength(1);
    expect((await say(worker, citation)).reply).toBe(raw);
    expect(inner.prompts).toHaveLength(1);
    const missed = await say(worker, "cite:absent");
    expect(missed.reply).not.toBe(raw);
    expect(inner.prompts).toHaveLength(2);

    const sentence = rawBody("follow-model");
    const modelBook = citationBook();
    const modelInner = answering(JSON.stringify({ reply: sentence }));
    const model = sessionModel(modelInner, undefined, bound(modelBook, `${modelInner.modelId}/harness`));
    const first = await generateText({ model, prompt: "Where is the vessel q-13?", maxRetries: 0 });
    const modelCitation = readTemplate(voiceTemplate, first.text)["citation"] ?? "";
    expect(modelInner.calls).toHaveLength(1);
    expect((await generateText({ model, prompt: modelCitation, maxRetries: 0 })).text).toBe(sentence);
    expect(modelInner.calls).toHaveLength(1);
    const streamedBody = rawBody("follow-stream");
    const streamBook = citationBook();
    const streamInner = answering(JSON.stringify({ reply: streamedBody }));
    const streamModel = sessionModel(streamInner, undefined, bound(streamBook, `${streamInner.modelId}/harness`));
    const streamed = await streamText({ model: streamModel, prompt: "Where is the vessel q-14?", maxRetries: 0 }).text;
    const streamCitation = readTemplate(voiceTemplate, streamed)["citation"] ?? "";
    expect(streamInner.calls).toHaveLength(1);
    expect(await streamText({ model: streamModel, prompt: streamCitation, maxRetries: 0 }).text).toBe(streamedBody);
    expect(streamInner.calls).toHaveLength(1);
  });

  it("VW1.7 a recalled memory line is in the harness wording and is not sent outward", async () => {
    const line = "MEMORY-LINE-4r";
    const raw = rawBody("memory-worker");
    const memory: string[] = [];
    const queries: string[] = [];
    const inner = scripted(() => raw);
    const worker = new DialogueWorker(inner, new Dialogue({ settings }), {
      voice: {
        voice: { personality: PERSONALITY, skills: [...SKILLS], memory },
        book: citationBook(),
        producer: { kind: "harness", id: "external-harness" },
        memoryStore: {
          async recall(query: string) {
            queries.push(query);
            return [{ text: line }];
          },
        },
      },
    });
    const turn = await say(worker, "what time is it");
    expect(readTemplate(voiceTemplate, turn.reply)["memory"]).toBe(line);
    expect(readTemplate(voiceTemplate, turn.reply)["personality"]).toBe(PERSONALITY);
    leaks(turn.reply);
    expect(JSON.stringify(inner.prompts)).not.toContain(line);
    expect(queries[0]).toContain("what time is it");
    expect(memory).toEqual([]);

    const modelMemory: string[] = [];
    const modelQueries: string[] = [];
    const sentence = rawBody("memory-model");
    const modelInner = answering(JSON.stringify({ reply: sentence }));
    const model = sessionModel(modelInner, undefined, {
      voice: { personality: PERSONALITY, skills: [...SKILLS], memory: modelMemory },
      book: citationBook(),
      ownModelId: `${modelInner.modelId}/harness`,
      memoryStore: {
        async recall(query: string) {
          modelQueries.push(query);
          return [{ text: line }];
        },
      },
    });
    const result = await generateText({ model, prompt: "Where is the vessel q-15?", ...inSession("s9"), maxRetries: 0 });
    expect(readTemplate(voiceTemplate, result.text)["memory"]).toBe(line);
    leaks(result.text);
    expect(JSON.stringify(modelInner.calls)).not.toContain(line);
    expect(modelQueries[0]).toContain("Where is the vessel q-15?");
    expect(modelMemory).toEqual([]);
  });

  it("VW1.8 recalled lines stay on the turn that recalled them", async () => {
    const memory: string[] = [];
    const voice = { personality: PERSONALITY, skills: [...SKILLS], memory };
    let first = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const readyGate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const prompts: PromptCommand["prompt"][] = [];
    const inner: Worker = {
      async run(command, emit) {
        prompts.push(command.prompt);
        const base = { sessionId: command.sessionId, turnId: command.turnId };
        if (first) {
          first = false;
          ready();
          await gate;
        }
        emit({ type: "update", ...base, update: textChunk(rawBody(command.sessionId)) });
        emit({ type: "end", ...base, stopReason: "end_turn" });
      },
      cancel() {},
      permission() {},
    };
    const worker = new DialogueWorker(inner, new Dialogue({ settings }), {
      voice: {
        voice,
        book: citationBook(),
        producer: { kind: "harness", id: "external-harness" },
        memoryStore: {
          async recall(query: string) {
            return [{ text: query.includes("slow") ? "SLOW-LINE-8s" : "FAST-LINE-2f" }];
          },
        },
      },
    });
    const slowTurn = say(worker, "slow please", "s-slow");
    await readyGate;
    const fast = await say(worker, "fast please", "s-fast");
    release();
    const slow = await slowTurn;
    expect(readTemplate(voiceTemplate, slow.reply)["memory"]).toBe("SLOW-LINE-8s");
    expect(readTemplate(voiceTemplate, fast.reply)["memory"]).toBe("FAST-LINE-2f");
    expect(JSON.stringify(prompts)).not.toContain("SLOW-LINE-8s");
    expect(JSON.stringify(prompts)).not.toContain("FAST-LINE-2f");
    expect(memory).toEqual([]);

    const kept = ["STATIC-MEM-1c"];
    let calls = 0;
    const failing = new DialogueWorker(scripted(() => rawBody("recall-down")), new Dialogue({ settings }), {
      voice: {
        voice: { personality: PERSONALITY, skills: [...SKILLS], memory: kept },
        book: citationBook(),
        producer: { kind: "harness", id: "external-harness" },
        memoryStore: {
          async recall() {
            calls += 1;
            if (calls > 1) throw new Error("down");
            return [{ text: "MEMORY-LINE-4r" }];
          },
        },
      },
    });
    const remembered = await say(failing, "first question");
    const missed = await say(failing, "second question");
    expect(readTemplate(voiceTemplate, remembered.reply)["memory"]).toBe("MEMORY-LINE-4r");
    expect(readTemplate(voiceTemplate, missed.reply)["memory"]).toBe("STATIC-MEM-1c");
    expect(kept).toEqual(["STATIC-MEM-1c"]);
  });

  it("VW1.9 a session agent's instructions and memories are not sent to a model that is not the harness's own", async () => {
    const line = "MEMORY-LINE-4r";
    const instructions = `${PERSONALITY}\n\nAgent skills:\n- ${SKILLS[0]}: left\n- ${SKILLS[1]}: right`;
    const recalled = { async recall() { return [{ text: line }]; }, async remember() { return []; } };
    const speaker = answering("own words", "speaker");
    const speakerVoice = { personality: PERSONALITY, skills: [...SKILLS], memory: [] as string[] };
    const speakerModel = sessionModel(speaker, undefined, { voice: speakerVoice, book: citationBook(), ownModelId: speaker.modelId, memoryStore: recalled });
    const own = new AgentWorker({ agent: sessionAgent({ model: speakerModel, instructions, memory: recalled }) });
    const ownTurn = await say(own, "hello from the harness");
    expect(ownTurn.reply).toBe("own words");
    expect(JSON.stringify(speaker.calls)).toContain(PERSONALITY);
    expect(JSON.stringify(speaker.calls)).toContain(line);

    const gateway = answering(JSON.stringify({ reply: rawBody("gateway-turn") }), "gateway");
    const gatewayMemory: string[] = [];
    const gatewayModel = sessionModel(gateway, undefined, {
      voice: { personality: PERSONALITY, skills: [...SKILLS], memory: gatewayMemory },
      book: citationBook(),
      ownModelId: speaker.modelId,
      memoryStore: recalled,
    });
    const foreign = new AgentWorker({ agent: sessionAgent({ model: gatewayModel, instructions, memory: recalled }) });
    const foreignTurn = await say(foreign, "where is the key?");
    expect(readTemplate(voiceTemplate, foreignTurn.reply)["memory"]).toBe(line);
    expect(readTemplate(voiceTemplate, foreignTurn.reply)["personality"]).toBe(PERSONALITY);
    leaks(foreignTurn.reply);
    const sent = JSON.stringify(gateway.calls);
    expect(sent).not.toContain(PERSONALITY);
    expect(sent).not.toContain(SKILLS[0]!);
    expect(sent).not.toContain(line);
    expect(sent).toContain("where is the key?");
    expect(gateway.calls[0]!.prompt.some((message) => message.role === "system")).toBe(false);
    expect(gatewayMemory).toEqual([]);

    const seen = answering(JSON.stringify({ reply: rawBody("vision-turn") }), "vision");
    const visionModel = sessionModel(seen, undefined, {
      voice: { personality: PERSONALITY, skills: [...SKILLS], memory: [] },
      book: citationBook(),
      ownModelId: speaker.modelId,
      memoryStore: recalled,
    });
    const vision = new AgentWorker({ agent: sessionAgent({ model: speakerModel, vision: visionModel, instructions, memory: recalled }) });
    const events: WorkerEvent[] = [];
    await vision.run({ type: "prompt", sessionId: "s-vis", turnId: "t-vis", cwd: "/repo", prompt: [{ type: "text", text: "what is this?" }, { type: "image", data: "AQID", mimeType: "image/png" }] }, (event) => events.push(event));
    const visionReply = events.flatMap((event) => (event.type === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text" ? [event.update.content.text] : [])).join("");
    expect(readTemplate(voiceTemplate, visionReply)["memory"]).toBe(line);
    leaks(visionReply);
    expect(speaker.calls).toHaveLength(1);
    const viewed = JSON.stringify(seen.calls);
    expect(viewed).not.toContain(PERSONALITY);
    expect(viewed).not.toContain(SKILLS[0]!);
    expect(viewed).not.toContain(line);
    expect(viewed).toContain("what is this?");
    expect(seen.calls[0]!.prompt.some((message) => message.role === "system")).toBe(false);
  });

  it("VW1.10 an external harness with no dialogue is shown as harness wording and cited in full", async () => {
    const raw = rawBody("no-dialogue");
    const book = citationBook();
    const inner = scripted(() => raw);
    const worker = voiceWorker(inner, { voice: voiceOf(), book, producer: { kind: "harness", id: "external-harness" } });
    const spokenTurn = await say(worker, "what time is it");
    spoken(spokenTurn.reply, "harness:external-harness", book, raw);
    expect(spokenTurn.messages).toHaveLength(1);
    expect(JSON.stringify(inner.prompts)).not.toContain(PERSONALITY);
    expect(JSON.stringify(inner.prompts)).not.toContain("MEMORY-9q");
    const citation = readTemplate(voiceTemplate, spokenTurn.reply)["citation"] ?? "";
    expect((await say(worker, citation)).reply).toBe(raw);
    expect(inner.prompts).toHaveLength(1);
  });

  it("VW1.11 a later call to a non-own model does not contain the previous harness wording", async () => {
    const personality = "Use the skills and the memory and the source carefully.";
    const skill = "search memory and the source docs";
    const line = "the source of the leak is the valve";
    const instructions = `${personality}\n\nAgent skills:\n- ${skill}: left`;
    const recalled = { async recall() { return [{ text: line }]; }, async remember() { return []; } };
    const calls: LanguageModelV4CallOptions[] = [];
    let n = 0;
    const parts = (delta: string, toolCall = false): LanguageModelV4StreamPart[] => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta },
      { type: "text-end", id: "0" },
      ...(toolCall ? [{ type: "tool-call" as const, toolCallId: "c1", toolName: "ping", input: "{}" }] : []),
      { type: "finish", finishReason: { unified: toolCall ? "tool-calls" : "stop", raw: undefined }, usage: usage() },
    ];
    const inner = new MockLanguageModelV4({
      modelId: "gateway",
      doStream: async (call) => {
        calls.push(call);
        n += 1;
        const delta = rawBody(n === 1 ? "later-first" : "later-next");
        return { stream: convertArrayToReadableStream(parts(delta, n === 1)) };
      },
    });
    const book = citationBook();
    const model = sessionModel(inner, undefined, {
      voice: { personality, skills: [skill], memory: [] },
      book,
      ownModelId: "speaker",
      memoryStore: recalled,
    });
    const worker = new AgentWorker({
      agent: sessionAgent({
        model,
        instructions,
        memory: recalled,
        tools: { ping: tool({ inputSchema: z.object({}), execute: async () => "pong" }) },
      }),
    });
    const first = await say(worker, "where is the key?");
    const wordings = visibleWordings(first.reply);
    const raws = [rawBody("later-first"), rawBody("later-next")];
    expect(calls).toHaveLength(raws.length);
    expect(wordings).toHaveLength(raws.length);
    const readable = first.reply.replaceAll("\u200b", "");
    expect(readable).toContain(personality);
    expect(readable).toContain(skill);
    expect(readable).toContain(line);
    const tokens = first.reply.split(/\s+/).filter((token) => token.startsWith("cite:"));
    expect(tokens).toEqual(wordings.map((holes) => holes["citation"]));
    wordings.forEach((holes, i) => {
      expect(holes["personality"]).toBe(personality);
      expect(holes["skills"]).toBe(skill);
      expect(holes["memory"]).toBe(line);
      const citation = holes["citation"] ?? "";
      expect(citation).toMatch(/^cite:\S+$/);
      const id = citation.slice("cite:".length);
      expect(book.read(id)).toBe(raws[i]);
      expect(citedBody(citation, book)).toBe(raws[i]);
    });
    const followed = JSON.stringify(calls.slice(1));
    expect(followed).not.toContain("carefully");
    expect(followed).not.toContain("source docs");
    expect(followed).not.toContain("valve");
    expect(followed).toContain("where is the key?");
    expect(followed).toContain(tokens[0]);

    const again = answering(JSON.stringify({ reply: rawBody("second-turn") }), "gateway-2");
    const continued = new AgentWorker({
      agent: sessionAgent({
        model: sessionModel(again, undefined, {
          voice: { personality, skills: [skill], memory: [] },
          book: citationBook(),
          ownModelId: "speaker",
          memoryStore: recalled,
        }),
        instructions,
        memory: recalled,
      }),
    });
    await say(continued, "where is the key?");
    const second = await say(continued, "and the spare?");
    expect(visibleWordings(second.reply)[0]?.["personality"]).toBe(personality);
    expect(visibleWordings(second.reply)[0]?.["memory"]).toBe(line);
    const resent = JSON.stringify(again.calls[1]!.prompt);
    expect(resent).not.toContain("carefully");
    expect(resent).not.toContain("source docs");
    expect(resent).not.toContain("valve");
    expect(resent).toContain("and the spare?");
    expect(resent).toContain("where is the key?");
  });

  it("VW1.12 a dialogue in front of an external harness rewrites a turn that is not pure text, and one it cannot decide", async () => {
    const raw = rawBody("with-image");
    const book = citationBook();
    const inner = scripted(() => raw);
    const worker = new DialogueWorker(inner, new Dialogue({ settings }), { voice: { voice: voiceOf(), book, producer: { kind: "harness", id: "external-harness" } } });
    const events: WorkerEvent[] = [];
    await worker.run(
      { type: "prompt", sessionId: "s-img", turnId: "t-img", cwd: "/repo", prompt: [{ type: "text", text: "what is this?" }, { type: "image", data: "AQID", mimeType: "image/png" }] },
      (event) => events.push(event),
    );
    const reply = events.flatMap((event) => (event.type === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text" ? [event.update.content.text] : [])).join("");
    spoken(reply, "harness:external-harness", book, raw);
    expect(JSON.stringify(inner.prompts)).not.toContain(PERSONALITY);
    expect(JSON.stringify(inner.prompts)).toContain("what is this?");

    const failing = new Dialogue({ settings });
    failing.respond = () => Promise.reject(new Error("down"));
    const dropped = rawBody("dialogue-down");
    const droppedBook = citationBook();
    const droppedInner = scripted(() => dropped);
    const broken = new DialogueWorker(droppedInner, failing, { voice: { voice: voiceOf(), book: droppedBook, producer: { kind: "harness", id: "external-harness" } } });
    const turn = await say(broken, "what time is it");
    spoken(turn.reply, "harness:external-harness", droppedBook, dropped);
    expect(JSON.stringify(droppedInner.prompts)).not.toContain(PERSONALITY);
  });

  it("VW1.13 a speaking model's plain answer stays on a later call to another model", async () => {
    const personality = "Use the skills and the memory and the source carefully.";
    const skill = "search memory and the source docs";
    const line = "the source of the leak is the valve";
    const plain = "personality is not a template\n";
    const instructions = `${personality}\n\nAgent skills:\n- ${skill}: left`;
    const recalled = { async recall() { return [{ text: line }]; }, async remember() { return []; } };
    const speaker = answering(plain, "speaker");
    const speakerModel = sessionModel(speaker, undefined, {
      voice: { personality, skills: [skill], memory: [] },
      book: citationBook(),
      ownModelId: speaker.modelId,
      memoryStore: recalled,
    });
    const seen = answering(JSON.stringify({ reply: rawBody("after-own") }), "vision");
    const visionModel = sessionModel(seen, undefined, {
      voice: { personality, skills: [skill], memory: [] },
      book: citationBook(),
      ownModelId: speaker.modelId,
      memoryStore: recalled,
    });
    const worker = new AgentWorker({ agent: sessionAgent({ model: speakerModel, vision: visionModel, instructions, memory: recalled }) });
    const ownTurn = await say(worker, "hello from the harness", "s-plain");
    expect(ownTurn.reply).toBe(plain);
    const events: WorkerEvent[] = [];
    await worker.run(
      { type: "prompt", sessionId: "s-plain", turnId: "t-img", cwd: "/repo", prompt: [{ type: "text", text: "what is this?" }, { type: "image", data: "AQID", mimeType: "image/png" }] },
      (event) => events.push(event),
    );
    expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "end_turn" });
    const visionReply = events.flatMap((event) => (event.type === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text" ? [event.update.content.text] : [])).join("");
    const visionHoles = visibleWordings(visionReply);
    expect(visionHoles[0]?.["personality"]).toBe(personality);
    expect(visionHoles[0]?.["skills"]).toBe(skill);
    expect(visionHoles[0]?.["memory"]).toBe(line);
    leaks(visionReply);
    expect(speaker.calls).toHaveLength(1);
    const viewed = JSON.stringify(seen.calls);
    expect(viewed).toContain(plain.trim());
    expect(viewed).toContain("what is this?");
    expect(viewed).not.toContain("carefully");
    expect(viewed).not.toContain("source docs");
    expect(viewed).not.toContain("valve");
    expect(seen.calls[0]!.prompt.some((message) => message.role === "system")).toBe(false);
  });
});
