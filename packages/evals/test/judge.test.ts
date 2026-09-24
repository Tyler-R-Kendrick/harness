import { describe, expect, it } from "vitest";
import { JevJudge, JEV_MODEL_ID } from "@harness/evals";
import { FakeEvaluationModel } from "./fake-model.ts";

describe("JevJudge", () => {
  it("EV1.1 defaults to Jev on the Vercel AI Gateway", () => {
    const judge = new JevJudge();
    expect(JEV_MODEL_ID).toBe("typesafe-ai/jev");
    expect(judge.identity).toEqual({ provider: "gateway", modelId: "typesafe-ai/jev" });
  });

  it("EV1.2 sends the state and typed questions and returns typed answers", async () => {
    const model = new FakeEvaluationModel(() => ({ correct: { type: "boolean", probability: 0.93 } }));
    const judge = new JevJudge({ model });
    const answers = await judge.evaluate({ state: { reply: "4" }, questions: { correct: { type: "boolean", instructions: "Is the reply right?" } } });
    expect(answers).toEqual({ correct: { type: "boolean", probability: 0.93 } });
    expect(model.calls[0]).toMatchObject({ state: { reply: "4" }, questions: { correct: { type: "boolean", instructions: "Is the reply right?" } } });
    expect(judge.identity).toEqual({ provider: "fake", modelId: "fake-jev" });
  });
});
