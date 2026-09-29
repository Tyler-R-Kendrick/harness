import { describe, expect, it } from "vitest";
import { revisionId, ScoredTrajectorySchema, seedGraph } from "@harness/procedural";

const trajectory = () => ({
  id: "s1/t1",
  graph: "repo/harness",
  core: revisionId(seedGraph()),
  overlay: 4,
  session: "s1",
  turn: "t1",
  query: "Who directed the film?",
  steps: [
    { role: "user", content: "Who directed the film?" },
    { role: "assistant", content: "", call: { name: "first_hop_retrieve", arguments: { q: "film" } } },
    { role: "observation", content: "passages" },
  ],
  score: 0.8,
  scoreSource: "judge-probability",
  localization: { matched: 2, fallback: 1, inert: 0 },
  usage: { steps: 3, inputTokens: 1200, outputTokens: 80, guidanceTokens: 150 },
});

describe("scored trajectories", () => {
  it("PGR1.33 a scored trajectory wraps learning's steps with its graph, version pair, score and usage", () => {
    expect(ScoredTrajectorySchema.parse(trajectory())).toEqual(trajectory());
    for (const scoreSource of ["metric", "judge-probability", "judge-verdict", "outcome", "feedback"]) expect(ScoredTrajectorySchema.safeParse({ ...trajectory(), scoreSource }).success).toBe(true);
    // An unscored turn still counts as traversal evidence, and the paper preset has no overlay.
    expect(ScoredTrajectorySchema.safeParse({ ...trajectory(), score: null, scoreSource: null, overlay: null }).success).toBe(true);
  });

  it("PGR1.34 scores are probabilities, counts are whole and non-negative, and steps are learning steps", () => {
    const refused = [
      { ...trajectory(), score: 1.5 },
      { ...trajectory(), score: -0.1 },
      { ...trajectory(), scoreSource: "guess" },
      { ...trajectory(), overlay: -1 },
      { ...trajectory(), id: "" },
      { ...trajectory(), graph: "Repo" },
      { ...trajectory(), core: "abc" },
      { ...trajectory(), localization: { matched: 1, fallback: 0 } },
      { ...trajectory(), localization: { matched: 0.5, fallback: 0, inert: 0 } },
      { ...trajectory(), usage: { steps: 1, inputTokens: -1, outputTokens: 0, guidanceTokens: 0 } },
      { ...trajectory(), steps: [{ role: "system", content: "x" }] },
      { ...trajectory(), extra: true },
    ];
    expect(refused.map((t) => ScoredTrajectorySchema.safeParse(t).success)).toEqual(refused.map(() => false));
  });
});
