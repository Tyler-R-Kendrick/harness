import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const env = (extra: Record<string, string> = {}) => {
  const e: Record<string, string> = { PATH: process.env["PATH"] ?? "", NODE_OPTIONS: "", ...extra };
  return e;
};

describe("eval CLI", () => {
  it("EV6.1 without credentials every case is blocked, results are written, and the run does not claim success", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "evals-")), "r.json");
    const { stdout } = await run(process.execPath, [CLI, "--out", out], { env: env({ GITHUB_ACTIONS: "true" }) });
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.schemaVersion).toBe("harness.eval/v1");
    expect(report.judge).toEqual({ provider: "gateway", modelId: "typesafe-ai/jev" });
    expect(report.summary.passed).toBe(0);
    expect(report.summary.blocked).toBe(report.summary.total);
    expect(report.summary.total).toBeGreaterThanOrEqual(8);
    expect(stdout).toMatch(/::warning title=Evals blocked::/);
  });

  it("EV6.2 --require-live turns blocked cases into a failing exit code", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "evals-")), "r.json");
    await expect(run(process.execPath, [CLI, "--out", out, "--suite", "calibration", "--require-live"], { env: env() })).rejects.toMatchObject({ code: 1 });
  });

  it("EV6.3 an unknown suite is a usage error", async () => {
    await expect(run(process.execPath, [CLI, "--suite", "nope"], { env: env() })).rejects.toMatchObject({ code: 2 });
  });
});
