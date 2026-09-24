import { z } from "zod";
import { decideToolCalls } from "./cascade.ts";
import { EmbedInputSchema } from "./embedding.ts";
import type { Ensemble } from "./ensemble.ts";
import { TASK_CATEGORIES } from "./models.ts";
import { CompressRequestSchema, JudgeQuestionSchema, ParseRequestSchema, ToolSpecSchema } from "./ports.ts";

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
  judge: z.object({ state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]).default(""), questions: z.record(z.string(), JudgeQuestionSchema) }),
  route: ToolRequest,
  "decide-tools": ToolRequest.extend({ policy: z.object({ act: z.number(), verify: z.number(), accept: z.number() }).optional() }),
  embed: z.object({ inputs: z.array(EmbedInputSchema), dimensions: z.int().positive().optional() }),
  compress: CompressRequestSchema,
  parse: ParseRequestSchema,
  status: z.object({}),
} satisfies Record<Exclude<CognitiveOperation, ExtensionOperation>, z.ZodType>;

function parse<Op extends keyof typeof INPUTS>(op: Op, input: unknown): z.output<(typeof INPUTS)[Op]> {
  const result = INPUTS[op].safeParse(input ?? {});
  if (!result.success) throw new Error(`invalid ${op} input\n${z.prettifyError(result.error)}`);
  return result.data as z.output<(typeof INPUTS)[Op]>;
}

export async function invokeCognitive(ensemble: Ensemble, op: CognitiveOperation, input: unknown): Promise<unknown> {
  switch (op) {
    case "judge": {
      const request = parse(op, input);
      const { id, port } = await ensemble.resolve("judgment", "judge");
      return { model: id, answers: await port.evaluate(request) };
    }
    case "route": {
      const request = parse(op, input);
      const { id, port } = await ensemble.resolve("tool-calling", "router");
      return { model: id, ...(await port.route(request)) };
    }
    case "decide-tools": {
      const { policy, ...request } = parse(op, input);
      return policy === undefined ? decideToolCalls(ensemble, request) : decideToolCalls(ensemble, request, policy);
    }
    case "embed": {
      const { inputs, dimensions } = parse(op, input);
      const { id, port } = await ensemble.resolve("text-embedding", "embedder");
      const vectors = await port.embed(inputs, dimensions === undefined ? {} : { dimensions });
      return { model: id, vectors: vectors.map((v) => Array.from(v)) };
    }
    case "compress": {
      const request = parse(op, input);
      const { id, port } = await ensemble.resolve("prompt-compression", "compressor");
      return { model: id, ...(await port.compress(request)) };
    }
    case "parse": {
      const request = parse(op, input);
      const { id, port } = await ensemble.resolve("document-parsing", "document-parser");
      return { model: id, ...(await port.parse(request)) };
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
