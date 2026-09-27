import { streamText, ToolLoopAgent } from "ai";
import { HARNESS } from "@harness/cognitive";
import type { LanguageModel, ModelMessage, StopCondition, ToolLoopAgentSettings, ToolSet } from "ai";
import { z } from "zod";
import type { Turn, TurnOptions } from "./agent.ts";

/** Session memory (see @harness/memory): related items are recalled into a turn, and turns are remembered. */
export interface SessionMemory {
  recall(query: string, options: { readonly excludeSession?: string; readonly limit?: number; readonly kinds?: readonly string[] }): Promise<readonly { readonly text: string }[]>;
  remember(items: readonly { readonly text: string; readonly sessionId?: string; readonly kind?: string }[]): Promise<unknown>;
}

/** Learning (see @harness/learning): the lessons for what was asked, as a playbook. */
export interface TurnLearning {
  recall(task: string): Promise<{ readonly playbook: string }>;
}

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
  readonly instructions?: string;
  /** Tools, or a function giving them anew each turn (e.g. a workflow library's, which grows as learning builds tools). */
  readonly tools?: ToolSet | (() => ToolSet | Promise<ToolSet>);
  readonly toolApproval?: ToolLoopAgentSettings<TurnOptions, ToolSet>["toolApproval"];
  readonly stopWhen?: StopCondition<ToolSet> | StopCondition<ToolSet>[];
  readonly memory?: SessionMemory;
  readonly learning?: TurnLearning;
  /**
   * A (larger, often hosted) model to consult on each turn: its notes on what was asked
   * go into the instructions as reference, retrieval for a small local model. Best effort.
   */
  readonly consult?: LanguageModel;
}): ToolLoopAgent<TurnOptions, ToolSet> {
  return new ToolLoopAgent<TurnOptions, ToolSet>({
    model: options.model,
    ...(options.tools && typeof options.tools !== "function" ? { tools: options.tools } : {}),
    ...(options.toolApproval ? { toolApproval: options.toolApproval } : {}),
    ...(options.stopWhen ? { stopWhen: options.stopWhen } : {}),
    maxRetries: 0,
    callOptionsSchema: z.object({ sessionId: z.string() }),
    prepareCall: async ({ options: turn, ...call }) => {
      const user = lastUser(call.messages ?? []);
      const said = textOf(user);
      const playbook = options.learning && said ? await options.learning.recall(said).then((r) => r.playbook, () => "") : "";
      const memories = options.memory && said ? await options.memory.recall(said, { excludeSession: turn.sessionId, limit: 3, kinds: ["user", "assistant"] }).catch(() => []) : [];
      const notes = options.consult && said ? await consultOn(options.consult, said) : "";
      const instructions = [
        options.instructions,
        playbook,
        memories.length ? `Relevant memories from earlier sessions:\n${memories.map((m) => `- ${m.text}`).join("\n")}` : "",
        notes ? `Reference notes from a larger model (check them before relying on them):\n${notes}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const tools = typeof options.tools === "function" ? await options.tools() : undefined;
      // Every call names its daemon session: a steered model keeps that session's behavior state.
      const providerOptions = { ...call.providerOptions, [HARNESS]: { ...call.providerOptions?.[HARNESS], session: turn.sessionId } };
      return { ...call, providerOptions, ...(instructions ? { instructions } : {}), ...(options.vision && hasImage(user) ? { model: options.vision } : {}), ...(tools ? { tools } : {}) };
    },
  });
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
