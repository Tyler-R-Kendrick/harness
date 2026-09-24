import { BENCHMARKS } from "./benchmark-table.ts";
import { benchmarksOf, parseBenchmarks } from "./benchmarks.ts";
import type { ModelDescriptor, TaskCategory } from "./models.ts";

/**
 * The cognitive core's model ensemble. Embedding models are not here: memory brings
 * its own as an extension (@harness/memory). Every local model is pinned to a commit with
 * hashed weight files (downloadBytes counts weights; small config and tokenizer files
 * are fetched at the same revision). Benchmark results live in benchmark-table.ts, ours
 * to edit, and are attached to each model here.
 */

const MODELS: readonly Omit<ModelDescriptor, "benchmarks">[] = [
  {
    id: "typesafe-ai/jev",
    name: "Jev 1.13",
    publisher: "TypeSafe AI",
    tasks: ["judgment", "classification"],
    ports: ["judge"],
    locality: "hosted",
    runtime: "ai-gateway",
    platforms: ["native", "browser"],
    license: "proprietary (hosted API)",
    downloadBytes: 0,
    notes: "Typed judgments (boolean, choice, score) with probabilities. Closed weights; needs an AI Gateway credential.",
  },
  {
    id: "Contrastive-LM/CLM-v0.1-8B",
    name: "CLM 8B v0.1",
    publisher: "Contrastive-LM",
    tasks: ["judgment", "classification"],
    ports: ["judge"],
    locality: "local",
    runtime: "clm-serve",
    platforms: ["native"],
    license: "Apache-2.0",
    downloadBytes: 75557149,
    notes:
      "The local fallback for Jev: the same typed questions (TypeSafe's API), served by clm-serve. Two 20M-parameter heads over frozen Qwen3-8B last-token embeddings, which clm-serve reads from an OpenAI-compatible /v1/embeddings server. Published numbers are for fine-tuned verifier heads, not this checkpoint.",
    artifact: {
      repo: "Contrastive-LM/CLM-v0.1-8B",
      revision: "87655cb835bd76fd66c2da78e1e3709f7fa11a94",
      files: [{ path: "CLM_v0.1-8B.pt", bytes: 75557149, sha256: "b2b4a8c9c2d39263eff78a351eb909a342ce9b3bf21a3f07c1d1bf15f1c4eda5" }],
    },
  },
  {
    id: "Cactus-Compute/needle3",
    name: "Needle 3 (20 layers)",
    publisher: "Cactus Compute",
    tasks: ["tool-calling", "structured-extraction", "classification"],
    ports: ["router"],
    locality: "local",
    runtime: "needle-wasm",
    platforms: ["native", "browser"],
    license: "Apache-2.0",
    downloadBytes: 35335380 + 688521 + 62502,
    notes: "121M-parameter tool caller with a calibrated confidence head. One global instance per WASM module.",
    artifact: {
      repo: "Cactus-Compute/needle3",
      revision: "b274efcb211a9eef48c9a88da4b43bd569696a39",
      files: [
        { path: "needle3.cact", bytes: 35335380, sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38" },
        { path: "wasm/needle.wasm", bytes: 688521, sha256: "77c6a38cacb8efbeebfd5202082ba9a0850a7c3066db40d4d0e80509cd137d9b" },
        { path: "wasm/needle.js", bytes: 62502, sha256: "d00ec67ec7e03e4720dfc6c3dad95a0540afd00169a983ce3fabcd7aeaa0fa93" },
      ],
    },
  },
  {
    id: "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank",
    name: "LLMLingua-2 (mBERT)",
    publisher: "Microsoft",
    tasks: ["prompt-compression"],
    ports: ["compressor"],
    locality: "local",
    runtime: "transformers.js",
    platforms: ["native", "browser"],
    license: "Apache-2.0",
    downloadBytes: 178094427,
    notes: "Token classifier for prompt compression (LLMLingua-2 'small'). uint8 export: kept-word agreement 0.93 with fp32 per the exporter.",
    artifact: {
      repo: "atjsh/llmlingua-2-js-bert-base-multilingual-cased-meetingbank-onnx-v4",
      revision: "db67b6283d60e7190b32a6b8a8a87c87a6c1375a",
      files: [{ path: "onnx/model_uint8.onnx", bytes: 178094427, sha256: "d5ce58e66eb569a219d7c8f7d3e4680a8e0cdd2a0d7cf047b5049aac8a37e370" }],
    },
  },
  {
    id: "Qwen/Qwen3.5-0.8B",
    name: "Qwen3.5 0.8B",
    publisher: "Qwen",
    tasks: ["chat", "reasoning", "tool-calling", "structured-extraction", "vision-qa", "ocr", "document-parsing", "chart-understanding"],
    ports: ["generator"],
    locality: "local",
    runtime: "transformers.js",
    platforms: ["native", "browser"],
    license: "Apache-2.0",
    downloadBytes: 576621 + 483655680 + 857 + 162897920 + 185278 + 68267008,
    notes: "The browser LLM: text and vision, tool calls in qwen3_xml form. Thinking mode can loop; run non-thinking by default.",
    artifact: {
      repo: "onnx-community/Qwen3.5-0.8B-ONNX-OPT",
      revision: "fafab72d87a9e6be3925b38caf48286d2838f2d0",
      files: [
        { path: "onnx/decoder_model_merged_q4.onnx", bytes: 576621, sha256: "7390858c80a67275d8cb81fb70f66a24d3b86fe333057c1312de09c184a2d41b" },
        { path: "onnx/decoder_model_merged_q4.onnx_data", bytes: 483655680, sha256: "1a9165072dd51a9b6a917b6357a3686372b7429313022802cd4c9a730e8c9749" },
        { path: "onnx/embed_tokens_q4.onnx", bytes: 857, sha256: "8773dcf4858f855bfce13def4356ca17e0bc516a477154496b6ffb6dd6d084dc" },
        { path: "onnx/embed_tokens_q4.onnx_data", bytes: 162897920, sha256: "9210b1d26eb14136d3522584d17da14cc5f4b82b6f5607e6d80d59424a8cbe99" },
        { path: "onnx/vision_encoder_q4.onnx", bytes: 185278, sha256: "9b62022e77de4b22ca0bbc4453083c0cdeb8f967ccf13931d4c24c6e7c776177" },
        { path: "onnx/vision_encoder_q4.onnx_data", bytes: 68267008, sha256: "98aebedf02fc5414fd1c7f06a6580b42e272600ace9ecd33bfbc479a0c541c64" },
      ],
    },
  },
  {
    id: "ornith-ai/Ornith-1.5-9B",
    name: "Ornith 1.5 9B",
    publisher: "DeepReinforce AI",
    tasks: ["chat", "reasoning", "coding", "tool-calling"],
    ports: ["generator"],
    locality: "local",
    runtime: "llama.cpp-server",
    platforms: ["native"],
    license: "MIT",
    downloadBytes: 5780090816,
    notes: "Agentic coding and tool use; ChatML with <think> and qwen3_xml tool calls. Served by llama-server (--jinja). Benchmarks are for bf16; we run Q4_K_M.",
    artifact: {
      repo: "ornith-ai/Ornith-1.5-9B-GGUF",
      revision: "abdd624b12ebf020b767fff532ff44fe552b28c3",
      files: [{ path: "Ornith-1.5-9B-Q4_K_M.gguf", bytes: 5780090816, sha256: "70c112196e0b7023803c9762752e46d29e612a92c83f995bc3ba1ceb07e8fab6" }],
    },
  },
  {
    id: "lightonai/LightOnOCR-2-1B",
    name: "LightOnOCR-2 1B",
    publisher: "LightOn",
    tasks: ["ocr", "document-parsing", "table-extraction"],
    ports: ["document-parser"],
    locality: "local",
    runtime: "transformers.js",
    platforms: ["native", "browser"],
    license: "Apache-2.0",
    downloadBytes: 379583 + 390424576 + 854 + 99670016 + 331676 + 264593408,
    notes: "End-to-end page image to Markdown, no separate layout stage.",
    artifact: {
      repo: "onnx-community/LightOnOCR-2-1B-ONNX",
      revision: "2e2ecebebd69beaa3c38822c2927611eba811bd2",
      files: [
        { path: "onnx/decoder_model_merged_q4.onnx", bytes: 379583, sha256: "bb6773d33f6eb543d5c1f8d29f8a9d816baac6f0e1122a3361eec802dea966d7" },
        { path: "onnx/decoder_model_merged_q4.onnx_data", bytes: 390424576, sha256: "f4d756a524e348093bf13601dde1abbf606cc91f6bb532f0c97cd463426ea9cc" },
        { path: "onnx/embed_tokens_q4.onnx", bytes: 854, sha256: "b83a841f8699a02a7104521d676b2d64f2aa7c11c0572b7fc45c6e3f94dde329" },
        { path: "onnx/embed_tokens_q4.onnx_data", bytes: 99670016, sha256: "b88c4c463005375722e17bab1aa0a3b41c3c396a40ab074f23d9fb170c233b51" },
        { path: "onnx/vision_encoder_q4.onnx", bytes: 331676, sha256: "025631caf02fbb6fee404d8bb233adf3cb102d12cdd1b5a3e727c994917bc908" },
        { path: "onnx/vision_encoder_q4.onnx_data", bytes: 264593408, sha256: "dcb27f3c4072a948f907b3ca4e9f49c2266b77b2ef0218788a09a0f3827c45b7" },
      ],
    },
  },
  {
    id: "ATH-MaaS/OvisOCR2",
    name: "OvisOCR2",
    publisher: "ATH-MaaS",
    tasks: ["ocr", "document-parsing", "table-extraction"],
    ports: ["document-parser"],
    locality: "local",
    runtime: "llama.cpp-server",
    platforms: ["native"],
    license: "Apache-2.0",
    downloadBytes: 813576320 + 204987040,
    notes: "End-to-end page to Markdown (qwen3_5 architecture). Served by llama-server with its mmproj. Benchmarks are for the full-precision checkpoint.",
    artifact: {
      repo: "bartowski/ATH-MaaS_OvisOCR2-GGUF",
      revision: "ab22420f3d44201d3aa5a62ca49a665a46b507e9",
      files: [
        { path: "ATH-MaaS_OvisOCR2-Q8_0.gguf", bytes: 813576320, sha256: "8ca48f886bcd5f33636be25c935f07e0d2a83e839d9bce29c7fd3e4bfb344d33" },
        { path: "mmproj-ATH-MaaS_OvisOCR2-f16.gguf", bytes: 204987040, sha256: "4e0e9cb9d79dd0f423ba152a51816aa82a1f1a9d1a0190b6f67b2cd4cc5dd681" },
      ],
    },
  },
  {
    id: "Qwen/Qwen3-1.7B",
    name: "Qwen3 1.7B (steerable kernel)",
    publisher: "Qwen",
    tasks: ["steered-chat"],
    ports: ["generator"],
    locality: "local",
    runtime: "onnxruntime",
    platforms: ["native"],
    license: "Apache-2.0",
    downloadBytes: 1408943689,
    notes:
      "The local kernel: onnxruntime-genai's int4 CPU export, patched with a steering tap at layer 14 (resid_post), where adamkarvonen/qwen3-1.7b-saes (MIT) has 65k-feature BatchTopK SAEs with Neuronpedia labels. Chosen for steerability, not benchmark rank.",
    artifact: {
      repo: "onnx-community/Qwen3-1.7B-ONNX",
      revision: "cc6a06a21d614e9b8e92a6adfab1074d4e7d2438",
      files: [{ path: "onnxruntime/cpu_and_mobile/cpu-int4-kld-block-128/model.onnx", bytes: 1408943689, sha256: "9fddc5a0a7f9c51132c376db8fe44774b17a8e42d721c4d289ade16af87da0bd" }],
    },
  },
];

const ROWS = parseBenchmarks(BENCHMARKS);

export const MODEL_CATALOG: readonly ModelDescriptor[] = MODELS.map((m) => ({ ...m, benchmarks: benchmarksOf(ROWS, m.id) }));

/**
 * Tie-break order per task, used only when benchmarks cannot separate models (they
 * report different benchmarks). Specialists come before generalists, and larger
 * models before smaller ones.
 */
export const TASK_PREFERENCES: Partial<Record<TaskCategory, readonly string[]>> = {
  judgment: ["typesafe-ai/jev", "Contrastive-LM/CLM-v0.1-8B"],
  classification: ["typesafe-ai/jev", "Contrastive-LM/CLM-v0.1-8B", "Cactus-Compute/needle3"],
  "tool-calling": ["Cactus-Compute/needle3", "ornith-ai/Ornith-1.5-9B", "Qwen/Qwen3.5-0.8B"],
  "structured-extraction": ["Cactus-Compute/needle3", "Qwen/Qwen3.5-0.8B"],
  "prompt-compression": ["microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"],
  chat: ["ornith-ai/Ornith-1.5-9B", "Qwen/Qwen3.5-0.8B"],
  reasoning: ["ornith-ai/Ornith-1.5-9B", "Qwen/Qwen3.5-0.8B"],
  coding: ["ornith-ai/Ornith-1.5-9B"],
  "vision-qa": ["Qwen/Qwen3.5-0.8B"],
  ocr: ["ATH-MaaS/OvisOCR2", "lightonai/LightOnOCR-2-1B", "Qwen/Qwen3.5-0.8B"],
  "document-parsing": ["ATH-MaaS/OvisOCR2", "lightonai/LightOnOCR-2-1B", "Qwen/Qwen3.5-0.8B"],
  "table-extraction": ["ATH-MaaS/OvisOCR2", "lightonai/LightOnOCR-2-1B"],
  "chart-understanding": ["Qwen/Qwen3.5-0.8B"],
  "steered-chat": ["Qwen/Qwen3-1.7B"],
};
