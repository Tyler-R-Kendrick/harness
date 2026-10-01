import { citedBody, recalledLines, voiceAnswer } from "./voice.ts";
import type { ForeignVoice } from "./voice.ts";
import { promptText, textChunk } from "./worker.ts";
import type { Emit, EventCommand, PermissionCommand, PromptCommand, Worker } from "./worker.ts";

/**
 * A worker whose user-visible text is harness wording, with no dialogue in front of it.
 * Tool, permission, and end events pass through. A prompt that is only a citation returns
 * the stored raw body and does not ask the inner worker.
 */
export function voiceWorker(inner: Worker, voice: ForeignVoice): Worker {
  return {
    async run(command: PromptCommand, emit: Emit): Promise<void> {
      const base = { sessionId: command.sessionId, turnId: command.turnId };
      const opened = citedBody(promptText(command.prompt), voice.book);
      if (opened !== undefined) {
        emit({ type: "update", ...base, update: textChunk(opened) });
        emit({ type: "end", ...base, stopReason: "end_turn" });
        return;
      }
      const lines = await recalledLines(voice.voice, voice.memoryStore, promptText(command.prompt), command.sessionId);
      let text = "";
      await inner.run(command, (event) => {
        if (event.type === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") {
          text += event.update.content.text;
          return;
        }
        if (event.type === "end" && text !== "") emit({ type: "update", ...base, update: textChunk(voiceAnswer(text, voice.producer, voice.voice, voice.book, lines).text) });
        emit(event);
      });
    },
    cancel(sessionId: string, turnId: string): void {
      inner.cancel(sessionId, turnId);
    },
    permission(command: PermissionCommand): void {
      inner.permission(command);
    },
    event(command: EventCommand, emit: Emit): void {
      inner.event?.(command, emit);
    },
  };
}
