import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { describe, expect, it } from "vitest";
import { createCli, defaultDeps, evaluateSpec } from "@harness/cli";
import { parseSpec } from "@harness/ir";

function write(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  defaultDeps().writeText(path, JSON.stringify(value));
  return path;
}

describe("harness-eval", () => {
  it("EL1.1 hillclimb reports accept or the blocking reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-eval-"));
    const spec = {
      id: "cap",
      name: "cap",
      kind: "capability",
      cases: [
        { id: "a", source: "local", instruction: "a" },
        { id: "b", source: "local", instruction: "b", k: 2 },
      ],
      split: { train: ["a"], test: ["b"] },
    };
    const specPath = write(dir, "spec.json", spec);
    const badTrials = write(dir, "bad.json", [
      { caseId: "a", split: "train", index: 0, output: "", tools: [], files: [], behavior: "complied", scores: [], passed: false },
      { caseId: "b", split: "test", index: 0, output: "", tools: [], files: [], behavior: "complied", scores: [], passed: true },
      { caseId: "b", split: "test", index: 1, output: "", tools: [], files: [], behavior: "complied", scores: [], passed: true },
    ]);
    const goodTrials = write(dir, "good.json", [
      { caseId: "a", split: "train", index: 0, output: "a", tools: [], files: [], behavior: "complied", scores: [], passed: true },
      { caseId: "b", split: "test", index: 0, output: "b", tools: [], files: [], behavior: "complied", scores: [], passed: true },
      { caseId: "b", split: "test", index: 1, output: "b", tools: [], files: [], behavior: "complied", scores: [], passed: true },
    ]);
    const cli = createCli(defaultDeps());
    expect(Object.keys(cli.subCommands ?? {})).toEqual(["eval", "build-eval", "hillclimb"]);
    const rejected = await runCommand(cli, { rawArgs: ["hillclimb", specPath, badTrials, "patch-1"] });
    expect(rejected.result).toBe("rejected: train failed");
    const out = join(dir, "round");
    const accepted = await runCommand(cli, { rawArgs: ["hillclimb", specPath, goodTrials, "patch-1", "--out", out] });
    expect(accepted.result).toBe("accepted");
    expect(readFileSync(`${out}.jsonl`, "utf8")).toContain("impermissible");
    expect(readFileSync(`${out}.html`, "utf8")).toContain("overrefusal");
    const traces = write(dir, "traces.json", [{ attributes: { "input.value": "from a trace" } }]);
    const built = await runCommand(cli, { rawArgs: ["build-eval", traces] });
    expect(built.result).toContain("from a trace");
    const evaluated = await runCommand(cli, { rawArgs: ["eval", specPath] });
    const trials = JSON.parse(String(evaluated.result)) as { output: string }[];
    expect(trials.map((item) => item.output)).toEqual(["a", "b", "b"]);
    const parsed = parseSpec(spec);
    await expect(evaluateSpec(parsed, defaultDeps().agent, {
      ...defaultDeps().ports,
      async judge() {
        throw new Error("judge is not configured");
      },
    })).resolves.toHaveLength(3);
    const rubric = parseSpec({
      ...spec,
      cases: [{ id: "a", source: "local", instruction: "a", expect: { rubric: "be brief" } }],
      split: { train: ["a"], test: [] },
    });
    await expect(evaluateSpec(rubric, defaultDeps().agent, defaultDeps().ports)).rejects.toThrow(/judge is not configured/);
    const harbor = parseSpec({
      id: "h",
      name: "h",
      kind: "capability",
      cases: [{ id: "a", source: "harbor", instruction: "a" }],
      split: { train: ["a"], test: [] },
    });
    await expect(evaluateSpec(harbor, defaultDeps().agent, defaultDeps().ports)).rejects.toThrow(/out of process/);
    const asserted = parseSpec({
      id: "h",
      name: "h",
      kind: "capability",
      cases: [{ id: "a", source: "assert", instruction: "a" }],
      split: { train: ["a"], test: [] },
    });
    await expect(evaluateSpec(asserted, defaultDeps().agent, defaultDeps().ports)).rejects.toThrow(/out of process/);
    await expect(evaluateSpec({ ...parsed, split: { train: ["missing"], test: [] } }, defaultDeps().agent, defaultDeps().ports)).rejects.toThrow(/missing case/);
    const deps = defaultDeps();
    await expect(deps.ports.evaluate({ prompts: ["{{instruction}}"], providers: ["echo"], tests: [] })).resolves.toEqual({ passed: true });
    await expect(deps.ports.foreign()).resolves.toEqual({ passed: true });
    await expect(deps.agent.run("x", { kind: "harbor", handle: "h", view: { output: "", tools: [], files: [], behavior: "complied", passed: true } }, { caseId: "a", trial: 0 })).resolves.toBeUndefined();
    const quiet = await runCommand(cli, { rawArgs: ["hillclimb", specPath, goodTrials, "patch-1", "--out", ""] });
    expect(quiet.result).toBe("accepted");
  });
});
