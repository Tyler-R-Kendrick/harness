/**
 * The tool-call cascade (`decideToolCalls` in the cognitive core) as a recorded decision.
 * The cascade runs unchanged; one record of it is written through the decider, so tool
 * routing has the same log, outcomes, calibration data and `decision.made` events as every
 * other fork.
 *
 * Mapping: the router deciding is the `model` rung, the router confirmed by the judge is
 * the `judge` rung, the generator is the `generator` rung. The record's confidence is the
 * router's confidence or the judge's probability; a generator's answer has none, so it is
 * recorded as 0 (not calibrated, never to be read as a probability of being right). A
 * routing that stood because nothing stronger was available says so as a last trace step.
 * The record's member is the model that proposed the calls (the router, or the generator
 * when it decided).
 */
import { decideToolCalls, probability } from "@harness/cognitive";
import type { CascadePolicy, Ensemble, ToolDecision, ToolSpec } from "@harness/cognitive";
import type { DecideContext, Decider } from "./fork.ts";
import { forkId, JsonSchema } from "./types.ts";
import type { Rung, TraceStep } from "./types.ts";

/** The identity the cascade's decisions are recorded under. */
export const TOOL_FORK = { id: forkId("tool.calls"), version: "cascade-1" } as const;

const RUNG: Readonly<Record<ToolDecision["decidedBy"], Rung>> = { router: "model", "router+judge": "judge", generator: "generator" };
const STEP_RUNG = { route: "model", verify: "judge", escalate: "generator" } as const;

/**
 * Decide which tools to call with the cascade and record the decision. Returns the
 * cascade's `ToolDecision` untouched; throws what the cascade throws, recording nothing.
 */
export async function decideToolCallsRecorded(
  decider: Decider,
  ensemble: Ensemble,
  request: { readonly input: string; readonly tools: readonly ToolSpec[] },
  policy?: CascadePolicy,
  ctx: DecideContext = {},
): Promise<ToolDecision> {
  const decision = await decideToolCalls(ensemble, request, policy);
  const trace: TraceStep[] = decision.trace.map((step) => ({ rung: STEP_RUNG[step.step], ...(step.member === undefined ? {} : { member: step.member }), outcome: step.outcome }));
  const confidence = decision.confidence ?? probability(0);
  if (decision.unverified) trace.push({ rung: "model", outcome: "unverified: no stronger model was available", confidence });
  const proposer = decision.trace.find((step) => step.step === (decision.decidedBy === "generator" ? "escalate" : "route"))!.member;
  await decider.recordExternal({
    fork: TOOL_FORK,
    input: { request: request.input, tools: request.tools.map((tool) => tool.name) },
    action: JsonSchema.parse(JSON.parse(JSON.stringify({ calls: decision.calls }))),
    rung: RUNG[decision.decidedBy],
    confidence,
    trace,
    member: proposer,
    session: ctx.session,
    correlation: ctx.correlation,
  });
  return decision;
}
