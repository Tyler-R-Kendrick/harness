/**
 * A plan task on a model (ADR 0016, plan §7.6): the default `PlanTask` a host runs plans
 * with. A bound task is one AI SDK `generateText` step offered only its bound tool, with
 * the tool choice forced to it, so the model spends its answer on the tool's arguments
 * alone (the tool's input schema is the constraint). A workflow binding is a tool like
 * any other: `revisionTools` offers the workflows a head binds under their names. The
 * prompt is the settings' `planTask`, filled with the task's node, its guidance (the
 * transitions into its node in the plan's graph, as the serializer writes them) and its
 * inputs. The task succeeds with the tool's result, and fails with its error, a call the
 * tool's schema refuses, or no result; an answer with no call throws (the SDK's
 * `ToolChoiceViolationError`), which `runPlan` takes as the task's failure. An unbound
 * task is done by the model in text.
 */
import { generateText } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { incoming } from "./graph.ts";
import type { EffectiveGraph } from "./overlay-types.ts";
import type { PlanTask } from "./plan-run.ts";
import { renderPrompt } from "./prompt.ts";
import { serializeTransitions } from "./serialize.ts";
import type { Settings } from "./settings.ts";

export interface ModelTaskOptions {
  readonly model: LanguageModel;
  /** The tools plans may call: a host's session tools, with the workflows the graph's head binds. */
  readonly tools: ToolSet;
  readonly settings: Pick<Settings, "prompts" | "decoding">;
  /** The plan's graph, whose transitions guide each task; without it, tasks have no guidance. */
  readonly graph?: EffectiveGraph;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function modelTask(options: ModelTaskOptions): PlanTask {
  const { model, tools, settings, graph } = options;
  const decoding = { temperature: settings.decoding.temperature, topK: settings.decoding.topK, maxOutputTokens: settings.decoding.solverMaxTokens };
  return async ({ id, payload, inputs }) => {
    const name = payload.binding?.name;
    if (name !== undefined && !Object.hasOwn(tools, name)) return { ok: false, error: `tool ${name} is not available to plans` };
    const guidance = graph === undefined ? "" : serializeTransitions(incoming(graph, id));
    const task = `[${payload.node.id}] (Type: ${payload.node.type})\nDescription: ${payload.node.description}`;
    const prompt = renderPrompt(settings.prompts.planTask, { task, guidance, inputs: JSON.stringify(inputs) });
    if (name === undefined) return { ok: true, output: (await generateText({ model, prompt, ...decoding })).text };
    // Stryker disable next-line StringLiteral: equivalent; the SDK reads any object tool choice as the tool it names by toolName
    const result = await generateText({ model, prompt, tools: { [name]: tools[name]! }, toolChoice: { type: "tool", toolName: name }, ...decoding });
    for (const part of result.content) {
      if (part.type === "tool-result") return { ok: true, output: part.output };
      if (part.type === "tool-error") return { ok: false, error: messageOf(part.error) };
    }
    // A tool with no `execute` gives the call no result.
    return { ok: false, error: `tool ${name} returned no result` };
  };
}
