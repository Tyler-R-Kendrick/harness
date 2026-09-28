/**
 * Local models the page runs for a role (deciding which template answers, writing
 * templates), each loaded once through the browser host's ensemble, its files verified and
 * kept in the Cache API. Which one serves is a slug (`/decide [slug]`, `/writer [slug]`):
 * `auto` (the default) picks the best-ranked one this browser can run and loads it on its
 * own; a catalog id names one, which loads even when `auto` would skip it; the role's own
 * slug (`lexical`, `claude`) leaves the local models out. Until a model is ready, and when
 * none can load, the role's stand-in serves alone (the lexical judge, Claude); once one is,
 * the model serves and the stand-in is behind it for any call the model fails.
 */
import type { ModelDescriptor } from "@harness/cognitive";
import type { EngineSettings } from "./engine-settings.ts";
import { chooseModel, unfit } from "./model-choice.ts";
import type { Capabilities, Choice, Past } from "./model-choice.ts";

/** What a role's models are called, the command that picks one, and who stands in for them. */
export interface Role {
  /** What the models are, e.g. "decision model". */
  readonly kind: string;
  /** The command that picks one, e.g. "decide". */
  readonly command: string;
  /** The slug that leaves the local models out, and what it says. */
  readonly alone: { readonly slug: string; readonly status: string };
  /** What happens without a model, e.g. "the lexical judge decides". */
  readonly instead: string;
  /** What is said when the last call went to the stand-in, e.g. "the last decision fell back to the lexical judge". */
  readonly fellBack: string;
  /** Whether a local model is mandatory: with none that fits, auto loads the smallest this browser can run anyway. */
  readonly mandatory?: boolean;
}

type State<P> = { readonly kind: "idle" } | { readonly kind: "loading" } | { readonly kind: "ready"; readonly port: P } | { readonly kind: "failed"; readonly reason: string };
type Described = Pick<ModelDescriptor, "id" | "name" | "downloadBytes">;
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

export const AUTO = "auto";

/** One local model: not loaded, loading, ready (its port), or failed (and why). */
export class LocalModel<P> {
  readonly #model: Described;
  readonly #load: () => Promise<P>;
  readonly #onChange: () => void;
  readonly #role: Role;
  #state: State<P> = { kind: "idle" };
  #unkept: string | undefined;
  #fellBack: readonly string[] = [];
  #waiting: (() => void)[] = [];

  constructor(options: {
    readonly model: Described;
    /** Loads the model: its port, through the browser host's ensemble. */
    readonly load: () => Promise<P>;
    /** Called when the model starts loading, is ready, or fails. */
    readonly onChange: () => void;
    readonly role: Role;
  }) {
    this.#model = options.model;
    this.#load = options.load;
    this.#onChange = options.onChange;
    this.#role = options.role;
  }

  /** Start loading the model, and again after it failed. */
  load(): void {
    if (this.#state.kind === "loading" || this.#state.kind === "ready") return;
    this.#state = { kind: "loading" };
    this.#onChange();
    void this.#load().then(
      (port) => this.#settle({ kind: "ready", port }),
      (e: unknown) => this.#settle({ kind: "failed", reason: e instanceof Error ? e.message : String(e) }),
    );
  }

  #settle(state: State<P>): void {
    this.#state = state;
    this.#onChange();
    for (const wake of this.#waiting.splice(0)) wake();
  }

  /** The model's port once it has loaded (loading it if it has not started), or undefined if it could not load. */
  ready(): Promise<P | undefined> {
    if (this.#state.kind === "ready") return Promise.resolve(this.#state.port);
    if (this.#state.kind === "failed") return Promise.resolve(undefined);
    this.load();
    return new Promise((resolve) => this.#waiting.push(() => resolve(this.port)));
  }

  status(): string {
    const model = this.#model;
    const state = this.#state;
    const size = mb(model.downloadBytes);
    if (state.kind === "idle") return `${model.name}: not downloaded (${size}, once; kept in this browser)`;
    if (state.kind === "loading") return `${model.name}: loading (${size}, once; kept in this browser)`;
    if (state.kind === "ready") {
      const kept = this.#unkept === undefined ? "" : ` (not kept in this browser: ${this.#unkept}; it downloads again next visit)`;
      const fell = this.#fellBack.length === 0 ? "" : `; ${this.#role.fellBack} (${this.#fellBack.join("; ")})`;
      return `${model.name}: ready${kept}${fell}`;
    }
    return `${model.name}: could not load (${state.reason}); ${this.#role.instead}`;
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

  /** What the model failed with on the last call, if the stand-in took it over. */
  fellBack(problems: readonly string[]): void {
    this.#fellBack = problems;
  }

  /** The model's port once it is ready. */
  get port(): P | undefined {
    return this.#state.kind === "ready" ? this.#state.port : undefined;
  }

  phase(): State<P>["kind"] {
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

export type Candidate = Described & Pick<ModelDescriptor, "locality">;

/** A role's local models, and which one a slug (`auto`, the role's own, or a catalog id) makes serve. */
export class LocalModels<P, M extends Candidate = Candidate> {
  readonly #ranked: readonly M[];
  readonly #settings: EngineSettings["choice"];
  readonly #past: (id: string) => Past | undefined;
  readonly #role: Role;
  readonly #models = new Map<string, LocalModel<P>>();
  #capabilities: Capabilities | undefined;

  constructor(options: {
    /** The candidates, best first. */
    readonly ranked: readonly M[];
    readonly settings: EngineSettings["choice"];
    /** What became of a model's files on an earlier visit, if this browser downloaded them. */
    readonly past: (id: string) => Past | undefined;
    /** Loads a model: its port, through the browser host's ensemble over that one model. */
    readonly load: (model: M) => Promise<P>;
    /** Called when a model starts loading, is ready, or fails. */
    readonly onChange: (model: LocalModel<P>) => void;
    readonly role: Role;
  }) {
    this.#ranked = options.ranked;
    this.#settings = options.settings;
    this.#past = options.past;
    this.#role = options.role;
    for (const m of options.ranked) {
      const model: LocalModel<P> = new LocalModel({ model: m, load: () => options.load(m), onChange: () => options.onChange(model), role: options.role });
      this.#models.set(m.id, model);
    }
  }

  /** What this browser offers a local model, once the page has asked it (auto waits for it). */
  detected(capabilities: Capabilities): void {
    this.#capabilities = capabilities;
  }

  /** `auto`, the role's own slug, then each model's catalog id. */
  slugs(): string[] {
    return [AUTO, this.#role.alone.slug, ...this.#ranked.map((m) => m.id)];
  }

  /** Auto's pick: the best-ranked model that fits this browser, skipping any that failed to load on this visit. */
  #auto(capabilities: Capabilities): Choice<M> {
    const veto = (id: string) => {
      const failure = this.#models.get(id)?.failure;
      return failure === undefined ? undefined : `could not load: ${failure}`;
    };
    return chooseModel(this.#ranked, capabilities, this.#settings, this.#past, veto, this.#role.mandatory === true);
  }

  /** The slug's model once it has loaded, waiting for it (and for auto, moving past one that fails to load); undefined without one. */
  async ready(slug: string): Promise<P | undefined> {
    for (;;) {
      const model = this.current(slug);
      if (!model) return undefined;
      const port = await model.ready();
      if (port !== undefined || slug !== AUTO || this.current(slug) === model) return port;
    }
  }

  /** Auto's pick for this browser, before it loads (to reserve its download's room), once the capabilities are known. */
  pick(): M | undefined {
    return this.#capabilities && this.#auto(this.#capabilities).model;
  }

  /** The model a slug makes serve, if any (for auto, once the browser's capabilities are known). */
  current(slug: string): LocalModel<P> | undefined {
    if (slug !== AUTO) return this.#models.get(slug);
    const pick = this.pick();
    return pick && this.#models.get(pick.id);
  }

  /** Load the slug's model: auto's pick on its own; a named one when asked, or at boot unless the browser did not keep it last time. */
  want(slug: string, asked: boolean): void {
    const model = this.current(slug);
    if (!model) return;
    if (slug === AUTO || asked || this.#past(slug)?.kept !== false) model.load();
  }

  /** The slug's model's port, once it is ready. */
  port(slug: string): P | undefined {
    return this.current(slug)?.port;
  }

  /** Where the slug's model is: the stand-in alone, checking the browser, no model, or its model's phase. */
  phase(slug: string): "alone" | "checking" | "none" | State<P>["kind"] {
    if (slug === this.#role.alone.slug) return "alone";
    if (slug === AUTO && !this.#capabilities) return "checking";
    return this.current(slug)?.phase() ?? "none";
  }

  /** The slug's model's name and id, if it has one. */
  name(slug: string): string | undefined {
    return this.current(slug)?.name;
  }

  status(slug: string): string {
    const { alone, command, instead, kind } = this.#role;
    if (slug === alone.slug) return alone.status;
    const named = this.#ranked.find((m) => m.id === slug);
    if (slug !== AUTO) {
      const model = this.#models.get(slug);
      if (!named || !model) return `${slug} is not a ${kind} in this page's catalog; ${instead}`;
      const past = this.#past(slug);
      if (model.phase() === "idle" && past?.kept === false) return `${named.name}: not kept in this browser last time (${past.reason}): /${command} ${slug} downloads it again (${mb(named.downloadBytes)})`;
      const skip = this.#capabilities && unfit(named, this.#capabilities, this.#settings, past?.kept ? past : undefined);
      return `${model.status()}${skip === undefined ? "" : `; named by /${command}, though auto would skip it (${skip})`}`;
    }
    if (this.#ranked.length === 0) return `none for a browser in the catalog; ${instead}`;
    if (!this.#capabilities) return `checking what this browser can run; ${instead} meanwhile`;
    const { model, skipped, forced } = this.#auto(this.#capabilities);
    const nameOf = (id: string) => this.#ranked.find((m) => m.id === id)?.name ?? id;
    if (!model) return `none fits this browser (${skipped.map((s) => `${nameOf(s.id)}: ${s.reason}`).join("; ")}); ${instead} (/${command} ${this.#ranked[0]!.id} loads one anyway)`;
    const over = skipped.map((s) => `${nameOf(s.id)} (${s.reason})`).join("; ");
    const anyway = forced === undefined ? "" : `; loaded though ${forced}: local inference is mandatory`;
    return `${this.#models.get(model.id)!.status()}${over === "" ? "" : `; picked for this browser over ${over}`}${anyway}`;
  }
}
