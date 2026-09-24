import type { ModelDescriptor } from "@harness/cognitive";

const GEMMA_CARD = "https://huggingface.co/google/embeddinggemma-300m";

/** The embedding models memory brings to the cognitive core; pinned like the core catalog. */
export const MEMORY_MODELS: readonly ModelDescriptor[] = [
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
    benchmarks: [
      { benchmark: "MTEB (Multilingual, v2)", task: "text-embedding", metric: "mean (task)", score: 61.15, setting: "768d", higherIsBetter: true, source: GEMMA_CARD },
      { benchmark: "MTEB (English, v2)", task: "text-embedding", metric: "mean (task)", score: 69.67, setting: "768d", higherIsBetter: true, source: GEMMA_CARD },
      { benchmark: "MTEB (Code, v1)", task: "text-embedding", metric: "mean (task)", score: 68.76, setting: "768d", higherIsBetter: true, source: GEMMA_CARD },
    ],
  },
];
