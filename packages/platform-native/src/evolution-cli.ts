#!/usr/bin/env node
import { evolutionCommand } from "./evolution-command.ts";

// harness-evolution <start|round|run|status|documents> --config <evolution.json> [options]
// Regularized self-improvement of the harness's data (ADR 0014) on this machine: the
// configuration names the documents, the tasks and the evaluator command; the proposer
// (and an optional critic) are AI Gateway models. See evolution-command.ts.
process.exitCode = await evolutionCommand(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});
