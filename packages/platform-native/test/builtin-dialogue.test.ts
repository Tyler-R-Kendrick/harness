import { describe, expect, it } from "vitest";
import { Experimental_EvaluationMockModelV4 } from "ai/test";
import { bytes, Ensemble } from "@harness/cognitive";
import type { ModelDescriptor } from "@harness/cognitive";
import { parseBook } from "@harness/dialogue";
import { builtinDialogue, withBuiltinBook, withoutBuiltinBook } from "@harness/platform-native";

const decider: ModelDescriptor = {
  id: "decider",
  name: "decider",
  publisher: "t",
  tasks: ["classification"],
  ports: ["judge"],
  locality: "local",
  runtime: "transformers.js",
  run: { dtype: "q4" },
  platforms: ["native"],
  license: "MIT",
  downloadBytes: bytes(1),
  benchmarks: [],
};

function judging(): { ensemble: Ensemble; calls: unknown[] } {
  const calls: unknown[] = [];
  const ensemble = new Ensemble({ platform: "native" });
  ensemble.register(decider, async () => ({
    judge: new Experimental_EvaluationMockModelV4({
      doEvaluate: async (options) => {
        calls.push(options.state);
        const answers = Object.fromEntries(
          Object.entries(options.questions).map(([id, question]) => {
            const criteria = question.type === "choice" ? question.criteria : {};
            const hit = Object.entries(criteria).find(([, text]) => String(text).includes("skills and tools"));
            const none = Object.entries(criteria).find(([, text]) => String(text).includes("Something else"));
            const skills = String(options.state).includes("skills");
            const choice = skills && hit ? hit[0] : (none?.[0] ?? "none");
            const rest = Object.keys(criteria).filter((key) => key !== choice);
            const probabilities = Object.fromEntries([[choice, 0.8], ...rest.map((key) => [key, 0.2 / Math.max(rest.length, 1)])]);
            return [id, { type: "choice", choice, probabilities }];
          }),
        );
        return { answers: answers as never, warnings: [] };
      },
    }),
  }));
  return { ensemble, calls };
}

describe("builtin session dialogue", () => {
  it("BK3.1 what can you do and a skills question are the same template, and only the skills question asks the decision model", async () => {
    const { ensemble, calls } = judging();
    const dialogue = builtinDialogue({ ensemble });
    const direct = await dialogue.respond({ sessionId: "s", utterance: "what can you do?" });
    const similar = await dialogue.respond({ sessionId: "s", utterance: "what skills/tools do you have registered" });
    expect(direct).toMatchObject({ kind: "reply", script: "capabilities", match: { by: "pattern" } });
    expect(similar).toMatchObject({ kind: "reply", script: "capabilities", match: { by: "router" } });
    if (direct.kind === "reply" && similar.kind === "reply") expect(similar.text).toBe(direct.text);
    expect(direct.kind === "reply" && direct.text).not.toMatch(/claude|anthropic/i);
    expect(calls).toEqual(["what skills/tools do you have registered"]);
  });

  it("BK3.2 a user book keeps its own script and replaces a builtin script with the same id", () => {
    const added = parseBook(withBuiltinBook({ scripts: [{ id: "hours", intent: "Opening hours", reply: ["We open at 9."] }] }));
    expect(added.scripts.map((script) => script.id)).toEqual(["capabilities", "research", "calculation", "instructions", "manual", "harness-menu", "hours"]);
    const replaced = parseBook(withBuiltinBook({ scripts: [{ id: "capabilities", intent: "custom", reply: ["Custom."] }] }));
    expect(replaced.scripts.find((script) => script.id === "capabilities")?.reply[0]).toBe("Custom.");
    expect(replaced.scripts.map((script) => script.id)).toEqual(["research", "calculation", "instructions", "manual", "harness-menu", "capabilities"]);
  });

  it("BK3.3 a save drops the builtin scripts and documents, keeping the book's own and what was learned", () => {
    const own = { scripts: [{ id: "hours", intent: "Opening hours", reply: ["We open at 9."] }] };
    const saved = withoutBuiltinBook(
      {
        scripts: [
          { id: "capabilities", intent: "Capabilities", reply: ["Much."] },
          { id: "hours", intent: "Opening hours", reply: ["We open at 9."] },
          { id: "s1", intent: "learned", reply: ["Learned."] },
        ],
        documents: [
          { name: "harness-chat", type: "aiml", files: {} },
          { name: "alice", type: "aiml", files: {} },
        ],
      },
      own,
    );
    expect(parseBook(saved).scripts.map((script) => script.id)).toEqual(["hours", "s1"]);
    expect((saved as { documents: { name: string }[] }).documents.map((document) => document.name)).toEqual(["alice"]);
    // A book that overrides a builtin id keeps its own script under that id.
    const overridden = withoutBuiltinBook({ scripts: [{ id: "capabilities", intent: "custom", reply: ["Custom."] }] }, { scripts: [{ id: "capabilities", intent: "custom", reply: ["Custom."] }] });
    expect(parseBook(overridden).scripts).toHaveLength(1);
  });

  it("SO3.1 the decision model picks the research, calculation and instruction scripts", async () => {
    const calls: unknown[] = [];
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.register(decider, async () => ({
      judge: new Experimental_EvaluationMockModelV4({
        doEvaluate: async (options) => {
          calls.push(options.state);
          const answers = Object.fromEntries(
            Object.entries(options.questions).map(([id, question]) => {
              const criteria = question.type === "choice" ? question.criteria : {};
              const state = String(options.state);
              const mark = state.includes("research") ? "research report" : state.includes("calculat") ? "math calculation" : state.includes("how do") ? "how-to" : "";
              const hit = Object.entries(criteria).find(([, text]) => mark !== "" && String(text).includes(mark));
              const none = Object.entries(criteria).find(([, text]) => String(text).includes("Something else"));
              const choice = hit ? hit[0] : (none?.[0] ?? "none");
              const rest = Object.keys(criteria).filter((key) => key !== choice);
              const probabilities = Object.fromEntries([[choice, 0.8], ...rest.map((key) => [key, 0.2 / Math.max(rest.length, 1)])]);
              return [id, { type: "choice", choice, probabilities }];
            }),
          );
          return { answers: answers as never, warnings: [] };
        },
      }),
    }));
    const dialogue = builtinDialogue({ ensemble });
    const research = await dialogue.respond({ sessionId: "s", utterance: "research the history of paper" });
    const calculation = await dialogue.respond({ sessionId: "s", utterance: "calculate 12 times 3" });
    const instructions = await dialogue.respond({ sessionId: "s", utterance: "how do I brew tea" });
    expect(research).toMatchObject({ kind: "generate", script: "research", match: { by: "router" } });
    expect(calculation).toMatchObject({ kind: "generate", script: "calculation", template: { parts: [{ hole: "work" }] } });
    expect(instructions).toMatchObject({ kind: "generate", script: "instructions", template: { parts: [{ hole: "steps" }] } });
    expect(calls).toEqual(["research the history of paper", "calculate 12 times 3", "how do I brew tea"]);
  });

  it("SO3.2 a technical documentation question is the manual page", async () => {
    const ensemble = new Ensemble({ platform: "native" });
    ensemble.register(decider, async () => ({
      judge: new Experimental_EvaluationMockModelV4({
        doEvaluate: async (options) => {
          const answers = Object.fromEntries(
            Object.entries(options.questions).map(([id, question]) => {
              const criteria = question.type === "choice" ? question.criteria : {};
              const hit = Object.entries(criteria).find(([, text]) => String(text).includes("technical documentation"));
              const none = Object.entries(criteria).find(([, text]) => String(text).includes("Something else"));
              const choice = String(options.state).includes("doc") && hit ? hit[0] : (none?.[0] ?? "none");
              const rest = Object.keys(criteria).filter((key) => key !== choice);
              const probabilities = Object.fromEntries([[choice, 0.8], ...rest.map((key) => [key, 0.2 / Math.max(rest.length, 1)])]);
              return [id, { type: "choice", choice, probabilities }];
            }),
          );
          return { answers: answers as never, warnings: [] };
        },
      }),
    }));
    const dialogue = builtinDialogue({ ensemble });
    expect(await dialogue.respond({ sessionId: "s", utterance: "show me the technical docs for the daemon socket" })).toMatchObject({
      kind: "generate",
      script: "manual",
      match: { by: "router" },
      template: { parts: expect.arrayContaining(["NAME\n", "\nSEE ALSO\n"]) },
    });
  });
});
