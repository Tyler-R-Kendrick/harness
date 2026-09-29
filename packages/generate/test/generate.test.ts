import { describe, expect, it } from "vitest";
import { assertArgv, casesFromTraces, harborArgv, inspectArgv, redteamArgv, runForeign } from "@harness/generate";

describe("build-eval", () => {
  it("GN1.1 traces become cases and foreign tools are argv, not ports", async () => {
    const cases = casesFromTraces([
      { attributes: { "openinference.span.kind": "AGENT", "input.value": "first" } },
      { attributes: { "output.value": "skip" } },
      { attributes: { "input.value": "second" } },
    ]);
    expect(cases).toEqual([
      { id: "trace-1", source: "local", instruction: "first" },
      { id: "trace-2", source: "local", instruction: "second" },
    ]);
    expect(() => casesFromTraces([{ attributes: {} }])).toThrow(/input/);
    expect(casesFromTraces([null, { attributes: null }, { attributes: { "input.value": 1 } }, { attributes: { "input.value": "kept" } }])).toEqual([
      { id: "trace-1", source: "local", instruction: "kept" },
    ]);
    expect(harborArgv("ds", "agent")).toEqual(["run", "-d", "ds", "-a", "agent"]);
    expect(harborArgv("ds", "agent", "job.yaml")).toEqual(["run", "-d", "ds", "-a", "agent", "-c", "job.yaml"]);
    expect(assertArgv("eval_config.yaml")).toEqual(["run", "--config", "eval_config.yaml"]);
    expect(redteamArgv("promptfooconfig.yaml")).toEqual(["redteam", "generate", "-c", "promptfooconfig.yaml"]);
    expect(inspectArgv("inspect_evals/mmlu")).toEqual(["eval", "inspect_evals/mmlu"]);
    const seen: { bin: string; args: readonly string[] }[] = [];
    const injected = await runForeign("harbor", ["run", "-d", "ds"], async (bin, args) => {
      seen.push({ bin, args });
      return { stdout: "job", stderr: "", exitCode: 0 };
    });
    expect(injected.stdout).toBe("job");
    expect(seen).toEqual([{ bin: "harbor", args: ["run", "-d", "ds"] }]);
    const ok = await runForeign(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(ok).toMatchObject({ stdout: "ok", exitCode: 0 });
    const failed = await runForeign(process.execPath, ["-e", "process.exit(3)"]);
    expect(failed.exitCode).toBe(3);
    const signaled = await runForeign(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
    expect(signaled.exitCode).toBe(1);
  });
});
