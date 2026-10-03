import { experimental_evaluate, generateText, jsonSchema, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import type { Experimental_EvaluationModel as EvaluationModel, LanguageModel } from "ai";
import { ax, AxGenerateError, AxMockAIService, f, optimize } from "@ax-llm/ax";
import type { AxChatRequest, AxChatResponse } from "@ax-llm/ax";
import { ProbabilitySchema } from "@harness/cognitive";
import type { CriticRequest, CriticVerdict, ProposalRequest } from "./evolution.ts";
import type { Settings } from "./schemas.ts";
import { ProposalSchema } from "./surface.ts";
import type { Proposal } from "./surface.ts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Ax publishes no adapter that accepts an AI SDK model (its AI SDK package wraps Ax
 * the other way). `AxMockAIService` is the chat function Ax will call, so the harness
 * model stays the model and Ax owns the signature, the prompt and GEPA.
 */
function languageModelService(model: LanguageModel, maxTokens: number): AxMockAIService<string> {
  return new AxMockAIService({
    // Stryker disable next-line StringLiteral: equivalent; the service name only labels Ax's own metrics, traces and unsupported-feature errors, none of which a service with no tools and no streaming reaches
    name: "ai-sdk",
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent; with structuredOutputModes given Ax reads neither structuredOutputs nor functions (without it both default to on), the program has no tools, and AxMockAIService.chat never reads streaming, so no variant changes a request or an answer
    features: { functions: false, streaming: false, structuredOutputs: true, structuredOutputModes: ["native"] },
    chatResponse: async (req?: Readonly<AxChatRequest<unknown>>): Promise<AxChatResponse> => {
      // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent; AxMockAIService.chat always passes the request it was given (it is optional only in the type of its chatResponse), so the guard cannot fire
      if (req === undefined) throw new Error("Ax chat request is required");
      // Stryker disable next-line OptionalChaining: equivalent; Ax's json_schema response format always carries its schema wrapper, so the second `?.` never meets undefined (the first one is killed by the optimizer's reflection calls, which have no response format)
      const declared = req.responseFormat?.type === "json_schema" ? (req.responseFormat.schema?.schema ?? req.responseFormat.schema) : undefined;
      const { instructions, messages } = promptOf(req.chatPrompt);
      const { text } = await generateText({
        model,
        messages,
        // Stryker disable next-line ConditionalExpression: equivalent; `{ instructions: undefined }` is the same call to generateText as leaving the option out
        ...(instructions === undefined ? {} : { instructions }),
        // Stryker disable next-line OptionalChaining: equivalent; Ax sets a modelConfig object on every request it sends (at least `{}`)
        maxOutputTokens: req.modelConfig?.maxTokens ?? maxTokens,
        maxRetries: 0,
        ...(declared ? { output: Output.object({ schema: jsonSchema(declared) }) } : {}),
      });
      return { results: [{ index: 0, content: text, finishReason: "stop" }] };
    },
  });
}

/** AI SDK takes system text as `instructions`; a system role in `messages` is rejected. */
function promptOf(prompt: AxChatRequest["chatPrompt"]): { instructions?: string; messages: { role: "user" | "assistant"; content: string }[] } {
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent; the content-type check cannot differ (Ax's system prompt is always a string) and Ax sends exactly one system message, so the separator never joins anything (the role check and the rest of the line are killed by RS23.40)
  const instructions = prompt.flatMap((message) => (message.role === "system" && typeof message.content === "string" ? [message.content] : [])).join("\n\n");
  const messages = prompt.flatMap((message) => {
    // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent; Ax sends no assistant turn (those carry few-shot demos, which bootstrap: false leaves empty, and error-correction retries, which maxRetries: 0 forbids) and its user turns are strings
    if ((message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") return [];
    return [{ role: message.role, content: message.content }];
  });
  // Stryker disable next-line ObjectLiteral: equivalent for the branch without instructions: every Ax prompt starts with a system message, so it never runs (the other branch is killed by RS23.40)
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
    // Stryker disable next-line ObjectLiteral: equivalent; forward() below passes maxRetries: 0 on every call, so the program's own option repeats it
    { maxRetries: 0 },
  );
}

/** Ax may hand each edit back as an object or as a JSON string. Either must be a proposal. */
function readProposal(prediction: unknown): Proposal | undefined {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent; Ax validates the signature's fields before it returns (summary a string, edits an array, else it throws and the catch below handles it), and the optimizer scores only outputs that passed, so this only narrows `unknown` for the compiler
  if (typeof prediction !== "object" || prediction === null || !("summary" in prediction) || !("edits" in prediction) || !Array.isArray(prediction.edits)) return undefined;
  let edits: unknown[];
  try {
    edits = prediction.edits.map((edit) => (typeof edit === "string" ? JSON.parse(edit) : edit));
  // Stryker disable next-line BlockStatement: equivalent; with the catch empty `edits` stays unset, and the schema parse below then refuses the missing array exactly as the return does
  } catch {
    return undefined;
  }
  const parsed = ProposalSchema.safeParse({ summary: prediction.summary, edits });
  return parsed.success ? parsed.data : undefined;
}

/**
 * GEPA over the signature prompt, once per proposer. The run has no labeled proposals,
 * so this is the reflective search and not a bootstrap of gold demos. The metric is
 * the proposal constraint: it parses, and it stays inside the round's edit budget.
 */
async function tune(program: ReturnType<typeof proposalProgram>, service: AxMockAIService<string>, request: ProposalRequest, settings: Settings["proposer"]): Promise<void> {
  const roundRequest = JSON.stringify(request);
  const result = await optimize(program, [{ roundRequest }, { roundRequest }], ({ prediction }) => {
    const proposal = readProposal(prediction);
    // Stryker disable next-line ConditionalExpression: equivalent for the undefined check: a proposal that is not one makes the metric throw instead of return 0, and Ax scores a metric that throws as 0 and prints nothing (the other conditions on this line are killed by RS23.60-RS23.62)
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

const badAnswer = (e: unknown): e is Error => NoObjectGeneratedError.isInstance(e) || NoOutputGeneratedError.isInstance(e);

/**
 * A proposer on any AI SDK language model. Ax compiles the prompt from a signature
 * and the system text, and constrains the answer to the proposal schema. When the
 * metric-call cap is above zero, Ax's GEPA tunes that prompt once; later requests
 * use the tuned program. An answer that is not a proposal comes back as the reason,
 * which the round sends to the next attempt.
 */
export function modelProposer(model: LanguageModel, settings: Settings["proposer"]): (request: ProposalRequest) => Promise<unknown> {
  const program = proposalProgram(settings.system);
  const service = languageModelService(model, settings.maxTokens);
  let tuned: Promise<void> | undefined;
  return async (request) => {
    try {
      if (settings.optimize.maxMetricCalls > 0) {
        tuned ??= tune(program, service, request, settings);
        await tuned;
      }
      // Stryker disable next-line ObjectLiteral: equivalent for the options: maxRetries: 0 is also the program's own option, and a request without a maxTokens takes the service's, which is this same settings.maxTokens (the request object on this line is killed by RS23.40)
      const output = await program.forward(service, { roundRequest: JSON.stringify(request) }, { maxRetries: 0, modelConfig: { maxTokens: settings.maxTokens } });
      return readProposal(output) ?? "the answer was not a proposal";
    } catch (e) {
      // Ax wraps both a bad answer and a transport failure. Only the bad answer
      // is a reason the round can send back; the transport failure still throws.
      if (e instanceof AxGenerateError) {
        if (badAnswer(e.cause)) return message(e.cause);
        // Stryker disable next-line ConditionalExpression: equivalent; the cause of an AxGenerateError is always an Error (Ax wraps anything thrown into one), so the line after it never runs
        if (e.cause instanceof Error) throw e.cause;
        return message(e);
      }
      // Stryker disable next-line ConditionalExpression: equivalent for `false`: Ax wraps every error of forward() in an AxGenerateError and the optimizer swallows the model's failures while it runs, so a raw AI SDK error never gets here; it is kept as a guard (`true` is killed by RS23.68)
      if (badAnswer(e)) return message(e);
      throw e;
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
