import { describe, expect, it } from "vitest";
import { loadTestingRoster, testingRosterJsonSchema } from "../src/testing-roster.ts";

describe("the shipped testing sub-agent roster", () => {
  it("TA2.1 the shipped roster names the eight agents and the floors", () => {
    const roster = loadTestingRoster();
    expect(roster.fuzzMinTrials).toBe(100);
    expect(roster.mutationBreak).toBe(90);
    expect(roster.maxCrap).toBe(30);
    expect(roster.agents.map((agent) => [agent.name, agent.applies])).toEqual([
      ["fuzz", "always"],
      ["mutation", "always"],
      ["crap", "always"],
      ["contract", "always"],
      ["atomic", "always"],
      ["evals", "always"],
      ["bdd", "boundary"],
      ["ux", "ui"],
    ]);
  });

  it("TA2.2 the roster schema is the generated file", async () => {
    expect(testingRosterJsonSchema()).toMatchObject({ type: "object" });
    await expect(`${JSON.stringify(testingRosterJsonSchema(), null, 2)}\n`).toMatchFileSnapshot("../../core/data/testing-subagents.schema.json");
  });
});
