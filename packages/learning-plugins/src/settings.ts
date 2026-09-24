import { z } from "zod";

const unit = z.number().min(0).max(1);
const text = z.string().min(1);

/** The plugins' tunables and prompts (data/settings.json). */
export const PluginSettingsSchema = z.strictObject({
  $schema: z.string().exactOptional(),
  workflow: z.strictObject({
    /** The router's confidence needed to turn a procedure step into a tool call; below it the step asks the model. */
    toolConfidence: unit,
  }),
  toolBuilder: z.strictObject({
    /** Instructions for the model that writes a tool's workflow code (code mode). */
    system: text,
    maxTokens: z.int().positive(),
    /** Drafts to try; each failed check is shown to the next. */
    attempts: z.int().positive(),
  }),
  teacher: z.strictObject({
    /** Asked of a vision model about each screen frame. */
    screen: text,
    maxTokens: z.int().positive(),
  }),
});
export type PluginSettings = z.output<typeof PluginSettingsSchema>;

export function parsePluginSettings(input: unknown): PluginSettings {
  const result = PluginSettingsSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid learning plugin settings\n${z.prettifyError(result.error)}`);
  return result.data;
}

export const pluginSettingsJsonSchema = (): object => z.toJSONSchema(PluginSettingsSchema, { io: "input" });
