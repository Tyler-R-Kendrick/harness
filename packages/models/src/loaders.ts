import type { ModelDescriptor, Ports, Runtime } from "@harness/cognitive";
import { promptedEmbeddingModel, TokenClassifierCompressor, visionChatModel } from "./adapters.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { CactusWasmEngine } from "./cactus-wasm.ts";
import type { CactusModule } from "./cactus-wasm.ts";
import { gatewayEvaluationModel, serviceAvailable, typesafeApiEvaluationModel } from "./judge.ts";
import { loadFeatureExtractionBackend, loadTokenClassificationBackend, loadVisionChatBackend } from "./transformers-backends.ts";

type Of<R extends Runtime> = Extract<ModelDescriptor, { runtime: R }>;
/** A loader per runtime: it loads a catalog model on that runtime into the ports it serves. */
export type RuntimeLoaders = { readonly [R in Runtime]?: (m: Of<R>) => Promise<Ports> };
/** Constrained decoding for a model that enforces constraints token by token (XGrammar over its vocabulary). */
export type Constrainer = NonNullable<Parameters<typeof loadVisionChatBackend>[0]["constrainer"]>;

/** What a host gives the loaders: how it fetches and caches, and what it runs engines with. */
export interface LoaderHost {
  readonly fetch: typeof fetch;
  /** Verified model files (a Cactus engine's loader, WASM and weights). */
  readonly artifacts: ArtifactStore;
  /** Where credentials and server addresses are read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** transformers.js: a module override (tests), where it caches (Node; browsers use the Cache API), the device. */
  readonly transformers?: { readonly module?: unknown; readonly cacheDir?: string; readonly device?: "cpu" | "wasm" | "webgpu" };
  /** Instantiate an Emscripten module from its verified loader source and WASM bytes. */
  readonly emscripten: <M>(loader: Uint8Array, wasm: Uint8Array, name: string) => Promise<M>;
  /**
   * Give an engine its catalog environment where the host has one (natively, the process
   * environment). A browser has none; the Cactus WASM build reads only its own defaults and
   * makes no network calls beyond loading itself, which the verified bytes replace.
   */
  readonly engineEnv?: (vars: Readonly<Record<string, string>>) => void;
  /** Constrained decoding for a model, when this host can enforce its constraints. */
  readonly constrainer?: (m: ModelDescriptor) => Constrainer | undefined;
}

/**
 * The loaders for runtimes that run on every host: hosted and server judges, Cactus
 * WASM routers and transformers.js models. Hosts add their own (llama-server, the
 * steerable kernel) and supply how they fetch, cache and instantiate.
 */
export function portableLoaders(host: LoaderHost): Pick<RuntimeLoaders, "ai-gateway" | "typesafe-api" | "cactus-wasm" | "transformers.js"> {
  const { env } = host;
  const serves = (m: ModelDescriptor, port: keyof Ports) => m.ports.includes(port);
  const pinned = (m: ModelDescriptor) => ({
    repo: m.artifact!.repo,
    revision: m.artifact!.revision,
    ...(host.transformers?.cacheDir === undefined ? {} : { cacheDir: host.transformers.cacheDir }),
    ...(host.transformers?.module === undefined ? {} : { module: host.transformers.module }),
    ...(host.transformers?.device === undefined ? {} : { device: host.transformers.device }),
  });
  return {
    // Without a credential the model fails to load, and the next one for the task takes over.
    "ai-gateway": async (m) => {
      if (!env["AI_GATEWAY_API_KEY"] && !env["VERCEL_OIDC_TOKEN"]) throw new Error("no AI Gateway credential (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
      return { judge: gatewayEvaluationModel(m.run.model) };
    },
    "typesafe-api": async (m) => {
      const baseUrl = ((m.run.baseUrlEnv && env[m.run.baseUrlEnv]) || m.run.baseUrl).replace(/\/$/, "");
      if (m.run.health && !(await serviceAvailable(`${baseUrl}${m.run.health}`, host.fetch))) {
        throw new Error(`${m.name} is not answering at ${baseUrl}; start its server${m.run.baseUrlEnv ? ` or set ${m.run.baseUrlEnv}` : ""}`);
      }
      const apiKey = m.run.apiKeyEnv ? env[m.run.apiKeyEnv] : undefined;
      return { judge: typesafeApiEvaluationModel({ baseUrl, model: m.run.model, fetch: host.fetch, ...(apiKey ? { apiKey } : {}) }) };
    },
    "cactus-wasm": async (m) => {
      if (m.run.env) host.engineEnv?.(m.run.env);
      const [loader, wasm, weights] = await Promise.all([m.run.loader, m.run.wasm, m.run.weights].map((p) => host.artifacts.file(m.artifact!, p)));
      const engine = await CactusWasmEngine.create(await host.emscripten<CactusModule>(loader!, wasm!, m.run.loader), weights!, m.run.prefix);
      return { router: engine.router(m.id) };
    },
    "transformers.js": async (m) => {
      const at = { ...pinned(m), dtype: m.run.dtype };
      const constrainer = host.constrainer?.(m);
      const chat = m.run.modelClass
        ? await loadVisionChatBackend({
            ...at,
            modelClass: m.run.modelClass,
            ...(m.run.template ? { templateOptions: m.run.template } : {}),
            ...(m.run.imagesFirst ? { imagesFirst: true } : {}),
            ...(constrainer ? { constrainer } : {}),
          })
        : undefined;
      const model = chat && visionChatModel(chat, { modelId: m.id });
      return {
        ...(m.embedding ? { embedder: promptedEmbeddingModel(await loadFeatureExtractionBackend(at), m.embedding, { modelId: m.id }) } : {}),
        ...(m.compression ? { compressor: new TokenClassifierCompressor(await loadTokenClassificationBackend({ ...at, keepLabel: m.compression.keepLabel }), m.compression) } : {}),
        ...(model && serves(m, "generator") ? { generator: model } : {}),
        ...(model && serves(m, "document-parser") ? { "document-parser": model } : {}),
      };
    },
  };
}

/**
 * Instantiate an Emscripten module from its loader source (CommonJS: it gets
 * module/exports/require) with its WASM bytes passed in, so it never fetches or reads
 * them itself. `require` is the host's (natively Node's; in a browser, none).
 */
export async function instantiateEmscripten<M>(source: Uint8Array, wasm: Uint8Array, options: { readonly name: string; readonly require?: (id: string) => unknown }): Promise<M> {
  const module: { exports: unknown } = { exports: {} };
  const require = options.require ?? ((id: string) => {
    throw new Error(`${options.name} asked for ${id}, which this host does not provide`);
  });
  new Function("module", "exports", "require", "__filename", "__dirname", new TextDecoder().decode(source))(module, module.exports, require, options.name, ".");
  const factory = module.exports;
  if (typeof factory !== "function") throw new Error(`${options.name} did not export a module factory`);
  return (factory as (arg: { wasmBinary: Uint8Array }) => Promise<M>)({ wasmBinary: wasm });
}
