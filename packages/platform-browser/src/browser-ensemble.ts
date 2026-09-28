import { Ensemble } from "@harness/cognitive";
import type { Catalog, ModelDescriptor } from "@harness/cognitive";
import { ConstraintEngine } from "@harness/constrained";
import type { XGrammar } from "@harness/constrained";
import { ArtifactStore, instantiateEmscripten, loadDecisionModel, portableLoaders } from "@harness/models";
import type { ByteCache, Constrainer, OrtLike } from "@harness/models";
import type { Ports } from "@harness/cognitive";
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
  /** Hears why the cache could not read or keep a model file (a storage quota, an insecure page); the model loads regardless. */
  readonly onCacheProblem?: (key: string, error: unknown) => void;
  /** Allow hosted models (default true); they still need their credential in `env`. */
  readonly allowHosted?: boolean;
  /** Credentials and server addresses (a browser has no process environment). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Register only these catalog ids. */
  readonly only?: readonly string[];
  /**
   * Where models run: WebGPU or WebAssembly. transformers.js models default to
   * WebAssembly; decision models to WebGPU when the page has it (then WebAssembly).
   */
  readonly device?: "wasm" | "webgpu";
  /**
   * onnxruntime-web for decision models (`import * as ort from "onnxruntime-web/webgpu"`),
   * for hosts that cannot import it on demand; otherwise imported when the first one loads.
   */
  readonly onnxruntime?: unknown;
  /** Where onnxruntime-web fetches its WebAssembly, for a page whose script has no files beside it (one bundled file). */
  readonly onnxWasm?: string;
  /**
   * The transformers.js module (`import * as transformers from "@huggingface/transformers"`),
   * for hosts that cannot import it on demand: an extension's service worker, where
   * `import()` is not allowed. Otherwise it is imported when its first model loads.
   */
  readonly transformers?: unknown;
  /** An XGrammar loader (`xgrammarFromSource`, or `xgrammarFromFactory` where code cannot be evaluated); without one no model here claims to enforce constraints. */
  readonly xgrammar?: (fresh: boolean) => Promise<XGrammar>;
  /** How Emscripten loaders run: evaluated from their verified source by default; `packagedEmscripten` runs packaged copies instead, for pages that may not evaluate code (extensions). */
  readonly emscripten?: <M>(loader: Uint8Array, wasm: Uint8Array, name: string) => Promise<M>;
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
  const artifacts = new ArtifactStore({
    fetch: fetchFn,
    cache: options.cache ?? new CacheStorageByteCache(),
    ...(options.hub === undefined ? {} : { baseUrl: options.hub }),
    ...(options.onCacheProblem === undefined ? {} : { onCacheProblem: options.onCacheProblem }),
  });
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
    emscripten: options.emscripten ?? ((loader, wasm, name) => instantiateEmscripten(loader, wasm, { name })),
    constrainer,
  });
  // Decision models: their verified files from the byte cache, the weights handed to
  // onnxruntime-web as external data (a page has no folder to find them in).
  const decision = async (m: Extract<ModelDescriptor, { runtime: "onnxruntime-decision" }>): Promise<Ports> => {
    const { run } = m;
    const file = (path: string) => artifacts.file(m.artifact!, path);
    const [model, data, tokenizer, tokenizerConfig] = await Promise.all([file(run.model), run.data ? file(run.data) : undefined, file(run.tokenizer), file(run.tokenizerConfig)]);
    const runtime = (options.onnxruntime ?? (await import("onnxruntime-web/webgpu"))) as OrtLike & { env?: { wasm?: { wasmPaths?: unknown } } };
    if (options.onnxWasm !== undefined && runtime.env?.wasm) runtime.env.wasm.wasmPaths = options.onnxWasm;
    const gpu = options.device === "webgpu" || (options.device === undefined && typeof navigator !== "undefined" && "gpu" in navigator);
    const sessionOptions = { executionProviders: gpu ? ["webgpu", "wasm"] : ["wasm"], ...(data && run.data ? { externalData: [{ path: run.data, data }] } : {}) };
    return { judge: await loadDecisionModel(m, { model: model!, tokenizer: tokenizer!, tokenizerConfig: tokenizerConfig! }, { runtime, sessionOptions }) };
  };
  const all = { ...loaders, "onnxruntime-decision": decision };
  for (const m of options.catalog.models) {
    const load = all[m.runtime as keyof typeof all] as ((m: ModelDescriptor) => Promise<Ports>) | undefined;
    if (!load || !m.platforms.includes("browser") || (!allowHosted && m.locality === "hosted")) continue;
    if (options.only && !options.only.includes(m.id)) continue;
    const { constraints, ...rest } = m;
    const registered = (constraints && !enforces(m) ? rest : m) as ModelDescriptor;
    ensemble.register(registered, () => load(m));
  }
  return ensemble;
}
