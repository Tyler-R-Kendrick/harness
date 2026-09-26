import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { WorkerCommand, WorkerEvent } from "@harness/core";

export type PromptCommand = Extract<WorkerCommand, { type: "prompt" }>;
export type PermissionCommand = Extract<WorkerCommand, { type: "permission" }>;
export type Emit = (event: WorkerEvent) => void;

/**
 * A session worker runs turns for the daemon. Hosts translate daemon worker commands
 * into these calls and feed emitted events back to the daemon.
 */
export interface Worker {
  /** Run one turn; must emit exactly one `end` event before resolving. */
  run(command: PromptCommand, emit: Emit): Promise<void>;
  cancel(sessionId: string, turnId: string): void;
  permission(command: PermissionCommand): void;
}

export function promptText(prompt: readonly unknown[]): string {
  return prompt
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => b.text)
    .join("\n");
}

export const textChunk = (text: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
