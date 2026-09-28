/**
 * Procedural settings (plan §4.6): presets, decoding and prompts, as data
 * (data/settings.json) with a JSON Schema generated from this parser. The `paper` preset
 * is the paper's mechanism exactly; `harness` adds the live overlay and dream's gates.
 * The paper's App. B.5 prompts are stored verbatim in the data file.
 */
import { z } from "zod";
import { ProbabilitySchema } from "@harness/cognitive";

/** The neighborhood's hops (the paper's h). */
export const HOPS = 2;
/** The recent-trajectory window shown to the guidance model (the paper's w). */
export const WINDOW = 3;

const REFINER_SLOTS = ["task_description", "mode", "available_tools_list", "attempts_block", "current_graph_json", "rejected_block"] as const;
const GUIDANCE_SLOTS = ["task_description", "graph_context_desc", "subgraph_summary", "query", "recent_context", "graph_source"] as const;

/** The `{placeholders}` each prompt must keep, since its caller fills them. */
export const PLACEHOLDERS = {
  solver: ["system_prompt", "procedural_graph_guidance", "trajectory"],
  guidance: GUIDANCE_SLOTS,
  guidanceHarness: GUIDANCE_SLOTS,
  refiner: REFINER_SLOTS,
  dream: [...REFINER_SLOTS, "overlay_entries_block", "cautioned_edges_block", "rejection_reasons_block"],
  reflection: ["graph_context", "trajectory"],
  route: ["graphs"],
} as const satisfies Record<string, readonly string[]>;

/** Gates dream can apply (plan §7.4). An evaluator gate with a trailing `?` applies only when the graph has an evaluator. */
export const GATES = ["structure", "evidence", "evaluator-at-least-retained", "evaluator-anchored-noninferiority", "approval", "approval-for-side-effects"] as const;
const EVALUATOR_GATES = ["evaluator-at-least-retained", "evaluator-anchored-noninferiority"] as const;
const GateSchema = z.union([z.enum(GATES), z.templateLiteral([z.enum(EVALUATOR_GATES), "?"])]);
export type Gate = z.output<typeof GateSchema>;

const LiveSettingsSchema = z
  .strictObject({
    /** Model-written overlay entries after a scored turn (`turn`) or a batch of scored turns (`batch`); off by default (plan §6.2). */
    reflection: z.enum(["off", "turn", "batch"]),
    /** Scored turns per reflection under `batch`. */
    reflectionBatch: z.int().min(1).exactOptional(),
    /** The share of sessions shown a probationary entry. */
    probationShare: ProbabilitySchema,
    /** Distinct sessions needed to propose an entry, and for dream's evidence gate. */
    minSupport: z.int().min(1),
    /** Confidence at which exposed sessions must be non-inferior to promote an entry. */
    promote: z.strictObject({ confidence: ProbabilitySchema }),
    /** Support decays by half over this long without new evidence. */
    halfLifeDays: z.number().positive(),
    /** Entries beyond this many are displaced. */
    maxEntries: z.int().positive(),
  })
  .superRefine((l, ctx) => {
    if (l.reflection === "batch" && l.reflectionBatch === undefined) ctx.addIssue({ code: "custom", message: "batch reflection needs a batch size", path: ["reflectionBatch"] });
  });
export type LiveSettings = z.output<typeof LiveSettingsSchema>;

const DreamSettingsSchema = z
  .strictObject({
    /** App. D.2: `incremental` strides with the gate; `onetime` is one ungated round over everything. */
    mode: z.enum(["incremental", "onetime"]),
    /** The round budget K. */
    rounds: z.int().positive(),
    /**
     * The paper's S: training tasks rolled out per round with an evaluator, or recorded
     * trajectories selected per round without one. Unset: the training tasks once over the
     * rounds, or the runner's `DEFAULT_SELECT`.
     */
    stride: z.int().positive().exactOptional(),
    /** After the rounds, one more: compose a well-trodden path into a workflow node (plan §7.6), gated as any candidate. */
    compose: z.boolean().exactOptional(),
    /** The cycle policy c of App. B.6. */
    cycles: z.enum(["allowed", "forbidden"]),
    /** The trajectory limit L_max, in tokens. */
    contextTokens: z.int().positive(),
    /** The paper keeps the tail of the concatenated trajectories; the harness keeps each trajectory's tail. */
    context: z.enum(["tail-concatenated", "tail-per-trajectory"]),
    gate: z.array(GateSchema).min(1),
    rejections: z.strictObject({
      /** Never re-evaluate a candidate already rejected (by revision id). */
      dedupe: z.boolean(),
      show: z.enum(["all", "recent-and-similar"]),
      limit: z.int().positive().exactOptional(),
    }),
    enforceToolCatalog: z.boolean(),
    editFilter: z.boolean(),
    /** For `evaluator-anchored-noninferiority`: the total loss allowed against G₀, and δ's confidence and power. */
    noninferiority: z.strictObject({ totalLoss: ProbabilitySchema, confidence: ProbabilitySchema, power: ProbabilitySchema }).exactOptional(),
  })
  .superRefine((d, ctx) => {
    if (d.rejections.show === "recent-and-similar" && d.rejections.limit === undefined) {
      ctx.addIssue({ code: "custom", message: "showing recent-and-similar needs a limit", path: ["rejections", "limit"] });
    }
    if (d.noninferiority === undefined && d.gate.some((g) => g.startsWith("evaluator-anchored-noninferiority"))) {
      ctx.addIssue({ code: "custom", message: "the anchored non-inferiority gate needs noninferiority settings", path: ["noninferiority"] });
    }
  });
export type DreamSettings = z.output<typeof DreamSettingsSchema>;

const PresetSchema = z
  .strictObject({
    /** Learn a dynamic layer from live traffic. */
    overlay: z.boolean(),
    /** `exact` is the paper's written Match. */
    match: z.enum(["exact", "case-insensitive"]),
    /** `start` resets to Start at each turn (the paper); `carry` keeps the previous turn's last action. */
    turnBoundary: z.enum(["start", "carry"]),
    /** `system` rebuilds the instructions with the guidance slot (the paper); `trailing-message` adds one advisory message. */
    delivery: z.enum(["system", "trailing-message"]),
    /** Which guidance prompt: the paper's, or the harness variant (plan §9). */
    guidancePrompt: z.enum(["paper", "harness"]),
    guidanceCache: z.boolean(),
    /** Re-read the overlay at each turn boundary, or freeze it for the session (plan §5.1). */
    overlayRefresh: z.enum(["turn", "session"]).default("turn"),
    /** When dream moves the head mid-session: re-pin at the next turn, or keep the old core. */
    repinOnDream: z.enum(["turn", "never"]).default("turn"),
    live: LiveSettingsSchema.exactOptional(),
    dream: DreamSettingsSchema,
  })
  .superRefine((p, ctx) => {
    if (p.overlay && p.live === undefined) ctx.addIssue({ code: "custom", message: "an overlay needs live settings", path: ["live"] });
  });
export type Preset = z.output<typeof PresetSchema>;

const text = z.string().min(1);
const PromptsSchema = z
  .strictObject({
    /** App. B.5's solver execution prompt; the paper's `system` delivery fills its guidance slot. */
    solver: text,
    /** App. B.5's guidance generation prompt. */
    guidance: text,
    /** The same, without asking for command patterns and file paths. */
    guidanceHarness: text,
    /** App. B.5's refiner prompt. */
    refiner: text,
    /** The refiner prompt plus dream's consolidation section (plan §7.3). */
    dream: text,
    /** Live reflection: proposes overlay entries (plan §6.2). */
    reflection: text,
    /** The graph router's tool description: choose a candidate graph for the session's first prompt (a resolver's route rule). */
    route: text,
  })
  .superRefine((prompts, ctx) => {
    for (const [name, slots] of Object.entries(PLACEHOLDERS)) {
      const missing = slots.filter((slot) => !prompts[name as keyof typeof prompts].includes(`{${slot}}`));
      if (missing.length > 0) ctx.addIssue({ code: "custom", message: `missing placeholders ${missing.map((s) => `{${s}}`).join(", ")}`, path: [name] });
    }
  });

/** What fills `{graph_context_desc}` and `{graph_source}`. */
const ContextWordsSchema = z.strictObject({ desc: text, source: text });

export const SettingsSchema = z.strictObject({
  $schema: z.string().exactOptional(),
  presets: z.object({ paper: PresetSchema, harness: PresetSchema }).catchall(PresetSchema),
  decoding: z.strictObject({
    temperature: z.number().min(0),
    topK: z.int().positive(),
    solverMaxTokens: z.int().positive(),
    refinerMaxTokens: z.int().positive(),
  }),
  /** The guidance prompt's context slots for a neighborhood (`local`) and for the full-graph fallback (`full`, App. B.5). */
  graphContext: z.strictObject({ local: ContextWordsSchema, full: ContextWordsSchema }),
  prompts: PromptsSchema,
});
export type Settings = z.output<typeof SettingsSchema>;

/** Parse procedural settings (see data/settings.json); any problem refuses them whole, naming where. */
export function parseSettings(input: unknown): Settings {
  const result = SettingsSchema.safeParse(input);
  if (!result.success) throw new Error(`invalid procedural settings\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** JSON Schema for the settings file, for editors (data/settings.schema.json). */
export const settingsJsonSchema = (): object => z.toJSONSchema(SettingsSchema, { io: "input" });

/** A preset by name: `paper`, `harness` or one a deployment added. */
export function presetOf(settings: Settings, name: string): Preset {
  const preset = Object.hasOwn(settings.presets, name) ? settings.presets[name] : undefined;
  if (preset === undefined) throw new RangeError(`no procedural preset named ${name}`);
  return preset;
}

/** The guidance prompt a preset uses. */
export const guidancePromptOf = (settings: Settings, preset: Preset): string =>
  preset.guidancePrompt === "paper" ? settings.prompts.guidance : settings.prompts.guidanceHarness;
