/**
 * The page's local generators: the catalog's local generators that run in a browser
 * (Qwen3.5 0.8B where there is WebGPU and room, SmolLM2 135M everywhere else), picked for
 * this browser by slug (`/writer [slug]`: `auto`, `claude` or a catalog id;
 * `local-models.ts`). Local inference is mandatory: with none that fits, auto loads the
 * smallest this browser can run. A model that enforces a JSON Schema writes templates (they
 * are written as one); any local model answers a request no template can answer. Claude
 * writes and answers only when named (`/writer claude`).
 */
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { rankForTask } from "@harness/cognitive";
import type { Catalog, ModelDescriptor } from "@harness/cognitive";
import type { Role } from "./local-models.ts";

export const CLAUDE = "claude";

/** What generators are called, and what happens without one. */
export const WRITING: Role = {
  kind: "generator",
  command: "writer",
  alone: { slug: CLAUDE, status: "Claude writes templates and answers alone, when reachable (/writer auto picks a local model for this browser)" },
  instead: "nothing answers without a local model (/writer claude uses Claude)",
  fellBack: "its last template was refused, so it answered the request itself",
  mandatory: true,
};

/** The catalog's local generators for a browser, best first by rank (benchmarks, then preferences). */
export function rankGenerators(catalog: Catalog): ModelDescriptor[] {
  const generators = catalog.models.filter((m) => m.ports.includes("generator") && m.locality === "local");
  return rankForTask("chat", generators, { platform: "browser", allowHosted: false, prefer: catalog.preferences.chat ?? [] }).map((r) => r.descriptor);
}

/** Whether a catalog model enforces a JSON Schema, as a template is written. */
export function enforcesJson(catalog: Catalog): (id: string) => boolean {
  return (id) => catalog.models.some((m) => m.id === id && (m.constraints ?? []).includes("json-schema"));
}

type Local = { readonly id: string; readonly port: LanguageModelV4 } | undefined;

/** Who writes templates for a slug: Claude alone for `claude`; otherwise the local model, when it enforces a JSON Schema. */
export function writers(slug: string, local: Local, claude: LanguageModelV4 | undefined, json: (id: string) => boolean): LanguageModelV4[] {
  if (slug === CLAUDE) return claude ? [claude] : [];
  return local && json(local.id) ? [local.port] : [];
}

/** Who answers a request no template can answer: Claude alone for `claude`; otherwise the local model. */
export function answerers(slug: string, local: Local, claude: LanguageModelV4 | undefined): LanguageModelV4[] {
  if (slug === CLAUDE) return claude ? [claude] : [];
  return local ? [local.port] : [];
}
