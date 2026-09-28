#!/usr/bin/env node
import { evolutionCommand } from "./evolution-command.ts";

// harness-evolution <start|round|run|status|documents> --config <evolution.json> [options]
// Regularized self-improvement of the harness's data (ADR 0014) on this machine: the
// configuration names the documents (JSON, or raw text), the tasks and the evaluator command;
// the proposer is an AI Gateway model, the optional critic an AI Gateway model or the native
// host's ensemble judge (--critic ensemble). See evolution-command.ts.
process.exitCode = await evolutionCommand(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});
