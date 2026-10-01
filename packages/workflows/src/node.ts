import { experimental_codeModeTool as sessionCodeMode, experimental_runCodeMode as runCodeMode } from "@ai-sdk/code-mode";
import type { CodeMode } from "./code-mode.ts";

export { sessionCodeMode };

/** AI SDK code mode: QuickJS in a Node worker thread, with its time, memory and stack limits. Node only. */
export const aiCodeMode: CodeMode = ({ js, tools, abortSignal, timeoutMs }) =>
  runCodeMode({
    js,
    tools: { ...tools },
    toolExecutionOptions: { abortSignal },
    // Stryker disable next-line ConditionalExpression: equivalent; code mode reads an undefined limit as its default
    ...(timeoutMs === undefined ? {} : { options: { executionPolicy: { timeoutMs } } }),
  });
