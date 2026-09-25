import { experimental_evaluate, generateText, jsonSchema, tool } from "ai";
import type { LanguageModel, ToolSet, TypedToolCall } from "ai";
import { InvalidResponseDataError } from "@ai-sdk/provider";
import type { JSONValue } from "@ai-sdk/provider";
import { z } from "zod";
import type { ToolCall } from "./chat-format.ts";
import { CognitiveError } from "./ensemble.ts";
import type { Ensemble } from "./ensemble.ts";
import { HARNESS, MODEL_HEADER } from "./options.ts";
import type { ToolSpec } from "./ports.ts";
import { probability, ProbabilitySchema } from "./units.ts";
import type { Probability } from "./units.ts";

export const CascadePolicySchema = z
  .object({
    /** Router confidence at or above which its calls are taken without checking. */
    act: ProbabilitySchema,
    /** Router confidence at or above which the judge is asked; below it, escalate. */
    verify: ProbabilitySchema,
    /** Judge probability at or above which a verified routing is accepted. */
    accept: ProbabilitySchema,
  })
  .refine((p) => p.verify <= p.act, "verify must not be above act")
  .brand<"CascadePolicy">();
/** Cascade thresholds: probabilities with verify <= act, made only by cascadePolicy(). */
export type CascadePolicy = z.output<typeof CascadePolicySchema>;

export function cascadePolicy(thresholds: { readonly act: number; readonly verify: number; readonly accept: number }): CascadePolicy {
  const result = CascadePolicySchema.safeParse(thresholds);
  if (!result.success) throw new RangeError(`invalid cascade thresholds ${JSON.stringify(thresholds)}\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const DEFAULT_CASCADE: CascadePolicy = cascadePolicy({ act: 0.9, verify: 0.5, accept: 0.8 });

export interface CascadeStep {
  readonly step: "route" | "verify" | "escalate";
  readonly member?: string;
  readonly outcome: string;
}

export interface ToolDecision {
  readonly calls: readonly ToolCall[];
  readonly decidedBy: "router" | "router+judge" | "generator";
  /** Router confidence or judge probability behind the decision; absent for the generator. */
  readonly confidence?: Probability;
  /** Set when the decision could not be checked because no stronger model was available. */
  readonly unverified?: true;
  readonly trace: readonly CascadeStep[];
}

const TOOL_SYSTEM = "Call the tools that fulfil the user's request. Call nothing if no tool applies.";

/**
 * Tools as JSON, as an AI SDK tool set with no `execute`: calls come back to the
 * caller. The model sees each tool's JSON Schema as given; zod validates the calls
 * against it, so a call the schema rejects is an invalid call.
 */
export function toolSet(tools: readonly ToolSpec[]): ToolSet {
  return Object.fromEntries(
    tools.map((t) => {
      const schema = z.fromJSONSchema(t.parameters as z.core.JSONSchema.JSONSchema);
      const validate = (value: unknown) => {
        const result = schema.safeParse(value);
        return result.success ? { success: true as const, value: result.data } : { success: false as const, error: new Error(z.prettifyError(result.error)) };
      };
      return [t.name, tool({ description: t.description, inputSchema: jsonSchema(t.parameters, { validate }) })];
    }),
  );
}

/** Calls the AI SDK could match to a tool and validate against its schema, and why the others were not. */
function sortCalls(calls: readonly TypedToolCall<ToolSet>[]): { valid: ToolCall[]; problems: string[] } {
  const valid: ToolCall[] = [];
  const problems: string[] = [];
  for (const c of calls) {
    if (c.invalid) problems.push(`${c.toolName}: ${c.error instanceof Error ? c.error.message : String(c.error)}`);
    else valid.push({ name: c.toolName, arguments: (c.input ?? {}) as Record<string, unknown> });
  }
  return { valid, problems };
}

async function available<T>(get: () => Promise<T>): Promise<T | undefined> {
  try {
    return await get();
  } catch (e) {
    if (e instanceof CognitiveError) return undefined;
    throw e;
  }
}

const member = (headers: Readonly<Record<string, string | undefined>> | undefined) => headers?.[MODEL_HEADER];

/**
 * A tool router's routing (any AI SDK language model that routes, such as the
 * ensemble's router): the calls it makes, sorted into valid ones and why the others
 * are not, its calibrated confidence (provider metadata `harness.confidence`; 0 when
 * it gives none) and its reasoning.
 */
export async function route(model: LanguageModel, request: { readonly input: string; readonly tools: readonly ToolSpec[] }) {
  const result = await generateText({ model, prompt: request.input, tools: toolSet(request.tools), maxRetries: 0 });
  const confidence = ProbabilitySchema.safeParse(result.providerMetadata?.[HARNESS]?.["confidence"]);
  return {
    model: member(result.response.headers),
    ...sortCalls(result.toolCalls),
    confidence: confidence.success ? confidence.data : probability(0),
    reasoning: result.reasoningText ?? "",
  };
}

/**
 * Decide which tools to call, cheapest model first. The tool router answers with a
 * calibrated confidence: confident answers are taken, middling ones are put to the
 * judge, and uncertain or invalid ones escalate to a generator. Every step is recorded
 * in the trace.
 */
export async function decideToolCalls(
  ensemble: Ensemble,
  request: { readonly input: string; readonly tools: readonly ToolSpec[] },
  policy: CascadePolicy = DEFAULT_CASCADE,
): Promise<ToolDecision> {
  const trace: CascadeStep[] = [];
  let routing: Awaited<ReturnType<typeof route>> | undefined;

  if (ensemble.serves("tool-calling", "router")) routing = await available(() => route(ensemble.languageModel("tool-calling", "router"), request));
  if (!routing) trace.push({ step: "route", outcome: "no router available" });
  else {
    const valid = routing.problems.length === 0;
    trace.push({ step: "route", ...(routing.model === undefined ? {} : { member: routing.model }), outcome: valid ? `confidence ${routing.confidence}` : `invalid: ${routing.problems.join("; ")}` });
    if (valid && routing.confidence >= policy.act) {
      return { calls: routing.valid, decidedBy: "router", confidence: routing.confidence, trace };
    }
    if (valid && routing.confidence >= policy.verify) {
      const verdict = ensemble.serves("judgment", "judge")
        ? await available(() =>
            experimental_evaluate({
              model: ensemble.evaluationModel(),
              maxRetries: 0,
              state: { request: request.input, tools: request.tools.map((t) => ({ name: t.name, description: t.description })), calls: routing!.valid as unknown as JSONValue[] },
              questions: {
                correct: {
                  type: "boolean",
                  instructions: "Do `calls` do exactly what `request` asks, using only `tools`, with every argument taken from the request? An empty `calls` means no tool applies.",
                },
              },
            }).catch((e: unknown) => {
              // A judge whose answer is not a boolean one gives no support: the routing is not verified.
              if (InvalidResponseDataError.isInstance(e)) return { unusable: e.message };
              throw e;
            }),
          )
        : undefined;
      if (!verdict) trace.push({ step: "verify", outcome: "no judge available" });
      else if ("unusable" in verdict) trace.push({ step: "verify", outcome: `p=0: ${verdict.unusable}` });
      else {
        const p = ProbabilitySchema.parse(verdict.answers.correct.probability);
        const judge = member(verdict.response.headers);
        trace.push({ step: "verify", ...(judge === undefined ? {} : { member: judge }), outcome: `p=${p}` });
        if (p >= policy.accept) return { calls: routing.valid, decidedBy: "router+judge", confidence: p, trace };
      }
    }
  }

  const escalated = ensemble.serves("tool-calling", "generator")
    ? await available(() => generateText({ model: ensemble.languageModel("tool-calling"), instructions: TOOL_SYSTEM, prompt: request.input, tools: toolSet(request.tools), maxRetries: 0 }))
    : undefined;
  if (!escalated) {
    trace.push({ step: "escalate", outcome: "no generator available" });
    if (!routing) throw new CognitiveError("no_member", `no router or generator available for tool-calling on ${ensemble.platform}`);
    return { calls: routing.valid, decidedBy: "router", confidence: routing.confidence, unverified: true, trace };
  }
  const { valid, problems } = sortCalls(escalated.toolCalls);
  const generator = member(escalated.response.headers);
  trace.push({ step: "escalate", ...(generator === undefined ? {} : { member: generator }), outcome: `${valid.length} call(s)${problems.length ? `, ${problems.length} invalid dropped` : ""}` });
  return { calls: valid, decidedBy: "generator", trace };
}
