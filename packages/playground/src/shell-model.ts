/**
 * A deterministic language model for the playground: a prompt starting with `$ ` is a
 * call of the `bash` tool, and the tool's result (or its denial) is the reply. With it
 * the whole path of a tool call (model, approval, tool, filesystem, trace) can be
 * watched and tested without spending anyone's model usage.
 */
import type { LanguageModelV4, LanguageModelV4Prompt, LanguageModelV4StreamPart, LanguageModelV4ToolResultOutput } from "@ai-sdk/provider";
import { createIdGenerator, simulateReadableStream } from "ai";
import { collectParts, finishReason, usage } from "@harness/cognitive";

const HINT = "I run shell commands. Start a prompt with $ and a command line, for example: $ ls -la";

function report(output: LanguageModelV4ToolResultOutput): string {
  if (output.type === "execution-denied") return "The command did not run: denied by the person.";
  const r = output.value as { exitCode?: unknown; stdout?: unknown; stderr?: unknown } | null;
  return typeof r?.exitCode === "number" ? `exit ${r.exitCode}\n${String(r.stdout)}${String(r.stderr)}` : JSON.stringify(output.value);
}

/** The reply's parts: a bash call for `$ …`, the tool's result after a tool turn, else a hint. */
function parts(prompt: LanguageModelV4Prompt, id: () => string): LanguageModelV4StreamPart[] {
  const last = prompt.at(-1)!;
  const said = last.role === "user" ? last.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim() : "";
  const text =
    last.role === "tool" ? last.content.flatMap((p) => (p.type === "tool-result" ? [report(p.output)] : [])).join("\n") : said.startsWith("$ ") ? undefined : HINT;
  const body: LanguageModelV4StreamPart[] =
    text === undefined
      ? [{ type: "tool-call", toolCallId: id(), toolName: "bash", input: JSON.stringify({ command: said.slice(2) }) }]
      : [
          { type: "text-start", id: "0" },
          { type: "text-delta", id: "0", delta: text },
          { type: "text-end", id: "0" },
        ];
  return [{ type: "stream-start", warnings: [] }, ...body, { type: "finish", finishReason: finishReason(text === undefined ? "tool-calls" : "stop"), usage: usage() }];
}

export function shellModel(): LanguageModelV4 {
  // Unique across page loads, since a conversation outlives the model that wrote it.
  const id = createIdGenerator({ prefix: "shell" });
  return {
    specificationVersion: "v4",
    provider: "harness.playground",
    modelId: "shell",
    supportedUrls: {},
    doGenerate: async (options) => collectParts(parts(options.prompt, id)),
    doStream: async (options) => ({ stream: simulateReadableStream({ chunks: parts(options.prompt, id), initialDelayInMs: null, chunkDelayInMs: null }) }),
  };
}
