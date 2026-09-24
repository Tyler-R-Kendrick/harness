import { dirname, join } from "node:path";
import { BehaviorEngine } from "@harness/behavior";
import type { BehaviorPack } from "@harness/behavior";
import { Ensemble } from "@harness/cognitive";
import type { Catalog, ModelDescriptor, Ports } from "@harness/cognitive";
import {
  ArtifactStore,
  behaviorHook,
  EmbeddingGemmaEmbedder,
  clm,
  clmAvailable,
  EvaluationJudge,
  jev,
  LinguaCompressor,
  LanguageModelDocumentParser,
  LanguageModelGenerator,
  llamaServer,
  loadChatTokenizer,
  loadEmbeddingGemmaBackend,
  loadLinguaBackend,
  loadVisionChatBackend,
  NeedleEngine,
  OnnxSteerableSession,
  qwenTap,
  SteeredGenerator,
  VisionChatDocumentParser,
  VisionChatGenerator,
} from "@harness/models";
import type { ClmOptions, OrtLike } from "@harness/models";
import { Memory, memoryExtension } from "@harness/memory";
import { LlamaServerProcess } from "./llama-server-process.ts";
import { FileByteCache, loadNeedleModule } from "./model-cache.ts";
import { loadCatalog } from "./catalog-files.ts";
import { ModelFiles } from "./model-files.ts";
import { steerableModel } from "./steerable-model.ts";

export interface NativeEnsembleOptions {
  /** Where model files are cached. */
  readonly cacheDir: string;
  /** llama.cpp's llama-server binary; without it the GGUF models (Ornith, OvisOCR2) are not registered. */
  readonly llamaServer?: string;
  /** Allow hosted models (Jev on the AI Gateway). Default true. */
  readonly allowHosted?: boolean;
  /** Register only these catalog ids. */
  readonly only?: readonly string[];
  readonly fetch?: typeof fetch;
  /** Catalog to register from; defaults to the cognitive core's data files. */
  readonly catalog?: Catalog;
  /** transformers.js module override (tests). */
  readonly transformers?: unknown;
  /** onnxruntime module override for the steerable kernel (tests). */
  readonly onnxruntime?: unknown;
  /** Behavior pack the steerable kernel runs; without one it generates unsteered. */
  readonly behavior?: BehaviorPack;
  /** Where clm-serve answers (CLM, the local judge used when Jev cannot be). */
  readonly clm?: ClmOptions;
  /** Environment to read credentials from (default process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Install memory: its embedding model, vector recall and session memory. */
  readonly memory?: {
    /** A previous Memory.save(), to continue from. */
    readonly saved?: unknown;
    /** Called with Memory.save() after every change. */
    readonly persist?: (saved: unknown) => void;
    readonly dimensions?: number;
    /** Memory's models; defaults to memory's data files. */
    readonly catalog?: Catalog;
  };
}

/** Qwen3-1.7B's decoder shape and the layer its public SAEs read (resid_post 14). */
const KERNEL = { layer: 14, config: { layers: 28, kvHeads: 8, headSize: 128, hidden: 2048 } };

const QWEN_DTYPE = { embed_tokens: "q4", vision_encoder: "q4", decoder_model_merged: "q4" };

/**
 * The native host's cognitive core: every catalog model that can run here, registered
 * with a loader that fetches and verifies its pinned weights on first use.
 */
export function buildNativeEnsemble(options: NativeEnsembleOptions): { ensemble: Ensemble; memory?: Memory; close(): Promise<void> } {
  const allowHosted = options.allowHosted !== false;
  const catalog = options.catalog ?? loadCatalog();
  const ensemble = new Ensemble({ platform: "native", preferences: catalog.preferences, selection: { allowHosted } });
  const fetchFn = options.fetch ?? fetch;
  const artifacts = new ArtifactStore({ fetch: fetchFn, cache: new FileByteCache(join(options.cacheDir, "artifacts")) });
  const files = new ModelFiles({ dir: join(options.cacheDir, "gguf"), fetch: fetchFn });
  const transformersCache = join(options.cacheDir, "transformers");
  const servers: LlamaServerProcess[] = [];
  const pinned = (m: ModelDescriptor) => ({
    repo: m.artifact!.repo,
    revision: m.artifact!.revision,
    cacheDir: transformersCache,
    ...(options.transformers === undefined ? {} : { module: options.transformers }),
  });
  const serve = async (m: ModelDescriptor, withProjector: boolean, args: readonly string[] = []) => {
    const paths = await Promise.all(m.artifact!.files.map((f) => files.path(m.artifact!, f.path)));
    const server = await LlamaServerProcess.start({ binary: options.llamaServer!, model: paths[0]!, args, ...(withProjector ? { mmproj: paths[1]! } : {}) });
    servers.push(server);
    return server;
  };

  const loaders: Record<string, ((m: ModelDescriptor) => Promise<Ports>) | undefined> = {
    // Without a credential Jev fails to load, and the next judge (CLM) takes over.
    "typesafe-ai/jev": async () => {
      const env = options.env ?? process.env;
      if (!env["AI_GATEWAY_API_KEY"] && !env["VERCEL_OIDC_TOKEN"]) throw new Error("no AI Gateway credential (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
      return { judge: new EvaluationJudge(jev()) };
    },
    "Contrastive-LM/CLM-v0.1-8B": async () => {
      const clmOptions = { ...options.clm, ...(options.fetch && !options.clm?.fetch ? { fetch: options.fetch } : {}) };
      if (!(await clmAvailable(clmOptions))) throw new Error("clm-serve is not answering; start it (github.com/Contrastive-LM/CLM) or set CLM_BASE_URL");
      return { judge: new EvaluationJudge(clm(clmOptions)) };
    },
    "Cactus-Compute/needle3": async (m) => {
      process.env["NEEDLE_TELEMETRY"] ??= "0";
      process.env["DO_NOT_TRACK"] ??= "1";
      const [js, wasm, weights] = await Promise.all(["wasm/needle.js", "wasm/needle.wasm", "needle3.cact"].map((p) => artifacts.file(m.artifact!, p)));
      const engine = await NeedleEngine.create(await loadNeedleModule(js!, wasm!), weights!);
      return { router: engine };
    },
    "google/embeddinggemma-300m": async (m) => ({ embedder: new EmbeddingGemmaEmbedder(await loadEmbeddingGemmaBackend({ ...pinned(m), dtype: "q4" })) }),
    "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank": async (m) => ({ compressor: new LinguaCompressor(await loadLinguaBackend({ ...pinned(m), dtype: "uint8" })) }),
    "Qwen/Qwen3.5-0.8B": async (m) => ({
      generator: new VisionChatGenerator(await loadVisionChatBackend({ ...pinned(m), modelClass: "Qwen3_5ForConditionalGeneration", dtype: QWEN_DTYPE, templateOptions: { enable_thinking: false } })),
    }),
    "lightonai/LightOnOCR-2-1B": async (m) => ({
      "document-parser": new VisionChatDocumentParser(await loadVisionChatBackend({ ...pinned(m), modelClass: "LightOnOcrForConditionalGeneration", dtype: QWEN_DTYPE, imagesFirst: true })),
    }),
    // Thinking off by default: answers arrive promptly on CPU instead of after long reasoning.
    "ornith-ai/Ornith-1.5-9B": options.llamaServer ? async (m) => ({ generator: new LanguageModelGenerator(llamaServer({ baseUrl: (await serve(m, false, ["--reasoning-budget", "0"])).baseUrl })) }) : undefined,
    "Qwen/Qwen3-1.7B": async (m) => {
      const file = m.artifact!.files[0]!.path;
      const model = await steerableModel({ source: await files.path(m.artifact!, file), tap: qwenTap(KERNEL.layer, KERNEL.config.hidden), dir: join(options.cacheDir, "steerable") });
      const session = await OnnxSteerableSession.create({ model, ...KERNEL, ...(options.onnxruntime === undefined ? {} : { runtime: options.onnxruntime as OrtLike }) });
      const tokenizer = await loadChatTokenizer({ ...pinned(m), subfolder: dirname(file), templateOptions: { enable_thinking: false } });
      return { generator: new SteeredGenerator({ session, tokenizer, ...(options.behavior ? { hook: behaviorHook(new BehaviorEngine(options.behavior)) } : {}) }) };
    },
    "ATH-MaaS/OvisOCR2": options.llamaServer ? async (m) => ({ "document-parser": new LanguageModelDocumentParser(llamaServer({ baseUrl: (await serve(m, true)).baseUrl })) }) : undefined,
  };

  for (const m of catalog.models) {
    const load = loaders[m.id];
    if (!load || !m.platforms.includes("native") || (!allowHosted && m.locality === "hosted")) continue;
    if (options.only && !options.only.includes(m.id)) continue;
    ensemble.register(m, () => load(m));
  }
  const memory = options.memory && installMemory(ensemble, options.memory, (m) => loaders[m.id]!(m));
  return {
    ensemble,
    ...(memory ? { memory } : {}),
    close: async () => {
      await Promise.all(servers.map((s) => s.stop()));
    },
  };
}

function installMemory(ensemble: Ensemble, options: NonNullable<NativeEnsembleOptions["memory"]>, load: (m: ModelDescriptor) => Promise<Ports>): Memory {
  const { persist } = options;
  const memory = new Memory(ensemble, {
    ...(options.dimensions === undefined ? {} : { dimensions: options.dimensions }),
    ...(options.saved === undefined ? {} : { saved: options.saved }),
    ...(persist ? { onChange: (m: Memory) => persist(m.save()) } : {}),
  });
  ensemble.install(memoryExtension({ memory, models: (options.catalog ?? loadCatalog({ package: "@harness/memory" })).models, load }));
  return memory;
}
