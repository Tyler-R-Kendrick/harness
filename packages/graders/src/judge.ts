import { generateText } from "ai";
import type { LanguageModel } from "ai";

export interface JudgeClient {
  chat: { completions: { create(params: Record<string, unknown>): Promise<{ choices: { message: { role: "assistant"; content: string } }[] }> } };
}

export function aiSdkJudgeClient(model: LanguageModel): JudgeClient {
  return {
    chat: {
      completions: {
        async create(params) {
          const messages = Array.isArray(params["messages"]) ? params["messages"] : [];
          const prompt = messages.map((message) => {
            if (typeof message !== "object" || message === null) return "";
            return String((message as { content?: unknown }).content ?? "");
          }).join("\n");
          const result = await generateText({ model, prompt });
          return { choices: [{ message: { role: "assistant", content: result.text } }] };
        },
      },
    },
  };
}

export async function llmJudge(client: JudgeClient, rubric: string, output: string): Promise<{ passed: boolean; detail?: string }> {
  const { createLLMAsJudge } = await import("openevals");
  const evaluator = createLLMAsJudge({
    prompt: `${rubric}\n{outputs}`,
    judge: client,
    model: "judge",
    useReasoning: true,
  });
  const result = await evaluator({ outputs: output });
  const passed = result.score === true || result.score === 1;
  return result.comment === undefined ? { passed } : { passed, detail: result.comment };
}

export async function loadJudgeModel(provider: "openai" | "anthropic", model: string): Promise<Exclude<LanguageModel, string>> {
  if (provider === "openai") {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI()(model);
  }
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  return createAnthropic()(model);
}
