import * as ort from "onnxruntime-node";
import { loadDecisionModel } from "@harness/models";
import type { DecisionFormat, OrtLike } from "@harness/models";
import type { ModelDescriptor } from "@harness/cognitive";
import { judgeContract } from "@harness/testkit";
import { decisionFiles } from "./decision-fixture.ts";

const FORMAT: DecisionFormat = {
  model: "model.onnx",
  tokenizer: "tokenizer.json",
  tokenizerConfig: "tokenizer_config.json",
  head: "{type} question: {question}",
  option: " {option}",
  types: { choice: { id: 0, name: "choice" }, score: { id: 1, name: "score" }, boolean: { id: 2, name: "noul" } },
  json: { item: ", ", key: ": " },
  limits: { tokens: 256, head: 128, option: 16, options: { min: 2, max: 8 }, cut: { head: 8, budget: 16, option: 4 } },
  strict: true,
  padTo: 8,
  batchTokens: 4096,
};

judgeContract("a decision model on onnxruntime (a tiny one whose scores are marker positions)", () => {
  const files = decisionFiles(FORMAT);
  const m = { id: "tiny/decider", runtime: "onnxruntime-decision", run: FORMAT } as Extract<ModelDescriptor, { runtime: "onnxruntime-decision" }>;
  return loadDecisionModel(m, { model: files[FORMAT.model]!, tokenizer: files[FORMAT.tokenizer]!, tokenizerConfig: files[FORMAT.tokenizerConfig]! }, { runtime: ort as unknown as OrtLike });
});
