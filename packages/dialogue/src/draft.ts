import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { exponential } from "./render.ts";
import { ScriptSchema } from "./schemas.ts";
import type { Observation, Part, Script, ScriptId, Settings } from "./schemas.ts";

const text = z.string().min(1);

const DraftSlot = z.strictObject({ name: text, description: text, pattern: text.exactOptional(), prompt: text.exactOptional() });
const DraftPart = z.union([z.strictObject({ text: z.string() }), z.strictObject({ slot: text }), z.strictObject({ generate: text })]);
const DraftScript = { intent: text, exemplars: z.array(text), slots: z.array(DraftSlot), reply: z.array(DraftPart).min(1) };

/** What the drafter answers: a script for the exchanges it was shown, and scripts for what the user will likely say next. */
export const DraftSchema = z.strictObject({ ...DraftScript, followUps: z.array(z.strictObject(DraftScript)) });
export type Draft = z.output<typeof DraftSchema>;
type DraftedScript = Omit<Draft, "followUps">;

/**
 * Ask the drafter for a script for a cluster of exchanges (requests of one kind the
 * model answered) and for its follow-ups, constrained to DraftSchema's JSON Schema.
 */
export async function draft(model: LanguageModel, settings: Settings["draft"], observations: readonly Observation[]): Promise<Draft> {
  const exchanges = observations.map((o) => ({ user: o.utterance, assistant: o.reply }));
  const { output } = await generateText({
    model,
    instructions: settings.system,
    prompt: JSON.stringify({ exchanges, followUps: settings.followUps }),
    maxOutputTokens: settings.maxTokens,
    maxRetries: 0,
    output: Output.object({ schema: DraftSchema }),
  });
  return output;
}

/** A drafted script as a candidate script, in a context and a scope (parsed: an invalid one, or one with a slot pattern that could take exponential time, throws). */
export function draftedScript(drafted: DraftedScript, id: ScriptId, context: ScriptId | undefined, scope?: string): Script {
  const risky = drafted.slots.find((s) => s.pattern !== undefined && exponential(s.pattern));
  if (risky) throw new Error(`drafted slot ${risky.name} has a pattern that can take exponential time: ${risky.pattern}`);
  const reply = drafted.reply.flatMap((p): Part[] => ("text" in p ? (p.text === "" ? [] : [p.text]) : "slot" in p ? [{ slot: p.slot }] : [{ generate: p.generate }]));
  const slots = Object.fromEntries(
    drafted.slots.map((s) => [s.name, { description: s.description, ...(s.pattern === undefined ? {} : { pattern: s.pattern }), prompts: s.prompt === undefined ? [] : [s.prompt] }]),
  );
  return ScriptSchema.parse({ id, intent: drafted.intent, status: "candidate", origin: "drafted", ...(scope === undefined ? {} : { scope }), ...(context === undefined ? {} : { context }), exemplars: drafted.exemplars, slots, reply });
}
