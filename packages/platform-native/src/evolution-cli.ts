#!/usr/bin/env node
import { evolutionCommand } from "./evolution-command.ts";

// harness-evolution <start|round|run|status|documents> --config <evolution.json> [options]
// Regularized self-improvement of the harness's data (ADR 0018) on this machine: the
// configuration names the documents (JSON, or raw text), the tasks and the evaluator command;
// the proposer is an AI Gateway model, the optional critic an AI Gateway model or the native
// host's ensemble judge (--critic ensemble). See evolution-command.ts.
// A command never outlives the run that started it, and a lock is not left behind: on a signal
// the process exits, which kills the process groups of the evaluator and check commands (they
// are groups of their own, so a Ctrl-C at the terminal does not reach them) and releases the
// state's lock. (A SIGKILL cannot be handled: the lock is then stale, and taken over by the next run.)
for (const [signal, number] of [["SIGHUP", 1], ["SIGINT", 2], ["SIGTERM", 15]] as const) process.on(signal, () => process.exit(128 + number));

process.exitCode = await evolutionCommand(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});
