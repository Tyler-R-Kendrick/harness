#!/usr/bin/env node
import { deliverCommand } from "./deliver.ts";

// harness-deliver --repo <dir> --policy <delivery-policy.json> --tasks <tasks.json>
// --worktrees <dir> --cache <path> [--trunk main] [--cache-name node_modules]
// [--owner <owner> --name <repo>] [--author-name <name> --author-email <email>]
// Runs the delivery machine: one linked worktree per task, a shared cache symlink,
// incremental commits, stacked squash-merges, and removal of the worktrees.
process.exitCode = await deliverCommand(process.argv.slice(2), {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
});
