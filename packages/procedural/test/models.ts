/** AI SDK mock models for the procedural model calls (guide, refine, reflect). */
import { MockLanguageModelV4 } from "ai/test";
import { usage } from "@harness/cognitive";

/** A model that answers every call with `text`, recording the calls it gets. */
export function answering(text: string | ((call: number) => string), tokens: { input?: number; output?: number } = {}): MockLanguageModelV4 {
  let calls = 0;
  return new MockLanguageModelV4({
    modelId: "mock-guide",
    doGenerate: async () => ({
      content: [{ type: "text", text: typeof text === "string" ? text : text(calls++) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: usage(tokens.input, tokens.output),
      warnings: [],
    }),
  });
}
