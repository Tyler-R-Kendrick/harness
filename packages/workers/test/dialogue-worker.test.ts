import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import type { WorkerEvent } from "@harness/core";
import { Dialogue, parseSettings } from "@harness/dialogue";
import type { Step } from "@harness/dialogue";
import { DialogueWorker, EchoWorker, textChunk } from "@harness/workers";
import type { Emit, PromptCommand, Worker } from "@harness/workers";

const file = JSON.parse(readFileSync(new URL("../../dialogue/data/settings.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown>>;
const settings = parseSettings({ ...file, promote: { ...file["promote"], fits: 1, sessions: 1 } });
const book = { scripts: [{ id: "hi", intent: "Greet", patterns: ["hi"], reply: ["Hello there."] }, { id: "yes", intent: "Confirm", patterns: ["yes"], reply: ["Done: ", { generate: "what" }, "."] }] };

let turn = 0;
async function say(worker: Worker, text: string | unknown[], sessionId = "s1", cwd = "/repo") {
  const events: WorkerEvent[] = [];
  const prompt = typeof text === "string" ? [{ type: "text", text }] : text;
  await worker.run({ type: "prompt", sessionId, turnId: `t${++turn}`, prompt, cwd }, (e) => events.push(e));
  const reply = events.flatMap((e) => (e.type === "update" && e.update.sessionUpdate === "agent_message_chunk" && e.update.content.type === "text" ? [e.update.content.text] : [])).join("");
  return { events, reply, end: events.at(-1) };
}

/** A worker that answers with `answer(text)`, calling a tool when told to, recording its prompts. */
function scripted(answer: (text: string) => string, stopReason: "end_turn" | "refusal" = "end_turn"): Worker & { prompts: PromptCommand["prompt"][] } {
  const prompts: PromptCommand["prompt"][] = [];
  return {
    prompts,
    async run(command: PromptCommand, emit: Emit) {
      prompts.push(command.prompt);
      const text = (command.prompt.filter((b) => (b as { type: string }).type === "text").at(-1) as { text: string }).text;
      if (text.startsWith("tool")) emit({ type: "update", sessionId: command.sessionId, turnId: command.turnId, update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "run", status: "completed" } });
      else emit({ type: "update", sessionId: command.sessionId, turnId: command.turnId, update: textChunk(answer(text)) });
      emit({ type: "end", sessionId: command.sessionId, turnId: command.turnId, stopReason });
    },
    cancel() {},
    permission() {},
  };
}

describe("DialogueWorker: the dialogue in front of any worker", () => {
  it("DK1.1 a scripted turn is answered without the worker, named in the update's metadata; others go to the worker", async () => {
    const inner = scripted((t) => `worker: ${t}`);
    const worker = new DialogueWorker(inner, new Dialogue({ settings, book }));
    const scriptedTurn = await say(worker, "hi");
    expect(scriptedTurn.reply).toBe("Hello there.");
    expect(scriptedTurn.events[0]).toMatchObject({ type: "update", update: { _meta: { harness: { dialogue: { script: "hi", kind: "reply", match: { by: "pattern" } } } } } });
    expect(scriptedTurn.end).toMatchObject({ type: "end", stopReason: "end_turn" });
    expect((await say(worker, "what time is it")).reply).toBe("worker: what time is it");
    expect(inner.prompts).toHaveLength(1);
  });

  it("DK1.2 the worker's replies teach the dialogue: a reply it gives alike in two sessions becomes a script, which answers once it fits", async () => {
    const inner = scripted((t) => `Checking order ${/\d+/.exec(t)?.[0]}.`);
    const dialogue = new Dialogue({ settings, book });
    const worker = new DialogueWorker(inner, dialogue);
    await say(worker, "where is my order number 1", "a");
    await say(worker, "where is my order number 2", "b");
    await dialogue.idle();
    expect(dialogue.script("s1")).toMatchObject({ status: "candidate", scope: "/repo" });
    await say(worker, "where is my order number 3", "c");
    await dialogue.idle();
    expect(dialogue.script("s1")!.status).toBe("active");
    const learned = await say(worker, "where is my order number 4", "d");
    expect(learned.reply).toBe("Checking order 4.");
    expect(inner.prompts).toHaveLength(3);
    // In another project the script does not answer.
    expect((await say(worker, "where is my order number 5", "e", "/other")).reply).toBe("Checking order 5.");
    expect(inner.prompts).toHaveLength(4);
  });

  it("DK1.3 a worker that acted (called tools) or did not finish teaches nothing but that; a turn that is not a step ends the session's form", async () => {
    const dialogue = new Dialogue({ settings, book: { scripts: [{ id: "table", intent: "t", patterns: ["book a table"], slots: { time: { prompts: ["When?"] } }, reply: ["Booked for ", { slot: "time" }, "."] }] } });
    const worker = new DialogueWorker(scripted((t) => t), dialogue);
    await say(worker, "tool please", "a");
    await dialogue.idle();
    expect(dialogue.save()).toMatchObject({ clusters: [{ acted: true }] });
    const refusing = new Dialogue({ settings });
    await say(new DialogueWorker(scripted((t) => t, "refusal"), refusing), "something", "a");
    await refusing.idle();
    expect(refusing.save()).toMatchObject({ clusters: [] });
    expect((await say(worker, "book a table", "b")).reply).toBe("When?");
    await say(worker, [{ type: "text", text: "see this" }, { type: "image", data: "AQID", mimeType: "image/png" }], "b");
    expect((await say(worker, "7pm", "b")).reply).toBe("7pm");
  });

  it("DK1.4 a script's generated holes are the worker's to write, told the template; the echo worker's reply goes through", async () => {
    const inner = scripted(() => "Done: all set.");
    const worker = new DialogueWorker(inner, new Dialogue({ settings, book }));
    expect((await say(worker, "yes")).reply).toBe("Done: all set.");
    expect(inner.prompts[0]).toEqual([{ type: "text", text: `${settings.generate.instruction}\n\nDone: {what}.` }, { type: "text", text: "yes" }]);
    expect((await say(new DialogueWorker(new EchoWorker(), new Dialogue({ settings, book })), "hello world")).reply).toBe("echo: hello world");
  });

  it("DK1.5 a dialogue that fails leaves the turn to the worker; cancels, permissions and events go to the worker", async () => {
    class Failing extends Dialogue {
      override async respond(_step: Step): Promise<never> {
        throw new Error("broken");
      }
    }
    const calls: string[] = [];
    const inner: Worker = { ...scripted((t) => `w ${t}`), cancel: (s, t) => void calls.push(`cancel ${s} ${t}`), permission: (c) => void calls.push(`permission ${c.requestId}`), event: (c) => void calls.push(`event ${c.name}`) };
    const worker = new DialogueWorker(inner, new Failing({ settings, book }));
    expect((await say(worker, "hi")).reply).toBe("w hi");
    worker.cancel("s1", "t1");
    worker.permission({ type: "permission", sessionId: "s1", turnId: "t1", requestId: "r1", outcome: { outcome: "cancelled" } } as never);
    worker.event({ type: "event", sessionId: "s1", name: "praised" }, () => {});
    expect(calls).toEqual(["cancel s1 t1", "permission r1", "event praised"]);
    new DialogueWorker(scripted((t) => t), new Dialogue({ settings })).event({ type: "event", sessionId: "s1", name: "x" }, () => {});
  });

  it("DK1.6 a turn cancelled while the dialogue decides ends as cancelled, and the worker never runs it", async () => {
    let release!: () => void;
    class Slow extends Dialogue {
      override async respond(step: Step) {
        await new Promise<void>((r) => (release = r));
        return super.respond(step);
      }
    }
    const inner = scripted((t) => t);
    const worker = new DialogueWorker(inner, new Slow({ settings, book }));
    const events: WorkerEvent[] = [];
    const running = worker.run({ type: "prompt", sessionId: "s1", turnId: "t-cancel", prompt: [{ type: "text", text: "what now" }], cwd: "/repo" }, (e) => events.push(e));
    await Promise.resolve();
    worker.cancel("s1", "t-cancel");
    release();
    await running;
    expect(events).toEqual([{ type: "end", sessionId: "s1", turnId: "t-cancel", stopReason: "cancelled" }]);
    expect(inner.prompts).toHaveLength(0);
  });

  it("DK1.7 a worker keeping its own history is told the exchanges scripts answered since its last turn, once", async () => {
    const inner = scripted((t) => `w ${t}`);
    const dialogue = new Dialogue({ settings, book: { scripts: [...book.scripts, { id: "table", intent: "t", patterns: ["book a table"], slots: { time: { pattern: "\\d+(?:am|pm)", prompts: ["When?"] } }, reply: ["Booked for ", { slot: "time" }, "."] }] } });
    const worker = new DialogueWorker(inner, dialogue);
    await say(worker, "hi", "h");
    await say(worker, "book a table", "h");
    await say(worker, "whenever works", "h");
    expect(inner.prompts[0]).toEqual([
      { type: "text", text: `${settings.handoff.heading}\n\nUser: hi\nAssistant: Hello there.\n\nUser: book a table\nAssistant: When?` },
      { type: "text", text: "whenever works" },
    ]);
    await say(worker, "and then", "h");
    expect(inner.prompts[1]).toEqual([{ type: "text", text: "and then" }]);
    const plain = scripted((t) => t);
    const told = new DialogueWorker(plain, new Dialogue({ settings, book }), { handoff: false });
    await say(told, "hi", "p");
    await say(told, "something else", "p");
    expect(plain.prompts[0]).toEqual([{ type: "text", text: "something else" }]);
  });

  it("DK1.8 a relative working directory is no scope; one with a trailing separator is the same scope", async () => {
    const inner = scripted((t) => `Checking order ${/\d+/.exec(t)?.[0]}.`);
    const dialogue = new Dialogue({ settings, book });
    const worker = new DialogueWorker(inner, dialogue);
    await say(worker, "where is my order number 1", "a", "/repo/");
    await say(worker, "where is my order number 2", "b", "/repo");
    await dialogue.idle();
    expect(dialogue.script("s1")).toMatchObject({ scope: "/repo" });
    await say(worker, "where is my order number 3", "c", ".");
    await dialogue.idle();
    expect((dialogue.save() as { clusters: { scope?: string }[] }).clusters.map((c) => c.scope)).toContainEqual(undefined);
  });

  it("DK1.9 what a flow says before handing the turn on is said first, then the worker's reply; a worker keeping history is told, after the user's words, that it was said", async () => {
    const flows = {
      run: async (_name: string, _input: unknown, _run: string, tools: ToolSet) => {
        await tools["say"]!.execute!({ text: "One moment." }, { toolCallId: "1", messages: [], context: undefined });
        await tools["pass"]!.execute!({}, { toolCallId: "2", messages: [], context: undefined });
        return { status: "completed" as const };
      },
    };
    const inner = scripted(() => "It is noon.");
    const dialogue = new Dialogue({ settings, book: { ...book, entry: "front-desk" }, flows });
    const worker = new DialogueWorker(inner, dialogue);
    const answered = await say(worker, "what time is it");
    expect(answered.reply).toBe("One moment.\nIt is noon.");
    // The worker is told after the user's words what was already said in reply.
    expect(inner.prompts).toEqual([[{ type: "text", text: "what time is it" }, { type: "text", text: `${settings.handoff.said}\n\nOne moment.` }]]);
    // A worker keeping no history is not told.
    const plain = scripted(() => "It is noon.");
    await say(new DialogueWorker(plain, new Dialogue({ settings, book: { ...book, entry: "front-desk" }, flows }), { handoff: false }), "what time is it", "s2");
    expect(plain.prompts).toEqual([[{ type: "text", text: "what time is it" }]]);
    await dialogue.idle();
    // What the worker said is what it is learned from; what the flow said is not.
    expect(dialogue.save()).toMatchObject({ clusters: [{ observations: [{ reply: "It is noon." }] }] });
  });
});
