/**
 * A turn as dream and the live learner see it (plan §4.5): learning's steps, wrapped
 * with the version pair guidance read (I3), a score and how the turn localized.
 * Learning's `Trajectory` has neither a score nor a revision, hence this type.
 */
import { z } from "zod";
import { TrajectorySchema } from "@harness/learning";
import { GraphIdSchema, RevisionIdSchema, ScoreSchema, TrajectoryIdSchema } from "./graph.ts";

const count = z.int().min(0);

export const ScoredTrajectorySchema = z.strictObject({
  id: TrajectoryIdSchema,
  graph: GraphIdSchema,
  core: RevisionIdSchema,
  /** The overlay version, or null when the preset has no overlay. */
  overlay: count.nullable(),
  session: z.string().min(1),
  turn: z.string().min(1),
  query: z.string(),
  steps: TrajectorySchema.shape.steps,
  /** A judge's probability rather than its verdict, so the uncertain band is kept; null when unscored. */
  score: ScoreSchema.nullable(),
  scoreSource: z.enum(["metric", "judge-probability", "judge-verdict", "outcome", "feedback"]).nullable(),
  /** Steps whose action matched a node, fell back to the full graph, or were inert (tool absent). */
  localization: z.strictObject({ matched: count, fallback: count, inert: count }),
  usage: z.strictObject({ steps: count, inputTokens: count, outputTokens: count, guidanceTokens: count }),
});
export type ScoredTrajectory = z.output<typeof ScoredTrajectorySchema>;
