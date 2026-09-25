import type { HarnessAgent, HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { Agent, AgentCallParameters, AgentStreamParameters, Experimental_SandboxSession, ToolSet } from "ai";
import type { TurnOptions } from "./agent.ts";

/** An AI SDK agent whose turns name their daemon session, and which can end every harness session. */
export type HarnessSessions = Agent<TurnOptions, ToolSet> & { close(): Promise<void> };

/**
 * An AI SDK `HarnessAgent` (Claude Code, Codex, any ACP agent through
 * `@ai-sdk/harness-acp`, or any other `HarnessV1` adapter) as an agent an
 * `AgentWorker` runs: each daemon session gets its own harness session, started on
 * its first turn and kept for the rest. The harness keeps the conversation, so only
 * each turn's new prompt reaches it; approvals continue a paused turn as with any
 * agent. `sandboxSession` supplies a sandbox per session when the agent has no
 * sandbox provider.
 */
export function harnessSessions(
  // Any harness and tool set: the worker reads the stream, not the tools' types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: HarnessAgent<any, any>,
  options: { readonly sandboxSession?: (sessionId: string) => Experimental_SandboxSession } = {},
): HarnessSessions {
  const sessions = new Map<string, Promise<HarnessAgentSession>>();
  const session = (sessionId: string) => {
    let s = sessions.get(sessionId);
    if (!s) {
      s = agent.createSession({ sessionId, ...(options.sandboxSession ? { sandboxSession: options.sandboxSession(sessionId) } : {}) });
      // A session that fails to start is not kept: the next turn tries again.
      s.catch(() => sessions.delete(sessionId));
      sessions.set(sessionId, s);
    }
    return s;
  };
  return {
    version: "agent-v1",
    id: agent.id,
    tools: agent.tools as ToolSet,
    async generate({ options: turn, ...call }: AgentCallParameters<TurnOptions, ToolSet>) {
      return agent.generate({ ...call, session: await session(turn.sessionId) });
    },
    async stream({ options: turn, ...call }: AgentStreamParameters<TurnOptions, ToolSet>) {
      return agent.stream({ ...call, session: await session(turn.sessionId) });
    },
    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map(async (s) => (await s).destroy()));
    },
  };
}
