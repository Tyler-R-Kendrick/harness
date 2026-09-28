import type { HarnessAgent, HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { Agent, AgentCallParameters, AgentStreamParameters, Experimental_SandboxSession, ModelMessage, ToolSet } from "ai";
import type { TurnOptions } from "./agent.ts";
import { messageOf, scopeOf, stepEnded } from "./session-agent.ts";
import type { StepHook } from "./session-agent.ts";

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
 * sandbox provider. With a `store`, closing stops each harness session and parks it
 * there, and the session's next turn (in this process or a later one) resumes it.
 */
export function harnessSessions(
  // Any harness and tool set: the worker reads the stream, not the tools' types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent: HarnessAgent<any, any>,
  options: {
    readonly sandboxSession?: (sessionId: string) => Experimental_SandboxSession;
    readonly store?: HarnessStore;
    /** Guides each turn: its `turn` variant's text is prepended to the turn's prompt; its `end` is told each step's usage. */
    readonly step?: StepHook;
  } = {},
): HarnessSessions {
  const sessions = new Map<string, Promise<HarnessAgentSession>>();
  const lastActions = new Map<string, string>();
  const { store, step } = options;
  /**
   * The messages with the turn's guidance prepended to its prompt; undefined when there
   * is none. Only a new prompt is guided: a continuation after an approval round ends
   * with tool results, not a user message. A failing hook leaves the prompt unguided.
   */
  const guide = async (hook: NonNullable<StepHook["turn"]>, turn: TurnOptions, messages: ModelMessage[]): Promise<ModelMessage[] | undefined> => {
    const prompt = messages.at(-1);
    if (prompt?.role !== "user") return undefined;
    const scope = scopeOf(turn);
    let text: string | undefined;
    try {
      text = await hook({ ...scope, messages, lastAction: lastActions.get(turn.sessionId), tools: Object.keys(agent.tools ?? {}) });
    } catch (e) {
      scope.report({ sessionUpdate: "notice", severity: "warning", title: "Turn guidance failed", description: messageOf(e) });
    }
    if (!text) return undefined;
    const content = typeof prompt.content === "string" ? [{ type: "text" as const, text: prompt.content }] : prompt.content;
    return [...messages.slice(0, -1), { ...prompt, content: [{ type: "text", text: `${text}\n\n` }, ...content] }];
  };
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
      const live = await session(turn.sessionId);
      const guided = step?.turn && call.messages ? await guide(step.turn.bind(step), turn, call.messages) : undefined;
      const { onStepEnd, ...rest } = call;
      const settings = {
        // The harness keeps its own conversation, so the session's last tool call is remembered from its steps.
        onStepEnd: async (event: Parameters<NonNullable<typeof onStepEnd>>[0]) => {
          const last = event.toolCalls.at(-1);
          if (last) lastActions.set(turn.sessionId, last.toolName);
          await onStepEnd?.(event);
          if (step) await stepEnded(step, turn, event);
        },
        session: live,
      };
      if (guided === undefined) return agent.stream({ ...rest, ...settings });
      const { prompt: _prompt, messages: _messages, ...others } = rest;
      return agent.stream({ ...others, messages: guided, ...settings });
    },
    /**
     * End every harness session: parked in the store when there is one, otherwise
     * destroyed. Parking stops the harness's runtime and sandbox (a detach would leave
     * them running for another process); a later turn resumes from the parked state.
     */
    async close() {
      const open = [...sessions.entries()];
      sessions.clear();
      await Promise.allSettled(
        open.map(async ([sessionId, s]) => {
          const live = await s;
          if (store) await store.set(sessionId, await live.stop());
          else await live.destroy();
        }),
      );
    },
  };
}
