import { embedMany, experimental_evaluate, generateText } from "ai";
import { z } from "zod";
import { CascadePolicySchema, decideToolCalls, route } from "./cascade.ts";
import { parseChatOutput } from "./chat-format.ts";
import { EmbedInputSchema } from "./embedding.ts";
import type { EmbedInput } from "./embedding.ts";
import type { Ensemble } from "./ensemble.ts";
import { TASK_CATEGORIES } from "./models.ts";
import { embedding, MODEL_HEADER } from "./options.ts";
import { CompressRequestSchema, JudgeAnswerSchema, JudgeQuestionSchema, ParseRequestSchema, ToolSpecSchema } from "./ports.ts";
import { DimensionsSchema } from "./units.ts";
import type { Dimensions } from "./units.ts";

/**
 * The cognitive core's operations as JSON in, JSON out: what the daemon's
 * `_harness/cognitive/*` methods run on the host's ensemble. Every input is parsed
 * before anything runs, and every result names the model that produced it.
 */
export type CognitiveOperation = "judge" | "route" | "decide-tools" | "embed" | "compress" | "parse" | "status" | ExtensionOperation;
/** An installed extension's operation, e.g. `memory.recall`. */
export type ExtensionOperation = `${string}.${string}`;

const ToolRequest = z.object({ input: z.string(), tools: z.array(ToolSpecSchema) });

const INPUTS = {
  judge: z.object({ state: z.union([z.string(), z.record(z.string(), z.json()), z.array(z.json())]).default(""), questions: z.record(z.string(), JudgeQuestionSchema) }),
  route: ToolRequest,
  "decide-tools": ToolRequest.extend({ policy: CascadePolicySchema.optional() }),
  embed: z.object({ inputs: z.array(EmbedInputSchema), dimensions: DimensionsSchema.optional() }),
  compress: CompressRequestSchema,
  parse: ParseRequestSchema,
  status: z.object({}),
} satisfies Record<Exclude<CognitiveOperation, ExtensionOperation>, z.ZodType>;

function parse<Op extends keyof typeof INPUTS>(op: Op, input: unknown): z.output<(typeof INPUTS)[Op]> {
  const result = INPUTS[op].safeParse(input ?? {});
  if (!result.success) throw new Error(`invalid ${op} input\n${z.prettifyError(result.error)}`);
  return result.data as z.output<(typeof INPUTS)[Op]>;
}

/** Consecutive inputs that share their settings (kind, task, title), so each group is one embedding call. */
function groups(inputs: readonly EmbedInput[]): EmbedInput[][] {
  const key = (i: EmbedInput) => JSON.stringify([i.kind, i.kind === "query" ? i.task : i.title]);
  const out: EmbedInput[][] = [];
  for (const input of inputs) {
    const last = out.at(-1);
    if (last && key(last[0]!) === key(input)) last.push(input);
    else out.push([input]);
  }
  return out;
}

async function embedAll(ensemble: Ensemble, inputs: readonly EmbedInput[], dimensions: Dimensions | undefined) {
  let model: string | undefined;
  const vectors: number[][] = [];
  for (const group of groups(inputs)) {
    const first = group[0]!;
    const result = await embedMany({
      model: ensemble.embeddingModel(),
      values: group.map((i) => i.text),
      maxRetries: 0,
      ...embedding({
        kind: first.kind,
        ...(first.kind === "query" ? (first.task === undefined ? {} : { task: first.task }) : first.title === undefined ? {} : { title: first.title }),
        ...(dimensions === undefined ? {} : { dimensions }),
      }),
    });
    model ??= result.responses?.find((r) => r?.headers?.[MODEL_HEADER])?.headers?.[MODEL_HEADER];
    vectors.push(...result.embeddings);
  }
  return { model, vectors };
}

export async function invokeCognitive(ensemble: Ensemble, op: CognitiveOperation, input: unknown): Promise<unknown> {
  switch (op) {
    case "judge": {
      const request = parse(op, input);
      const result = await experimental_evaluate({ model: ensemble.evaluationModel(), state: request.state, questions: request.questions, maxRetries: 0 });
      return { model: result.response.headers?.[MODEL_HEADER], answers: Object.fromEntries(Object.entries(result.answers).map(([k, a]) => [k, JudgeAnswerSchema.parse(a)])) };
    }
    case "route": {
      const { model, valid, problems, confidence, reasoning } = await route(ensemble.languageModel("tool-calling", "router"), parse(op, input));
      return { model, calls: valid, ...(problems.length ? { invalid: problems } : {}), confidence, reasoning };
    }
    case "decide-tools": {
      const { policy, ...request } = parse(op, input);
      return policy === undefined ? decideToolCalls(ensemble, request) : decideToolCalls(ensemble, request, policy);
    }
    case "embed": {
      const { inputs, dimensions } = parse(op, input);
      return embedAll(ensemble, inputs, dimensions);
    }
    case "compress":
      return ensemble.compress(parse(op, input));
    case "parse": {
      const { pages, instruction } = parse(op, input);
      let model: string | undefined;
      const parsed = [];
      for (const page of pages) {
        const { text, response } = await generateText({
          model: ensemble.languageModel("document-parsing", "document-parser"),
          maxRetries: 0,
          messages: [{ role: "user", content: [{ type: "file", data: page.data, mediaType: page.mediaType }, ...(instruction === undefined ? [] : [{ type: "text" as const, text: instruction }])] }],
        });
        model ??= response.headers?.[MODEL_HEADER];
        parsed.push({ markdown: parseChatOutput(text).text, raw: text });
      }
      return { model, pages: parsed };
    }
    case "status":
      parse(op, input);
      return {
        platform: ensemble.platform,
        members: ensemble.members().map((m) => ({
          id: m.id,
          name: m.descriptor.name,
          state: m.state,
          ...(m.reason === undefined ? {} : { reason: m.reason }),
          tasks: m.descriptor.tasks,
          locality: m.descriptor.locality,
          runtime: m.descriptor.runtime,
        })),
        tasks: Object.fromEntries(TASK_CATEGORIES.map((t) => [t, ensemble.candidates(t).map((r) => ({ id: r.id, wins: r.wins, losses: r.losses }))])),
        extensions: ensemble.extensions(),
      };
    default: {
      const operation = ensemble.operation(op);
      if (!operation) throw new Error(`no installed extension serves ${op}`);
      return operation(input);
    }
  }
}

/**
 * Keep `cognitive.<task>` capabilities in step with the ensemble: offered while some
 * member in service can serve the task, withdrawn when revocation or failure leaves
 * none. Returns a function that stops mirroring.
 */
export function mirrorCapabilities(ensemble: Ensemble, sink: { offer(name: string): void; withdraw(name: string): void }): () => void {
  let offered = new Set<string>();
  const sync = () => {
    const now = new Set([...TASK_CATEGORIES.filter((t) => ensemble.candidates(t).length > 0).map((t) => `cognitive.${t}`), ...ensemble.extensions()]);
    for (const name of offered) if (!now.has(name)) sink.withdraw(name);
    for (const name of now) if (!offered.has(name)) sink.offer(name);
    offered = now;
  };
  sync();
  return ensemble.onChange(sync);
}
