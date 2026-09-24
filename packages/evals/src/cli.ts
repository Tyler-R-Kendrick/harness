#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { chooseJudge, runEvals } from "./runner.ts";
import type { EvalCase } from "./runner.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildNativeEnsemble } from "@harness/platform-native";
import { calibrationSuite } from "./suites/calibration.ts";
import { cognitiveSuite } from "./suites/cognitive.ts";
import { harnessSuite } from "./suites/harness.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "eval-results/results.json" },
    suite: { type: "string", default: "all" },
    "require-live": { type: "boolean", default: false },
  },
});

// The cognitive suite downloads and runs the local models (set HARNESS_MODEL_CACHE, and
// LLAMA_SERVER for the GGUF models), so it runs only when asked for by name.
let native: ReturnType<typeof buildNativeEnsemble> | undefined;
const suites: Record<string, () => readonly EvalCase[]> = {
  calibration: () => calibrationSuite,
  harness: () => harnessSuite,
  cognitive: () => {
    native ??= buildNativeEnsemble({
      cacheDir: process.env["HARNESS_MODEL_CACHE"] ?? join(homedir(), ".cache", "harness", "models"),
      ...(process.env["LLAMA_SERVER"] ? { llamaServer: process.env["LLAMA_SERVER"] } : {}),
      memory: {},
    });
    const ensemble = native.ensemble;
    return cognitiveSuite(async () => ensemble);
  },
};
const selected = values.suite === "all" ? ["calibration", "harness"] : values.suite.split(",");
const unknown = selected.filter((s) => !(s in suites));
if (unknown.length > 0) {
  process.stderr.write(`unknown suite(s): ${unknown.join(", ")}; choose from ${Object.keys(suites).join(", ")}, all\n`);
  process.exit(2);
}

function sourceRevision(): string | undefined {
  if (process.env["GITHUB_SHA"]) return process.env["GITHUB_SHA"];
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

const cases = selected.flatMap((s) => suites[s]!());
const revision = sourceRevision();
const { judge, credential } = await chooseJudge(process.env);
const report = await runEvals(cases, judge, {
  credential,
  ...(revision === undefined ? {} : { sourceRevision: revision }),
});

await native?.close();
await mkdir(dirname(values.out), { recursive: true });
await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);

const s = report.summary;
for (const r of report.results) process.stdout.write(`${r.verdict.padEnd(12)} ${r.id}${r.reason ? `  (${r.reason})` : ""}\n`);
const [lo, hi] = s.passRate.interval;
process.stdout.write(
  `\n${s.total} cases: ${s.passed} passed, ${s.failed} failed, ${s.inconclusive} inconclusive, ${s.blocked} blocked` +
    ` | judge ${report.judge.modelId} | pass rate ${s.passRate.successes}/${s.passRate.trials} (95% CI ${lo.toFixed(2)}-${hi.toFixed(2)})\n` +
    `results: ${values.out}\n`,
);
if (s.blocked > 0 && process.env["GITHUB_ACTIONS"]) {
  process.stdout.write(`::warning title=Evals blocked::${s.blocked} eval case(s) could not run: ${report.results.find((r) => r.verdict === "blocked")?.reason}\n`);
}
process.exit(s.failed > 0 || (values["require-live"] && s.blocked > 0) ? 1 : 0);
