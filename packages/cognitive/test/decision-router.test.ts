import { describe, expect, it } from "vitest";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { decisionRouter, DECISION_ACCEPT, route } from "@harness/cognitive";
import type { ToolSpec } from "@harness/cognitive";

const tools: ToolSpec[] = [
  {
    name: "capabilities",
    description: "What you can do, or which skills and tools are registered",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** A judge that picks the option whose text mentions `mark` when the request does, else none. Records each call. */
function judge(mark: string) {
  const calls: { state: unknown; questions: LanguageModelV4CallOptions | unknown }[] = [];
  const model = new Experimental_EvaluationMockModelV4({
    doEvaluate: async (options) => {
      calls.push({ state: options.state, questions: options.questions });
      const answers = Object.fromEntries(
        Object.entries(options.questions).map(([id, question]) => {
          const criteria = question.type === "choice" ? question.criteria : {};
          const hit = Object.entries(criteria).find(([, text]) => String(text).includes(mark));
          const none = Object.entries(criteria).find(([, text]) => String(text).toLowerCase().includes("something else"));
          const skills = String(options.state).includes("skills");
          const choice = skills && hit ? hit[0] : (none?.[0] ?? "none");
          const other = Object.keys(criteria).filter((key) => key !== choice);
          const probabilities = Object.fromEntries([[choice, skills ? 0.8 : 0.9], ...other.map((key) => [key, skills ? 0.2 / Math.max(other.length, 1) : 0.1 / Math.max(other.length, 1)])]);
          return [id, { type: "choice", choice, probabilities }];
        }),
      );
      return { answers: answers as never, warnings: [] };
    },
  });
  return { model, calls };
}

describe("decision router", () => {
  it("DR1.1 a likely choice of one offered script is that script", async () => {
    const deciding = judge("skills and tools");
    const routed = await route(decisionRouter(deciding.model), { input: "what skills/tools do you have registered", tools });
    expect(routed.valid).toEqual([{ name: "capabilities", arguments: {} }]);
    expect(routed.confidence).toBeGreaterThanOrEqual(DECISION_ACCEPT);
    expect(routed.problems).toEqual([]);
    const asked = deciding.calls[0]!;
    expect(asked.state).toBe("what skills/tools do you have registered");
    expect(JSON.stringify(asked.questions)).toContain("skills and tools");
    expect(JSON.stringify(asked.questions)).toContain("Something else");
  });

  it("DR1.2 none, or a choice below the decision bar, is no script", async () => {
    const deciding = judge("skills and tools");
    const routed = await route(decisionRouter(deciding.model), { input: "what is the capital of France?", tools });
    expect(routed.valid).toEqual([]);
    expect(routed.confidence).toBeLessThan(DECISION_ACCEPT);
  });

  it("DR1.3 no offered script does not ask the decision model", async () => {
    const deciding = judge("skills and tools");
    const routed = await route(decisionRouter(deciding.model), { input: "what can you do?", tools: [] });
    expect(routed.valid).toEqual([]);
    expect(deciding.calls).toEqual([]);
  });

  it("DR1.4 a choice below the decision bar is no script", async () => {
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async (options) => {
        const answers = Object.fromEntries(
          Object.entries(options.questions).map(([id, question]) => {
            const criteria = question.type === "choice" ? question.criteria : {};
            const hit = Object.keys(criteria).find((key) => String(criteria[key]).includes("skills")) ?? Object.keys(criteria)[0]!;
            const probabilities = Object.fromEntries(Object.keys(criteria).map((key) => [key, key === hit ? 0.55 : 0.45]));
            return [id, { type: "choice", choice: hit, probabilities }];
          }),
        );
        return { answers: answers as never, warnings: [] };
      },
    });
    expect((await route(decisionRouter(model), { input: "what skills/tools do you have registered", tools })).valid).toEqual([]);
  });

  it("DR1.5 several intents above the decision bar are those scripts, in the order offered", async () => {
    const offered: ToolSpec[] = [
      { name: "research", description: "A research report with sources", parameters: { type: "object", properties: {}, additionalProperties: false } },
      { name: "calculation", description: "A math calculation", parameters: { type: "object", properties: {}, additionalProperties: false } },
      { name: "instructions", description: "A how-to procedure", parameters: { type: "object", properties: {}, additionalProperties: false } },
    ];
    const model = new Experimental_EvaluationMockModelV4({
      doEvaluate: async (options) => {
        const state = String(options.state);
        const answers = Object.fromEntries(
          Object.entries(options.questions).map(([id, question]) => {
            const criteria = question.type === "choice" ? question.criteria : {};
            const none = Object.entries(criteria).find(([, text]) => String(text).includes("Something else"));
            const intent = Object.entries(criteria).find(([, text]) => !String(text).includes("Something else"));
            const text = String(intent?.[1] ?? "");
            const yes = (text.includes("research") && state.includes("research")) || (text.includes("calculation") && state.includes("calculate"));
            const choice = yes && intent ? intent[0] : (none?.[0] ?? "o0");
            const rest = Object.keys(criteria).filter((key) => key !== choice);
            const probabilities = Object.fromEntries([[choice, 0.8], ...rest.map((key) => [key, 0.2 / Math.max(rest.length, 1)])]);
            return [id, { type: "choice", choice, probabilities }];
          }),
        );
        return { answers: answers as never, warnings: [] };
      },
    });
    const routed = await route(decisionRouter(model), { input: "research the boiling point and calculate 2+2", tools: offered });
    expect(routed.valid.map((call) => call.name)).toEqual(["research", "calculation"]);
    expect(routed.confidence).toBeGreaterThanOrEqual(DECISION_ACCEPT);
    expect(routed.problems).toEqual([]);
  });
});
