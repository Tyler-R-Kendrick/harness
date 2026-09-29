import { z } from "zod";
import type { Case } from "@harness/ir";

const SkillsFile = z.object({
  skill: z.string().min(1),
  evals: z.array(z.object({
    id: z.string().min(1),
    prompt: z.string(),
    expected: z.string().exactOptional(),
    files: z.array(z.string()).exactOptional(),
  }).strict()),
}).strict();

export function skillsToCases(input: unknown): Case[] {
  const file = SkillsFile.safeParse(input);
  if (!file.success) throw new Error(file.error.issues.map((item) => item.message).join("; "));
  return file.data.evals.map((item) => {
    const specCase: Case = { id: item.id, source: "skills", instruction: item.prompt };
    const expect: NonNullable<Case["expect"]> = {};
    if (item.expected !== undefined) expect.promptfoo = [{ type: "contains", value: item.expected }];
    if (item.files !== undefined) expect.files = item.files;
    if (item.expected !== undefined || item.files !== undefined) specCase.expect = expect;
    return specCase;
  });
}
