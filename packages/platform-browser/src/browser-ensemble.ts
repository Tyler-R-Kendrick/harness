import { Ensemble } from "@harness/cognitive";
import type { Catalog, ModelDescriptor } from "@harness/cognitive";
import { ConstraintEngine } from "@harness/constrained";
import type { XGrammar } from "@harness/constrained";
import { ArtifactStore, instantiateEmscripten, portableLoaders } from "@harness/models";
import type { ByteCache, Constrainer } from "@harness/models";
import { CacheStorageByteCache } from "./byte-cache.ts";

export interface BrowserEnsembleOptions {
  /** The catalog to register from (the cognitive core's data files, parsed with `parseCatalog`). */
  readonly catalog: Catalog;
  /** Where verified model files are kept; defaults to the Cache API. */
  readonly cache?: ByteCache;
  /** Fetches model files, and reaches model servers. */
  readonly fetch?: typeof fetch;
  /** Where model files come from (default Hugging Face). */
  readonly hub?: string;
  /** Allow hosted models (default true); they still need their credential in `env`. */
  readonly allowHosted?: boolean;
  /** Credentials and server addresses (a browser has no process environment). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Register only these catalog ids. */
  readonly only?: readonly string[];
  /** Where transformers.js models run: WebGPU, or WebAssembly (its default). */
  readonly device?: "wasm" | "webgpu";
  /** transformers.js module override (tests). */
  readonly transformers?: unknown;
  /** An XGrammar loader (`xgrammarFromSource`); without one no model here claims to enforce constraints. */
  readonly xgrammar?: (fresh: boolean) => Promise<XGrammar>;
}

/**
 * The browser host's cognitive core: every catalog model that runs in a browser,
 * registered with its runtime's loader (the same loaders the native host uses), which
 * fetches and verifies the pinned files on first use and keeps them in the Cache API.
 * A model the catalog says enforces constraints keeps that claim only when an XGrammar
 * loader is given, so a constrained request never goes to a model that would ignore it.
 */
export function buildBrowserEnsemble(options: BrowserEnsembleOptions): Ensemble {
  const allowHosted = options.allowHosted !== false;
  const fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const ensemble = new Ensemble({ platform: "browser", preferences: options.catalog.preferences, selection: { allowHosted } });
  const artifacts = new ArtifactStore({ fetch: fetchFn, cache: options.cache ?? new CacheStorageByteCache(), ...(options.hub === undefined ? {} : { baseUrl: options.hub }) });
  const xgrammar = options.xgrammar;
  const enforces = (m: ModelDescriptor) => xgrammar !== undefined && m.runtime === "transformers.js" && m.run.vocab !== undefined;
  const constrainer = (m: ModelDescriptor): Constrainer | undefined =>
    m.constraints && enforces(m)
      ? async (vocabulary) => {
          const engine = await ConstraintEngine.create(xgrammar!, { ...vocabulary, encoding: (m as Extract<ModelDescriptor, { runtime: "transformers.js" }>).run.vocab! });
          return (constraint) => engine.matcher(constraint);
        }
      : undefined;
  const loaders = portableLoaders({
    fetch: fetchFn,
    artifacts,
    env: options.env ?? {},
    transformers: { ...(options.transformers === undefined ? {} : { module: options.transformers }), ...(options.device === undefined ? {} : { device: options.device }) },
    emscripten: (loader, wasm, name) => instantiateEmscripten(loader, wasm, { name }),
    constrainer,
  });
  for (const m of options.catalog.models) {
    const load = loaders[m.runtime as keyof typeof loaders] as ((m: ModelDescriptor) => ReturnType<NonNullable<(typeof loaders)["transformers.js"]>>) | undefined;
    if (!load || !m.platforms.includes("browser") || (!allowHosted && m.locality === "hosted")) continue;
    if (options.only && !options.only.includes(m.id)) continue;
    const { constraints, ...rest } = m;
    const registered = (constraints && !enforces(m) ? rest : m) as ModelDescriptor;
    ensemble.register(registered, () => load(m));
  }
  return ensemble;
}
