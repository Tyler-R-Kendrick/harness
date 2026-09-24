import { base64 } from "@scure/base";
import type { ChatMessage, ContentPart, GenerateRequest, GenerationEvent, TaskCategory } from "@harness/cognitive";
import type { StopReason } from "@harness/core";
import { textChunk } from "./worker.ts";
import type { Emit, PromptCommand, Worker } from "./worker.ts";

/** The part of the cognitive ensemble this worker needs. */
export interface GeneratingEnsemble {
  generate(request: GenerateRequest, task?: TaskCategory): AsyncIterable<GenerationEvent>;
}

const STOP_REASONS: Record<string, StopReason> = { stop: "end_turn", "tool-calls": "end_turn", length: "max_tokens", error: "refusal" };

function toContent(prompt: readonly unknown[]): { parts: ContentPart[]; hasImage: boolean } {
  const parts: ContentPart[] = [];
  let hasImage = false;
  for (const block of prompt) {
    const b = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (b.type === "text" && typeof b.text === "string") parts.push({ type: "text", text: b.text });
    else if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
      parts.push({ type: "image", image: { mediaType: b.mimeType, data: base64.decode(b.data) } });
      hasImage = true;
    }
  }
  return { parts, hasImage };
}

/**
 * Session worker backed by the cognitive core: each turn runs on the best generator
 * the ensemble has for the task (Ornith natively, Qwen3.5 in a browser), and turns
 * with images go to the vision task. Keeps per-session history.
 */
export class EnsembleWorker implements Worker {
  readonly #ensemble: GeneratingEnsemble;
  readonly #system: string | undefined;
  readonly #task: TaskCategory;
  #history = new Map<string, ChatMessage[]>();
  #cancelled = new Set<string>();

  /** `task` is what text turns ask the ensemble for: "chat" by default, "steered-chat" for the local kernel. */
  constructor(options: { ensemble: GeneratingEnsemble; system?: string; task?: TaskCategory }) {
    this.#ensemble = options.ensemble;
    this.#system = options.system;
    this.#task = options.task ?? "chat";
  }

  async run(command: PromptCommand, emit: Emit): Promise<void> {
    const key = `${command.sessionId}/${command.turnId}`;
    const base = { sessionId: command.sessionId, turnId: command.turnId };
    const { parts, hasImage } = toContent(command.prompt);
    const user: ChatMessage = { role: "user", content: hasImage ? parts : parts.map((p) => (p.type === "text" ? p.text : "")).join("") };
    const history = this.#history.get(command.sessionId) ?? [];
    const messages: ChatMessage[] = [...(history.length === 0 && this.#system ? [{ role: "system" as const, content: this.#system }] : []), ...history, user];
    let stopReason: StopReason = "end_turn";
    let reply = "";
    try {
      for await (const event of this.#ensemble.generate({ messages }, hasImage ? "vision-qa" : this.#task)) {
        if (this.#cancelled.has(key)) {
          stopReason = "cancelled";
          break;
        }
        if (event.type === "text") {
          reply += event.text;
          emit({ type: "update", ...base, update: textChunk(event.text) });
        } else if (event.type === "reasoning") {
          emit({ type: "update", ...base, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } } });
        } else if (event.type === "state") {
          const { type: _, ...behavior } = event;
          const description = event.from === undefined ? event.state : `${event.from} → ${event.state}${event.cause === undefined ? "" : ` (${event.cause})`}`;
          emit({ type: "update", ...base, update: { sessionUpdate: "notice", severity: "info", title: `Behavior: ${event.state}`, description, _meta: { harness: { behavior } } } });
        } else if (event.type === "finish") stopReason = STOP_REASONS[event.reason] ?? "end_turn";
      }
      if (stopReason !== "cancelled") this.#history.set(command.sessionId, [...messages, { role: "assistant", content: reply }]);
    } catch (e) {
      emit({ type: "update", ...base, update: { sessionUpdate: "notice", severity: "error", title: "Model call failed", description: e instanceof Error ? e.message : String(e) } });
    } finally {
      this.#cancelled.delete(key);
    }
    emit({ type: "end", ...base, stopReason });
  }

  cancel(sessionId: string, turnId: string): void {
    this.#cancelled.add(`${sessionId}/${turnId}`);
  }

  permission(): void {
    // Tool use through the daemon's permission flow is not wired to the ensemble yet.
  }
}
