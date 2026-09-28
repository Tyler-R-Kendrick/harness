import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { judgeCritic, modelProposer, parseSettings } from "@harness/evolution";
import type { AppliedEdit, ProposalRequest } from "@harness/evolution";
import { probability } from "@harness/cognitive";
import { scriptedJudge, scriptedModel } from "@harness/testkit";
import { readFileSync } from "node:fs";
import { toggle } from "./world.ts";

const s = parseSettings(JSON.parse(readFileSync(new URL("../data/settings.json", import.meta.url), "utf8")));
const request = { round: 0, candidate: "A", budget: 1, components: ["prompt"], documents: {}, analysis: { score: 0, failures: [], successes: [] }, history: [], mechanisms: [] } satisfies ProposalRequest;
const edit: AppliedEdit = { id: "e1", hypothesis: "h", targets: "t", predicted: [], components: ["prompt"], footprint: 1, changes: [{ document: "d", wrote: [{ op: "replace", path: "/x", value: "y" }], inverse: [] }] };

describe("the proposer and the critic on AI SDK models", () => {
  it("RS12.1 the proposer asks for a Proposal constrained to its JSON Schema and answers it parsed", async () => {
    const model = scriptedModel(() => JSON.stringify(toggle("verify")));
    const answer = await modelProposer(model, s.proposer)(request);
    expect(answer).toMatchObject({ summary: "enable verify", edits: [{ id: "e1", predicted: [], ops: [{ op: "add", document: "policy", path: "/rules/verify", value: true }] }] });
    const call = model.doGenerateCalls[0]!;
    expect(call.responseFormat).toMatchObject({ type: "json", schema: expect.objectContaining({ type: "object" }) });
    expect(call.maxOutputTokens).toBe(s.proposer.maxTokens);
    expect(JSON.stringify(call.prompt)).toContain(s.proposer.system.slice(0, 40));
  });

  it("RS12.2 an answer that is not a proposal comes back as the reason; other failures are thrown", async () => {
    expect(await modelProposer(scriptedModel(() => "not json"), s.proposer)(request)).toMatch(/could not parse|No object generated/i);
    const broken = new MockLanguageModelV4({ doGenerate: async () => { throw new Error("gateway down"); } });
    await expect(modelProposer(broken, s.proposer)(request)).rejects.toThrow(/gateway down/);
  });

  it("RS12.3 the critic refuses edits the judge finds specific to the evolve tasks, and refuses when it cannot judge", async () => {
    const judge = (p: number) => scriptedJudge(() => ({ type: "boolean", probability: probability(p) }));
    const examples = [{ id: "t1", text: "task one" }];
    const specific = judge(0.9);
    expect(await judgeCritic(specific, s.critic)({ edits: [edit], examples })).toEqual({ accept: false, reasons: ["it reads as specific to the evolve tasks (p = 0.90)"] });
    expect(specific.requests[0]!.state).toEqual({ edits: [{ hypothesis: "h", targets: "t", changes: [{ document: "d", wrote: [{ op: "replace", path: "/x", value: "y" }] }] }], examples: ["task one"] });
    expect(await judgeCritic(judge(0.1), s.critic)({ edits: [edit], examples })).toEqual({ accept: true, reasons: [] });
    expect(await judgeCritic(judge(0.5), s.critic)({ edits: [edit], examples })).toMatchObject({ accept: false });
    const failing = scriptedJudge(() => { throw new Error("judge offline"); });
    expect(await judgeCritic(failing, s.critic)({ edits: [edit], examples })).toEqual({ accept: false, reasons: ["the critic could not judge it: judge offline"] });
  });
});
