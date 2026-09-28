/**
 * The page's decision model: the catalog's best local classification judge that runs in
 * a browser (Julia 1 today), loaded once through the browser host's ensemble, its files
 * verified and kept in the Cache API, on WebGPU when the page has it. Until it is ready,
 * and when it cannot load, the lexical judge decides alone; once it is, the model decides
 * and the lexical judge stands behind it for any call the model fails.
 */
import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { rankForTask } from "@harness/cognitive";
import type { Catalog, ModelDescriptor } from "@harness/cognitive";
import { modelDecider } from "./decide.ts";
import type { Decide, Decider } from "./decide.ts";

/** The catalog's best local judge for classification in a browser, by rank (benchmarks, then preferences). */
export function pickDecisionModel(catalog: Catalog): ModelDescriptor | undefined {
  const judges = catalog.models.filter((m) => m.ports.includes("judge") && m.locality === "local");
  return rankForTask("classification", judges, { platform: "browser", allowHosted: false, prefer: catalog.preferences.classification ?? [] })[0]?.descriptor;
}

type State = { readonly kind: "idle" } | { readonly kind: "loading" } | { readonly kind: "ready"; readonly judge: EvaluationModelV4 } | { readonly kind: "failed"; readonly reason: string };

export class DecisionModel {
  readonly #model: Pick<ModelDescriptor, "id" | "name" | "downloadBytes"> | undefined;
  readonly #ensemble: { resolve(task: "classification", kind: "judge"): Promise<{ readonly port: EvaluationModelV4 }> };
  readonly #onChange: () => void;
  readonly #notKept: string | undefined;
  #state: State = { kind: "idle" };
  #unkept: string | undefined;
  #fellBack: readonly string[] = [];

  constructor(options: {
    readonly model: Pick<ModelDescriptor, "id" | "name" | "downloadBytes"> | undefined;
    readonly ensemble: { resolve(task: "classification", kind: "judge"): Promise<{ readonly port: EvaluationModelV4 }> };
    /** Called when the model starts loading, is ready, or fails. */
    readonly onChange: () => void;
    /** Why this browser did not keep the model's files last time, if it did not. */
    readonly notKept?: string;
  }) {
    this.#model = options.model;
    this.#ensemble = options.ensemble;
    this.#onChange = options.onChange;
    this.#notKept = options.notKept;
  }

  /** Start loading the model: when asked (a download), and again after it failed. */
  load(): void {
    if (!this.#model || this.#state.kind === "loading" || this.#state.kind === "ready") return;
    this.#state = { kind: "loading" };
    this.#onChange();
    void this.#ensemble.resolve("classification", "judge").then(
      ({ port }) => this.#settle({ kind: "ready", judge: port }),
      (e: unknown) => this.#settle({ kind: "failed", reason: e instanceof Error ? e.message : String(e) }),
    );
  }

  #settle(state: State): void {
    this.#state = state;
    this.#onChange();
  }

  status(): string {
    const model = this.#model;
    if (!model) return "none for a browser in the catalog; the lexical judge decides";
    const state = this.#state;
    const size = `${Math.round(model.downloadBytes / 1e6)} MB`;
    if (state.kind === "idle") {
      return this.#notKept === undefined
        ? `${model.name}: not downloaded (${size}, once; kept in this browser): /decide model loads it`
        : `${model.name}: not kept in this browser last time (${this.#notKept}): /decide model downloads it again (${size})`;
    }
    if (state.kind === "loading") return `${model.name}: loading (${size}, once; kept in this browser)`;
    if (state.kind === "ready") {
      const kept = this.#unkept === undefined ? "" : ` (not kept in this browser: ${this.#unkept}; it downloads again next visit)`;
      const fell = this.#fellBack.length === 0 ? "" : `; the last decision fell back to the lexical judge (${this.#fellBack.join("; ")})`;
      return `${model.name}: ready${kept}${fell}`;
    }
    return `${model.name}: could not load (${state.reason}); the lexical judge decides`;
  }

  /** The browser would not keep one of the model's files (its storage quota): the next visit downloads it again. */
  cacheProblem(reason: string): void {
    this.#unkept ??= reason;
  }

  /** Whether the files were kept, for the next visit: why not, if they were not. */
  get unkept(): string | undefined {
    return this.#unkept;
  }

  /** What the last decision's decision models failed with, if the lexical judge took it over. */
  fellBack(problems: readonly string[]): void {
    this.#fellBack = problems;
  }

  /** Who decides, in order: the model when it is ready and wanted, the lexical judge always last. */
  deciders(decide: Decide, lexical: Decider): Decider[] {
    return decide === "model" && this.#state.kind === "ready" ? [modelDecider(this.#state.judge), lexical] : [lexical];
  }

  /** Where the model is: none in the catalog, not loaded, loading, ready, or failed. */
  phase(): "none" | State["kind"] {
    return this.#model ? this.#state.kind : "none";
  }

  /** The model's name and id, for the harness's own description (`~/AGENTS.md`). */
  get name(): string | undefined {
    return this.#model && `${this.#model.name} (${this.#model.id})`;
  }
}
