import type { HarnessAgent, HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { Agent, AgentCallParameters, AgentStreamParameters, Experimental_SandboxSession, ToolSet } from "ai";
import type { TurnOptions } from "./agent.ts";

/** An AI SDK agent whose turns name their daemon session, and which can end every harness session. */
export type HarnessSessions = Agent<TurnOptions, ToolSet> & { close(): Promise<void> };

/**
 * Where parked harness sessions wait between daemon processes: the state a harness
 * returned on detach, by daemon session id. Hosts keep it durable (a file natively).
 */
export interface HarnessStore {
  get(sessionId: string): Promise<unknown>;
  set(sessionId: string, state: unknown): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/**
 * An AI SDK `HarnessAgent` (Claude Code, Codex, any ACP agent through
 * `@ai-sdk/harness-acp`, or any other `HarnessV1` adapter) as an agent an
 * `AgentWorker` runs: each daemon session gets its own harness session, started on
 * its first turn and kept for the rest. The harness keeps the conversation, so only
 * each turn's new prompt reaches it; approvals continue a paused turn as with any
 * agent. `sandboxSession` supplies a sandbox per session when the agent has no
 * sandbox provider. With a `store`, closing parks each harness session there and the
 * session's next turn (in this process or a later one) resumes it.
 */
export function harnessSessions(
  // Any harness and tool set: the worker reads the stream, not the tools' types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: HarnessAgent<any, any>,
  options: { readonly sandboxSession?: (sessionId: string) => Experimental_SandboxSession; readonly store?: HarnessStore } = {},
): HarnessSessions {
  const sessions = new Map<string, Promise<HarnessAgentSession>>();
  const { store } = options;
  const start = async (sessionId: string): Promise<HarnessAgentSession> => {
    const sandbox = options.sandboxSession ? { sandboxSession: options.sandboxSession(sessionId) } : {};
    const parked = await store?.get(sessionId);
    if (parked !== undefined) {
      // A parked state is spent once read: resumed now, or unusable (another harness, a
      // stale runtime), in which case the session starts fresh.
      await store!.delete(sessionId);
      const state = parked as { harnessId?: unknown };
      if (state.harnessId === agent.harnessId) {
        const resumed = await agent.createSession({ sessionId, resumeFrom: parked as never, ...sandbox }).catch(() => undefined);
        if (resumed) return resumed;
      }
    }
    return agent.createSession({ sessionId, ...sandbox });
  };
  const session = (sessionId: string) => {
    let s = sessions.get(sessionId);
    if (!s) {
      s = start(sessionId);
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
    /** End every harness session: parked in the store when there is one, otherwise destroyed. */
    async close() {
      const open = [...sessions.entries()];
      sessions.clear();
      await Promise.allSettled(
        open.map(async ([sessionId, s]) => {
          const live = await s;
          if (store) await store.set(sessionId, await live.detach());
          else await live.destroy();
        }),
      );
    },
  };
}
