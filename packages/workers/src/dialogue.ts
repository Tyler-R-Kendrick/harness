import type { JSONObject, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4Middleware, LanguageModelV4StreamPart, SharedV4ProviderMetadata } from "@ai-sdk/provider";
import { constrain, constraintOf, HARNESS, MODEL_HEADER, sessionOf, StreamParts, usage } from "@harness/cognitive";
import type { TemplateConstraint } from "@harness/cognitive";
import type { Decision, Dialogue, Step, ToolResult } from "@harness/dialogue";

/**
 * The step a model call answers, when it is a chat turn a script could answer: the
 * prompt ends with the user's words (all text), or with the result of one tool call
 * made for them. Calls that ask for a shape of their own (a constraint, a JSON response,
 * a forced tool) are not steps.
 */
export function stepOf(options: LanguageModelV4CallOptions): Step | undefined {
  if (constraintOf(options) !== undefined || options.toolChoice?.type === "required" || options.toolChoice?.type === "tool") return undefined;
  const { prompt } = options;
  const user = [...prompt].reverse().find((m) => m.role === "user");
  if (user?.role !== "user" || user.content.some((p) => p.type !== "text")) return undefined;
  const utterance = user.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  if (utterance.trim() === "") return undefined;
  const session = sessionOf(options.providerOptions);
  const base = { ...(session === undefined ? {} : { sessionId: session }), utterance };
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

/** What a scripted answer says about itself, as provider metadata `harness.dialogue`. */
const scriptMetadata = (decision: Exclude<Decision, { kind: "pass" }>): SharedV4ProviderMetadata => ({
  [HARNESS]: { dialogue: { script: decision.script, kind: decision.kind, match: { ...decision.match } } as JSONObject },
});

const withMetadata = (metadata: SharedV4ProviderMetadata | undefined, decision: Exclude<Decision, { kind: "pass" }>): SharedV4ProviderMetadata => ({
  ...metadata,
  [HARNESS]: { ...metadata?.[HARNESS], ...scriptMetadata(decision)[HARNESS] },
});

/** Call options asking for a script's template, keeping the call's own provider options (its session among them). */
const templated = (options: LanguageModelV4CallOptions, template: TemplateConstraint): LanguageModelV4CallOptions => ({
  ...options,
  providerOptions: { ...options.providerOptions, [HARNESS]: { ...options.providerOptions?.[HARNESS], ...constrain(template).providerOptions[HARNESS] } },
});

/** The model's reply in a response: its text, or nothing when it called tools. */
const replyOf = (content: readonly LanguageModelV4Content[]): string | undefined =>
  content.some((p) => p.type === "tool-call") ? undefined : content.map((p) => (p.type === "text" ? p.text : "")).join("");

/** The dialogue's decision on a step; a dialogue that fails decides nothing, and the model answers. */
async function decide(dialogue: Dialogue, step: Step | undefined): Promise<Decision | undefined> {
  if (step === undefined) return undefined;
  try {
    return await dialogue.respond(step);
  } catch {
    return undefined;
  }
}

/**
 * A dialogue in front of a model, as AI SDK middleware (`wrapLanguageModel`): a step a
 * script answers is answered with no model call (header `x-harness-model:
 * dialogue/<script>`, metadata `harness.dialogue`); a script with generated holes has the
 * model write only those, under its template; every other step goes to the model, and
 * its reply is observed, so the dialogue builds scripts from what the model says.
 */
export function dialogueMiddleware(dialogue: Dialogue): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const step = stepOf(params);
      const decision = await decide(dialogue, step);
      if (decision === undefined) return doGenerate();
      if (decision.kind === "pass") {
        const result = await doGenerate();
        dialogue.observe(step!, decision, replyOf(result.content));
        return result;
      }
      if (decision.kind === "generate") {
        const result = await model.doGenerate(templated(params, decision.template));
        return { ...result, providerMetadata: withMetadata(result.providerMetadata, decision) };
      }
      return {
        content: [{ type: "text", text: decision.text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(0, 0),
        providerMetadata: scriptMetadata(decision),
        response: { headers: { [MODEL_HEADER]: `dialogue/${decision.script}` } },
        warnings: [],
      };
    },
    wrapStream: async ({ doStream, params, model }) => {
      const step = stepOf(params);
      const decision = await decide(dialogue, step);
      if (decision === undefined) return doStream();
      if (decision.kind === "pass") {
        const result = await doStream();
        let text = "";
        let taught = true;
        const observing = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "text-delta") text += part.delta;
            else if (part.type === "tool-call" || part.type === "error") taught = false;
            controller.enqueue(part);
          },
          flush() {
            dialogue.observe(step!, decision, taught ? text : undefined);
          },
        });
        return { ...result, stream: result.stream.pipeThrough(observing) };
      }
      if (decision.kind === "generate") {
        const result = await model.doStream(templated(params, decision.template));
        const naming = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            controller.enqueue(part.type === "finish" ? { ...part, providerMetadata: withMetadata(part.providerMetadata, decision) } : part);
          },
        });
        return { ...result, stream: result.stream.pipeThrough(naming) };
      }
      const parts = new StreamParts();
      const all: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }, ...parts.push({ type: "text", text: decision.text }), ...parts.end({ usage: usage(0, 0), providerMetadata: scriptMetadata(decision) })];
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of all) controller.enqueue(part);
          controller.close();
        },
      });
      return { stream, response: { headers: { [MODEL_HEADER]: `dialogue/${decision.script}` } } };
    },
  };
}
