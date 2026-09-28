/**
 * The page's decision models: the catalog's local classification judges that run in a
 * browser (Julia 1 today), each loaded once through the browser host's ensemble, its files
 * verified and kept in the Cache API, on WebGPU when the page has it. Which one decides is
 * a slug (`/decide [slug]`): `auto` (the default) picks the best-ranked one this browser
 * can run and loads it on its own; a catalog id names one, which loads even when `auto`
 * would skip it; `lexical` leaves the lexical judge alone. Until a model is ready, and when
 * none can load, the lexical judge decides alone; once one is, the model decides and the
 * lexical judge stands behind it for any call the model fails.
 */
import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { rankForTask } from "@harness/cognitive";
import type { Catalog, ModelDescriptor } from "@harness/cognitive";
import { modelDecider } from "./decide.ts";
import type { Decider } from "./decide.ts";
import type { EngineSettings } from "./engine-settings.ts";
import { chooseModel, unfit } from "./model-choice.ts";
import type { Capabilities, Choice, Past } from "./model-choice.ts";

/** The catalog's local judges for classification in a browser, best first by rank (benchmarks, then preferences). */
export function rankDecisionModels(catalog: Catalog): ModelDescriptor[] {
  const judges = catalog.models.filter((m) => m.ports.includes("judge") && m.locality === "local");
  return rankForTask("classification", judges, { platform: "browser", allowHosted: false, prefer: catalog.preferences.classification ?? [] }).map((r) => r.descriptor);
}

type State = { readonly kind: "idle" } | { readonly kind: "loading" } | { readonly kind: "ready"; readonly judge: EvaluationModelV4 } | { readonly kind: "failed"; readonly reason: string };
type Described = Pick<ModelDescriptor, "id" | "name" | "downloadBytes">;
interface Ensemble {
  resolve(task: "classification", kind: "judge"): Promise<{ readonly port: EvaluationModelV4 }>;
}
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

/** One decision model: not loaded, loading, ready, or failed (and why). */
export class DecisionModel {
  readonly #model: Described;
  readonly #ensemble: Ensemble;
  readonly #onChange: () => void;
  #state: State = { kind: "idle" };
  #unkept: string | undefined;
  #fellBack: readonly string[] = [];

  constructor(options: {
    readonly model: Described;
    readonly ensemble: Ensemble;
    /** Called when the model starts loading, is ready, or fails. */
    readonly onChange: () => void;
  }) {
    this.#model = options.model;
    this.#ensemble = options.ensemble;
    this.#onChange = options.onChange;
  }

  /** Start loading the model, and again after it failed. */
  load(): void {
    if (this.#state.kind === "loading" || this.#state.kind === "ready") return;
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
    const state = this.#state;
    const size = mb(model.downloadBytes);
    if (state.kind === "idle") return `${model.name}: not downloaded (${size}, once; kept in this browser)`;
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

  /** Why the model could not load, if it could not. */
  get failure(): string | undefined {
    return this.#state.kind === "failed" ? this.#state.reason : undefined;
  }

  /** What the last decision's decision models failed with, if the lexical judge took it over. */
  fellBack(problems: readonly string[]): void {
    this.#fellBack = problems;
  }

  /** Who decides, in order: the model when it is ready, the lexical judge always last. */
  deciders(lexical: Decider): Decider[] {
    return this.#state.kind === "ready" ? [modelDecider(this.#state.judge), lexical] : [lexical];
  }

  phase(): State["kind"] {
    return this.#state.kind;
  }

  get id(): string {
    return this.#model.id;
  }

  /** The model's name and id, for the harness's own description (`~/AGENTS.md`). */
  get name(): string {
    return `${this.#model.name} (${this.#model.id})`;
  }

  /** The model's name alone, for the page's pill. */
  get label(): string {
    return this.#model.name;
  }
}

export const AUTO = "auto";
export const LEXICAL = "lexical";
type Candidate = Described & Pick<ModelDescriptor, "locality">;

/** The page's decision models, and which one a slug (`auto`, `lexical` or a catalog id) makes decide. */
export class DecisionModels<M extends Candidate = Candidate> {
  readonly #ranked: readonly M[];
  readonly #settings: EngineSettings["choice"];
  readonly #past: (id: string) => Past | undefined;
  readonly #models = new Map<string, DecisionModel>();
  #capabilities: Capabilities | undefined;

  constructor(options: {
    /** The candidates, best first (`rankDecisionModels`). */
    readonly ranked: readonly M[];
    readonly settings: EngineSettings["choice"];
    /** What became of a model's files on an earlier visit, if this browser downloaded them. */
    readonly past: (id: string) => Past | undefined;
    /** Loads a model: the browser host's ensemble over that one model. */
    readonly ensemble: (model: M) => Ensemble;
    /** Called when a model starts loading, is ready, or fails. */
    readonly onChange: (model: DecisionModel) => void;
  }) {
    this.#ranked = options.ranked;
    this.#settings = options.settings;
    this.#past = options.past;
    for (const m of options.ranked) {
      const model: DecisionModel = new DecisionModel({ model: m, ensemble: options.ensemble(m), onChange: () => options.onChange(model) });
      this.#models.set(m.id, model);
    }
  }

  /** What this browser offers a local model, once the page has asked it (auto waits for it). */
  detected(capabilities: Capabilities): void {
    this.#capabilities = capabilities;
  }

  /** `auto`, `lexical`, then each model's catalog id. */
  slugs(): string[] {
    return [AUTO, LEXICAL, ...this.#ranked.map((m) => m.id)];
  }

  /** Auto's pick: the best-ranked model that fits this browser, skipping any that failed to load on this visit. */
  #auto(capabilities: Capabilities): Choice<M> {
    return chooseModel(this.#ranked, capabilities, this.#settings, this.#past, (id) => {
      const failure = this.#models.get(id)?.failure;
      return failure === undefined ? undefined : `could not load: ${failure}`;
    });
  }

  /** The model a slug makes decide, if any (for auto, once the browser's capabilities are known). */
  current(slug: string): DecisionModel | undefined {
    if (slug !== AUTO) return this.#models.get(slug);
    const pick = this.#capabilities && this.#auto(this.#capabilities).model;
    return pick && this.#models.get(pick.id);
  }

  /** Load the slug's model: auto's pick on its own; a named one when asked, or at boot unless the browser did not keep it last time. */
  want(slug: string, asked: boolean): void {
    const model = this.current(slug);
    if (!model) return;
    if (slug === AUTO || asked || this.#past(slug)?.kept !== false) model.load();
  }

  /** Who decides for a slug, in order: its model when it is ready, the lexical judge always last. */
  deciders(slug: string, lexical: Decider): Decider[] {
    return this.current(slug)?.deciders(lexical) ?? [lexical];
  }

  /** Where the slug's decider is: the lexical judge alone, checking the browser, no model, or its model's phase. */
  phase(slug: string): "lexical" | "checking" | "none" | State["kind"] {
    if (slug === LEXICAL) return "lexical";
    if (slug === AUTO && !this.#capabilities) return "checking";
    return this.current(slug)?.phase() ?? "none";
  }

  /** The slug's model's name and id, if it has one. */
  name(slug: string): string | undefined {
    return this.current(slug)?.name;
  }

  status(slug: string): string {
    if (slug === LEXICAL) return "the lexical judge decides alone (/decide auto picks a decision model for this browser)";
    const named = this.#ranked.find((m) => m.id === slug);
    if (slug !== AUTO) {
      const model = this.#models.get(slug);
      if (!named || !model) return `${slug} is not a decision model in this page's catalog; the lexical judge decides`;
      const past = this.#past(slug);
      if (model.phase() === "idle" && past?.kept === false) return `${named.name}: not kept in this browser last time (${past.reason}): /decide ${slug} downloads it again (${mb(named.downloadBytes)})`;
      const skip = this.#capabilities && unfit(named, this.#capabilities, this.#settings, past?.kept ? past : undefined);
      return `${model.status()}${skip === undefined ? "" : `; named by /decide, though auto would skip it (${skip})`}`;
    }
    if (this.#ranked.length === 0) return "none for a browser in the catalog; the lexical judge decides";
    if (!this.#capabilities) return "checking what this browser can run; the lexical judge decides meanwhile";
    const { model, skipped } = this.#auto(this.#capabilities);
    const nameOf = (id: string) => this.#ranked.find((m) => m.id === id)?.name ?? id;
    if (!model) return `none fits this browser (${skipped.map((s) => `${nameOf(s.id)}: ${s.reason}`).join("; ")}); the lexical judge decides (/decide ${this.#ranked[0]!.id} loads one anyway)`;
    const over = skipped.map((s) => `${nameOf(s.id)} (${s.reason})`).join("; ");
    return `${this.#models.get(model.id)!.status()}${over === "" ? "" : `; picked for this browser over ${over}`}`;
  }
}
