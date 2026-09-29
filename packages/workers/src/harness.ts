import type { HarnessAgent, HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { Agent, AgentCallParameters, AgentStreamParameters, Experimental_SandboxSession, ModelMessage, ToolSet } from "ai";
import type { TurnOptions } from "./agent.ts";
import { conversationOf, messageOf, scopeOf, stepEnded } from "./session-agent.ts";
import type { LastCall, StepHook, ToolContext, TurnGuidance } from "./session-agent.ts";

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

/** The call options `harnessSessions` gives its agent's turns: the host tools it chose for the turn, if any. */
export interface HarnessTurnOptions {
  readonly tools?: ToolSet;
}

/**
 * A `HarnessAgent` `prepareCall` that gives each new turn the host-executed tools
 * `harnessSessions` chose for it (its `tools` option) in place of the agent's own; a
 * turn without them keeps the agent's. The harness's builtin tools are its own either
 * way, and a turn continued after an approval round keeps the tools it started with.
 */
export function harnessTurnTools<T extends { readonly options?: HarnessTurnOptions | undefined; readonly tools?: ToolSet | undefined }>({ options, ...call }: T): Omit<T, "options"> {
  return options?.tools === undefined ? call : { ...call, tools: options.tools };
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
  agent: HarnessAgent<any, any, any, any, any>,
  options: {
    readonly sandboxSession?: (sessionId: string) => Experimental_SandboxSession;
    readonly store?: HarnessStore;
    /** Guides each turn: its `turn` variant's text is prepended to the turn's prompt; its `end` is told each step's usage. */
    readonly step?: StepHook;
    /**
     * Host-executed tools for each turn, in place of the agent's own (given once, or anew
     * each turn, told the turn's scope and conversation, e.g. the workflows the session's
     * pinned procedural core binds). The agent applies them with `prepareCall: harnessTurnTools`.
     */
    readonly tools?: ToolSet | ((turn: ToolContext) => ToolSet | Promise<ToolSet>);
  } = {},
): HarnessSessions {
  const sessions = new Map<string, Promise<HarnessAgentSession>>();
  /** Each session's last tool call, with its id so a later step's result can be paired with it. */
  const lastCalls = new Map<string, LastCall & { readonly id: string }>();
  const { store, step } = options;
  /** The call options that give a turn its own tools; none without them. */
  const turnTools = async (turn: TurnOptions, call: { readonly messages?: ModelMessage[] | undefined; readonly prompt?: string | ModelMessage[] | undefined }): Promise<{ readonly tools: ToolSet } | undefined> => {
    const { tools } = options;
    if (tools === undefined) return undefined;
    return { tools: typeof tools === "function" ? await tools({ ...scopeOf(turn), messages: conversationOf(call) }) : tools };
  };
  /**
   * The turn's guidance: the messages with its text prepended to the prompt (none without
   * text), and the tools it limits the turn to. Only a new prompt is guided: a continuation
   * after an approval round ends with tool results, not a user message. A failing hook
   * leaves the prompt unguided. The hook is told the names of the harness's tools and the turn's.
   */
  const guide = async (hook: NonNullable<StepHook["turn"]>, turn: TurnOptions, messages: ModelMessage[], tools: readonly string[]): Promise<{ readonly messages?: ModelMessage[]; readonly activeTools?: readonly string[] }> => {
    const prompt = messages.at(-1);
    if (prompt?.role !== "user") return {};
    const scope = scopeOf(turn);
    let guidance: TurnGuidance | string | undefined;
    try {
      const known = lastCalls.get(turn.sessionId);
      const lastCall = known === undefined ? {} : { lastCall: { name: known.name, input: known.input, ...(known.output === undefined ? {} : { output: known.output }) } };
      guidance = await hook({ ...scope, messages, lastAction: known?.name, ...lastCall, tools });
    } catch (e) {
      scope.report({ sessionUpdate: "notice", severity: "warning", title: "Turn guidance failed", description: messageOf(e) });
    }
    const { text, activeTools } = typeof guidance === "string" ? { text: guidance, activeTools: undefined } : { text: guidance?.text, activeTools: guidance?.activeTools };
    const limit = activeTools === undefined ? {} : { activeTools };
    if (!text) return limit;
    const content = typeof prompt.content === "string" ? [{ type: "text" as const, text: prompt.content }] : prompt.content;
    return { messages: [...messages.slice(0, -1), { ...prompt, content: [{ type: "text", text: `${text}\n\n` }, ...content] }], ...limit };
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
      return agent.generate({ ...call, options: await turnTools(turn, call), session: await session(turn.sessionId) });
    },
    async stream({ options: turn, ...call }: AgentStreamParameters<TurnOptions, ToolSet>) {
      const live = await session(turn.sessionId);
      const own = await turnTools(turn, call);
      const guided = step?.turn && call.messages ? await guide(step.turn.bind(step), turn, call.messages, Object.keys({ ...agent.tools, ...own?.tools })) : {};
      // Only the turn's own tools can be limited: the agent's cannot be told from the harness's builtins.
      const { activeTools } = guided;
      const limited = own === undefined || activeTools === undefined ? own : { tools: Object.fromEntries(Object.entries(own.tools).filter(([name]) => activeTools.includes(name))) };
      const { onStepEnd, ...rest } = call;
      const settings = {
        // The harness keeps its own conversation, so the session's last tool call is remembered from its steps,
        // and its output from the step that reports its result (a later one, for a host-executed tool).
        onStepEnd: async (event: Parameters<NonNullable<typeof onStepEnd>>[0]) => {
          const last = event.toolCalls.at(-1);
          if (last) lastCalls.set(turn.sessionId, { id: last.toolCallId, name: last.toolName, input: last.input });
          const known = lastCalls.get(turn.sessionId);
          const result = event.toolResults.find((r) => r.toolCallId === known?.id);
          if (known !== undefined && result !== undefined) lastCalls.set(turn.sessionId, { ...known, output: result.output });
          await onStepEnd?.(event);
          if (step) await stepEnded(step, turn, event);
        },
        session: live,
        options: limited,
      };
      if (guided.messages === undefined) return agent.stream({ ...rest, ...settings });
      const { prompt: _prompt, messages: _messages, ...others } = rest;
      return agent.stream({ ...others, messages: guided.messages, ...settings });
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
