/**
 * The page's local generators: the catalog's local generators that run in a browser and
 * enforce a JSON Schema (Qwen3.5 0.8B today), picked for this browser by slug
 * (`/writer [slug]`: `auto`, `claude` or a catalog id; `local-models.ts`). A template is
 * written by the local model first; Claude writes only when no local model is ready, and
 * for a call the local model fails (its answer does not make a template).
 */
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { rankForTask } from "@harness/cognitive";
import type { Catalog, ModelDescriptor } from "@harness/cognitive";
import type { LocalModels, Role } from "./local-models.ts";

export const CLAUDE = "claude";

/** What generators are called, and Claude standing in for them. */
export const WRITING: Role = {
  kind: "generator",
  command: "writer",
  alone: { slug: CLAUDE, status: "Claude writes templates alone, when reachable (/writer auto picks a local generator for this browser)" },
  instead: "Claude writes templates, when reachable",
  fellBack: "the last template was written by Claude instead",
};

/** The catalog's local generators for a browser that enforce a JSON Schema (templates are written as one), best first by rank. */
export function rankGenerators(catalog: Catalog): ModelDescriptor[] {
  const generators = catalog.models.filter((m) => m.ports.includes("generator") && m.locality === "local" && (m.constraints ?? []).includes("json-schema"));
  return rankForTask("structured-extraction", generators, { platform: "browser", allowHosted: false, prefer: catalog.preferences["structured-extraction"] ?? [] }).map((r) => r.descriptor);
}

/** Who writes for a slug, in order: its local model when it is ready, then Claude when reachable. */
export function writers(models: LocalModels<LanguageModelV4>, slug: string, claude: LanguageModelV4 | undefined): LanguageModelV4[] {
  const local = models.port(slug);
  return [...(local ? [local] : []), ...(claude ? [claude] : [])];
}
