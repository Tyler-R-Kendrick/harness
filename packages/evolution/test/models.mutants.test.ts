import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { judgeCritic, modelProposer, parseSettings } from "@harness/evolution";
import type { AppliedEdit, ProposalRequest } from "@harness/evolution";
import { probability } from "@harness/cognitive";
import { scriptedJudge, scriptedModel } from "@harness/testkit";
import { AxGen, AxGenerateError } from "@ax-llm/ax";
import type * as AxModule from "@ax-llm/ax";
import { promptOf, readProposal, reasonOf } from "../src/models.ts";
import { TUNING_EXAMPLES } from "../src/schemas.ts";
import { toggle } from "./world.ts";

// Ax's optimize() is the real one, except in the one test that needs a run which finds no Pareto front (RS31.2).
const optimizer = vi.hoisted(() => ({ dropsProgram: false }));
vi.mock("@ax-llm/ax", async (importOriginal) => {
  const actual = await importOriginal<typeof AxModule>();
  return {
    ...actual,
    optimize: async (...args: Parameters<typeof actual.optimize>) => {
      const result = await actual.optimize(...args);
      return optimizer.dropsProgram ? { ...result, optimizedProgram: undefined } : result;
    },
  };
});

const s = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));
const request = { round: 0, candidate: "A", budget: 1, components: ["prompt"], documents: {}, analysis: { score: 0, failures: [], successes: [] }, history: [], mechanisms: [] } satisfies ProposalRequest;
const untuned = { ...s.proposer, system: "Improve the harness.", maxTokens: 777, optimize: { maxMetricCalls: 0, seed: 0 } };
const edit1 = { id: "e1", hypothesis: "verify helps", targets: "failures", predicted: [], ops: [{ op: "add", document: "policy", path: "/rules/verify", value: true }] };

const retryable = () => new APICallError({ message: "overloaded", url: "https://x.test", requestBodyValues: {}, isRetryable: true });

const systemOf = (call: { prompt: readonly { role: string; content: unknown }[] }) => call.prompt.filter((m) => m.role === "system").map((m) => m.content as string);

describe("what the proposer sends the model", () => {
  it("RS23.40 the system prompt carries the signature's field descriptions and the system text, and the user message carries the request as JSON", async () => {
    const model = scriptedModel(() => JSON.stringify(toggle("verify")));
    await modelProposer(model, untuned)(request);
    const call = model.doGenerateCalls[0]!;
    const system = systemOf(call);
    expect(system).toHaveLength(1);
    // Nothing but the signature's own system prompt: not the user's turn, and no other message.
    expect(system[0]).toMatch(/^<identity>[\s\S]*<\/formatting_rules>$/);
    expect(system[0]).not.toContain("Round Request: {");
    expect(system[0]).toContain("Round Request: The round's request as JSON: the incumbent, the evidence, and the constraints.");
    expect(system[0]).toContain("Summary (wire key: `summary`): (This string field must be included) One line saying what the proposal changes.");
    expect(system[0]).toContain("Edits (wire key: `edits`): (This json array of JSON object items field must be included) One edit: id, hypothesis, targets, predicted, ops.");
    expect(system[0]).toContain("<task_definition>\nImprove the harness.\n</task_definition>");
    const users = call.prompt.filter((m) => m.role === "user");
    expect(users).toEqual([{ role: "user", content: [{ type: "text", text: `Round Request: ${JSON.stringify(request)}\n` }] }]);
  });

  it("RS23.41 the answer is constrained to an object with a string summary and an array of edits, nothing else", async () => {
    const model = scriptedModel(() => JSON.stringify(toggle("verify")));
    await modelProposer(model, untuned)(request);
    expect(model.doGenerateCalls[0]!.responseFormat).toMatchObject({
      type: "json",
      schema: {
        type: "object",
        properties: { summary: { type: "string", description: "One line saying what the proposal changes." }, edits: { type: "array", description: "One edit: id, hypothesis, targets, predicted, ops." } },
        required: ["summary", "edits"],
        additionalProperties: false,
      },
    });
  });

  it("RS23.42 the model gets the settings' token cap, untuned and while tuning", async () => {
    const plain = scriptedModel(() => JSON.stringify(toggle("verify")));
    await modelProposer(plain, untuned)(request);
    expect(plain.doGenerateCalls.map((c) => c.maxOutputTokens)).toEqual([777]);
    const tuning = scriptedModel(() => JSON.stringify(toggle("verify")));
    await modelProposer(tuning, { ...untuned, optimize: { maxMetricCalls: 4, seed: 1 } })(request);
    expect(tuning.doGenerateCalls.length).toBeGreaterThan(1);
    expect(new Set(tuning.doGenerateCalls.map((c) => c.maxOutputTokens))).toEqual(new Set([777]));
  });

  it("RS23.43 a failing model is asked once: neither the AI SDK nor Ax retries a retryable failure", async () => {
    const failing = new MockLanguageModelV4({ doGenerate: async () => { throw retryable(); } });
    await expect(modelProposer(failing, untuned)(request)).rejects.toThrow("overloaded");
    expect(failing.doGenerateCalls).toHaveLength(1);
  });
});

describe("what the proposer answers", () => {
  it("RS23.44 edits that arrive as JSON strings are parsed into the proposal", async () => {
    const model = scriptedModel(() => JSON.stringify({ summary: "s", edits: [JSON.stringify(edit1)] }));
    expect(await modelProposer(model, untuned)(request)).toEqual({ summary: "s", edits: [edit1] });
  });

  it("RS23.48 an edit that arrives JSON-encoded twice is decoded, and one that is not JSON once decoded is not a proposal", async () => {
    const twice = scriptedModel(() => JSON.stringify({ summary: "s", edits: [JSON.stringify(JSON.stringify(edit1))] }));
    expect(await modelProposer(twice, untuned)(request)).toEqual({ summary: "s", edits: [edit1] });
    const broken = scriptedModel(() => JSON.stringify({ summary: "s", edits: [JSON.stringify("{not json")] }));
    expect(await modelProposer(broken, untuned)(request)).toBe("the answer was not a proposal");
  });

  it("RS23.45 edits that are not edits come back as the reason that the answer was not a proposal", async () => {
    const model = scriptedModel(() => JSON.stringify({ summary: "s", edits: [{ bogus: 1 }] }));
    expect(await modelProposer(model, untuned)(request)).toBe("the answer was not a proposal");
  });

  it("RS23.46 an answer that cannot be parsed comes back as the AI SDK's own message, not prefixed with the error's name", async () => {
    const answer = await modelProposer(scriptedModel(() => "not json"), untuned)(request);
    expect(answer).toMatch(/^No object generated/);
  });

  it("RS23.47 a transport failure is thrown as the error itself", async () => {
    const boom = new Error("gateway down");
    const broken = new MockLanguageModelV4({ doGenerate: async () => { throw boom; } });
    await expect(modelProposer(broken, untuned)(request)).rejects.toBe(boom);
  });
});

/**
 * A model that plays all three parts GEPA needs: the proposer, whose proposals fit the budget only once the
 * system prompt holds the tuned instruction, the reflection that summarizes feedback, and the one that writes
 * the instruction. `answers` is the proposal the proposer gives without and with the instruction.
 */
const TUNED = "Propose exactly one edit.";
function tuningModel(without: unknown, withInstruction: unknown) {
  return scriptedModel((options) => {
    const system = String((options.prompt[0] as { content: unknown }).content);
    if (system.includes("`Target Id`")) return "feedbackSummary: the proposals have too many edits";
    if (system.includes("`Component Key`")) return `newValue: ${TUNED}`;
    return JSON.stringify(system.includes(TUNED) ? withInstruction : without);
  });
}
const tuned = { ...untuned, optimize: { maxMetricCalls: 60, seed: 0 } };
const twoEdits = { summary: "two", edits: [edit1, { ...edit1, id: "e2" }] };
const oneEdit = { summary: "one", edits: [edit1] };
const reflections = (model: ReturnType<typeof scriptedModel>) => model.doGenerateCalls.filter((c) => c.responseFormat === undefined);

describe("tuning the proposer's prompt with GEPA", () => {
  it("RS23.60 proposals over the round's budget make the optimizer reflect and write a better instruction, which the proposer then uses", async () => {
    const model = tuningModel(twoEdits, oneEdit);
    const answer = await modelProposer(model, tuned)(request);
    expect(answer).toEqual(oneEdit);
    expect(reflections(model)).toHaveLength(2);
    const last = model.doGenerateCalls.at(-1)!;
    expect(last.responseFormat).toBeDefined();
    expect(systemOf(last)[0]).toContain(TUNED);
  });

  it("RS23.61 proposals within the budget leave nothing to improve: no reflection, and the instruction is the system text", async () => {
    const model = tuningModel(oneEdit, oneEdit);
    const answer = await modelProposer(model, tuned)(request);
    expect(answer).toEqual(oneEdit);
    expect(reflections(model)).toHaveLength(0);
    expect(systemOf(model.doGenerateCalls.at(-1)!)[0]).not.toContain(TUNED);
  });

  it("RS23.62 an answer that is not a proposal scores 0 exactly as one over the budget does: the optimizer spends the same calls and reflects on it", async () => {
    const over = tuningModel(twoEdits, oneEdit);
    await modelProposer(over, tuned)(request);
    const model = tuningModel({ summary: "s", edits: [{ bogus: 1 }] }, oneEdit);
    expect(await modelProposer(model, tuned)(request)).toEqual(oneEdit);
    expect(reflections(model)).toHaveLength(2);
    expect(model.doGenerateCalls).toHaveLength(over.doGenerateCalls.length);
  });

  it("RS23.63 every example the optimizer scores is the round's request, and the tuning calls all carry the settings' token cap", async () => {
    const model = tuningModel(twoEdits, oneEdit);
    await modelProposer(model, tuned)(request);
    const proposing = model.doGenerateCalls.filter((c) => c.responseFormat !== undefined);
    expect(proposing.length).toBeGreaterThan(2);
    for (const call of proposing) expect(call.prompt.filter((m) => m.role === "user")).toEqual([{ role: "user", content: [{ type: "text", text: `Round Request: ${JSON.stringify(request)}\n` }] }]);
    expect(new Set(model.doGenerateCalls.map((c) => c.maxOutputTokens))).toEqual(new Set([777]));
  });

  it("RS23.64 the optimizer is tuned once per proposer: a second request is one call", async () => {
    const model = tuningModel(twoEdits, oneEdit);
    const propose = modelProposer(model, tuned);
    await propose(request);
    const spent = model.doGenerateCalls.length;
    await propose(request);
    expect(model.doGenerateCalls.length).toBe(spent + 1);
  });
});

describe("failures while tuning", () => {
  it("RS23.68 an error of the optimizer itself is thrown, not offered as a reason: one metric call cannot even score the examples", async () => {
    const model = scriptedModel(() => JSON.stringify(toggle("verify")));
    await expect(modelProposer(model, { ...untuned, optimize: { maxMetricCalls: 1, seed: 0 } })(request)).rejects.toThrow(/maxMetricCalls=1 is too small/);
  });

  it("RS23.65 a transport failure while the optimizer runs is thrown, not offered as a reason", async () => {
    const failing = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("gateway down"); } });
    await expect(modelProposer(failing, tuned)(request)).rejects.toThrow("gateway down");
  });

  it("RS23.66 a bad answer reported by the AI SDK while the optimizer runs comes back as the reason, whichever of its two errors it is", async () => {
    const noObject = new MockLanguageModelV4({ doGenerate: async () => { throw new NoObjectGeneratedError({ message: "no object", response: {} as never, usage: {} as never, finishReason: "stop" }); } });
    expect(await modelProposer(noObject, tuned)(request)).toBe("no object");
    const noOutput = new MockLanguageModelV4({ doGenerate: async () => { throw new NoOutputGeneratedError({ message: "no output" }); } });
    expect(await modelProposer(noOutput, tuned)(request)).toBe("no output");
  });

  it("RS23.67 tuning prints nothing", async () => {
    const written: unknown[] = [];
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write")];
    for (const spy of spies) spy.mockImplementation((...args: unknown[]) => { written.push(args); return true; });
    try {
      await modelProposer(tuningModel(twoEdits, oneEdit), tuned)(request);
      await modelProposer(tuningModel({ summary: "s", edits: [{ bogus: 1 }] }, oneEdit), tuned)(request);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(written).toEqual([]);
  });
});

describe("what the critic asks and answers", () => {
  const examples = [{ id: "t1", text: "task one" }, { id: "t2", text: "task two" }];
  const edit: AppliedEdit = {
    id: "e1",
    hypothesis: "h1",
    targets: "t1",
    predicted: ["x"],
    components: ["prompt"],
    footprint: 2,
    changes: [
      { document: "d1", wrote: [{ op: "replace", path: "/x", value: "y" }], inverse: [{ op: "remove", path: "/x" }] },
      { document: "d2", wrote: [{ op: "add", path: "/z", value: 1 }], inverse: [] },
    ],
  };
  const judge = (p: number) => scriptedJudge(() => ({ type: "boolean", probability: probability(p) }));

  it("RS23.50 the critic asks one boolean question, worded by the settings, over the edits' hypotheses, targets and writes only, and the examples' texts", async () => {
    const asked = judge(0.1);
    await judgeCritic(asked, s.critic)({ edits: [edit, { ...edit, hypothesis: "h2", targets: "t2" }], examples });
    expect(asked.requests).toHaveLength(1);
    expect(asked.requests[0]!.questions).toEqual({ specific: { type: "boolean", instructions: s.critic.question } });
    expect(asked.requests[0]!.state).toEqual({
      edits: [
        { hypothesis: "h1", targets: "t1", changes: [{ document: "d1", wrote: [{ op: "replace", path: "/x", value: "y" }] }, { document: "d2", wrote: [{ op: "add", path: "/z", value: 1 }] }] },
        { hypothesis: "h2", targets: "t2", changes: [{ document: "d1", wrote: [{ op: "replace", path: "/x", value: "y" }] }, { document: "d2", wrote: [{ op: "add", path: "/z", value: 1 }] }] },
      ],
      examples: ["task one", "task two"],
    });
  });

  it("RS23.51 a judge that fails is asked once: a retryable failure is not retried", async () => {
    const failing = scriptedJudge(() => { throw retryable(); });
    expect(await judgeCritic(failing, s.critic)({ edits: [edit], examples })).toEqual({ accept: false, reasons: ["the critic could not judge it: overloaded"] });
    expect(failing.requests).toHaveLength(1);
  });

  it("RS23.52 an answer that is not a probability refuses the edits as one the critic could not judge", async () => {
    const wrong = scriptedJudge(() => ({ type: "boolean", probability: 1.5 }));
    const verdict = await judgeCritic(wrong, s.critic)({ edits: [edit], examples });
    expect(verdict.accept).toBe(false);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/^the critic could not judge it: ./);
  });

  it("RS23.53 a failure that is not an Error is reported by its string", async () => {
    const failing = scriptedJudge(() => { throw "judge offline"; });
    expect(await judgeCritic(failing, s.critic)({ edits: [edit], examples })).toEqual({ accept: false, reasons: ["the critic could not judge it: judge offline"] });
  });

  it("RS23.54 the probability in the reason is shown to two decimals, and the threshold itself refuses", async () => {
    expect(await judgeCritic(judge(0.999), s.critic)({ edits: [edit], examples })).toEqual({ accept: false, reasons: ["it reads as specific to the evolve tasks (p = 1.00)"] });
    expect(await judgeCritic(judge(0.5), { ...s.critic, threshold: probability(0.5) })({ edits: [edit], examples })).toEqual({ accept: false, reasons: ["it reads as specific to the evolve tasks (p = 0.50)"] });
    expect(await judgeCritic(judge(0.4999), s.critic)({ edits: [edit], examples })).toEqual({ accept: true, reasons: [] });
  });
});

describe("what the proposer sends and reads, step by step", () => {
  it("RS27.1 the system messages become the instructions, joined by a blank line, and the other turns stay in order", () => {
    const sent = promptOf([
      { role: "system", content: "first" },
      { role: "user", content: "question" },
      { role: "system", content: "second" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "again" },
    ]);
    expect(sent).toEqual({
      instructions: "first\n\nsecond",
      messages: [
        { role: "user", content: "question" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "again" },
      ],
    });
  });

  it("RS27.2 a prompt without a system message has no instructions at all, and turns that are not plain text are left out", () => {
    const sent = promptOf([
      { role: "user", content: [{ type: "text", text: "parts" }] },
      { role: "user", content: "plain" },
      { role: "assistant", functionCalls: [{ id: "c1", type: "function", function: { name: "f" } }] },
      { role: "function", result: "result", functionId: "c1" },
    ]);
    expect(sent).toEqual({ messages: [{ role: "user", content: "plain" }] });
    expect("instructions" in sent).toBe(false);
  });

  it("RS27.3 an answer that is not an object with an array of edits is not a proposal", () => {
    for (const answer of [undefined, null, "text", 5, {}, { summary: "s" }, { edits: [] }, { summary: "s", edits: "none" }, { summary: "s", edits: { 0: edit1 } }, { summary: 5, edits: [] }]) expect(readProposal(answer)).toBeUndefined();
  });

  it("RS27.4 edits are decoded from strings one by one, and what stays undecodable is refused whole", () => {
    expect(readProposal({ summary: "s", edits: [edit1, JSON.stringify(edit1)] })).toEqual({ summary: "s", edits: [edit1, edit1] });
    expect(readProposal({ summary: "s", edits: [] })).toEqual({ summary: "s", edits: [] });
    expect(readProposal({ summary: "s", edits: [edit1, "{not json"] })).toBeUndefined();
    expect(readProposal({ summary: "s", edits: ["{not json"] })).toBeUndefined();
  });

  it("RS27.19 only a string is decoded: an object that would print as an edit is not one", () => {
    expect(readProposal({ summary: "s", edits: [{ toString: () => JSON.stringify(edit1) }] })).toBeUndefined();
  });

  it("RS27.20 the reason is what Ax wrapped when it wrapped an error, and the error's own message otherwise", () => {
    const details = { model: "m", maxTokens: 1, streaming: false, signature: { input: [], output: [] } } as never;
    expect(reasonOf(new AxGenerateError("Generate failed: wrapped", details, { cause: new Error("inner") }))).toBe("inner");
    expect(reasonOf(new AxGenerateError("Generate failed: no cause", details))).toBe("Generate failed: no cause");
    expect(reasonOf(new AxGenerateError("Generate failed: odd cause", details, { cause: "text" as never }))).toBe("Generate failed: odd cause");
    expect(reasonOf(new Error("plain"))).toBe("plain");
    expect(reasonOf("text")).toBe("text");
  });
});

describe("the tuning cap the settings allow", () => {
  it("RS27.5 the smallest cap the settings allow above zero scores the optimizer's examples once and tunes", async () => {
    const model = tuningModel(oneEdit, oneEdit);
    const answer = await modelProposer(model, { ...untuned, optimize: { maxMetricCalls: TUNING_EXAMPLES, seed: 0 } })(request);
    expect(answer).toEqual(oneEdit);
    expect(model.doGenerateCalls.filter((c) => c.responseFormat !== undefined)).toHaveLength(TUNING_EXAMPLES + 1);
  });

  it("RS27.6 a cap one below the examples cannot score them: the optimizer's own error is thrown", async () => {
    const model = scriptedModel(() => JSON.stringify(oneEdit));
    await expect(modelProposer(model, { ...untuned, optimize: { maxMetricCalls: TUNING_EXAMPLES - 1, seed: 0 } })(request)).rejects.toThrow(/is too small to evaluate the initial Pareto set/);
  });

  it("RS27.7 while tuning, the program's own retry limit holds: an answer Ax rejects is never sent back to the model for correction", async () => {
    const model = scriptedModel(() => JSON.stringify({ summary: "s" }));
    await modelProposer(model, tuned)(request);
    const proposing = model.doGenerateCalls.filter((c) => c.responseFormat !== undefined);
    expect(proposing.length).toBeGreaterThan(0);
    for (const call of proposing) expect(call.prompt.filter((m) => m.role !== "system")).toHaveLength(1);
  });

  it("RS27.8 the optimizer reflects on the answer it scored 0, as the model gave it", async () => {
    const model = tuningModel({ summary: "s", edits: [{ bogus: "marker-of-the-answer" }] }, oneEdit);
    await modelProposer(model, tuned)(request);
    const reflecting = reflections(model);
    expect(reflecting.length).toBeGreaterThan(0);
    expect(JSON.stringify(reflecting[0]!.prompt)).toContain("marker-of-the-answer");
  });
});

describe("what comes back from a bad answer and what is thrown", () => {
  const answering = (text: string) => scriptedModel(() => text);
  const reason = async (text: string, settings = untuned) => modelProposer(answering(text), settings)(request);

  it("RS27.9 an edit that is not JSON comes back as a reason, not as an error", async () => {
    const answer = await reason(JSON.stringify({ summary: "s", edits: ["{not json"] }));
    expect(typeof answer).toBe("string");
    expect(answer).toMatch(/^Unable to fix validation error: .*Invalid JSON/);
  });

  it("RS27.10 an answer without a summary comes back as a reason", async () => {
    const answer = await reason(JSON.stringify({ edits: [edit1] }));
    expect(typeof answer).toBe("string");
    expect(answer).toMatch(/summary/i);
  });

  it("RS27.11 an answer whose edits are not an array comes back as a reason", async () => {
    const answer = await reason(JSON.stringify({ summary: "s", edits: "none" }));
    expect(typeof answer).toBe("string");
    expect(answer).toMatch(/edits/i);
  });

  it("RS27.12 the same bad answers come back as reasons after tuning", async () => {
    for (const text of [JSON.stringify({ summary: "s", edits: ["{not json"] }), JSON.stringify({ edits: [edit1] }), JSON.stringify({ summary: "s", edits: "none" })]) {
      expect(typeof (await reason(text, tuned))).toBe("string");
    }
  });

  it("RS27.13 a transport failure is thrown, in forward and while tuning, whether Ax wrapped it or passed it on", async () => {
    const plain = new Error("gateway down");
    const named = Object.assign(new Error("model said no"), { name: "ValidationError" });
    for (const boom of [plain, named]) {
      const failing = () => new MockLanguageModelV4({ doGenerate: async () => { throw boom; } });
      await expect(modelProposer(failing(), untuned)(request)).rejects.toBe(boom);
      await expect(modelProposer(failing(), tuned)(request)).rejects.toBe(boom);
    }
  });

  it("RS27.14 a failure that is not an Error is thrown as an Error that carries its string", async () => {
    const failing = new MockLanguageModelV4({ doGenerate: async () => { throw "offline"; } });
    const caught = await modelProposer(failing, untuned)(request).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("offline");
  });
});

describe("what tuning leaves the proposer with, and what aborts it", () => {
  /** The round number the request in a call carried. */
  const roundOf = (call: { prompt: readonly { role: string; content: unknown }[] }): number => {
    const user = call.prompt.find((m) => m.role === "user")!.content as { text: string }[];
    return (JSON.parse(user[0]!.text.slice("Round Request: ".length)) as { round: number }).round;
  };

  it("RS31.1 when the last candidate the optimizer evaluates is not the best, the proposer answers with the best one", async () => {
    let seeded = 0;
    const BAD = "Propose nothing useful.";
    // The system text answers badly in tuning round 0 on every other call, and always well in round 1; the instruction the
    // optimizer writes answers badly in every round, so it is evaluated last, scores below the system text, and is not kept.
    const model = scriptedModel((options) => {
      const system = String((options.prompt[0] as { content: unknown }).content);
      if (system.includes("`Target Id`")) return "feedbackSummary: the proposals have too many edits";
      if (system.includes("`Component Key`")) return `newValue: ${BAD}`;
      if (system.includes(BAD)) return JSON.stringify(twoEdits);
      seeded += 1;
      return JSON.stringify(roundOf(options) === 1 || seeded % 2 === 1 ? oneEdit : twoEdits);
    });
    const applied = vi.spyOn(AxGen.prototype, "applyOptimization");
    try {
      const propose = modelProposer(model, tuned);
      await propose(request);
      expect(model.doGenerateCalls.some((c) => systemOf(c)[0]?.includes(BAD))).toBe(true);
      expect(applied).toHaveBeenCalledTimes(1);
      const answer = await propose({ ...request, round: 1 });
      expect(answer).toEqual(oneEdit);
      expect(systemOf(model.doGenerateCalls.at(-1)!)[0]).not.toContain(BAD);
    } finally {
      applied.mockRestore();
    }
  });

  it("RS31.2 an optimizer run that returns no program applies nothing, and the proposer still answers", async () => {
    const applied = vi.spyOn(AxGen.prototype, "applyOptimization");
    optimizer.dropsProgram = true;
    try {
      expect(await modelProposer(tuningModel(oneEdit, oneEdit), tuned)(request)).toEqual(oneEdit);
      expect(applied).not.toHaveBeenCalled();
    } finally {
      optimizer.dropsProgram = false;
      applied.mockRestore();
    }
  });

  it("RS31.3 an error of our own code is thrown, not offered as a reason: a request that cannot be written as JSON, untuned and tuned", async () => {
    const unwritable = { ...request, round: 1n } as never;
    const model = scriptedModel(() => JSON.stringify(oneEdit));
    await expect(modelProposer(model, untuned)(unwritable)).rejects.toThrow(/BigInt/);
    await expect(modelProposer(model, tuned)(unwritable)).rejects.toThrow(/BigInt/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("RS31.4 an error that Ax raises on its own account and is not about the answer is thrown as it is, even when it is not an Error", async () => {
    const internal = new TypeError("Ax internal fault");
    for (const fault of [internal, "odd fault"]) {
      const forward = vi.spyOn(AxGen.prototype, "forward").mockRejectedValueOnce(fault);
      try {
        await expect(modelProposer(scriptedModel(() => JSON.stringify(oneEdit)), untuned)(request)).rejects.toBe(fault);
      } finally {
        forward.mockRestore();
      }
    }
  });

  it("RS31.5 the AI SDK's two errors for an answer it could not read come back as the reason even when Ax passes them on unwrapped", async () => {
    const unreadable = [
      new NoObjectGeneratedError({ message: "no object", response: {} as never, usage: {} as never, finishReason: "stop" }),
      new NoOutputGeneratedError({ message: "no output" }),
    ];
    for (const error of unreadable) {
      const forward = vi.spyOn(AxGen.prototype, "forward").mockRejectedValueOnce(error);
      try {
        expect(await modelProposer(scriptedModel(() => JSON.stringify(oneEdit)), untuned)(request)).toBe(error.message);
      } finally {
        forward.mockRestore();
      }
    }
  });
});
