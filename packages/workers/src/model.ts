import { streamText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { StopReason } from "@harness/core";
import { promptText, textChunk } from "./worker.ts";
import type { Emit, PromptCommand, Worker } from "./worker.ts";

const STOP_REASONS: Record<string, StopReason> = {
  stop: "end_turn",
  length: "max_tokens",
  "content-filter": "refusal",
};

/**
 * In-process agent runtime: streams a turn from any AI SDK language model, for
 * example `gateway("provider/model")` through the Vercel AI Gateway. Keeps
 * per-session history so follow-up turns carry context.
 */
export class ModelWorker implements Worker {
  readonly #model: LanguageModel;
  readonly #system: string | undefined;
  #history = new Map<string, ModelMessage[]>();
  #aborts = new Map<string, AbortController>();

  constructor(options: { model: LanguageModel; system?: string }) {
    this.#model = options.model;
    this.#system = options.system;
  }

  async run(command: PromptCommand, emit: Emit): Promise<void> {
    const key = `${command.sessionId}/${command.turnId}`;
    const abort = new AbortController();
    this.#aborts.set(key, abort);
    const base = { sessionId: command.sessionId, turnId: command.turnId };
    const history = this.#history.get(command.sessionId) ?? [];
    const messages: ModelMessage[] = [...history, { role: "user", content: promptText(command.prompt) }];
    let stopReason: StopReason = "end_turn";
    let reply = "";
    // The text stream only reports a generic "no output" error; keep the real cause.
    let streamError: unknown;
    try {
      const result = streamText({
        model: this.#model,
        ...(this.#system === undefined ? {} : { system: this.#system }),
        messages,
        abortSignal: abort.signal,
        maxRetries: 0,
        onError: ({ error }) => {
          streamError ??= error;
        },
      });
      for await (const delta of result.textStream) {
        reply += delta;
        emit({ type: "update", ...base, update: textChunk(delta) });
      }
      stopReason = STOP_REASONS[await result.finishReason] ?? "end_turn";
      this.#history.set(command.sessionId, [...messages, { role: "assistant", content: reply }]);
    } catch (e) {
      if (abort.signal.aborted) stopReason = "cancelled";
      else {
        const cause = streamError ?? e;
        emit({ type: "update", ...base, update: { sessionUpdate: "notice", severity: "error", title: "Model call failed", description: cause instanceof Error ? cause.message : String(cause) } });
      }
    } finally {
      this.#aborts.delete(key);
    }
    emit({ type: "end", ...base, stopReason });
  }

  cancel(sessionId: string, turnId: string): void {
    this.#aborts.get(`${sessionId}/${turnId}`)?.abort();
  }

  permission(): void {
    // This worker exposes no tools yet, so it never asks for permission.
  }
}
