import { defineCommand } from "citty";
import type { CommandDef } from "citty";
import { readFileSync, writeFileSync } from "node:fs";
import { climbRound } from "@harness/climb";
import { casesFromTraces } from "@harness/generate";
import { grade } from "@harness/graders";
import type { GradePorts } from "@harness/graders";
import { parseSpec, parseTrials } from "@harness/ir";
import type { Spec, Trial } from "@harness/ir";
import { reportHtml, trialsJsonl } from "@harness/report";
import { executeCase, InProcessEnvironment } from "@harness/runner";
import type { Agent } from "@harness/runner";

export interface CliDeps {
  agent: Agent;
  ports: GradePorts;
  readText: (path: string) => string;
  writeText: (path: string, text: string) => void;
}

export function defaultDeps(): CliDeps {
  return {
    agent: {
      async run(instruction, env) {
        if (env.kind === "process") env.say(instruction);
      },
    },
    ports: {
      async evaluate() {
        return { passed: true };
      },
      async judge() {
        throw new Error("judge is not configured");
      },
      async foreign() {
        return { passed: true };
      },
    },
    readText: (path) => readFileSync(path, "utf8"),
    writeText: (path, text) => writeFileSync(path, text),
  };
}

export async function evaluateSpec(spec: Spec, agent: Agent, ports: GradePorts): Promise<Trial[]> {
  const trials: Trial[] = [];
  for (const split of ["train", "test"] as const) {
    for (const id of spec.split[split]) {
      const specCase = spec.cases.find((item) => item.id === id);
      if (specCase === undefined) throw new Error(`missing case ${id}`);
      if (specCase.source === "harbor" || specCase.source === "assert") throw new Error(`${specCase.source} cases run out of process`);
      const k = specCase.k ?? 1;
      for (let index = 0; index < k; index += 1) {
        const env = new InProcessEnvironment();
        const trial = await executeCase(agent, env, specCase, { caseId: id, trial: index }, split);
        const graded = await grade({ specCase, trial, sutModel: "sut", judgeModel: "judge" }, ports);
        trials.push({ ...trial, passed: graded.passed, scores: graded.scores });
      }
    }
  }
  return trials;
}

function textArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is missing`);
  return value;
}

export function createCli(deps: CliDeps): CommandDef {
  // citty 0.2.2 runs a subcommand and drops its return value. The parent run
  // hands that value back as `runCommand(...).result`.
  let result: unknown;
  const done = (value: string): string => {
    result = value;
    return value;
  };
  return defineCommand({
    meta: { name: "harness-eval", description: "Eval IR, climber, and foreign runners" },
    run() {
      return result;
    },
    subCommands: {
      eval: defineCommand({
        meta: { name: "eval", description: "Run cases against an injected agent" },
        args: { spec: { type: "positional", description: "Spec JSON path", required: true } },
        async run({ args }) {
          const spec = parseSpec(JSON.parse(deps.readText(textArg(args, "spec"))));
          return done(JSON.stringify(await evaluateSpec(spec, deps.agent, deps.ports)));
        },
      }),
      "build-eval": defineCommand({
        meta: { name: "build-eval", description: "Turn OpenInference traces into cases" },
        args: { traces: { type: "positional", description: "Trace JSON path", required: true } },
        run({ args }) {
          return done(JSON.stringify(casesFromTraces(JSON.parse(deps.readText(textArg(args, "traces"))) as unknown[])));
        },
      }),
      hillclimb: defineCommand({
        meta: { name: "hillclimb", description: "Accept one patch on a frozen split" },
        args: {
          spec: { type: "positional", description: "Spec JSON path", required: true },
          trials: { type: "positional", description: "Trials JSON path", required: true },
          patch: { type: "positional", description: "The one patch", required: true },
          out: { type: "string", description: "Report path prefix" },
        },
        run({ args }) {
          const spec = parseSpec(JSON.parse(deps.readText(textArg(args, "spec"))));
          const trials = parseTrials(JSON.parse(deps.readText(textArg(args, "trials"))));
          const round = climbRound({ spec, patchId: textArg(args, "patch"), frozen: spec.split, trials });
          const out = args["out"];
          if (typeof out === "string" && out.length > 0) {
            deps.writeText(`${out}.jsonl`, trialsJsonl(round, trials));
            deps.writeText(`${out}.html`, reportHtml(round));
          }
          if (!round.accepted && round.reason === undefined) throw new Error("rejected round needs a reason");
          return done(round.accepted ? "accepted" : `rejected: ${round.reason}`);
        },
      }),
    },
  });
}
