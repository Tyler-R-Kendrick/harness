import { describe, expect, it } from "vitest";
import { SeededEntropy } from "@harness/testkit";
import { epsilonGreedy, uniform } from "../src/explore.ts";
import type { Explorer } from "../src/fork.ts";
import { gate, policyJson, rig, sure, withActions, withFloor } from "./fork-fixtures.ts";

describe("the runner with the exploration policy of explore.ts", () => {
  it("FRK15.1 epsilon-greedy is an Explorer, and the record carries the propensity it computed", async () => {
    const explorer: Explorer = epsilonGreedy;
    const { decider } = rig({ members: [sure("m", 0.97)], policy: policyJson({ default: { explore: 0.5 } }), rng: () => 0.9, explorer });
    const d = await decider.decide(gate(withActions), { text: "x" });
    expect(d).toMatchObject({ action: "allow", explored: false });
    expect(d.record.propensity).toBe(0.75);
  });

  it("FRK15.2 driven by the entropy port, about epsilon of decisions explore, each with the propensity of what it took, and none goes below the floor", async () => {
    const { decider } = rig({
      members: [sure("m", 0.97)],
      policy: policyJson({ default: { explore: 0.4 } }),
      rng: uniform(new SeededEntropy(7)),
      explorer: epsilonGreedy,
    });
    let explored = 0;
    for (let i = 0; i < 400; i++) {
      const d = await decider.decide(gate({ ...withActions, ...withFloor(() => undefined) }), { text: String(i) });
      if (d.explored) explored++;
      expect([0.8, 0.2]).toContain(Math.round(d.record.propensity * 100) / 100);
    }
    expect(explored / 400).toBeGreaterThan(0.3);
    expect(explored / 400).toBeLessThan(0.5);
    const floored = await rig({ members: [sure("m", 0.97)], policy: policyJson({ default: { explore: 1 } }), rng: uniform(new SeededEntropy(3)), explorer: epsilonGreedy }).decider.decide(gate({ ...withActions, ...withFloor(() => "deny") }), { text: "x" });
    expect(floored.action).toBe("deny");
    expect(floored.record.propensity).toBe(1);
  });
});
