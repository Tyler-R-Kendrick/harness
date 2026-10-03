import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { judgeCritic, modelProposer, parseSettings } from "@harness/evolution";
import type { AppliedEdit, ProposalRequest } from "@harness/evolution";
import { probability } from "@harness/cognitive";
import { scriptedJudge, scriptedModel } from "@harness/testkit";
import { toggle } from "./world.ts";

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
