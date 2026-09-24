import type { ToolCall } from "./chat-format.ts";
import { CognitiveError } from "./ensemble.ts";
import type { Ensemble } from "./ensemble.ts";
import type { Routing, ToolSpec } from "./ports.ts";
import { z } from "zod";
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

function invalidCall(call: ToolCall, tools: readonly ToolSpec[]): string | undefined {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return `unknown tool ${call.name}`;
  const required = Array.isArray(tool.parameters["required"]) ? (tool.parameters["required"] as unknown[]) : [];
  const missing = required.filter((k) => typeof k === "string" && !(k in call.arguments));
  return missing.length > 0 ? `${call.name} is missing ${missing.join(", ")}` : undefined;
}

async function available<T>(get: () => Promise<T>): Promise<T | undefined> {
  try {
    return await get();
  } catch (e) {
    if (e instanceof CognitiveError) return undefined;
    throw e;
  }
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
  let routing: Routing | undefined;
  let valid = false;

  const router = await available(() => ensemble.resolve("tool-calling", "router"));
  if (!router) trace.push({ step: "route", outcome: "no router available" });
  else {
    routing = await router.port.route(request);
    const problems = routing.calls.map((c) => invalidCall(c, request.tools)).filter((p) => p !== undefined);
    valid = problems.length === 0;
    trace.push({ step: "route", member: router.id, outcome: valid ? `confidence ${routing.confidence}` : `invalid: ${problems.join("; ")}` });
    if (valid && routing.confidence >= policy.act) {
      return { calls: routing.calls, decidedBy: "router", confidence: routing.confidence, trace };
    }
    if (valid && routing.confidence >= policy.verify) {
      const judge = await available(() => ensemble.resolve("judgment", "judge"));
      if (!judge) trace.push({ step: "verify", outcome: "no judge available" });
      else {
        const answers = await judge.port.evaluate({
          state: { request: request.input, tools: request.tools.map((t) => ({ name: t.name, description: t.description })), calls: routing.calls },
          questions: {
            correct: {
              type: "boolean",
              instructions: "Do `calls` do exactly what `request` asks, using only `tools`, with every argument taken from the request? An empty `calls` means no tool applies.",
            },
          },
        });
        const answer = answers["correct"];
        const p = answer?.type === "boolean" ? answer.probability : probability(0);
        trace.push({ step: "verify", member: judge.id, outcome: `p=${p}` });
        if (p >= policy.accept) return { calls: routing.calls, decidedBy: "router+judge", confidence: p, trace };
      }
    }
  }

  const generator = await available(() => ensemble.resolve("tool-calling", "generator"));
  if (!generator) {
    trace.push({ step: "escalate", outcome: "no generator available" });
    if (!routing) throw new CognitiveError("no_member", `no router or generator available for tool-calling on ${ensemble.platform}`);
    const calls = routing.calls.filter((c) => invalidCall(c, request.tools) === undefined);
    return { calls, decidedBy: "router", confidence: routing.confidence, unverified: true, trace };
  }
  const calls: ToolCall[] = [];
  for await (const event of generator.port.generate({
    messages: [
      { role: "system", content: TOOL_SYSTEM },
      { role: "user", content: request.input },
    ],
    tools: request.tools,
  })) {
    if (event.type === "tool-call") calls.push(event.call);
  }
  const kept = calls.filter((c) => invalidCall(c, request.tools) === undefined);
  trace.push({ step: "escalate", member: generator.id, outcome: `${kept.length} call(s)${kept.length < calls.length ? `, ${calls.length - kept.length} invalid dropped` : ""}` });
  return { calls: kept, decidedBy: "generator", trace };
}
