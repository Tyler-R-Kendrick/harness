import { experimental_evaluate, generateText, jsonSchema, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import type { Experimental_EvaluationModel as EvaluationModel, LanguageModel } from "ai";
import { ax, AxGenerateError, AxMockAIService, f, optimize } from "@ax-llm/ax";
import type { AxChatRequest, AxChatResponse } from "@ax-llm/ax";
import { ProbabilitySchema } from "@harness/cognitive";
import type { CriticRequest, CriticVerdict, ProposalRequest } from "./evolution.ts";
import { TUNING_EXAMPLES } from "./schemas.ts";
import type { Settings } from "./schemas.ts";
import { ProposalSchema } from "./surface.ts";
import type { Proposal } from "./surface.ts";

const badAnswer = (e: unknown): e is Error => NoObjectGeneratedError.isInstance(e) || NoOutputGeneratedError.isInstance(e);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Ax publishes no adapter that accepts an AI SDK model (its AI SDK package wraps Ax
 * the other way). `AxMockAIService` is the chat function Ax will call, so the harness
 * model stays the model and Ax owns the signature, the prompt and GEPA.
 */
function languageModelService(model: LanguageModel, maxTokens: number, transport: WeakSet<Error>): AxMockAIService<string> {
  return new AxMockAIService({
    // Stryker disable next-line StringLiteral: equivalent; the service name only labels Ax's own metrics, traces and unsupported-feature errors, none of which a service with no tools and no streaming reaches
    name: "ai-sdk",
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent; with structuredOutputModes given Ax reads neither structuredOutputs nor functions (without it both default to on), the program has no tools, and AxMockAIService.chat never reads streaming, so no variant changes a request or an answer
    features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ["native"] },
    chatResponse: async (req?: Readonly<AxChatRequest<unknown>>): Promise<AxChatResponse> => {
      // Stryker disable next-line ConditionalExpression,StringLiteral,CallExpression: equivalent; AxMockAIService.chat always passes the request it was given (it is optional only in the type of its chatResponse), so the guard cannot fire
      if (req === undefined) throw new Error("Ax chat request is required");
      const format = req.responseFormat;
      const declared =
        format?.type === "json_schema"
          ? // Stryker disable next-line OptionalChaining: equivalent; Ax's json_schema response format always carries its schema wrapper, so this `?.` never meets undefined
            (format.schema?.schema ?? format.schema)
          : undefined;
      const prompt = promptOf(req.chatPrompt);
      try {
        const { text } = await generateText({
          model,
          ...prompt,
          // Stryker disable next-line OptionalChaining: equivalent; Ax sets a modelConfig object on every request it sends (at least `{}`)
          maxOutputTokens: req.modelConfig?.maxTokens ?? maxTokens,
          maxRetries: 0,
          ...(declared ? { output: Output.object({ schema: jsonSchema(declared) }) } : {}),
        });
        return { results: [{ index: 0, content: text, finishReason: "stop" }] };
      } catch (e) {
        // Ax wraps whatever the service throws, and passes some errors on as they are; this
        // marks the ones that came from the model or the transport, so the proposer can
        // tell them from what Ax says about an answer. A model that answered badly is not
        // one of them: that answer is the proposer's reason to give back.
        const failure = e instanceof Error ? e : new Error(String(e));
        if (!badAnswer(failure)) transport.add(failure);
        throw failure;
      }
    },
  });
}

/** AI SDK takes system text as `instructions`; a system role in `messages` is rejected. */
export function promptOf(prompt: AxChatRequest["chatPrompt"]): { instructions?: string; messages: { role: "user" | "assistant"; content: string }[] } {
  const instructions = prompt.flatMap((message) => (message.role === "system" ? [message.content] : [])).join("\n\n");
  const messages = prompt.flatMap((message) => ((message.role === "user" || message.role === "assistant") && typeof message.content === "string" ? [{ role: message.role, content: message.content }] : []));
  return instructions ? { instructions, messages } : { messages };
}

function proposalProgram(system: string) {
  // Field types, not the shared zod schema: Ax's converter caches on the schema object
  // and a second program then trips over that cache.
  return ax(
    f()
      .input("roundRequest", f.string("The round's request as JSON: the incumbent, the evidence, and the constraints."))
      .output("summary", f.string("One line saying what the proposal changes."))
      .output("edits", f.json("One edit: id, hypothesis, targets, predicted, ops.").array())
      .description(system)
      .useStructured()
      .build(),
    // The program's own limit is what GEPA's forward calls run under (they pass none): no error-correction retry.
    { maxRetries: 0 },
  );
}

/** One edit as Ax may hand it back: an object, or a JSON string of one. What is not JSON stays as it is. */
function decode(edit: unknown): unknown {
  if (typeof edit !== "string") return edit;
  try {
    return JSON.parse(edit);
  }
  // Stryker disable next-line BlockStatement: equivalent; a string that is not JSON stays a string, and an empty block leaves undefined: the proposal schema refuses either as an edit
  catch {
    return edit;
  }
}

/** Either must be a proposal; anything else is not. */
export function readProposal(prediction: unknown): Proposal | undefined {
  const { summary, edits } = (prediction ?? {}) as { summary?: unknown; edits?: unknown };
  if (!Array.isArray(edits)) return undefined;
  const parsed = ProposalSchema.safeParse({ summary, edits: edits.map(decode) });
  return parsed.success ? parsed.data : undefined;
}

/**
 * GEPA over the signature prompt, once per proposer. The run has no labeled proposals,
 * so this is the reflective search and not a bootstrap of gold demos. The metric is
 * the proposal constraint: it parses, and it stays inside the round's edit budget.
 */
async function tune(program: ReturnType<typeof proposalProgram>, service: AxMockAIService<string>, request: ProposalRequest, settings: Settings["proposer"]): Promise<void> {
  const roundRequest = JSON.stringify(request);
  const examples = Array.from({ length: TUNING_EXAMPLES }, () => ({ roundRequest }));
  const result = await optimize(program, examples, ({ prediction }) => {
    const proposal = readProposal(prediction);
    return proposal !== undefined && proposal.edits.length <= request.budget ? 1 : 0;
  }, {
    studentAI: service,
    maxMetricCalls: settings.optimize.maxMetricCalls,
    numTrials: settings.optimize.maxMetricCalls,
    seed: settings.optimize.seed,
    sampleCount: 1,
    earlyStoppingTrials: 1,
    bootstrap: false,
    verbose: false,
    optimizerLogger: () => {},
  });
  // Stryker disable next-line ConditionalExpression,CallExpression: equivalent; optimize() applies the optimized program itself (its apply option defaults on) and always returns one, so this only repeats that
  if (result.optimizedProgram) program.applyOptimization(result.optimizedProgram);
}

/** What Ax raised about an answer, as the reason to send back: the error it wrapped when it wrapped one, else the error itself. */
export const reasonOf = (e: unknown): string => message(e instanceof AxGenerateError && e.cause instanceof Error ? e.cause : e);

/**
 * A proposer on any AI SDK language model. Ax compiles the prompt from a signature
 * and the system text, and constrains the answer to the proposal schema. When the
 * metric-call cap is above zero, Ax's GEPA tunes that prompt once; later requests
 * use the tuned program. An answer that is not a proposal comes back as the reason,
 * which the round sends to the next attempt: that is whatever Ax raises about the
 * answer (it is not JSON, a field is missing or ill-typed) and the AI SDK's own
 * errors for one. Only a failure of the model or the transport, which is what the
 * service recorded as thrown by its own call, is thrown, and so is an error of the
 * optimizer itself.
 */
export function modelProposer(model: LanguageModel, settings: Settings["proposer"]): (request: ProposalRequest) => Promise<unknown> {
  const program = proposalProgram(settings.system);
  const transport = new WeakSet<Error>();
  const service = languageModelService(model, settings.maxTokens, transport);
  let tuned: Promise<void> | undefined;
  const failureOf = (e: unknown): Error | undefined => [e, e instanceof Error ? e.cause : undefined].find((x): x is Error => x instanceof Error && transport.has(x));
  return async (request) => {
    if (settings.optimize.maxMetricCalls > 0) {
      tuned ??= tune(program, service, request, settings);
      await tuned;
    }
    try {
      // The request's own token cap is the service's, and its retry limit the program's.
      const output = await program.forward(service, { roundRequest: JSON.stringify(request) });
      return readProposal(output) ?? "the answer was not a proposal";
    } catch (e) {
      const failure = failureOf(e);
      if (failure) throw failure;
      return reasonOf(e);
    }
  };
}

/**
 * The model half of the leakage screen, on any AI SDK evaluation model: asked whether the
 * edits encode knowledge only these tasks need, it refuses them when the probability
 * reaches the threshold. A critic that cannot answer refuses too: the screen runs before
 * any evaluation is spent, and an unscreened candidate is what it exists to stop. Use a
 * judge from another family than the proposer's model where one is reachable: a critic
 * that shares the proposer's blind spots screens little (the paper uses one model for
 * both).
 */
export function judgeCritic(model: EvaluationModel, settings: Settings["critic"]): (request: CriticRequest) => Promise<CriticVerdict> {
  return async ({ edits, examples }) => {
    try {
      const { answers } = await experimental_evaluate({
        model,
        maxRetries: 0,
        state: { edits: edits.map((e) => ({ hypothesis: e.hypothesis, targets: e.targets, changes: e.changes.map((c) => ({ document: c.document, wrote: c.wrote })) })), examples: examples.map((t) => t.text) },
        questions: { specific: { type: "boolean", instructions: settings.question } },
      });
      const p = ProbabilitySchema.parse(answers.specific.probability);
      return p >= settings.threshold ? { accept: false, reasons: [`it reads as specific to the evolve tasks (p = ${p.toFixed(2)})`] } : { accept: true, reasons: [] };
    } catch (e) {
      return { accept: false, reasons: [`the critic could not judge it: ${message(e)}`] };
    }
  };
}
