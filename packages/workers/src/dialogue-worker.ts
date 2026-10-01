import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { projectScope } from "@harness/cognitive";
import type { Decision, Dialogue, Outcome, Step } from "@harness/dialogue";
import type { Emit, EventCommand, PermissionCommand, PromptCommand, Worker } from "./worker.ts";
import { promptText, textChunk } from "./worker.ts";
import { citedBody, recalledLines, voiceAnswer } from "./voice.ts";
import type { ForeignVoice } from "./voice.ts";

type Answer = Exclude<Decision, { kind: "pass" } | { kind: "generate" }>;

/** What a scripted answer says about itself, as the update's `_meta.harness.dialogue`. */
const metaOf = (decision: Answer) => ({
  harness: {
    dialogue: {
      ...(decision.kind === "flow" ? { flow: decision.flow } : {}),
      ...(decision.script === undefined ? {} : { script: decision.script }),
      kind: decision.kind,
      match: { ...decision.match },
    },
  },
});

/** The step a prompt is: its text, when every block is text and there is some; its session, and its working directory as the scope. */
function stepOf(command: PromptCommand): Step | undefined {
  const textual = command.prompt.every((b) => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text");
  const utterance = promptText(command.prompt);
  const scope = projectScope(command.cwd);
  return textual && utterance.trim() !== "" ? { sessionId: command.sessionId, ...(scope === undefined ? {} : { scope }), utterance } : undefined;
}

/**
 * The dialogue in front of any session worker, for workers whose model calls the
 * dialogue's model middleware cannot reach (an external harness such as Claude Code, the
 * echo worker): a turn a script or flow answers is answered here, and the worker never
 * sees it; a script's generated holes are the worker's to write, told the template; every
 * other turn goes to the worker, and how it answered is observed, so the dialogue builds
 * scripts from the worker's replies. Scripts learned are scoped to the session's working
 * directory. What a flow said before handing a turn on is said first. A worker that keeps
 * its own history (an external harness) is told the turns scripts answered since it last
 * had one, and, after the user's words, what a flow already said in reply, so it sees the
 * whole exchange in order; a turn cancelled while the dialogue decides ends as cancelled,
 * and the worker never runs it.
 */
export class DialogueWorker implements Worker {
  readonly #inner: Worker;
  readonly #dialogue: Dialogue;
  /** Turns (`session/turn`) the dialogue is deciding, and those of them cancelled meanwhile. */
  readonly #deciding = new Set<string>();
  readonly #cancelled = new Set<string>();
  /** Per session, the exchanges scripts answered since the worker last had a turn. */
  readonly #unseen = new Map<string, string[]>();

  readonly #handoff: boolean;
  /** Set when the inner worker is a different harness or another model: its text is rewritten, and the harness voice is not sent to it. */
  readonly #voice: ForeignVoice | undefined;

  /** `handoff: false` for a worker that keeps no history of its own (the echo worker): it is not told the turns scripts answered. */
  constructor(inner: Worker, dialogue: Dialogue, options: { readonly handoff?: boolean; readonly voice?: ForeignVoice } = {}) {
    this.#inner = inner;
    this.#dialogue = dialogue;
    this.#handoff = options.handoff ?? true;
    this.#voice = options.voice;
  }

  /** A prompt that is only `cite:<id>` names a stored raw body. */
  #opened(command: PromptCommand): string | undefined {
    const voice = this.#voice;
    if (voice === undefined) return undefined;
    return citedBody(promptText(command.prompt), voice.book);
  }

  async run(command: PromptCommand, emit: Emit): Promise<void> {
    const step = stepOf(command);
    const key = `${command.sessionId}/${command.turnId}`;
    const base = { sessionId: command.sessionId, turnId: command.turnId };
    const opened = this.#opened(command);
    if (opened !== undefined) {
      emit({ type: "update", ...base, update: textChunk(opened) });
      return emit({ type: "end", ...base, stopReason: "end_turn" });
    }
    let decision: Decision | undefined;
    this.#deciding.add(key);
    try {
      if (step === undefined) this.#dialogue.skip(command.sessionId);
      else decision = await this.#dialogue.respond(step);
    } catch {
      // A dialogue that fails decides nothing, and the worker answers.
      decision = undefined;
    } finally {
      this.#deciding.delete(key);
    }
    if (this.#cancelled.delete(key)) return emit({ type: "end", ...base, stopReason: "cancelled" });
    if (decision === undefined) {
      if (this.#voice === undefined) return this.#inner.run(this.#told(command), emit);
      const lines = await recalledLines(this.#voice.voice, this.#voice.memoryStore, step?.utterance ?? promptText(command.prompt), command.sessionId);
      return this.#foreign(this.#voice, this.#told(command), emit, undefined, lines);
    }
    // What a flow said before handing the turn on is said first; the worker, told it was said, answers after.
    const said = (decision.kind === "pass" || decision.kind === "generate") && decision.said !== undefined ? decision.said : undefined;
    if (said !== undefined) emit({ type: "update", ...base, update: textChunk(`${said}\n`) });
    if (decision.kind === "generate" || decision.kind === "pass") {
      const prompt = decision.kind === "generate"
        ? this.#saidAfter(this.#told({ ...command, prompt: [{ type: "text", text: decision.instruction }, ...command.prompt] }), said)
        : this.#saidAfter(this.#told(command), said);
      if (this.#voice !== undefined) {
        const lines = await recalledLines(this.#voice.voice, this.#voice.memoryStore, step?.utterance ?? "", command.sessionId);
        return this.#foreign(this.#voice, prompt, emit, decision.kind === "pass" ? { step: step!, decision } : undefined, lines);
      }
      if (decision.kind === "generate") return this.#inner.run(prompt, emit);
      return this.#observed(prompt, emit, step!, decision);
    }
    if (this.#handoff && this.#voice === undefined) this.#remember(command.sessionId, step!.utterance, decision.text);
    const update: SessionUpdate = { ...textChunk(decision.text), _meta: metaOf(decision) };
    emit({ type: "update", ...base, update });
    emit({ type: "end", ...base, stopReason: "end_turn" });
  }

  /** Keep an exchange a script answered, for the worker's next turn (the latest few, per the dialogue's settings). */
  #remember(sessionId: string, utterance: string, reply: string): void {
    const turns = [...(this.#unseen.get(sessionId) ?? []), `User: ${utterance}\nAssistant: ${reply}`];
    this.#unseen.delete(sessionId);
    this.#unseen.set(sessionId, turns.slice(-this.#dialogue.settings.handoff.turns));
    // Sessions are kept as the dialogue keeps them: the least recent goes first.
    for (const oldest of this.#unseen.keys()) {
      if (this.#unseen.size <= this.#dialogue.settings.sessions) break;
      this.#unseen.delete(oldest);
    }
  }

  /** A prompt for a worker keeping history, told after the user's words what a flow already said in reply this turn. */
  #saidAfter(command: PromptCommand, said: string | undefined): PromptCommand {
    if (this.#voice !== undefined || said === undefined || !this.#handoff) return command;
    return { ...command, prompt: [...command.prompt, { type: "text", text: `${this.#dialogue.settings.handoff.said}\n\n${said}` }] };
  }

  /** A prompt for the worker, told first the exchanges scripts answered since its last turn. */
  #told(command: PromptCommand): PromptCommand {
    if (this.#voice !== undefined) return command;
    const unseen = this.#unseen.get(command.sessionId);
    if (!unseen) return command;
    this.#unseen.delete(command.sessionId);
    return { ...command, prompt: [{ type: "text", text: `${this.#dialogue.settings.handoff.heading}\n\n${unseen.join("\n\n")}` }, ...command.prompt] };
  }

  /** The worker's turn, watched: its text when it ends the turn, that it acted when it called tools, nothing when it did not finish. */
  async #observed(command: PromptCommand, emit: Emit, step: Step, decision: Decision): Promise<void> {
    let text = "";
    let acted = false;
    let outcome: Outcome;
    await this.#inner.run(command, (event) => {
      if (event.type === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") text += event.update.content.text;
      else if (event.type === "update" && event.update.sessionUpdate === "tool_call") acted = true;
      else if (event.type === "end") outcome = acted ? { acted: true } : event.stopReason === "end_turn" ? text : undefined;
      emit(event);
    });
    this.#dialogue.observe(step, decision, outcome);
  }

  /** The worker's text, rewritten in the harness voice. Tool and end events pass through. The raw reply is not learned. */
  async #foreign(voice: ForeignVoice, command: PromptCommand, emit: Emit, observe: { readonly step: Step; readonly decision: Decision } | undefined, lines: readonly string[]): Promise<void> {
    let text = "";
    let acted = false;
    let outcome: Outcome;
    await this.#inner.run(command, (event) => {
      if (event.type === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") {
        text += event.update.content.text;
        return;
      }
      if (event.type === "update" && event.update.sessionUpdate === "tool_call") acted = true;
      if (event.type === "end") {
        if (text !== "") emit({ type: "update", sessionId: command.sessionId, turnId: command.turnId, update: textChunk(voiceAnswer(text, voice.producer, voice.voice, voice.book, lines).text) });
        outcome = acted ? { acted: true } : undefined;
      }
      emit(event);
    });
    if (observe !== undefined) this.#dialogue.observe(observe.step, observe.decision, outcome);
  }

  cancel(sessionId: string, turnId: string): void {
    const key = `${sessionId}/${turnId}`;
    if (this.#deciding.has(key)) this.#cancelled.add(key);
    this.#inner.cancel(sessionId, turnId);
  }

  permission(command: PermissionCommand): void {
    this.#inner.permission(command);
  }

  event(command: EventCommand, emit: Emit): void {
    this.#inner.event?.(command, emit);
  }
}
