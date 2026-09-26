import type { CallbackOutcome } from "@harness/core";
import { promptText, textChunk } from "./worker.ts";
import type { Emit, PermissionCommand, PromptCommand, Worker } from "./worker.ts";

interface Turn {
  cancelled: boolean;
  decide?: (outcome: CallbackOutcome) => void;
}

/**
 * Deterministic worker for tests and demos: echoes the prompt back word by word.
 * A prompt containing `!permission` first asks for permission, exercising routing.
 * It never calls a model.
 */
export class EchoWorker implements Worker {
  readonly #pause: () => Promise<void>;
  #turns = new Map<string, Turn>();

  constructor(options: { pause?: () => Promise<void> } = {}) {
    this.#pause = options.pause ?? (() => Promise.resolve());
  }

  async run(command: PromptCommand, emit: Emit): Promise<void> {
    const key = `${command.sessionId}/${command.turnId}`;
    const turn: Turn = { cancelled: false };
    this.#turns.set(key, turn);
    const base = { sessionId: command.sessionId, turnId: command.turnId };
    const end = (stopReason: "end_turn" | "cancelled") => {
      this.#turns.delete(key);
      emit({ type: "end", ...base, stopReason });
    };
    const text = promptText(command.prompt);
    if (text.includes("!permission")) {
      const decision = new Promise<CallbackOutcome>((resolve) => (turn.decide = resolve));
      emit({
        type: "permission",
        ...base,
        requestId: `${command.turnId}:permission`,
        toolCall: { toolCallId: `${command.turnId}:tool`, title: "Echo the prompt back", kind: "other", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      const outcome = await decision;
      if (turn.cancelled || outcome.outcome === "cancelled") return end("cancelled");
      if (outcome.optionId !== "allow") {
        emit({ type: "update", ...base, update: textChunk("permission denied") });
        return end("end_turn");
      }
    }
    const words = `echo: ${text}`.split(/(?<= )/);
    for (const word of words) {
      await this.#pause();
      if (turn.cancelled) return end("cancelled");
      emit({ type: "update", ...base, update: textChunk(word) });
    }
    end("end_turn");
  }

  cancel(sessionId: string, turnId: string): void {
    const turn = this.#turns.get(`${sessionId}/${turnId}`);
    if (!turn) return;
    turn.cancelled = true;
    turn.decide?.({ outcome: "cancelled" });
  }

  permission(command: PermissionCommand): void {
    this.#turns.get(`${command.sessionId}/${command.turnId}`)?.decide?.(command.outcome);
  }
}
