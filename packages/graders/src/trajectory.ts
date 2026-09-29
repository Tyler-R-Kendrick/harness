import type { ToolCall, ToolMatch } from "@harness/ir";

function messages(tools: readonly ToolCall[]): { role: "assistant"; content: string; tool_calls?: { function: { name: string; arguments: string } }[] }[] {
  if (tools.length === 0) return [{ role: "assistant", content: "" }];
  return tools.map((tool) => ({
    role: "assistant" as const,
    content: "",
    tool_calls: [{ function: { name: tool.name, arguments: JSON.stringify(tool.args ?? {}) } }],
  }));
}

/** agentevals strict, unordered, subset, and superset. Args are ignored when the expected call omits them. */
export async function matchTrajectory(mode: ToolMatch, expected: readonly ToolCall[], actual: readonly ToolCall[]): Promise<boolean> {
  const { createTrajectoryMatchEvaluator } = await import("agentevals");
  const overrides: Record<string, "exact" | "ignore"> = {};
  for (const tool of expected) overrides[tool.name] = tool.args === undefined ? "ignore" : "exact";
  const evaluator = createTrajectoryMatchEvaluator({
    trajectoryMatchMode: mode,
    toolArgsMatchMode: expected.some((tool) => tool.args !== undefined) ? "exact" : "ignore",
    toolArgsMatchOverrides: overrides,
  });
  const result = await evaluator({ outputs: messages(actual), referenceOutputs: messages(expected) });
  return result.score === true || result.score === 1;
}
