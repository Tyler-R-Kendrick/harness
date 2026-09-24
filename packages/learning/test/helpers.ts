import { Ensemble } from "@harness/cognitive";
import type { GenerateRequest, JudgeAnswer, JudgeQuestion, JudgeRequest, ModelDescriptor, Ports } from "@harness/cognitive";
import { Memory } from "@harness/memory";
import { parseSettings } from "@harness/learning";
import type { Settings } from "@harness/learning";
import { HashEmbedder, KeywordRouter, ScriptedGenerator, ScriptedJudge } from "@harness/testkit";

export const settings: Settings = parseSettings({
  reflection: { system: "Distill lessons as JSON.", maxTokens: 512, related: 4 },
  curation: { duplicate: 0.9, retireMargin: 2 },
  recall: { limit: 5, minScore: 0.2 },
  ladder: {
    native: { question: "Can you do this without tools?", threshold: 0.7 },
    tool: { confidence: 0.6 },
    build: { question: "Can you build a tool for this?", threshold: 0.6 },
  },
});

const descriptor = (id: string, tasks: ModelDescriptor["tasks"], ports: ModelDescriptor["ports"]): ModelDescriptor =>
  ({ id, name: id, publisher: "t", tasks, ports, locality: "local", runtime: "transformers.js", run: { dtype: "q4" }, platforms: ["native"], license: "MIT", downloadBytes: 1, benchmarks: [] }) as ModelDescriptor;

/**
 * An ensemble with scripted models: the generator answers reflections with `reflect`,
 * the judge answers the ladder's questions with `judge`, and a keyword router picks tools.
 */
export function setup(options: { reflect?: (request: GenerateRequest) => string; judge?: (id: string, q: JudgeQuestion, r: JudgeRequest) => JudgeAnswer | undefined; noJudge?: boolean; noRouter?: boolean } = {}) {
  const ensemble = new Ensemble({ platform: "native" });
  const generator = new ScriptedGenerator(options.reflect ?? (() => `{"operations": []}`), 50);
  const judge = new ScriptedJudge(options.judge);
  const router = new KeywordRouter();
  const register = (id: string, tasks: ModelDescriptor["tasks"], ports: ModelDescriptor["ports"], p: Ports) => ensemble.register(descriptor(id, tasks, ports), async () => p);
  register("generator-a", ["reasoning", "chat", "coding", "vision-qa"], ["generator"], { generator });
  if (!options.noJudge) register("judge-a", ["judgment"], ["judge"], { judge });
  if (!options.noRouter) register("router-a", ["tool-calling"], ["router"], { router });
  register("embedder-a", ["text-embedding"], ["embedder"], { embedder: new HashEmbedder(64) });
  const memory = new Memory(ensemble, { dimensions: 64 });
  return { ensemble, generator, judge, router, memory };
}

export const reply = (operations: unknown[]) => JSON.stringify({ operations });
