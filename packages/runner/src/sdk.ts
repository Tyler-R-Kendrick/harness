import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { isOpenInferenceSpan, OpenInferenceSimpleSpanProcessor } from "@arizeai/openinference-vercel";

/** OTLP export through OpenInference's processor, so Phoenix and ASSERT can attach later. */
export function createEvalSdk(url: string): NodeSDK {
  const exporter = new OTLPTraceExporter({ url });
  const processor = new OpenInferenceSimpleSpanProcessor({ exporter, spanFilter: isOpenInferenceSpan });
  return new NodeSDK({ spanProcessors: [processor] });
}
