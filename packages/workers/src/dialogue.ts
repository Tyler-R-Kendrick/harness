import type {
  JSONObject,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { constrain, constraintOf, HARNESS, MODEL_HEADER, readTemplate, scopeOf, sessionOf, StreamParts, usage } from "@harness/cognitive";
import type { TemplateConstraint } from "@harness/cognitive";
import type { Decision, Dialogue, Outcome, Step, ToolResult } from "@harness/dialogue";

/** Whether a call asks for a shape of its own (a constraint, a JSON response, a forced tool): the work of a program, not a chat turn. */
const shaped = (options: LanguageModelV4CallOptions): boolean =>
  constraintOf(options) !== undefined || options.toolChoice?.type === "required" || options.toolChoice?.type === "tool";

/**
 * The step a model call answers, when it is a chat turn a script could answer: the
 * prompt ends with the user's words (all text), or with the result of one tool call
 * made for them. Calls that ask for a shape of their own (a constraint, a JSON response,
 * a forced tool) are not steps.
 */
export function stepOf(options: LanguageModelV4CallOptions): Step | undefined {
  if (shaped(options)) return undefined;
  const { prompt } = options;
  const user = [...prompt].reverse().find((m) => m.role === "user");
  if (user?.role !== "user" || user.content.some((p) => p.type !== "text")) return undefined;
  const utterance = user.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  if (utterance.trim() === "") return undefined;
  const session = sessionOf(options.providerOptions);
  const scope = scopeOf(options.providerOptions);
  const base = { ...(session === undefined ? {} : { sessionId: session }), ...(scope === undefined ? {} : { scope }), utterance };
  const last = prompt[prompt.length - 1]!;
  if (last === user) return base;
  if (last.role !== "tool" || last.content.length !== 1 || last.content[0]!.type !== "tool-result") return undefined;
  const result = last.content[0]!;
  const output = result.output.type === "json" || result.output.type === "text" ? result.output.value : undefined;
  const call = prompt.flatMap((m) => (m.role === "assistant" ? m.content : [])).find((p) => p.type === "tool-call" && p.toolCallId === result.toolCallId);
  if (output === undefined || call?.type !== "tool-call") return undefined;
  // Tool inputs and outputs in a prompt are JSON.
  return { ...base, result: { tool: result.toolName, input: call.input as ToolResult["input"], output: output as ToolResult["output"] } };
}

type Answer = Exclude<Decision, { kind: "pass" }>;
type Generated = Extract<Decision, { kind: "generate" }>;

/**
 * What a scripted answer says about itself, as provider metadata `harness.dialogue`: the
 * script, or the flow, that answered, and how; for generated holes, whether the model's
 * reply fits the template (a model that does not enforce it may not have kept to it).
 */
const scriptMetadata = (decision: Answer, fitted?: boolean): SharedV4ProviderMetadata => ({
  [HARNESS]: {
    dialogue: {
      ...(decision.kind === "flow" ? { flow: decision.flow } : {}),
      ...(decision.script === undefined ? {} : { script: decision.script }),
      kind: decision.kind,
      match: { ...decision.match },
      ...(fitted === undefined ? {} : { fitted }),
    } as JSONObject,
  },
});

/** The response header naming what answered: `dialogue/<script>`, or `dialogue/flow/<flow>`. */
const answeredBy = (decision: Answer) => ({ [MODEL_HEADER]: decision.kind === "flow" ? `dialogue/flow/${decision.flow}` : `dialogue/${decision.script}` });

const withMetadata = (metadata: SharedV4ProviderMetadata | undefined, decision: Generated, text: string): SharedV4ProviderMetadata => ({
  ...metadata,
  [HARNESS]: { ...metadata?.[HARNESS], ...scriptMetadata(decision, fits(decision.template, text))[HARNESS] },
});

/** Whether a reply follows a template. */
function fits(template: TemplateConstraint, text: string): boolean {
  try {
    readTemplate(template, text.trim());
    return true;
  } catch {
    return false;
  }
}

/**
 * Call options asking for a script's template: as a constraint, for models that enforce
 * one, and as an instruction after the call's own system messages, for models that do
 * not. The call's own provider options (its session among them) are kept.
 */
const templated = (options: LanguageModelV4CallOptions, decision: Generated): LanguageModelV4CallOptions => {
  const at = options.prompt.findIndex((m) => m.role !== "system");
  return {
    ...options,
    prompt: [...options.prompt.slice(0, at), { role: "system", content: decision.instruction }, ...options.prompt.slice(at)],
    providerOptions: { ...options.providerOptions, [HARNESS]: { ...options.providerOptions?.[HARNESS], ...constrain(decision.template).providerOptions[HARNESS] } },
  };
};

/**
 * How the model answered a step, to learn from: it acted when it called tools; its reply
 * when it finished one; nothing when it failed or was cut short.
 */
function outcomeOf(content: readonly LanguageModelV4Content[], finish: LanguageModelV4FinishReason): Outcome {
  if (content.some((p) => p.type === "tool-call")) return { acted: true };
  return finish.unified === "stop" ? content.map((p) => (p.type === "text" ? p.text : "")).join("") : undefined;
}

type Decided = { readonly step: Step; readonly decision: Decision };

/**
 * The dialogue's decision on a call: a step's, or none. A user turn the dialogue cannot
 * read (it has a file) ends its session's form and context, since the dialogue did not
 * see it; a call a program shaped is not a turn and leaves the session as it was.
 */
async function decide(dialogue: Dialogue, options: LanguageModelV4CallOptions): Promise<Decided | undefined> {
  try {
    if (shaped(options)) return undefined;
    const step = stepOf(options);
    if (step !== undefined) return { step, decision: await dialogue.respond(step) };
    const session = sessionOf(options.providerOptions);
    if (session !== undefined && options.prompt.at(-1)?.role === "user") dialogue.skip(session);
  } catch {
    // A dialogue that fails decides nothing, and the model answers.
  }
  return undefined;
}

/** A 32-bit FNV-1a hash of a text: a short name for a whole prompt. */
function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Decisions whose model call has not yet succeeded, by session: a call the AI SDK retries
 * (the same prompt again, built anew) gets the decision it had, so a form or a flow moves
 * on once per turn. As many sessions are kept as the dialogue keeps, the least recent
 * going first.
 */
class Decisions {
  readonly #dialogue: Dialogue;
  readonly #pending = new Map<string, { readonly key: string; readonly decided: Promise<Decided | undefined> }>();

  constructor(dialogue: Dialogue) {
    this.#dialogue = dialogue;
  }

  decide(options: LanguageModelV4CallOptions): Promise<Decided | undefined> {
    const call = Decisions.#call(options);
    if (call === undefined) return decide(this.#dialogue, options);
    const last = this.#pending.get(call.session);
    if (last?.key === call.key) return last.decided;
    const decided = decide(this.#dialogue, options);
    this.#pending.delete(call.session);
    this.#pending.set(call.session, { key: call.key, decided });
    for (const oldest of this.#pending.keys()) {
      if (this.#pending.size <= this.#dialogue.settings.sessions) break;
      this.#pending.delete(oldest);
    }
    return decided;
  }

  /** The call succeeded: the next call in its session is a new turn. */
  done(options: LanguageModelV4CallOptions): void {
    const call = Decisions.#call(options);
    if (call !== undefined && this.#pending.get(call.session)?.key === call.key) this.#pending.delete(call.session);
  }

  /** A turn's session and what tells it from the session's other calls (its whole prompt); none for a call a program shaped. */
  static #call(options: LanguageModelV4CallOptions): { readonly session: string; readonly key: string } | undefined {
    try {
      if (shaped(options)) return undefined;
      const prompt = JSON.stringify(options.prompt);
      return { session: sessionOf(options.providerOptions) ?? "", key: `${prompt.length}:${fnv(prompt)}` };
    } catch {
      // A call whose options cannot be read is not a turn the dialogue decides.
      return undefined;
    }
  }
}

/** What a flow said before handing the turn to the model, first in a generated response. */
const saidFirst = <T extends { readonly content: readonly LanguageModelV4Content[] }>(said: string | undefined, result: T): T =>
  said === undefined ? result : { ...result, content: [{ type: "text", text: `${said}\n` }, ...result.content] };

/** What a flow said before handing the turn to the model, first in a streamed response (after the stream starts). */
function sayingFirst(said: string | undefined): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  let first = true;
  return new TransformStream({
    transform(part, controller) {
      if (first && said !== undefined) {
        if (part.type === "stream-start") controller.enqueue(part);
        const id = "dialogue-said";
        for (const p of [{ type: "text-start", id }, { type: "text-delta", id, delta: `${said}\n` }, { type: "text-end", id }] as const) controller.enqueue(p);
        first = false;
        if (part.type === "stream-start") return;
      }
      first = false;
      controller.enqueue(part);
    },
  });
}

/**
 * A dialogue in front of a model, as AI SDK middleware (`wrapLanguageModel`): a step a
 * script or a flow answers is answered with no model call (header `x-harness-model:
 * dialogue/<script>` or `dialogue/flow/<flow>`, metadata `harness.dialogue`); a script with generated holes has the
 * model write only those, under its template; every other step goes to the model, and
 * its reply is observed, so the dialogue builds scripts from what the model says.
 */
export function dialogueMiddleware(dialogue: Dialogue): LanguageModelV4Middleware {
  const decisions = new Decisions(dialogue);
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const decided = await decisions.decide(params);
      const answered = <T>(result: T): T => {
        decisions.done(params);
        return result;
      };
      if (decided === undefined) return answered(await doGenerate());
      const { step, decision } = decided;
      if (decision.kind === "pass") {
        const result = answered(await doGenerate());
        dialogue.observe(step, decision, outcomeOf(result.content, result.finishReason));
        return saidFirst(decision.said, result);
      }
      if (decision.kind === "generate") {
        const result = answered(await model.doGenerate(templated(params, decision)));
        const text = result.content.map((p) => (p.type === "text" ? p.text : "")).join("");
        return saidFirst(decision.said, { ...result, providerMetadata: withMetadata(result.providerMetadata, decision, text) });
      }
      return answered({
        content: [{ type: "text", text: decision.text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(0, 0),
        providerMetadata: scriptMetadata(decision),
        response: { headers: answeredBy(decision) },
        warnings: [],
      });
    },
    wrapStream: async ({ doStream, params, model }) => {
      const decided = await decisions.decide(params);
      const answered = <T>(result: T): T => {
        decisions.done(params);
        return result;
      };
      if (decided === undefined) return answered(await doStream());
      const { step, decision } = decided;
      if (decision.kind === "pass") {
        const result = answered(await doStream());
        const content: LanguageModelV4Content[] = [];
        let finish: LanguageModelV4FinishReason = { unified: "other", raw: undefined };
        let failed = false;
        const observing = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "text-delta") content.push({ type: "text", text: part.delta });
            else if (part.type === "tool-call") content.push(part);
            else if (part.type === "finish") finish = part.finishReason;
            else if (part.type === "error") failed = true;
            controller.enqueue(part);
          },
          flush() {
            dialogue.observe(step, decision, failed ? undefined : outcomeOf(content, finish));
          },
        });
        return { ...result, stream: result.stream.pipeThrough(observing).pipeThrough(sayingFirst(decision.said)) };
      }
      if (decision.kind === "generate") {
        const result = answered(await model.doStream(templated(params, decision)));
        let text = "";
        const naming = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "text-delta") text += part.delta;
            controller.enqueue(part.type === "finish" ? { ...part, providerMetadata: withMetadata(part.providerMetadata, decision, text) } : part);
          },
        });
        return { ...result, stream: result.stream.pipeThrough(naming).pipeThrough(sayingFirst(decision.said)) };
      }
      const parts = new StreamParts();
      const all: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }, ...parts.push({ type: "text", text: decision.text }), ...parts.end({ usage: usage(0, 0), providerMetadata: scriptMetadata(decision) })];
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of all) controller.enqueue(part);
          controller.close();
        },
      });
      return answered({ stream, response: { headers: answeredBy(decision) } });
    },
  };
}
