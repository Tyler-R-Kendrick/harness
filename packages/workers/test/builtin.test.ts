import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateText, wrapLanguageModel } from "ai";
import { Experimental_EvaluationMockModelV4, MockLanguageModelV4 } from "ai/test";
import { constraintOf, decisionRouter, DECISION_ACCEPT, inSession, usage } from "@harness/cognitive";
import type { Constraint } from "@harness/cognitive";
import { parseBook, parseSettings } from "@harness/dialogue";
import { dialogueMiddleware } from "@harness/workers";
import { Dialogue } from "@harness/dialogue";

const file = JSON.parse(readFileSync(new URL("../../dialogue/data/settings.json", import.meta.url), "utf8")) as { match: Record<string, unknown> };
const book = JSON.parse(readFileSync(new URL("../../dialogue/data/builtin.json", import.meta.url), "utf8"));
const reply = parseBook(book).scripts.find((script) => script.id === "capabilities")!.reply[0];

function judge() {
  return new Experimental_EvaluationMockModelV4({
    doEvaluate: async (options) => {
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
  });
}

describe("builtin capability template in front of the model", () => {
  it("BK2.1 what can you do and which skills are registered are the same template, with no chat-model call", async () => {
    const calls: string[] = [];
    const inner = new MockLanguageModelV4({
      doGenerate: async () => {
        calls.push("chat");
        return { content: [{ type: "text", text: "I am Claude, made by Anthropic." }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] };
      },
    });
    const dialogue = new Dialogue({
      settings: parseSettings({ ...file, match: { ...file.match, route: DECISION_ACCEPT } }),
      book,
      router: decisionRouter(judge()),
    });
    const model = wrapLanguageModel({ model: inner, middleware: dialogueMiddleware(dialogue) });
    const direct = await generateText({ model, prompt: "what can you do?", ...inSession("s") });
    const similar = await generateText({ model, prompt: "what skills/tools do you have registered", ...inSession("s") });
    expect(direct.text).toBe(reply);
    expect(similar.text).toBe(direct.text);
    expect(calls).toEqual([]);
    expect(direct.usage.outputTokens).toBe(0);
  });

  it("BK2.2 a different question still goes to the chat model", async () => {
    const calls: string[] = [];
    const inner = new MockLanguageModelV4({
      doGenerate: async () => {
        calls.push("chat");
        return { content: [{ type: "text", text: "Paris." }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] };
      },
    });
    const dialogue = new Dialogue({
      settings: parseSettings({ ...file, match: { ...file.match, route: DECISION_ACCEPT } }),
      book,
      router: decisionRouter(judge()),
    });
    const model = wrapLanguageModel({ model: inner, middleware: dialogueMiddleware(dialogue) });
    expect((await generateText({ model, prompt: "what is the capital of France?", ...inSession("s") })).text).toBe("Paris.");
    expect(calls).toEqual(["chat"]);
  });
});

/** A judge that picks the intent whose text includes `mark` when `when` says the request is that kind. */
function picking(mark: string, when: (state: string) => boolean) {
  return new Experimental_EvaluationMockModelV4({
    doEvaluate: async (options) => {
      const answers = Object.fromEntries(
        Object.entries(options.questions).map(([id, question]) => {
          const criteria = question.type === "choice" ? question.criteria : {};
          const hit = Object.entries(criteria).find(([, text]) => String(text).includes(mark));
          const none = Object.entries(criteria).find(([, text]) => String(text).includes("Something else"));
          const choice = when(String(options.state)) && hit ? hit[0] : (none?.[0] ?? "none");
          const rest = Object.keys(criteria).filter((key) => key !== choice);
          const probabilities = Object.fromEntries([[choice, 0.8], ...rest.map((key) => [key, 0.2 / Math.max(rest.length, 1)])]);
          return [id, { type: "choice", choice, probabilities }];
        }),
      );
      return { answers: answers as never, warnings: [] };
    },
  });
}

/** The constraint the chat model was given for `prompt`. */
async function constrained(prompt: string, mark: string, when: (state: string) => boolean): Promise<Constraint | undefined> {
  let constraint: Constraint | undefined;
  const inner = new MockLanguageModelV4({
    doGenerate: async (options) => {
      constraint = constraintOf(options);
      return { content: [{ type: "text", text: "filled" }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] };
    },
  });
  const dialogue = new Dialogue({
    settings: parseSettings({ ...file, match: { ...file.match, route: DECISION_ACCEPT } }),
    book,
    router: decisionRouter(picking(mark, when)),
  });
  const model = wrapLanguageModel({ model: inner, middleware: dialogueMiddleware(dialogue) });
  expect((await generateText({ model, prompt, ...inSession("s") })).text).toBe("filled");
  return constraint;
}

describe("builtin structured outputs in front of the model", () => {
  it("SO2.1 a research question is filled under the report template", async () => {
    const constraint = await constrained("research the history of paper", "research report", (state) => state.includes("research"));
    expect(constraint).toMatchObject({ type: "template", parts: expect.arrayContaining(["Abstract\n", "\nReferences\n", "\nTLDR\n", "\nELI5\n"]) });
  });

  it("SO2.2 a calculation is filled under the math grammar", async () => {
    const constraint = await constrained("calculate 12 times 3", "math calculation", (state) => state.includes("calculat"));
    expect(constraint).toMatchObject({ type: "template", parts: [{ hole: "work", constraint: { type: "grammar" } }] });
  });

  it("SO2.5 a technical documentation question is filled under the man page template", async () => {
    const constraint = await constrained("show me the technical docs for the daemon", "technical documentation", (state) => state.includes("doc"));
    expect(constraint).toMatchObject({ type: "template", parts: expect.arrayContaining(["NAME\n", "\nSYNOPSIS\n", "\nDESCRIPTION\n", "\nOPTIONS\n", "\nEXAMPLES\n", "\nSEE ALSO\n"]) });
  });

  it("SO2.3 instructions are filled under the step-and-verify grammar", async () => {
    const constraint = await constrained("how do I brew tea", "how-to", (state) => state.includes("how do"));
    expect(constraint).toMatchObject({ type: "template", parts: [{ hole: "steps", constraint: { type: "grammar", ebnf: expect.stringContaining("Verify: ") } }] });
  });

  it("SO2.4 two accepted intents are one constrained fill, and the chat model is called once", async () => {
    const calls: Constraint[] = [];
    const inner = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const constraint = constraintOf(options);
        if (constraint) calls.push(constraint);
        return { content: [{ type: "text", text: "filled" }], finishReason: { unified: "stop", raw: undefined }, usage: usage(), warnings: [] };
      },
    });
    const judge = new Experimental_EvaluationMockModelV4({
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
    const dialogue = new Dialogue({
      settings: parseSettings({ ...file, match: { ...file.match, route: DECISION_ACCEPT } }),
      book,
      router: decisionRouter(judge),
    });
    const model = wrapLanguageModel({ model: inner, middleware: dialogueMiddleware(dialogue) });
    expect((await generateText({ model, prompt: "research the boiling point and calculate 2+2", ...inSession("s") })).text).toBe("filled");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.type).toBe("template");
    if (call?.type !== "template") return;
    expect(call.parts.map((part) => (typeof part === "string" ? part : part.hole))).toEqual(["abstract", "\n\n", "work"]);
  });
});
