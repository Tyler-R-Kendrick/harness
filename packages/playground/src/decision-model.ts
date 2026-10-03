/**
 * The page's decision models: the catalog's local classification judges that run in a
 * browser (Julia 1 today), picked for this browser by slug (`/decide [slug]`: `auto`,
 * `lexical` or a catalog id; `local-models.ts`). The lexical judge decides until a model is
 * ready and where none can load, and stands behind the model for any call it fails.
 */
import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { rankForTask } from "@harness/cognitive";
import type { Catalog, ModelDescriptor } from "@harness/cognitive";
import { modelDecider } from "./decide.ts";
import type { Decider } from "./decide.ts";
import type { LocalModels, Role } from "./local-models.ts";

export const LEXICAL = "lexical";

/** What decision models are called, and the lexical judge standing in for them. */
export const DECIDING: Role = {
  kind: "decision model",
  command: "decide",
  alone: { slug: LEXICAL, status: "the lexical judge decides alone (/decide auto picks a decision model for this browser)" },
  instead: "the lexical judge decides",
  fellBack: "the last decision fell back to the lexical judge",
};

/** The catalog's local judges for classification in a browser, best first by rank (benchmarks, then preferences). */
export function rankDecisionModels(catalog: Catalog): ModelDescriptor[] {
  const judges = catalog.models.filter((m) => m.ports.includes("judge") && m.locality === "local");
  return rankForTask("classification", judges, { platform: "browser", allowHosted: false, prefer: catalog.preferences.classification ?? [] }).map((r) => r.descriptor);
}

/** Who decides for a slug, in order: its model when it is ready, the lexical judge always last. */
export function deciders(models: LocalModels<EvaluationModelV4>, slug: string, lexical: Decider): Decider[] {
  const judge = models.port(slug);
  const model = models.current(slug);
  // The model decides under its catalog id and the revision its weights are pinned to.
  return judge && model ? [modelDecider(judge, { id: model.id, version: model.version }), lexical] : [lexical];
}
