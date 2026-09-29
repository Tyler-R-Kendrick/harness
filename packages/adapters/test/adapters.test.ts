import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { adkToCases, failureClassFromHarbor, parseAssertScores, parseAssertStatus, parseHarborJob, promptfooSuite, readPromptfoo, skillsToCases, writePromptfoo } from "@harness/adapters";
import { parseSpec } from "@harness/ir";

describe("eval adapters", () => {
  it("EA1.1 a spec round-trips through Promptfoo YAML", () => {
    const spec = parseSpec({
      id: "spec-1",
      name: "greet",
      kind: "policy",
      cases: [{
        id: "c1",
        source: "promptfoo",
        instruction: "say hello",
        permissible: true,
        expect: { promptfoo: [{ type: "contains", value: "hello" }, { type: "is-json" }] },
      }],
      split: { train: ["c1"], test: [] },
    });
    const yaml = writePromptfoo(spec);
    expect(yaml).toContain("{{instruction}}");
    const doc = parse(yaml) as { prompts: string[]; providers: string[]; tests: { assert: { type: string; value?: string }[] }[] };
    expect(doc.prompts).toEqual(["{{instruction}}"]);
    expect(doc.providers).toEqual(["echo"]);
    expect(doc.tests[0]?.assert[0]).toEqual({ type: "contains", value: "hello" });
    expect(doc.tests[0]?.assert[1]).toEqual({ type: "is-json" });
    const back = readPromptfoo(yaml);
    expect(back).toEqual(spec);
    expect(promptfooSuite(spec.cases[0]!).prompts).toEqual(["{{instruction}}"]);
    expect(promptfooSuite({ id: "x", source: "local", instruction: "x" }).tests[0]?.assert).toEqual([]);
    const capability = parseSpec({
      id: "cap",
      name: "cap",
      kind: "capability",
      cases: [
        { id: "a", source: "local", instruction: "a", k: 2 },
        { id: "b", source: "skills", instruction: "b" },
        { id: "c", source: "adk", instruction: "c" },
        { id: "d", source: "harbor", instruction: "d" },
        { id: "e", source: "assert", instruction: "e" },
        { id: "f", source: "inspect", instruction: "f" },
      ],
      split: { train: ["a"], test: ["b", "c", "d", "e", "f"] },
    });
    expect(readPromptfoo(writePromptfoo(capability))).toEqual(capability);
    expect(() => readPromptfoo(writePromptfoo(capability).replace("source: local", "source: nope"))).toThrow(/source/);
    expect(() => readPromptfoo(writePromptfoo(capability).replace("kind: capability", "kind: other"))).toThrow(/kind/);
    expect(() => readPromptfoo("prompts: []\n")).toThrow(/tests/);
  });

  it("EA1.2 skills evals.json and an ADK eval set become cases", () => {
    const skills = skillsToCases({ skill: "lookup", evals: [{ id: "s1", prompt: "find it", expected: "found", files: ["out.txt"] }] });
    expect(skills).toEqual([{
      id: "s1",
      source: "skills",
      instruction: "find it",
      expect: { promptfoo: [{ type: "contains", value: "found" }], files: ["out.txt"] },
    }]);
    expect(() => skillsToCases({})).toThrow();
    expect(skillsToCases({ skill: "lookup", evals: [{ id: "bare", prompt: "only" }] })).toEqual([{ id: "bare", source: "skills", instruction: "only" }]);
    expect(skillsToCases({ skill: "lookup", evals: [{ id: "word", prompt: "p", expected: "yes" }] })[0]?.expect).toEqual({ promptfoo: [{ type: "contains", value: "yes" }] });
    expect(skillsToCases({ skill: "lookup", evals: [{ id: "file", prompt: "p", files: ["out.txt"] }] })[0]?.expect).toEqual({ files: ["out.txt"] });
    const adk = adkToCases({
      eval_set_id: "set-1",
      name: "chat",
      eval_cases: [{
        eval_id: "e1",
        conversation: [
          { user_content: { parts: [{ text: "hello" }, { text: "there" }] } },
          { user_content: { parts: [{ text: "again" }] } },
        ],
      }],
    });
    expect(adk).toEqual([{ id: "e1", source: "adk", instruction: "hello\nthere\nagain" }]);
    expect(() => adkToCases({ eval_set_id: "set-1", name: "chat", eval_cases: [{ eval_id: "e2", conversation: [{}] }] })).toThrow(/instruction/);
    expect(() => adkToCases({})).toThrow();
    expect(adkToCases({
      eval_set_id: "set-1",
      name: "chat",
      eval_cases: [{ eval_id: "e3", conversation: [{}, { user_content: { parts: [{}, { text: "only" }] } }] }],
    })).toEqual([{ id: "e3", source: "adk", instruction: "only" }]);
  });

  it("EA1.3 Harbor result.json and ASSERT status parse without running those tools", () => {
    const job = parseHarborJob({
      id: "job-1",
      stats: { evals: { suite: { n_trials: 2, n_errors: 1, metrics: [{ reward: 0 }] } } },
    });
    expect(job).toEqual({ id: "job-1", evals: { suite: { nTrials: 2, nErrors: 1, metrics: [{ reward: 0 }] } } });
    expect(failureClassFromHarbor({ exception_info: { exception_type: "TimeoutError" } })).toBe("timeout");
    expect(failureClassFromHarbor({ exception: "RuntimeError" })).toBe("harness");
    expect(failureClassFromHarbor({ agent_result: { metadata: { refused: true } } })).toBe("refusal");
    expect(failureClassFromHarbor({ verifier_result: { rewards: { reward: 0 } } })).toBe("genuine");
    expect(failureClassFromHarbor({ verifier_result: { rewards: { reward: 1 } } })).toBeUndefined();
    expect(() => parseHarborJob({ id: "job-1", stats: { evals: { suite: { n_errors: 0 } } } })).toThrow(/n_trials/);
    expect(() => parseHarborJob([])).toThrow(/object/);
    expect(() => parseHarborJob({ stats: { evals: {} } })).toThrow(/id/);
    expect(() => parseHarborJob({ id: "job-1", stats: { evals: { suite: { n_trials: "2", n_errors: 0 } } } })).toThrow(/n_trials/);
    expect(failureClassFromHarbor({ exception_info: { exception_message: "Timeout waiting" } })).toBe("timeout");
    expect(failureClassFromHarbor({ exception_info: { exception_type: 1 }, reward: 1 })).toBeUndefined();
    expect(failureClassFromHarbor({ exception_info: null, exception: "Boom" })).toBe("harness");
    expect(failureClassFromHarbor({ exception_info: null, reward: 1 })).toBeUndefined();
    expect(failureClassFromHarbor({ refused: true })).toBe("refusal");
    expect(failureClassFromHarbor({ agent_result: { refused: true } })).toBe("refusal");
    expect(failureClassFromHarbor({ agent_result: {}, reward: 0 })).toBe("genuine");
    expect(failureClassFromHarbor({ reward: 0 })).toBe("genuine");
    expect(() => failureClassFromHarbor({})).toThrow(/missing reward/);
    expect(() => failureClassFromHarbor({ verifier_result: {} })).toThrow(/missing reward/);
    expect(() => failureClassFromHarbor({ verifier_result: { rewards: {} } })).toThrow(/missing reward/);
    expect(() => failureClassFromHarbor({ verifier_result: { rewards: { reward: "no" } } })).toThrow(/missing reward/);
    const status = parseAssertStatus({
      not_permissible_policy_violation_rate: 0.2,
      overrefusal_rate: 0.4,
      permissible_policy_violation_rate: 0.1,
    });
    expect(status).toEqual({ impermissible: 0.2, overrefusal: 0.4, permissibleViolation: 0.1 });
    expect(status.overrefusal).not.toBe(status.permissibleViolation);
    expect(() => parseAssertStatus({ not_permissible_policy_violation_rate: 0.2 })).toThrow(/overrefusal_rate/);
    expect(() => parseAssertStatus([])).toThrow(/object/);
    expect(() => parseAssertStatus({
      not_permissible_policy_violation_rate: "x",
      overrefusal_rate: 0,
      permissible_policy_violation_rate: 0,
    })).toThrow(/not_permissible_policy_violation_rate/);
    const scores = parseAssertScores('{"name":"harm"}\n\n{"name":"ok"}\n');
    expect(scores).toEqual([{ name: "harm" }, { name: "ok" }]);
  });
});
