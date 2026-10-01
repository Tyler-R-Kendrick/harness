import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decisionsApiAvailable, openAiCompatibleRoot } from "@harness/models";
import { modelIdsFromCatalog } from "./harness-host.ts";

/** An OpenAI-compatible server named by harness settings. */
export interface OpenAiCompatibleEndpoint {
  readonly baseUrl: string;
  readonly model?: string;
  readonly apiKey?: string;
}

/** The `openai` value of one settings file: a base URL, or a base URL with its model and key. */
export function openAiCompatibleEndpoint(settings: unknown): OpenAiCompatibleEndpoint | undefined {
  if (typeof settings !== "object" || settings === null) return undefined;
  const openai = (settings as Record<string, unknown>)["openai"];
  if (typeof openai === "string") {
    const baseUrl = httpBase(openai);
    return baseUrl === undefined ? undefined : { baseUrl };
  }
  if (typeof openai !== "object" || openai === null || Array.isArray(openai)) return undefined;
  const record = openai as Record<string, unknown>;
  const baseUrl = typeof record["baseUrl"] === "string" ? httpBase(record["baseUrl"]) : undefined;
  if (baseUrl === undefined) return undefined;
  const model = typeof record["model"] === "string" && record["model"].trim().length > 0 ? record["model"].trim() : undefined;
  const apiKey = typeof record["apiKey"] === "string" && record["apiKey"].length > 0 ? record["apiKey"] : undefined;
  return { baseUrl, ...(model === undefined ? {} : { model }), ...(apiKey === undefined ? {} : { apiKey }) };
}

function httpBase(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** Workspace, then user, then global. A missing file is an empty layer. */
export function readSettingsLayers(places: { readonly project?: string; readonly user: string; readonly global: string }): readonly unknown[] {
  return [places.project, places.user, places.global].map(readSettingsFile);
}

function readSettingsFile(dir: string | undefined): unknown {
  if (dir === undefined) return undefined;
  const file = join(dir, "settings.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The first configured OpenAI-compatible endpoint that answers the decisions API.
 * Its model is the one settings name, or the first model the endpoint lists.
 * A configured endpoint that does not answer the route is not used.
 */
export async function configuredDecisionsEndpoint(options: {
  readonly layers: readonly unknown[];
  readonly fetch?: typeof fetch;
}): Promise<{ readonly baseUrl: string; readonly model: string; readonly apiKey?: string } | undefined> {
  const endpoint = options.layers.map(openAiCompatibleEndpoint).find((item) => item !== undefined);
  if (endpoint === undefined) return undefined;
  const fetchFn = options.fetch ?? fetch;
  if (!(await decisionsApiAvailable(endpoint.baseUrl, fetchFn))) return undefined;
  const model = endpoint.model ?? (await listedModel(endpoint.baseUrl, fetchFn));
  if (model === undefined) return undefined;
  return { baseUrl: endpoint.baseUrl, model, ...(endpoint.apiKey === undefined ? {} : { apiKey: endpoint.apiKey }) };
}

async function listedModel(baseUrl: string, fetchFn: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchFn(`${openAiCompatibleRoot(baseUrl)}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return undefined;
    const ids = modelIdsFromCatalog(await response.json());
    return ids[0];
  } catch {
    return undefined;
  }
}
