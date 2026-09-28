import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { streamText, ToolLoopAgent } from "ai";
import { HARNESS, projectScope } from "@harness/cognitive";
import type { AgentCallParameters, AgentStreamParameters, Instructions, LanguageModel, LanguageModelUsage, ModelMessage, PrepareStepFunction, StepResult, StopCondition, ToolLoopAgentSettings, ToolSet } from "ai";
import { z } from "zod";
import type { Turn, TurnOptions } from "./agent.ts";

/** What a step hook is told about the session and turn a step belongs to. */
export interface TurnScope {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly cwd?: string;
  readonly sessionMeta?: Readonly<Record<string, unknown>>;
  /** Sends a session update to the client as part of the turn. */
  readonly report: (update: SessionUpdate) => void;
}

/** What tools given anew each turn are told: the turn's scope and its conversation so far. */
export interface ToolContext extends TurnScope {
  /**
   * The call's conversation (a prompt given as text is one user message): a new prompt
   * last, or, for a stream restarted in its turn (after an approval round), what the turn
   * did so far.
   */
  readonly messages: readonly ModelMessage[];
}

/** One step of an agent's loop, as AI SDK `prepareStep` sees it. */
export interface StepContext extends TurnScope {
  /** Everything the step's model call would get: the conversation so far, this turn's tool calls and results included. */
  readonly messages: readonly ModelMessage[];
  /** The turn's instructions before any step changed them. */
  readonly initialInstructions: Instructions | undefined;
  /** The AI SDK step number, which restarts when the worker restarts the stream (after an approval round). */
  readonly stepNumber: number;
  /** The step's model. */
  readonly model: LanguageModel;
  /** The names of the tools the turn offers. */
  readonly tools: readonly string[];
}

/** A harness's tool call as a turn hook is told it. */
export interface LastCall {
  readonly name: string;
  readonly input: unknown;
  readonly output?: unknown;
}

/** A turn of an opaque harness, which has no steps to prepare: only its prompt can carry guidance. */
export interface TurnContext extends TurnScope {
  /** The conversation the worker holds, ending with the turn's prompt. */
  readonly messages: readonly ModelMessage[];
  /** The last tool the harness called in an earlier turn of the session. */
  readonly lastAction: string | undefined;
  /** That call with its input and, once the harness reported it, its result's output (what a state tracker reads). */
  readonly lastCall?: LastCall;
  /** The names of the tools the harness offers: its own, and the turn's. */
  readonly tools: readonly string[];
}

/**
 * A harness turn's guidance: text prepended to its prompt, and optionally the only host
 * tools of the turn's own (`harnessSessions({ tools })`) it offers. The harness's builtin
 * tools stay offered: a turn cannot limit them.
 */
export interface TurnGuidance {
  readonly text?: string;
  readonly activeTools?: readonly string[];
}

/** A step that ended, as AI SDK `onStepEnd` sees it: its number and its model call's usage. */
export interface StepEndContext extends TurnScope {
  /** The AI SDK step number (it restarts with the stream after an approval round). */
  readonly stepNumber: number;
  /** The step's model usage, as the AI SDK reports it. */
  readonly usage: LanguageModelUsage;
}

/**
 * Per-step guidance (e.g. procedural graphs): `prepare` may replace a step's
 * instructions (they carry forward, so rebuild them from `initialInstructions`) or its
 * messages, and may limit the tools that step offers the model (AI SDK `activeTools`;
 * the next step offers every tool again unless the hook limits it too). `turn`, when
 * given, guides an opaque harness's turn: its text is prepended to the prompt, and its
 * active tools, when it gives them, are the only host tools of the turn's own it offers. `end`,
 * when given, is told each step's model usage once the step ends (an agent's steps and
 * a harness's alike), e.g. to record it in the session log.
 */
export interface StepHook {
  prepare(context: StepContext): Promise<{ readonly instructions?: Instructions; readonly messages?: readonly ModelMessage[]; readonly activeTools?: readonly string[] } | undefined>;
  turn?(context: TurnContext): Promise<string | TurnGuidance | undefined>;
  end?(context: StepEndContext): Promise<void>;
}

/** A thrown value's message. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The turn's scope for a hook: a turn without a report function reports nowhere. */
export function scopeOf(turn: TurnOptions): TurnScope {
  const { report = () => undefined, ...rest } = turn;
  return { ...rest, report };
}

/** A step's preparation by the hook; a failing hook leaves the step as it was and says why. */
function preparing(hook: StepHook, turn: TurnOptions, tools: readonly string[]): PrepareStepFunction<ToolSet> {
  const scope = scopeOf(turn);
  return async ({ messages, initialInstructions, stepNumber, model }) => {
    try {
      const prepared = await hook.prepare({ ...scope, messages, initialInstructions, stepNumber, model, tools });
      return {
        ...(prepared?.instructions === undefined ? {} : { instructions: prepared.instructions }),
        ...(prepared?.messages ? { messages: [...prepared.messages] } : {}),
        ...(prepared?.activeTools ? { activeTools: [...prepared.activeTools] } : {}),
      };
    } catch (e) {
      scope.report({ sessionUpdate: "notice", severity: "warning", title: "Step guidance failed", description: messageOf(e) });
      return {};
    }
  };
}

/** Tell the hook's `end` about a step that ended; a failing hook never fails the turn, and a warning says why. */
export async function stepEnded(hook: StepHook, turn: TurnOptions, step: Pick<StepResult<ToolSet>, "stepNumber" | "usage">): Promise<void> {
  if (!hook.end) return;
  const scope = scopeOf(turn);
  try {
    await hook.end({ ...scope, stepNumber: step.stepNumber, usage: step.usage });
  } catch (e) {
    scope.report({ sessionUpdate: "notice", severity: "warning", title: "Step usage failed", description: messageOf(e) });
  }
}

type StepEnd = NonNullable<AgentCallParameters<TurnOptions, ToolSet>["onStepEnd"]>;

/** Call parameters whose step ends also reach the hook, after the caller's own `onStepEnd` (or its deprecated alias, which this one replaces). */
function ending<P extends AgentCallParameters<TurnOptions, ToolSet>>(hook: StepHook | undefined, params: P): P {
  if (!hook?.end) return params;
  const theirs: StepEnd | undefined = params.onStepEnd ?? params.onStepFinish;
  return {
    ...params,
    onStepEnd: async (step: Parameters<StepEnd>[0]) => {
      await theirs?.(step);
      await stepEnded(hook, params.options, step);
    },
  };
}

/** A `ToolLoopAgent` whose steps, once ended, are told to the step hook's `end`. */
class SessionAgent extends ToolLoopAgent<TurnOptions, ToolSet> {
  readonly #hook: StepHook | undefined;

  constructor(settings: ToolLoopAgentSettings<TurnOptions, ToolSet>, hook: StepHook | undefined) {
    super(settings);
    this.#hook = hook;
  }

  override generate(params: AgentCallParameters<TurnOptions, ToolSet>) {
    return super.generate(ending(this.#hook, params));
  }

  override stream(params: AgentStreamParameters<TurnOptions, ToolSet>) {
    return super.stream(ending(this.#hook, params));
  }
}

const TurnOptionsSchema = z.object({
  sessionId: z.string(),
  turnId: z.string().exactOptional(),
  cwd: z.string().exactOptional(),
  sessionMeta: z.record(z.string(), z.unknown()).exactOptional(),
  report: z.custom<(update: SessionUpdate) => void>((v) => typeof v === "function").exactOptional(),
});

/** Session memory (see @harness/memory): related items are recalled into a turn, and turns are remembered. */
export interface SessionMemory {
  recall(query: string, options: { readonly excludeSession?: string; readonly limit?: number; readonly kinds?: readonly string[] }): Promise<readonly { readonly text: string }[]>;
  remember(items: readonly { readonly text: string; readonly sessionId?: string; readonly kind?: string }[]): Promise<unknown>;
}

/** Learning (see @harness/learning): the lessons for what was asked, as a playbook. */
export interface TurnLearning {
  recall(task: string): Promise<{ readonly playbook: string }>;
}

/** A call's conversation: its messages, or its prompt (text is one user message). */
/** A call's conversation: its messages, or its prompt as messages (a text prompt is one user message). */
export const conversationOf = (call: { readonly messages?: readonly ModelMessage[] | undefined; readonly prompt?: string | readonly ModelMessage[] | undefined }): readonly ModelMessage[] =>
  call.messages ?? (typeof call.prompt === "string" ? [{ role: "user", content: call.prompt }] : (call.prompt ?? []));

const lastUser = (messages: readonly ModelMessage[]) => [...messages].reverse().find((m) => m.role === "user");
const textOf = (m: ModelMessage | undefined) => (m === undefined ? "" : typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n"));
const hasImage = (m: ModelMessage | undefined) => m !== undefined && typeof m.content !== "string" && m.content.some((p) => p.type === "file" || p.type === "image");

/**
 * A session's agent: an AI SDK `ToolLoopAgent` whose instructions, per turn, carry the
 * lessons learning has for what was asked and related memories from other sessions
 * (both best effort), and whose model is the vision model when the turn sends images.
 * Tools with approval go through the worker's permission flow (see AgentWorker).
 */
export function sessionAgent(options: {
  readonly model: LanguageModel;
  /** Takes turns that send images, when given. */
  readonly vision?: LanguageModel;
  /** Instructions, or a function giving them anew each turn (e.g. a file the person edits). */
  readonly instructions?: string | (() => string | Promise<string>);
  /**
   * Tools, or a function giving them anew each turn (e.g. a workflow library's, which
   * grows as learning builds tools), told the turn's scope and conversation so a session
   * can get tools of its own (e.g. the workflows its pinned procedural core binds, where a
   * routing resolver reads the first prompt).
   */
  readonly tools?: ToolSet | ((turn: ToolContext) => ToolSet | Promise<ToolSet>);
  readonly toolApproval?: ToolLoopAgentSettings<TurnOptions, ToolSet>["toolApproval"];
  readonly stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
  readonly memory?: SessionMemory;
  readonly learning?: TurnLearning;
  /**
   * A (larger, often hosted) model to consult on each turn: its notes on what was asked
   * go into the instructions as reference, retrieval for a small local model. Best effort.
   */
  readonly consult?: LanguageModel;
  /** Prepares each step (see StepHook), e.g. with procedural graph guidance. */
  readonly step?: StepHook;
}): ToolLoopAgent<TurnOptions, ToolSet> {
  return new SessionAgent({
    model: options.model,
    ...(options.tools && typeof options.tools !== "function" ? { tools: options.tools } : {}),
    ...(options.toolApproval ? { toolApproval: options.toolApproval } : {}),
    ...(options.stopWhen ? { stopWhen: options.stopWhen } : {}),
    maxRetries: 0,
    callOptionsSchema: TurnOptionsSchema,
    prepareCall: async ({ options: turn, ...call }) => {
      const messages = call.messages ?? [];
      const user = lastUser(messages);
      const said = textOf(user);
      const playbook = options.learning && said ? await options.learning.recall(said).then((r) => r.playbook, () => "") : "";
      const memories = options.memory && said ? await options.memory.recall(said, { excludeSession: turn.sessionId, limit: 3, kinds: ["user", "assistant"] }).catch(() => []) : [];
      const notes = options.consult && said ? await consultOn(options.consult, said) : "";
      const instructions = [
        typeof options.instructions === "function" ? await options.instructions() : options.instructions,
        playbook,
        memories.length ? `Relevant memories from earlier sessions:\n${memories.map((m) => `- ${m.text}`).join("\n")}` : "",
        notes ? `Reference notes from a larger model (check them before relying on them):\n${notes}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const tools = typeof options.tools === "function" ? await options.tools({ ...scopeOf(turn), messages: conversationOf(call) }) : undefined;
      // Every call names its daemon session: a steered model keeps that session's behavior state.
      const scope = turn.cwd === undefined ? undefined : projectScope(turn.cwd);
      const providerOptions = { ...call.providerOptions, [HARNESS]: { ...call.providerOptions?.[HARNESS], session: turn.sessionId, ...(scope === undefined ? {} : { scope }) } };
      return {
        ...call,
        providerOptions,
        ...(instructions ? { instructions } : {}),
        ...(options.vision && hasImage(user) ? { model: options.vision } : {}),
        ...(tools ? { tools } : {}),
        ...(options.step ? { prepareStep: preparing(options.step, turn, Object.keys(tools ?? call.tools ?? {})) } : {}),
      };
    },
  }, options.step);
}

const CONSULT = "Give brief factual notes that help answer the request: facts, figures, names and caveats. Do not answer in full; another model will.";

/** A consulted model's notes on a request, or nothing when it fails or has none. */
async function consultOn(model: LanguageModel, said: string): Promise<string> {
  try {
    const result = streamText({ model, instructions: CONSULT, prompt: [{ role: "user", content: [{ type: "text", text: said }] }], maxRetries: 0 });
    return (await result.text).trim();
  } catch {
    return "";
  }
}

/** Remember each turn in session memory: what was said and what was replied. */
export function rememberTurns(memory: SessionMemory): (turn: Turn) => Promise<unknown> {
  return async ({ sessionId, said, reply }) =>
    memory.remember(
      [
        { text: said, sessionId, kind: "user" },
        { text: reply, sessionId, kind: "assistant" },
      ].filter((item) => item.text !== ""),
    );
}
