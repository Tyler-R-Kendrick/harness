/**
 * What the cognitive core knows about a model: the task categories it serves, the
 * ports its adapter implements, where it can run, and the published benchmark
 * results that back choosing it for a task.
 */

export type Platform = "native" | "browser";

/** Task categories the cognitive core routes work by. */
export const TASK_CATEGORIES = [
  "judgment",
  "classification",
  "tool-calling",
  "structured-extraction",
  "text-embedding",
  "prompt-compression",
  "chat",
  "reasoning",
  "coding",
  "vision-qa",
  "ocr",
  "document-parsing",
  "table-extraction",
  "chart-understanding",
] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

/** Adapter interfaces (see ports.ts); a model may implement several. */
export type PortKind = "judge" | "router" | "embedder" | "compressor" | "generator" | "document-parser";

/** Which ports can serve each task. */
export const TASK_PORTS: Readonly<Record<TaskCategory, readonly PortKind[]>> = {
  judgment: ["judge"],
  classification: ["judge", "router"],
  "tool-calling": ["router", "generator"],
  "structured-extraction": ["router", "generator"],
  "text-embedding": ["embedder"],
  "prompt-compression": ["compressor"],
  chat: ["generator"],
  reasoning: ["generator"],
  coding: ["generator"],
  "vision-qa": ["generator"],
  ocr: ["document-parser", "generator"],
  "document-parsing": ["document-parser", "generator"],
  "table-extraction": ["document-parser", "generator"],
  "chart-understanding": ["document-parser", "generator"],
};

export type Locality = "local" | "hosted";
export type Runtime = "ai-gateway" | "needle-wasm" | "transformers.js" | "llama.cpp-server";

export interface BenchmarkResult {
  /** Benchmark name with version or split, e.g. "MTEB (Multilingual, v2)". */
  readonly benchmark: string;
  readonly task: TaskCategory;
  readonly metric: string;
  readonly score: number;
  readonly higherIsBetter: boolean;
  /** Conditions the number depends on, e.g. "thinking", "768d". Only equal settings are compared. */
  readonly setting?: string;
  /** Where the number was published. */
  readonly source: string;
  /** Who produced the number; absent means the model's publisher. */
  readonly reportedBy?: "vendor" | "third-party";
}

export interface ArtifactFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256?: string;
}

export interface Artifact {
  readonly repo: string;
  /** Pinned commit, never a moving branch. */
  readonly revision: string;
  readonly files: readonly ArtifactFile[];
}

export interface ModelDescriptor {
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  readonly tasks: readonly TaskCategory[];
  readonly ports: readonly PortKind[];
  readonly locality: Locality;
  readonly runtime: Runtime;
  readonly platforms: readonly Platform[];
  readonly license: string;
  /** Bytes a client must download to run it; 0 for hosted models. */
  readonly downloadBytes: number;
  readonly benchmarks: readonly BenchmarkResult[];
  readonly artifact?: Artifact;
  readonly notes?: string;
}
