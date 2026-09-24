import type { ToolCall, ToolSpec } from "@harness/cognitive";
import type { Learning, Reasoner } from "./learning.ts";
import type { Plugins } from "./plugins.ts";
import type { Lesson } from "./schemas.ts";

export type Rung = "native" | "tool" | "build-tool" | "teach";

export interface Evidence {
  readonly rung: Exclude<Rung, "teach">;
  /** "unknown" when the model that would assess it is not available. */
  readonly decision: "yes" | "no" | "unknown";
  readonly detail: string;
}

export interface Plan {
  readonly rung: Rung;
  /** Related lessons, and a playbook of them to put before the model, whatever the rung. */
  readonly lessons: readonly Lesson[];
  readonly playbook: string;
  /** The tool calls to make, for "tool". */
  readonly calls?: readonly ToolCall[];
  /** The plugin that builds the tool, for "build-tool". */
  readonly builder?: string;
  /** Who could watch a person do it, for "teach". */
  readonly teach?: { readonly teachers: readonly { readonly id: string; readonly modalities: readonly string[] }[] };
  readonly evidence: readonly Evidence[];
}

export interface LadderContext {
  readonly learning: Learning;
  readonly reasoner: Reasoner;
  readonly plugins: Plugins;
  /** The client's tool discovery (its capability registry, an MCP tool search...). */
  readonly discover?: (task: string) => Promise<readonly ToolSpec[]>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * How to take on a task, cheapest first. What the model knows how to do natively needs
 * no tools. Otherwise it uses a tool it has: offered with the task, found by discovery,
 * or built and learned earlier. Otherwise, if it knows how to build one and a
 * tool-building plugin is installed, it builds it. Otherwise it asks to be taught.
 * Each rung's decision is kept as evidence.
 */
export async function planTask(ctx: LadderContext, input: { readonly task: string; readonly tools?: readonly ToolSpec[] }): Promise<Plan> {
  const { task } = input;
  const { ladder } = ctx.learning.settings;
  const { lessons, playbook } = await ctx.learning.recall(task);
  const evidence: Evidence[] = [];
  const plan = (rung: Rung, extra: Partial<Plan> = {}): Plan => ({ rung, lessons, playbook, evidence, ...extra });
  const assess = async (rung: "native" | "build-tool", question: { readonly question: string; readonly threshold: number }): Promise<boolean> => {
    try {
      const answer = (await ctx.reasoner.judge({ state: { task, lessons: playbook }, questions: { [rung === "native" ? "native" : "build"]: { type: "boolean", instructions: question.question } } }))[rung === "native" ? "native" : "build"];
      const p = answer?.type === "boolean" ? answer.probability : 0;
      const yes = p >= question.threshold;
      evidence.push({ rung, decision: yes ? "yes" : "no", detail: `p=${p} ${yes ? "≥" : "<"} ${question.threshold}` });
      return yes;
    } catch (e) {
      evidence.push({ rung, decision: "unknown", detail: message(e) });
      return false;
    }
  };

  if (await assess("native", ladder.native)) return plan("native");

  const learned = lessons.flatMap((l) => (l.tool ? [l.tool] : []));
  const found = ctx.discover ? await ctx.discover(task) : [];
  const tools = [...new Map([...(input.tools ?? []), ...found, ...learned].map((t) => [t.name, t])).values()];
  if (tools.length === 0) evidence.push({ rung: "tool", decision: "no", detail: "no tools are available" });
  else {
    try {
      const routing = await ctx.reasoner.route({ input: task, tools });
      const yes = routing.calls.length > 0 && routing.confidence >= ladder.tool.confidence;
      evidence.push({ rung: "tool", decision: yes ? "yes" : "no", detail: routing.calls.length ? `confidence ${routing.confidence} ${yes ? "≥" : "<"} ${ladder.tool.confidence}` : `no tool fits: ${routing.reasoning}` });
      if (yes) return plan("tool", { calls: routing.calls });
    } catch (e) {
      evidence.push({ rung: "tool", decision: "unknown", detail: message(e) });
    }
  }

  const builder = ctx.plugins.materializer("tool");
  if (!builder) evidence.push({ rung: "build-tool", decision: "no", detail: "no tool-building plugin is installed" });
  else if (await assess("build-tool", ladder.build)) return plan("build-tool", { builder: builder.id });

  return plan("teach", { teach: { teachers: ctx.plugins.teachers().map((t) => ({ id: t.id, modalities: t.modalities })) } });
}
