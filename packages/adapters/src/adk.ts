import { z } from "zod";
import type { Case } from "@harness/ir";

const AdkFile = z.object({
  eval_set_id: z.string().min(1),
  name: z.string().min(1),
  eval_cases: z.array(z.object({
    eval_id: z.string().min(1),
    conversation: z.array(z.object({
      user_content: z.object({
        parts: z.array(z.object({ text: z.string().exactOptional() }).passthrough()),
      }).passthrough().exactOptional(),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

export function adkToCases(input: unknown): Case[] {
  const file = AdkFile.safeParse(input);
  if (!file.success) throw new Error(file.error.issues.map((item) => item.message).join("; "));
  return file.data.eval_cases.map((item) => {
    const texts: string[] = [];
    for (const turn of item.conversation) {
      for (const part of turn.user_content?.parts ?? []) {
        if (part.text !== undefined) texts.push(part.text);
      }
    }
    if (texts.length === 0) throw new Error(`missing instruction for ${item.eval_id}`);
    return { id: item.eval_id, source: "adk" as const, instruction: texts.join("\n") };
  });
}
