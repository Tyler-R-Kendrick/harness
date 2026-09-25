import { gateway } from "@ai-sdk/gateway";
import type { Experimental_EvaluationModelV4 } from "@ai-sdk/provider";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";

/** An evaluation model served through the Vercel AI Gateway, by its gateway id. */
export const gatewayEvaluationModel = (model: string): Experimental_EvaluationModelV4 => gateway.evaluationModel(model);

export interface TypeSafeApiOptions {
  /** The server's address; the API lives under /v1. */
  readonly baseUrl: string;
  readonly model: string;
  /** Local servers usually ignore the key; the provider requires one, so a placeholder is sent without it. */
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

/**
 * An evaluation model on any server that speaks TypeSafe's evaluation API, such as a
 * local judge: TypeSafe's own AI SDK provider talks to it.
 */
export function typesafeApiEvaluationModel(options: TypeSafeApiOptions): Experimental_EvaluationModelV4 {
  return createTypeSafeAi({
    baseURL: `${options.baseUrl.replace(/\/$/, "")}/v1`,
    apiKey: options.apiKey ?? "none",
    ...(options.fetch ? { fetch: options.fetch } : {}),
  }).evaluationModel(options.model);
}

/** Whether a service answers `url` with a success status within two seconds. */
export async function serviceAvailable(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    return (await fetchFn(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
