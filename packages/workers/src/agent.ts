import { base64 } from "@scure/base";
import type { Agent, ModelMessage, ToolApprovalResponse, ToolSet, UserContent } from "ai";
import { stateOf } from "@harness/cognitive";
import type { CallbackOutcome, StopReason } from "@harness/core";
import { textChunk } from "./worker.ts";
import type { Emit, PermissionCommand, PromptCommand, Worker } from "./worker.ts";

/** What each turn tells the agent: which session it belongs to (see sessionAgent). */
export interface TurnOptions {
  readonly sessionId: string;
}

/** A finished turn: what the person said and what the agent replied, e.g. to remember it. */
export interface Turn {
  readonly sessionId: string;
  readonly said: string;
  readonly reply: string;
}

const STOP_REASONS: Record<string, StopReason> = { stop: "end_turn", "tool-calls": "end_turn", length: "max_tokens", "content-filter": "refusal" };

/** An ACP prompt (text and image blocks) as AI SDK user content. */
export function userContent(prompt: readonly unknown[]): { content: UserContent; said: string } {
  const content: Exclude<UserContent, string> = [];
  for (const block of prompt) {
    const b = (typeof block === "object" && block !== null ? block : {}) as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
    if (b.type === "text" && typeof b.text === "string") content.push({ type: "text", text: b.text });
    else if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") content.push({ type: "file", data: base64.decode(b.data), mediaType: b.mimeType });
  }
  return { content, said: content.map((p) => (p.type === "text" ? p.text : "")).join("\n") };
}

interface Running {
  readonly abort: AbortController;
  readonly decisions: Map<string, (outcome: CallbackOutcome) => void>;
}

/**
 * A session worker that runs any AI SDK agent (a `ToolLoopAgent` over the ensemble or
 * a hosted model, or any other `Agent`). It keeps each session's conversation, streams
 * the agent's text, reasoning and tool calls as ACP session updates, and puts tool
 * approvals through the daemon's permission flow: an approval request becomes a
 * permission request routed to the session's approvers, and their answer continues
 * the turn. A steered model's behavior state changes become notices.
 */
export class AgentWorker implements Worker {
  readonly #agent: Agent<TurnOptions, ToolSet>;
  readonly #onTurn: ((turn: Turn) => Promise<unknown>) | undefined;
  readonly #history = new Map<string, ModelMessage[]>();
  readonly #running = new Map<string, Running>();

  constructor(options: { readonly agent: Agent<TurnOptions, ToolSet>; readonly onTurn?: (turn: Turn) => Promise<unknown> }) {
    this.#agent = options.agent;
    this.#onTurn = options.onTurn;
  }

  async run(command: PromptCommand, emit: Emit): Promise<void> {
    const key = `${command.sessionId}/${command.turnId}`;
    const running: Running = { abort: new AbortController(), decisions: new Map() };
    this.#running.set(key, running);
    const base = { sessionId: command.sessionId, turnId: command.turnId };
    const update = (u: Readonly<Record<string, unknown>>) => emit({ type: "update", ...base, update: u });
    const { content, said } = userContent(command.prompt);
    const messages: ModelMessage[] = [...(this.#history.get(command.sessionId) ?? []), { role: "user", content }];
    let stopReason: StopReason = "end_turn";
    let reply = "";
    try {
      for (;;) {
        const result = await this.#agent.stream({ messages, options: { sessionId: command.sessionId }, abortSignal: running.abort.signal });
        const approvals: { approvalId: string; toolCallId: string; toolName: string; input: unknown }[] = [];
        for await (const part of result.fullStream) {
          const state = stateOf(part as { type: string });
          if (state) {
            const description = state.from === undefined ? state.state : `${state.from} → ${state.state}${state.cause === undefined ? "" : ` (${state.cause})`}`;
            update({ sessionUpdate: "notice", severity: "info", title: `Behavior: ${state.state}`, description, _meta: { harness: { behavior: state } } });
            continue;
          }
          switch (part.type) {
            case "text-delta":
              reply += part.text;
              update(textChunk(part.text));
              break;
            case "reasoning-delta":
              update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: part.text } });
              break;
            case "tool-call":
              update({ sessionUpdate: "tool_call", toolCallId: part.toolCallId, title: part.toolName, kind: "other", status: "pending", rawInput: part.input });
              break;
            case "tool-result":
              update({ sessionUpdate: "tool_call_update", toolCallId: part.toolCallId, status: "completed", rawOutput: part.output });
              break;
            case "tool-error":
              update({ sessionUpdate: "tool_call_update", toolCallId: part.toolCallId, status: "failed", rawOutput: { error: part.error instanceof Error ? part.error.message : String(part.error) } });
              break;
            case "tool-approval-request":
              approvals.push({ approvalId: part.approvalId, toolCallId: part.toolCall.toolCallId, toolName: part.toolCall.toolName, input: part.toolCall.input });
              break;
            case "error":
              throw part.error;
            case "finish":
              stopReason = STOP_REASONS[part.finishReason] ?? "end_turn";
              break;
          }
        }
        messages.push(...(await result.response).messages);
        if (approvals.length === 0) break;
        // An answer must follow its request in the conversation. Agents that keep their own
        // conversation (harnesses) return no response messages, so add the requests they made.
        const asked = new Set(messages.flatMap((m) => (m.role === "assistant" && typeof m.content !== "string" ? m.content.flatMap((p) => (p.type === "tool-approval-request" ? [p.approvalId] : [])) : [])));
        const unasked = approvals.filter((a) => !asked.has(a.approvalId));
        if (unasked.length > 0)
          messages.push({
            role: "assistant",
            content: unasked.flatMap((a) => [
              { type: "tool-call" as const, toolCallId: a.toolCallId, toolName: a.toolName, input: a.input },
              { type: "tool-approval-request" as const, approvalId: a.approvalId, toolCallId: a.toolCallId },
            ]),
          });
        const responses: ToolApprovalResponse[] = [];
        for (const a of approvals) {
          const outcome = await new Promise<CallbackOutcome>((resolve) => {
            running.decisions.set(a.approvalId, resolve);
            emit({
              type: "permission",
              ...base,
              requestId: a.approvalId,
              toolCall: { toolCallId: a.toolCallId, title: a.toolName, kind: "other", status: "pending", rawInput: a.input },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            });
          });
          running.decisions.delete(a.approvalId);
          if (outcome.outcome === "cancelled") throw new CancelledTurn();
          responses.push({ type: "tool-approval-response", approvalId: a.approvalId, approved: outcome.optionId === "allow" });
        }
        messages.push({ role: "tool", content: responses });
      }
      this.#history.set(command.sessionId, messages);
      // Remembering is best effort: a turn never fails because of it.
      await this.#onTurn?.({ sessionId: command.sessionId, said, reply }).catch(() => undefined);
    } catch (e) {
      if (running.abort.signal.aborted || e instanceof CancelledTurn) stopReason = "cancelled";
      else update({ sessionUpdate: "notice", severity: "error", title: "Model call failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      this.#running.delete(key);
    }
    emit({ type: "end", ...base, stopReason });
  }

  cancel(sessionId: string, turnId: string): void {
    const running = this.#running.get(`${sessionId}/${turnId}`);
    if (!running) return;
    running.abort.abort();
    for (const decide of running.decisions.values()) decide({ outcome: "cancelled" });
  }

  permission(command: PermissionCommand): void {
    this.#running.get(`${command.sessionId}/${command.turnId}`)?.decisions.get(command.requestId)?.(command.outcome);
  }
}

class CancelledTurn extends Error {}
