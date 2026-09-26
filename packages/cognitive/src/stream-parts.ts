/**
 * Our local models decode tokens themselves; these turn what they decode into the AI
 * SDK's language model stream parts (`LanguageModelV4StreamPart`), and parts into a
 * generate result, so every local model is a `LanguageModelV4` like any provider's.
 */
import type { LanguageModelV4Content, LanguageModelV4FinishReason, LanguageModelV4GenerateResult, LanguageModelV4StreamPart, LanguageModelV4Usage, SharedV4ProviderMetadata } from "@ai-sdk/provider";
import type { ChatEvent } from "./chat-format.ts";
import { stateContent } from "./options.ts";
import type { StateChange } from "./options.ts";

export function usage(inputTokens?: number, outputTokens?: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
  };
}

export const finishReason = (unified: LanguageModelV4FinishReason["unified"]): LanguageModelV4FinishReason => ({ unified, raw: unified });

/**
 * Stream parts for decoded events: text and reasoning open a block on their first
 * delta and close it when something else comes; tool calls get ids in call order.
 */
export class StreamParts {
  #open: { readonly type: "text" | "reasoning"; readonly id: string } | undefined;
  #blocks = 0;
  #calls = 0;

  /** Parts for one event. */
  push(event: ChatEvent | ({ readonly type: "state" } & StateChange)): LanguageModelV4StreamPart[] {
    if (event.type === "text" || event.type === "reasoning") {
      if (event.text === "") return [];
      const parts: LanguageModelV4StreamPart[] = [];
      if (this.#open?.type !== event.type) {
        parts.push(...this.#close());
        this.#open = { type: event.type, id: `${this.#blocks++}` };
        parts.push({ type: `${event.type}-start`, id: this.#open.id });
      }
      parts.push({ type: `${event.type}-delta`, id: this.#open.id, delta: event.text });
      return parts;
    }
    if (event.type === "state") {
      const { type: _, ...change } = event;
      return [...this.#close(), stateContent(change)];
    }
    return [...this.#close(), { type: "tool-call", toolCallId: `call_${this.#calls++}`, toolName: event.call.name, input: JSON.stringify(event.call.arguments) }];
  }

  /** The closing parts: any open block, then the finish (tool calls when there were any, unless the output was cut off). */
  end(options: { readonly length?: boolean; readonly usage?: LanguageModelV4Usage; readonly providerMetadata?: SharedV4ProviderMetadata } = {}): LanguageModelV4StreamPart[] {
    const reason = options.length ? "length" : this.#calls > 0 ? "tool-calls" : "stop";
    return [...this.#close(), { type: "finish", finishReason: finishReason(reason), usage: options.usage ?? usage(), ...(options.providerMetadata ? { providerMetadata: options.providerMetadata } : {}) }];
  }

  #close(): LanguageModelV4StreamPart[] {
    const open = this.#open;
    this.#open = undefined;
    return open ? [{ type: `${open.type}-end`, id: open.id }] : [];
  }
}

/** A generate result from the parts a stream would carry: text and reasoning joined per block, the rest as they are. */
export function collectParts(parts: readonly LanguageModelV4StreamPart[]): LanguageModelV4GenerateResult {
  const content: LanguageModelV4Content[] = [];
  const blocks = new Map<string, { type: "text" | "reasoning"; text: string }>();
  let finish: Extract<LanguageModelV4StreamPart, { type: "finish" }> | undefined;
  for (const part of parts) {
    switch (part.type) {
      case "text-start":
      case "reasoning-start": {
        const block = { type: part.type === "text-start" ? ("text" as const) : ("reasoning" as const), text: "" };
        blocks.set(part.id, block);
        content.push(block);
        break;
      }
      case "text-delta":
      case "reasoning-delta":
        blocks.get(part.id)!.text += part.delta;
        break;
      case "tool-call":
      case "custom":
        content.push(part);
        break;
      case "finish":
        finish = part;
        break;
      case "error":
        throw part.error;
    }
  }
  if (!finish) throw new Error("the stream ended without a finish part");
  return { content, finishReason: finish.finishReason, usage: finish.usage, ...(finish.providerMetadata ? { providerMetadata: finish.providerMetadata } : {}), warnings: [] };
}
