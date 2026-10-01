import { z } from "zod";

/**
 * A person's negative feedback on an answer, kept for a later trainer (RLHF preference
 * data). A record is appended; it is not collapsed into a helpful or harmful count.
 * "Steering" here is the person's instruction as text. SAE residual steering is unrelated.
 */
export const CORRECTION_ACTIONS = ["rating", "replacement", "steering"] as const;
export type CorrectionAction = (typeof CORRECTION_ACTIONS)[number];

export const ARTIFACT_KINDS = ["template", "workflow", "script"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ArtifactRefSchema = z.strictObject({
  kind: z.enum(ARTIFACT_KINDS),
  id: z.string().min(1),
});
export type ArtifactRef = z.output<typeof ArtifactRefSchema>;

const correctionFields = {
  /** What the person said. */
  utterance: z.string().min(1),
  /** The answer that was rejected or steered. */
  answer: z.string().min(1),
  /** What the person wrote. Empty when a rating carries no replacement and no instruction. */
  text: z.string(),
  action: z.enum(CORRECTION_ACTIONS),
  artifact: ArtifactRefSchema,
};

export const CorrectionInputSchema = z.strictObject(correctionFields).superRefine(needsText);
export type CorrectionInput = z.output<typeof CorrectionInputSchema>;

export const PreferenceRecordSchema = z
  .strictObject({ ...correctionFields, signal: z.literal("negative") })
  .superRefine(needsText);
export type PreferenceRecord = z.output<typeof PreferenceRecordSchema>;

function needsText(value: { readonly action: CorrectionAction; readonly text: string }, ctx: z.RefinementCtx): void {
  if (value.action !== "rating" && value.text.trim() === "") ctx.addIssue({ code: "custom", message: "a replacement or a steering instruction needs the person's text" });
}

/** The text the next use of a template or a chat script should return. */
export function correctedText(content: string, action: CorrectionAction, text: string): string {
  if (action === "rating") return content;
  if (action === "replacement") return text;
  return `${content}\n${text}`;
}

/**
 * Workflow code whose next run returns the correction. A replacement returns that text.
 * A steering instruction keeps the previous code, and the run's output still contains
 * the previous result and the instruction.
 */
export function correctedWorkflow(code: string, action: CorrectionAction, text: string): string {
  if (action === "rating") return code;
  if (action === "replacement") return `return ${JSON.stringify(text)};`;
  const note = JSON.stringify(text);
  return `const __previous = await (async () => {\n${code}\n})();\nconst __note = ${note};\nif (typeof __previous === "string") return __previous + "\\n" + __note;\nif (Array.isArray(__previous)) return [...__previous, __note];\nif (__previous !== null && typeof __previous === "object") return { ...__previous, steering: __note };\nreturn String(__previous) + "\\n" + __note;`;
}

export function correctedArtifact(kind: ArtifactKind, content: string, action: CorrectionAction, text: string): string {
  return kind === "workflow" ? correctedWorkflow(content, action, text) : correctedText(content, action, text);
}

/** The text of one artifact, read and written by the store that already keeps it. */
export interface ArtifactText {
  read(id: string): Promise<string | undefined> | string | undefined;
  write(id: string, content: string): Promise<void> | void;
}
