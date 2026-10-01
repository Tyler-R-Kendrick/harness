import type { Experimental_ToolCallers, Tool, ToolSet } from "ai";
import { rankTools } from "@harness/cognitive";
import type { EvaluationModelV4 } from "@harness/cognitive";

/** The code-mode caller a session adds when an MCP tool remains. */
export const CODE_MODE = "code_mode";

/** Names that are MCP tools: listed ones, and any tool whose name starts with `mcp:`. */
export function mcpToolNames(tools: ToolSet, listed: readonly string[] = []): ReadonlySet<string> {
  const extra = new Set(listed);
  const names = new Set<string>();
  for (const name of Object.keys(tools)) {
    if (name === CODE_MODE) continue;
    if (extra.has(name) || name.startsWith("mcp:")) names.add(name);
  }
  return names;
}

function described(name: string, tool: { readonly description?: unknown }): string {
  const description = tool.description;
  return typeof description === "string" && description.length > 0 ? description : name;
}

/**
 * Tools a turn offers the model. The decision layer, when given, ranks them and leaves
 * out those below the decision bar. An MCP tool that remains is callable only through
 * code mode. A decision model that throws leaves the set unpruned.
 */
export async function offerTurnTools(options: {
  readonly input: string;
  readonly tools: ToolSet;
  readonly mcp: ReadonlySet<string>;
  readonly decide?: EvaluationModelV4;
  readonly codeMode?: Tool;
}): Promise<{
  readonly tools: ToolSet;
  readonly toolOrder: readonly string[];
  readonly experimental_toolCallers?: Experimental_ToolCallers<ToolSet>;
}> {
  const specs = Object.entries(options.tools).flatMap(([name, tool]) => (name === CODE_MODE ? [] : [{ name, description: described(name, tool) }]));
  let ranked: readonly string[] | undefined;
  if (options.decide && options.input.length > 0 && specs.length > 0) {
    try {
      ranked = (await rankTools(options.decide, { input: options.input, tools: specs })).map((row) => row.name);
    } catch {
      ranked = undefined;
    }
  }
  const kept = ranked === undefined ? specs.map((spec) => spec.name) : ranked.filter((name) => Object.hasOwn(options.tools, name));
  const mcp = kept.filter((name) => options.mcp.has(name));
  const direct = kept.filter((name) => !options.mcp.has(name));
  const tools: ToolSet = {};
  if (mcp.length > 0) {
    const codeMode = options.codeMode ?? options.tools[CODE_MODE];
    if (codeMode === undefined) throw new Error("an MCP tool needs code mode");
    tools[CODE_MODE] = codeMode;
    for (const name of mcp) tools[name] = options.tools[name]!;
  }
  for (const name of direct) tools[name] = options.tools[name]!;
  const toolOrder = mcp.length > 0 ? [CODE_MODE, ...direct] : direct;
  if (mcp.length === 0) return { tools, toolOrder };
  // A generic ToolSet cannot name the code_mode caller; the host tool is that caller.
  return {
    tools,
    toolOrder,
    experimental_toolCallers: Object.fromEntries(mcp.map((name) => [name, [CODE_MODE]])) as unknown as Experimental_ToolCallers<ToolSet>,
  };
}
