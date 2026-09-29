import { trace } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import { safelyJSONStringify } from "@arizeai/openinference-core";
import { OpenInferenceSpanKind, SemanticConventions } from "@arizeai/openinference-semantic-conventions";

export function harnessTracer(name: string): Tracer {
  return trace.getTracer(name);
}

export interface SpanWriter {
  setAttribute(key: string, value: string): void;
  end(): void;
}

export interface TracerPort {
  startSpan(name: string): SpanWriter;
}

export function traceAgent(tracer: TracerPort, name: string, input: string, output: string): void {
  const span = tracer.startSpan(name);
  span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, OpenInferenceSpanKind.AGENT);
  span.setAttribute(SemanticConventions.INPUT_VALUE, input);
  span.setAttribute(SemanticConventions.OUTPUT_VALUE, output);
  span.end();
}

export function traceTool(tracer: TracerPort, name: string, input: unknown): void {
  const encoded = safelyJSONStringify(input);
  if (encoded === null) throw new Error("tool input did not serialize");
  const span = tracer.startSpan(name);
  span.setAttribute(SemanticConventions.OPENINFERENCE_SPAN_KIND, OpenInferenceSpanKind.TOOL);
  span.setAttribute(SemanticConventions.TOOL_NAME, name);
  span.setAttribute(SemanticConventions.INPUT_VALUE, encoded);
  span.end();
}
