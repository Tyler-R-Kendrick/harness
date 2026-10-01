import { describe, expect, it } from "vitest";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { DECISION_ACCEPT, rankTools } from "@harness/cognitive";

/** A decision model that scores a tool by the probability named in its description, on both rotations. */
function judging() {
  const calls: unknown[] = [];
  const model = new Experimental_EvaluationMockModelV4({
    doEvaluate: async (options) => {
      calls.push(options.state);
      const answers = Object.fromEntries(
        Object.entries(options.questions).map(([id, question]) => {
          const criteria = question.type === "choice" ? question.criteria : {};
          const hit = Object.entries(criteria).find(([, text]) => /\b0\.\d+\b/.test(String(text)));
          const score = hit ? Number(String(hit[1]).match(/0\.\d+/)?.[0]) : 0;
          const marked = hit?.[0];
          const keys = Object.keys(criteria);
          const share = (1 - score) / Math.max(keys.length - (marked === undefined ? 0 : 1), 1);
          const probabilities = Object.fromEntries(keys.map((key) => [key, key === marked ? score : share]));
          const choice = keys.reduce((best, key) => ((probabilities[key] ?? 0) > (probabilities[best] ?? 0) ? key : best), keys[0] ?? "o0");
          return [id, { type: "choice", choice, probabilities }];
        }),
      );
      return { answers: answers as never, warnings: [] };
    },
  });
  return { model, calls };
}

const tools = [
  { name: "later", description: "Later tool 0.9" },
  { name: "earlier", description: "Earlier tool 0.7" },
  { name: "aside", description: "Aside tool 0.2" },
];

describe("decision-layer tool ranking", () => {
  it("TR1.1 a higher score comes first and a score below the decision bar is left out", async () => {
    const deciding = judging();
    const ranked = await rankTools(deciding.model, { input: "use the later tool", tools });
    const again = await rankTools(deciding.model, { input: "use the later tool", tools });
    expect(ranked.map((row) => row.name)).toEqual(["later", "earlier"]);
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(DECISION_ACCEPT);
    expect(ranked[1]!.score).toBeGreaterThanOrEqual(DECISION_ACCEPT);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(again).toEqual(ranked);
    expect(deciding.calls).toEqual(["use the later tool", "use the later tool"]);
  });

  it("TR1.2 no tools does not ask the decision model", async () => {
    const deciding = judging();
    expect(await rankTools(deciding.model, { input: "anything", tools: [] })).toEqual([]);
    expect(deciding.calls).toEqual([]);
  });

  it("TR1.3 equal scores keep the order the tools were offered", async () => {
    const deciding = judging();
    const tied = [
      { name: "beta", description: "Beta tool 0.8" },
      { name: "alpha", description: "Alpha tool 0.8" },
    ];
    expect((await rankTools(deciding.model, { input: "either", tools: tied })).map((row) => row.name)).toEqual(["beta", "alpha"]);
  });
});
