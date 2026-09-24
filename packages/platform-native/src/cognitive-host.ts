import { dirname, join } from "node:path";
import { BehaviorEngine } from "@harness/behavior";
import type { BehaviorPack } from "@harness/behavior";
import { Ensemble } from "@harness/cognitive";
import type { Catalog, ModelDescriptor, Ports, Runtime } from "@harness/cognitive";
import {
  ArtifactStore,
  behaviorHook,
  CactusWasmEngine,
  EvaluationJudge,
  gatewayEvaluationModel,
  LanguageModelDocumentParser,
  LanguageModelGenerator,
  llamaServer,
  loadChatTokenizer,
  loadFeatureExtractionBackend,
  loadTokenClassificationBackend,
  loadVisionChatBackend,
  OnnxSteerableSession,
  PromptedEmbedder,
  serviceAvailable,
  SteeredGenerator,
  TokenClassifierCompressor,
  typesafeApiEvaluationModel,
  VisionChatDocumentParser,
  VisionChatGenerator,
} from "@harness/models";
import type { CactusModule, OrtLike } from "@harness/models";
import { Memory, memoryExtension, sharedEmbeddingSize } from "@harness/memory";
import { Learning, learningExtension, Plugins } from "@harness/learning";
import type { Settings } from "@harness/learning";
import { LlamaServerProcess } from "./llama-server-process.ts";
import { FileByteCache, loadEmscriptenModule } from "./model-cache.ts";
import { loadCatalog, loadLearningSettings } from "./catalog-files.ts";
import { ModelFiles } from "./model-files.ts";
import { steerableModel } from "./steerable-model.ts";

export interface NativeEnsembleOptions {
  /** Where model files are cached. */
  readonly cacheDir: string;
  /** llama.cpp's llama-server binary; without it the llama.cpp-server models are not registered. */
  readonly llamaServer?: string;
  /** Allow hosted models (e.g. on the AI Gateway). Default true. */
  readonly allowHosted?: boolean;
  /** Register only these catalog ids. */
  readonly only?: readonly string[];
  /** Fetches weights, and reaches model servers. */
  readonly fetch?: typeof fetch;
  /** Catalog to register from; defaults to the cognitive core's data files. */
  readonly catalog?: Catalog;
  /** transformers.js module override (tests). */
  readonly transformers?: unknown;
  /** onnxruntime module override for the steerable kernel (tests). */
  readonly onnxruntime?: unknown;
  /** Behavior pack the steerable kernel runs; without one it generates unsteered. */
  readonly behavior?: BehaviorPack;
  /** Environment to read credentials and server addresses from (default process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Install memory: its embedding model, vector recall and session memory. */
  readonly memory?: {
    /** A previous Memory.save(), to continue from. */
    readonly saved?: unknown;
    /** Called with Memory.save() after every change. */
    readonly persist?: (saved: unknown) => void;
    /** Index size; defaults to the largest size all of memory's embedding models produce. */
    readonly dimensions?: number;
    /** Memory's models; defaults to memory's data files. */
    readonly catalog?: Catalog;
  };
  /** Install learning, on memory (which it requires): lessons from sessions, the capability ladder, plugins. */
  readonly learning?: {
    /** A previous Learning.save(), to continue from. */
    readonly saved?: unknown;
    /** Called with Learning.save() after every change. */
    readonly persist?: (saved: unknown) => void;
    /** Thresholds and prompts; defaults to learning's data file. */
    readonly settings?: Settings;
    /** Plugins the client brings (skills, workflows, tool building, teaching). */
    readonly plugins?: Plugins;
  };
}

type Of<R extends Runtime> = Extract<ModelDescriptor, { runtime: R }>;
type Loaders = { readonly [R in Runtime]?: (m: Of<R>) => Promise<Ports> };

/**
 * The native host's cognitive core: every catalog model that can run here, registered
 * with its runtime's loader, which fetches and verifies the pinned weights on first
 * use. Nothing here knows a model: the catalog entry says which runtime runs it, how
 * (its `run` settings) and which ports it serves.
 */
export function buildNativeEnsemble(options: NativeEnsembleOptions): { ensemble: Ensemble; memory?: Memory; learning?: Learning; close(): Promise<void> } {
  if (options.learning && !options.memory) throw new Error("learning requires memory: install memory too");
  const allowHosted = options.allowHosted !== false;
  const catalog = options.catalog ?? loadCatalog();
  const env = options.env ?? process.env;
  const ensemble = new Ensemble({ platform: "native", preferences: catalog.preferences, selection: { allowHosted } });
  const fetchFn = options.fetch ?? fetch;
  const artifacts = new ArtifactStore({ fetch: fetchFn, cache: new FileByteCache(join(options.cacheDir, "artifacts")) });
  const files = new ModelFiles({ dir: join(options.cacheDir, "gguf"), fetch: fetchFn });
  const servers: LlamaServerProcess[] = [];
  const pinned = (m: ModelDescriptor) => ({
    repo: m.artifact!.repo,
    revision: m.artifact!.revision,
    cacheDir: join(options.cacheDir, "transformers"),
    ...(options.transformers === undefined ? {} : { module: options.transformers }),
  });
  const serves = (m: ModelDescriptor, port: keyof Ports) => m.ports.includes(port);

  const loaders: Loaders = {
    // Without a credential the model fails to load, and the next one for the task takes over.
    "ai-gateway": async (m) => {
      if (!env["AI_GATEWAY_API_KEY"] && !env["VERCEL_OIDC_TOKEN"]) throw new Error("no AI Gateway credential (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
      return { judge: new EvaluationJudge(gatewayEvaluationModel(m.run.model)) };
    },
    "typesafe-api": async (m) => {
      const baseUrl = ((m.run.baseUrlEnv && env[m.run.baseUrlEnv]) || m.run.baseUrl).replace(/\/$/, "");
      if (m.run.health && !(await serviceAvailable(`${baseUrl}${m.run.health}`, fetchFn))) {
        throw new Error(`${m.name} is not answering at ${baseUrl}; start its server${m.run.baseUrlEnv ? ` or set ${m.run.baseUrlEnv}` : ""}`);
      }
      const apiKey = m.run.apiKeyEnv ? env[m.run.apiKeyEnv] : undefined;
      return { judge: new EvaluationJudge(typesafeApiEvaluationModel({ baseUrl, model: m.run.model, fetch: fetchFn, ...(apiKey ? { apiKey } : {}) })) };
    },
    "cactus-wasm": async (m) => {
      // The engine reads the real process environment.
      for (const [k, v] of Object.entries(m.run.env ?? {})) process.env[k] ??= v;
      const [loader, wasm, weights] = await Promise.all([m.run.loader, m.run.wasm, m.run.weights].map((p) => artifacts.file(m.artifact!, p)));
      const engine = await CactusWasmEngine.create(await loadEmscriptenModule<CactusModule>(loader!, wasm!, m.run.loader), weights!, m.run.prefix);
      return { router: engine };
    },
    "transformers.js": async (m) => {
      const at = { ...pinned(m), dtype: m.run.dtype };
      const chat = m.run.modelClass
        ? await loadVisionChatBackend({
            ...at,
            modelClass: m.run.modelClass,
            ...(m.run.template ? { templateOptions: m.run.template } : {}),
            ...(m.run.imagesFirst ? { imagesFirst: true } : {}),
          })
        : undefined;
      return {
        ...(m.embedding ? { embedder: new PromptedEmbedder(await loadFeatureExtractionBackend(at), m.embedding) } : {}),
        ...(m.compression ? { compressor: new TokenClassifierCompressor(await loadTokenClassificationBackend({ ...at, keepLabel: m.compression.keepLabel }), m.compression) } : {}),
        ...(chat && serves(m, "generator") ? { generator: new VisionChatGenerator(chat) } : {}),
        ...(chat && serves(m, "document-parser") ? { "document-parser": new VisionChatDocumentParser(chat) } : {}),
      };
    },
    ...(options.llamaServer
      ? {
          "llama.cpp-server": async (m: Of<"llama.cpp-server">) => {
            const path = (file: string) => files.path(m.artifact!, file);
            const server = await LlamaServerProcess.start({
              binary: options.llamaServer!,
              model: await path(m.run.model),
              ...(m.run.projector ? { mmproj: await path(m.run.projector) } : {}),
              ...(m.run.args ? { args: m.run.args } : {}),
            });
            servers.push(server);
            const model = llamaServer({ baseUrl: server.baseUrl });
            return {
              ...(serves(m, "generator") ? { generator: new LanguageModelGenerator(model) } : {}),
              ...(serves(m, "document-parser") ? { "document-parser": new LanguageModelDocumentParser(model) } : {}),
            };
          },
        }
      : {}),
    onnxruntime: async (m) => {
      const { run } = m;
      const model = await steerableModel({ source: await files.path(m.artifact!, run.model), tap: { ...run.tap, hidden: run.decoder.hidden }, dir: join(options.cacheDir, "steerable") });
      const session = await OnnxSteerableSession.create({ model, layer: run.tap.layer, config: run.decoder, ...(options.onnxruntime === undefined ? {} : { runtime: options.onnxruntime as OrtLike }) });
      // ONNX exports keep the tokenizer and chat template beside the model file.
      const folder = dirname(run.model);
      const tokenizer = await loadChatTokenizer({ ...pinned(m), endTokens: run.endTokens, ...(folder === "." ? {} : { subfolder: folder }), ...(run.template ? { templateOptions: run.template } : {}) });
      return { generator: new SteeredGenerator({ session, tokenizer, ...(options.behavior ? { hook: behaviorHook(new BehaviorEngine(options.behavior)) } : {}) }) };
    },
  };
  const loaderFor = (m: ModelDescriptor) => loaders[m.runtime] as ((m: ModelDescriptor) => Promise<Ports>) | undefined;

  for (const m of catalog.models) {
    const load = loaderFor(m);
    if (!load || !m.platforms.includes("native") || (!allowHosted && m.locality === "hosted")) continue;
    if (options.only && !options.only.includes(m.id)) continue;
    ensemble.register(m, () => load(m));
  }
  const memory =
    options.memory &&
    installMemory(ensemble, options.memory, (m) => {
      const load = loaderFor(m);
      if (!load) throw new Error(`no ${m.runtime} runtime on this host`);
      return load(m);
    });
  const learning = memory && options.learning && installLearning(ensemble, memory, options.learning);
  return {
    ensemble,
    ...(memory ? { memory } : {}),
    ...(learning ? { learning } : {}),
    close: async () => {
      await Promise.all(servers.map((s) => s.stop()));
    },
  };
}

function installMemory(ensemble: Ensemble, options: NonNullable<NativeEnsembleOptions["memory"]>, load: (m: ModelDescriptor) => Promise<Ports>): Memory {
  const { persist } = options;
  const { models } = options.catalog ?? loadCatalog({ package: "@harness/memory" });
  const memory = new Memory(ensemble, {
    dimensions: options.dimensions ?? sharedEmbeddingSize(models),
    ...(options.saved === undefined ? {} : { saved: options.saved }),
    ...(persist ? { onChange: (m: Memory) => persist(m.save()) } : {}),
  });
  ensemble.install(memoryExtension({ memory, models, load }));
  return memory;
}

function installLearning(ensemble: Ensemble, memory: Memory, options: NonNullable<NativeEnsembleOptions["learning"]>): Learning {
  const { persist } = options;
  const learning = new Learning({
    reasoner: ensemble,
    memory,
    settings: options.settings ?? loadLearningSettings(),
    ...(options.saved === undefined ? {} : { saved: options.saved }),
    ...(persist ? { onChange: (l: Learning) => persist(l.save()) } : {}),
  });
  ensemble.install(learningExtension({ learning, reasoner: ensemble, plugins: options.plugins ?? new Plugins() }));
  return learning;
}
