/**
 * A decision record as an OpenTelemetry-style span, for whatever tracing backend a host
 * already has. It is a plain object (no SDK, no clock, no randomness): the same record
 * always gives the same span.
 *
 * Mapping. OpenTelemetry's GenAI conventions cover model calls and agents and are still
 * evolving, so only what fits is used and the rest is namespaced under `harness.`:
 *
 * - `name`: `decision <fork>`; `kind`: `internal`.
 * - `spanId` is the decision id and `traceId` the correlation (the hook-bus saga), or the
 *   decision id when it has none. These are linkage fields as text: no id is invented.
 * - start and end are the instant the decision was recorded (`at`), in nanoseconds as text.
 * - `gen_ai.operation.name` is `decision`; `gen_ai.request.model` is the member and
 *   `gen_ai.response.model` the member at its pinned version, when a model decided.
 *   `gen_ai.agent.name` is not set: a decision is not an agent.
 * - `harness.decision.*` carries the fork and its version, rung, action (as JSON with
 *   sorted keys), confidence, propensity, whether it explored, mode, policy version,
 *   session, correlation and the outcome's kind, source and correctness.
 * - every trace step is an event `harness.decision.step`; an outcome is a last event
 *   `harness.decision.outcome` at the outcome's own time.
 * - status is `error` for an outcome that is `incorrect` or `failed` or says it was not
 *   correct, and `ok` otherwise (no outcome included).
 *
 * Attribute values are only strings, numbers and booleans.
 */
import { canonicalJson } from "./records.ts";
import type { DecisionRecord } from "./types.ts";

export type OtelValue = string | number | boolean;
export type OtelAttributes = Readonly<Record<string, OtelValue>>;

export interface OtelEvent {
  readonly name: string;
  readonly timeUnixNano: string;
  readonly attributes: OtelAttributes;
}

export interface OtelSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly kind: "internal";
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly status: { readonly code: "ok" | "error"; readonly message?: string };
  readonly attributes: OtelAttributes;
  readonly events: readonly OtelEvent[];
}

const nanos = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();

/** The span for a decision record. */
export function toSpan(record: DecisionRecord): OtelSpan {
  const { outcome } = record;
  const at = nanos(record.at);
  const attributes: Record<string, OtelValue> = {
    "gen_ai.operation.name": "decision",
    ...(record.member === undefined ? {} : { "gen_ai.request.model": record.member, "gen_ai.response.model": record.memberVersion === undefined ? record.member : `${record.member}@${record.memberVersion}` }),
    "harness.decision.id": record.id,
    "harness.decision.fork": record.fork,
    "harness.decision.fork_version": record.forkVersion,
    "harness.decision.rung": record.rung,
    "harness.decision.action": canonicalJson(record.action),
    "harness.decision.confidence": record.confidence,
    "harness.decision.propensity": record.propensity,
    "harness.decision.explored": record.explored,
    "harness.decision.mode": record.mode,
    "harness.decision.policy": record.policy,
    ...(record.memberVersion === undefined ? {} : { "harness.decision.member_version": record.memberVersion }),
    ...(record.session === undefined ? {} : { "harness.decision.session": record.session }),
    ...(record.correlation === undefined ? {} : { "harness.decision.correlation": record.correlation }),
    ...(outcome === undefined
      ? {}
      : { "harness.decision.outcome.kind": outcome.kind, "harness.decision.outcome.source": outcome.source, ...(outcome.correct === undefined ? {} : { "harness.decision.outcome.correct": outcome.correct }) }),
  };
  const events: OtelEvent[] = record.trace.map((step) => ({
    name: "harness.decision.step",
    timeUnixNano: at,
    attributes: {
      "harness.step.rung": step.rung,
      ...(step.member === undefined ? {} : { "harness.step.member": step.member }),
      "harness.step.outcome": step.outcome,
      ...(step.confidence === undefined ? {} : { "harness.step.confidence": step.confidence }),
    },
  }));
  if (outcome !== undefined) {
    events.push({
      name: "harness.decision.outcome",
      timeUnixNano: nanos(outcome.at),
      attributes: {
        "harness.outcome.kind": outcome.kind,
        "harness.outcome.source": outcome.source,
        ...(outcome.correct === undefined ? {} : { "harness.outcome.correct": outcome.correct }),
        ...(outcome.by === undefined ? {} : { "harness.outcome.by": outcome.by }),
      },
    });
  }
  const failed = outcome !== undefined && (outcome.kind === "incorrect" || outcome.kind === "failed" || outcome.correct === false);
  return {
    name: `decision ${record.fork}`,
    traceId: record.correlation ?? record.id,
    spanId: record.id,
    kind: "internal",
    startTimeUnixNano: at,
    endTimeUnixNano: at,
    status: failed ? { code: "error", message: `outcome ${outcome.kind}` } : { code: "ok" },
    attributes,
    events,
  };
}
