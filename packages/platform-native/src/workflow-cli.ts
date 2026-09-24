#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { askEnsemble, MemoryLibrary, parseWorkflow, WorkflowHost } from "@harness/workflows";
import type { WorkflowLibrary } from "@harness/workflows";
import { buildNativeEnsemble } from "./cognitive-host.ts";
import { WorkflowFiles } from "./workflow-files.ts";

// harness-workflow run <workflow.json> --run <id> [--input <json>] [--library <dir>]
// Runs a workflow durably: its journal sits beside the file (in .runs/), so running the
// same command again resumes an interrupted run, or prints the finished run's result.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    run: { type: "string" },
    input: { type: "string", default: "{}" },
    library: { type: "string" },
    "model-cache": { type: "string" },
    "llama-server": { type: "string" },
    "no-hosted": { type: "boolean", default: false },
  },
});
const [command, file] = positionals;
if (command !== "run" || !file || !values.run) {
  process.stderr.write("usage: harness-workflow run <workflow.json> --run <run-id> [--input <json>] [--library <dir>]\n");
  process.exit(2);
}

const workflow = parseWorkflow(JSON.parse(readFileSync(file, "utf8")));
const others: WorkflowLibrary | undefined = values.library === undefined ? undefined : new WorkflowFiles(values.library);
const library: WorkflowLibrary = {
  get: async (name) => (name === workflow.name ? workflow : others?.get(name)),
  put: async (w) => (others ? others.put(w) : new MemoryLibrary().put(w)),
  list: async () => [workflow, ...((await others?.list()) ?? []).filter((w) => w.name !== workflow.name)],
};
// Models load only if the workflow asks one a question.
const cognitive = buildNativeEnsemble({
  cacheDir: values["model-cache"] ?? join(homedir(), ".cache", "harness", "models"),
  allowHosted: !values["no-hosted"],
  ...(values["llama-server"] === undefined ? {} : { llamaServer: values["llama-server"] }),
});
const journals = new WorkflowFiles(dirname(file));
const host = new WorkflowHost({ library, journal: (run) => journals.journal(run), ask: askEnsemble(cognitive.ensemble) });
try {
  const result = await host.run(workflow.name, JSON.parse(values.input), values.run);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === "completed" ? 0 : 1;
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\nThe run is kept; run the same command again to resume it.\n`);
  process.exitCode = 1;
} finally {
  await cognitive.close();
}
