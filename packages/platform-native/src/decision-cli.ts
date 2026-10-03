#!/usr/bin/env node
import { runDecisionCli } from "./decision-commands.ts";

// harness-decision status|report|calibrate|thresholds|export|induce <dir> [options]: see decision-commands.ts.
process.exitCode = await runDecisionCli(process.argv.slice(2), { out: (text) => void process.stdout.write(text), err: (text) => void process.stderr.write(text) });
