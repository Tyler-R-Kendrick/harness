import { getRandomValues } from "node:crypto";
import { Daemon } from "@harness/core";
import type { Output } from "@harness/core";
import type { Worker } from "@harness/workers";

export interface TurnResult {
  readonly prompt: string;
  readonly reply: string;
  readonly stopReason: string | undefined;
  readonly notices: readonly { severity: string; title: string; description?: string }[];
}

/**
 * Run prompts through the real daemon core with a worker, as one ACP client would,
 * and return each turn's reply. Used by evals to judge end-to-end harness behavior.
 */
export async function runSession(
  worker: Worker,
  prompts: readonly string[],
  options: { permission?: "allow" | "deny" } = {},
): Promise<TurnResult[]> {
  const policy = options.permission ?? "deny";
  const daemon = new Daemon({
    clock: { now: () => Date.now() },
    entropy: { bytes: (n) => getRandomValues(new Uint8Array(n)) },
    agentInfo: { name: "harness-evals", version: "0.0.0" },
  });
  const inbox: Record<string, unknown>[] = [];
  const running: Promise<void>[] = [];
  const apply = (outputs: Output[]) => {
    for (const o of outputs) {
      if (o.kind === "send") {
        const message = o.message as Record<string, unknown>;
        if (message["method"] === "session/request_permission") answerPermission(message);
        else inbox.push(message);
      } else if (o.command.type === "prompt") running.push(worker.run(o.command, (e) => apply(daemon.workerEvent(e))));
      else if (o.command.type === "cancel") worker.cancel(o.command.sessionId, o.command.turnId);
      else worker.permission(o.command);
    }
  };
  // Unattended evals must never leave a permission request hanging: apply the policy.
  const answerPermission = (message: Record<string, unknown>) => {
    const options = ((message["params"] as { options?: { optionId: string; kind: string }[] }).options ?? []);
    const chosen = options.find((o) => o.kind.startsWith(policy === "allow" ? "allow" : "reject"));
    const outcome = chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" };
    apply(daemon.receive("eval", { jsonrpc: "2.0", id: message["id"], result: { outcome } }));
  };
  daemon.connect("eval", { principal: "eval", kind: "human" });
  apply(daemon.receive("eval", { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: 1 } }));
  apply(daemon.receive("eval", { jsonrpc: "2.0", id: "new", method: "session/new", params: { cwd: "/", mcpServers: [] } }));
  const created = inbox.find((m) => m["id"] === "new") as { result: { sessionId: string } };
  const sessionId = created.result.sessionId;
  const turns: TurnResult[] = [];
  for (const [i, prompt] of prompts.entries()) {
    inbox.length = 0;
    apply(daemon.receive("eval", { jsonrpc: "2.0", id: `p${i}`, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: prompt }] } }));
    await Promise.all(running.splice(0));
    const updates = inbox.filter((m) => m["method"] === "session/update").map((m) => (m["params"] as { update: Record<string, unknown> }).update);
    const response = inbox.find((m) => m["id"] === `p${i}`) as { result?: { stopReason: string } } | undefined;
    turns.push({
      prompt,
      reply: updates
        .filter((u) => u["sessionUpdate"] === "agent_message_chunk")
        .map((u) => (u["content"] as { text?: string }).text ?? "")
        .join(""),
      stopReason: response?.result?.stopReason,
      notices: updates.filter((u) => u["sessionUpdate"] === "notice") as unknown as TurnResult["notices"],
    });
  }
  return turns;
}
