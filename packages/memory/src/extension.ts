import { z } from "zod";
import type { CognitiveExtension, ModelDescriptor, Ports } from "@harness/cognitive";
import type { Memory } from "./memory.ts";

const Remember = z.object({ items: z.array(z.object({ text: z.string(), sessionId: z.string().exactOptional(), kind: z.string().exactOptional() })) });
const Recall = z.object({
  query: z.string(),
  limit: z.int().positive().exactOptional(),
  minScore: z.number().min(-1).max(1).exactOptional(),
  sessionId: z.string().exactOptional(),
  excludeSession: z.string().exactOptional(),
});

const parse = <T>(schema: z.ZodType<T>, op: string, input: unknown): T => {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw new Error(`invalid memory.${op} input\n${z.prettifyError(result.error)}`);
  return result.data;
};

/**
 * Memory for the cognitive core. Installing it brings the embedding models (the core
 * has none of its own) and the `memory.remember` / `memory.recall` operations; the
 * daemon offers `memory` and `cognitive.text-embedding` while it can serve them.
 * `models` come from memory's catalog (packages/memory/data, loaded by the host), and
 * `load` is the host's way to run a model on its platform.
 */
export function memoryExtension(options: { readonly memory: Memory; readonly models: readonly ModelDescriptor[]; readonly load: (model: ModelDescriptor) => Promise<Ports> }): CognitiveExtension {
  const { memory, models, load } = options;
  return {
    id: "memory",
    models: models.map((descriptor) => ({ descriptor, load: () => load(descriptor) })),
    operations: {
      remember: async (input) => ({ ids: await memory.remember(parse(Remember, "remember", input).items) }),
      recall: async (input) => {
        const { query, ...options } = parse(Recall, "recall", input);
        return { memories: await memory.recall(query, options) };
      },
    },
  };
}
