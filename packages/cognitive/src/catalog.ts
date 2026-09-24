import type { BenchmarkResult, ModelDescriptor, TaskCategory } from "./models.ts";

/**
 * The cognitive core's model ensemble. Every local model is pinned to a commit with
 * hashed weight files (downloadBytes counts weights; small config and tokenizer files
 * are fetched at the same revision). Benchmark numbers are copied from the cited
 * source, which also states conditions; they describe the published checkpoint, not
 * necessarily the quantization we run.
 */

type Result = Omit<BenchmarkResult, "higherIsBetter"> & { readonly higherIsBetter?: boolean };
const results = (list: readonly Result[]): BenchmarkResult[] => list.map((r) => ({ higherIsBetter: true, ...r }));

const JEV_THIRD_PARTY = "https://raw.githubusercontent.com/dhruvmehra/jevbench/main/docs/results/2026-09-22-n500-summary.md";
const NEEDLE_CHART = "https://huggingface.co/Cactus-Compute/needle3/resolve/main/assets/benchmarks.svg";
// Needle 3's chart runs the shipped CQ2 engine against f16 baselines on the same splits.
const CHART = "Needle 3 card chart";
const QWEN_CARD = "https://huggingface.co/Qwen/Qwen3.5-0.8B";
const ORNITH_CARD = "https://huggingface.co/ornith-ai/Ornith-1.5-9B";
const GEMMA_CARD = "https://huggingface.co/google/embeddinggemma-300m";
const LINGUA_PAPER = "https://arxiv.org/html/2403.12968v2";

export const MODEL_CATALOG: readonly ModelDescriptor[] = [
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
    benchmarks: results([
      { benchmark: "JevBench v1.0 (242 decisions)", task: "judgment", metric: "accuracy", score: 96.3, source: "https://benchmarkheaven.com/jev-models/v1", reportedBy: "third-party" },
      { benchmark: "JevBench v1.0 (242 decisions)", task: "judgment", metric: "ECE", score: 0.027, higherIsBetter: false, source: "https://benchmarkheaven.com/jev-models/v1", reportedBy: "third-party" },
      { benchmark: "SST-2 (n=500)", task: "classification", metric: "accuracy", score: 95.4, source: JEV_THIRD_PARTY, reportedBy: "third-party" },
      { benchmark: "SST-2 (n=500)", task: "classification", metric: "ECE", score: 0.026, higherIsBetter: false, source: JEV_THIRD_PARTY, reportedBy: "third-party" },
      { benchmark: "AG News (n=500)", task: "classification", metric: "accuracy", score: 84.3, source: JEV_THIRD_PARTY, reportedBy: "third-party" },
      { benchmark: "Banking77 (n=500)", task: "classification", metric: "accuracy", score: 76.4, source: JEV_THIRD_PARTY, reportedBy: "third-party" },
    ]),
  },
  {
    id: "Cactus-Compute/needle3",
    name: "Needle 3 (20 layers)",
    publisher: "Cactus Compute",
    tasks: ["tool-calling", "structured-extraction", "classification", "text-embedding"],
    ports: ["router", "embedder"],
    locality: "local",
    runtime: "needle-wasm",
    platforms: ["native", "browser"],
    license: "Apache-2.0",
    downloadBytes: 35335380 + 688521 + 62502,
    notes: "121M-parameter tool caller with a calibrated confidence head; 3072-d embeddings. One global instance per WASM module.",
    artifact: {
      repo: "Cactus-Compute/needle3",
      revision: "b274efcb211a9eef48c9a88da4b43bd569696a39",
      files: [
        { path: "needle3.cact", bytes: 35335380, sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38" },
        { path: "wasm/needle.wasm", bytes: 688521, sha256: "77c6a38cacb8efbeebfd5202082ba9a0850a7c3066db40d4d0e80509cd137d9b" },
        { path: "wasm/needle.js", bytes: 62502, sha256: "d00ec67ec7e03e4720dfc6c3dad95a0540afd00169a983ce3fabcd7aeaa0fa93" },
      ],
    },
    benchmarks: results([
      { benchmark: "Mobile Actions (961)", task: "tool-calling", metric: "exact-call accuracy", score: 86.0, setting: CHART, source: NEEDLE_CHART },
      { benchmark: "DroidCall (200)", task: "tool-calling", metric: "exact calls in order", score: 47.0, setting: CHART, source: NEEDLE_CHART },
      { benchmark: "BFCL v4 (3,641)", task: "tool-calling", metric: "AST-match accuracy", score: 50.2, setting: CHART, source: NEEDLE_CHART },
      { benchmark: "DSTC8 (1,813 turns)", task: "structured-extraction", metric: "field micro-F1", score: 40.7, setting: CHART, source: NEEDLE_CHART },
      { benchmark: "SNIPS gold (700)", task: "structured-extraction", metric: "field micro-F1", score: 30.2, setting: CHART, source: NEEDLE_CHART },
      { benchmark: "SNIPS 7-way (700)", task: "structured-extraction", metric: "field micro-F1", score: 24.7, setting: CHART, source: NEEDLE_CHART },
    ]),
  },
  {
    id: "google/embeddinggemma-300m",
    name: "EmbeddingGemma 300M",
    publisher: "Google DeepMind",
    tasks: ["text-embedding"],
    ports: ["embedder"],
    locality: "local",
    runtime: "transformers.js",
    platforms: ["native", "browser"],
    license: "Gemma Terms of Use",
    downloadBytes: 519322 + 196725760,
    notes: "768-d, Matryoshka to 512/256/128. Needs task prefixes. Do not run fp16 activations.",
    artifact: {
      repo: "onnx-community/embeddinggemma-300m-ONNX",
      revision: "5090578d9565bb06545b4552f76e6bc2c93e4a66",
      files: [
        { path: "onnx/model_q4.onnx", bytes: 519322, sha256: "ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043" },
        { path: "onnx/model_q4.onnx_data", bytes: 196725760, sha256: "599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02" },
      ],
    },
    benchmarks: results([
      { benchmark: "MTEB (Multilingual, v2)", task: "text-embedding", metric: "mean (task)", score: 61.15, setting: "768d", source: GEMMA_CARD },
      { benchmark: "MTEB (English, v2)", task: "text-embedding", metric: "mean (task)", score: 69.67, setting: "768d", source: GEMMA_CARD },
      { benchmark: "MTEB (Code, v1)", task: "text-embedding", metric: "mean (task)", score: 68.76, setting: "768d", source: GEMMA_CARD },
    ]),
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
    benchmarks: results([
      { benchmark: "MeetingBank QA", task: "prompt-compression", metric: "exact match", score: 85.82, setting: "3.0x, GPT-3.5-Turbo target", source: LINGUA_PAPER },
      { benchmark: "LongBench (avg)", task: "prompt-compression", metric: "score", score: 38.2, setting: "2k-token budget (5x), GPT-3.5-Turbo target", source: LINGUA_PAPER },
      { benchmark: "LongBench (avg)", task: "prompt-compression", metric: "score", score: 41.9, setting: "3k-token budget (3x), GPT-3.5-Turbo target", source: LINGUA_PAPER },
    ]),
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
    benchmarks: results([
      { benchmark: "MMLU-Pro", task: "chat", metric: "accuracy", score: 29.7, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "MMLU-Pro", task: "chat", metric: "accuracy", score: 42.3, setting: "thinking", source: QWEN_CARD },
      { benchmark: "MMLU-Redux", task: "chat", metric: "accuracy", score: 48.5, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "IFEval", task: "chat", metric: "accuracy", score: 52.1, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "SuperGPQA", task: "reasoning", metric: "accuracy", score: 16.9, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "GPQA", task: "reasoning", metric: "accuracy", score: 11.9, setting: "thinking", source: QWEN_CARD },
      { benchmark: "BFCL-V4", task: "tool-calling", metric: "score", score: 25.3, setting: "thinking", source: QWEN_CARD },
      { benchmark: "TAU2-Bench", task: "tool-calling", metric: "score", score: 11.6, setting: "thinking", source: QWEN_CARD },
      { benchmark: "Mobile Actions (961)", task: "tool-calling", metric: "exact-call accuracy", score: 76.0, setting: CHART, source: NEEDLE_CHART, reportedBy: "third-party" },
      { benchmark: "DroidCall (200)", task: "tool-calling", metric: "exact calls in order", score: 28.0, setting: CHART, source: NEEDLE_CHART, reportedBy: "third-party" },
      { benchmark: "BFCL v4 (3,641)", task: "tool-calling", metric: "AST-match accuracy", score: 56.8, setting: CHART, source: NEEDLE_CHART, reportedBy: "third-party" },
      { benchmark: "DSTC8 (1,813 turns)", task: "structured-extraction", metric: "field micro-F1", score: 49.0, setting: CHART, source: NEEDLE_CHART, reportedBy: "third-party" },
      { benchmark: "SNIPS gold (700)", task: "structured-extraction", metric: "field micro-F1", score: 35.0, setting: CHART, source: NEEDLE_CHART, reportedBy: "third-party" },
      { benchmark: "SNIPS 7-way (700)", task: "structured-extraction", metric: "field micro-F1", score: 34.0, setting: CHART, source: NEEDLE_CHART, reportedBy: "third-party" },
      { benchmark: "MMMU", task: "vision-qa", metric: "accuracy", score: 47.4, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "RealWorldQA", task: "vision-qa", metric: "accuracy", score: 61.6, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "MMBench-EN-DEV v1.1", task: "vision-qa", metric: "accuracy", score: 68.0, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "OCRBench", task: "ocr", metric: "score", score: 79.1, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "CC-OCR", task: "ocr", metric: "score", score: 66.7, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "OmniDocBench v1.5", task: "document-parsing", metric: "overall", score: 70.6, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "MMLongBench-Doc", task: "document-parsing", metric: "accuracy", score: 28.1, setting: "non-thinking", source: QWEN_CARD },
      { benchmark: "CharXiv (RQ)", task: "chart-understanding", metric: "accuracy", score: 38.2, setting: "non-thinking", source: QWEN_CARD },
    ]),
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
    benchmarks: results([
      { benchmark: "SWE-bench Verified", task: "coding", metric: "resolved %", score: 70.6, setting: "OpenHands, 256K context", source: ORNITH_CARD },
      { benchmark: "SWE-bench Pro", task: "coding", metric: "resolved %", score: 47.5, setting: "OpenHands, 256K context", source: ORNITH_CARD },
      { benchmark: "Terminal-Bench 2.1", task: "coding", metric: "accuracy", score: 46.2, setting: "Terminus-2, 128K context", source: ORNITH_CARD },
      { benchmark: "GPQA Diamond", task: "reasoning", metric: "accuracy", score: 86.4, source: ORNITH_CARD },
      { benchmark: "HLE", task: "reasoning", metric: "accuracy", score: 20.2, setting: "no tools", source: ORNITH_CARD },
      { benchmark: "MCP-Atlas", task: "tool-calling", metric: "score", score: 54.2, setting: "thinking, 500-task public subset", source: ORNITH_CARD },
      { benchmark: "Toolathlon-Verified", task: "tool-calling", metric: "score", score: 41.2, setting: "128K token limit", source: ORNITH_CARD },
    ]),
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
    benchmarks: results([{ benchmark: "olmOCR-Bench", task: "document-parsing", metric: "overall", score: 83.2, source: "https://arxiv.org/html/2601.14251" }]),
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
    benchmarks: results([
      { benchmark: "OmniDocBench v1.6", task: "document-parsing", metric: "overall", score: 96.58, source: "https://arxiv.org/abs/2607.13639" },
      { benchmark: "OmniDocBench v1.6", task: "ocr", metric: "text edit distance", score: 0.025, higherIsBetter: false, source: "https://huggingface.co/StarDoc-AI/TeleOCR", reportedBy: "third-party" },
      { benchmark: "OmniDocBench v1.6", task: "table-extraction", metric: "table TEDS", score: 94.76, source: "https://huggingface.co/StarDoc-AI/TeleOCR", reportedBy: "third-party" },
    ]),
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
    benchmarks: [],
  },
];

/**
 * Tie-break order per task, used only when benchmarks cannot separate models (they
 * report different benchmarks). Specialists come before generalists, and larger
 * models before smaller ones.
 */
export const TASK_PREFERENCES: Partial<Record<TaskCategory, readonly string[]>> = {
  judgment: ["typesafe-ai/jev"],
  classification: ["typesafe-ai/jev", "Cactus-Compute/needle3"],
  "tool-calling": ["Cactus-Compute/needle3", "ornith-ai/Ornith-1.5-9B", "Qwen/Qwen3.5-0.8B"],
  "structured-extraction": ["Cactus-Compute/needle3", "Qwen/Qwen3.5-0.8B"],
  "text-embedding": ["google/embeddinggemma-300m", "Cactus-Compute/needle3"],
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
