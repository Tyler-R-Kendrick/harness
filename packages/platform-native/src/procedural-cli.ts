#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { proceduralExtension } from "@harness/procedural";
import { loadProceduralSettings } from "./catalog-files.ts";
import { proceduralStore } from "./procedural-host.ts";

// harness-procedural <history|export|import|revert|dream> <graph> [options]
// Works on the procedural store in --procedural <dir> (the daemon's), through the same
// operations the `procedural` extension serves. Run it while no daemon holds that store:
// one process owns a store file.
const USAGE =
  "usage: harness-procedural history <graph>\n" +
  "       harness-procedural export <graph> [--format json|mermaid] [--revision <id>] [--no-overlay] [--out <file>]\n" +
  "       harness-procedural import <graph> [<graph.json>]   (without a file: the scratch skeleton)\n" +
  "       harness-procedural revert <graph> [--to <revision>]\n" +
  "       harness-procedural dream <graph>\n" +
  "  options: [--procedural <dir>] [--settings <settings.json>] [--preset <name>]\n";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    procedural: { type: "string" },
    settings: { type: "string" },
    preset: { type: "string" },
    format: { type: "string" },
    revision: { type: "string" },
    "no-overlay": { type: "boolean", default: false },
    out: { type: "string" },
    to: { type: "string" },
  },
});
const [command = "", graph, file] = positionals;
const COMMANDS = ["history", "export", "import", "revert", "dream"];
if (!COMMANDS.includes(command) || graph === undefined || (file !== undefined && command !== "import")) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const store = proceduralStore(values.procedural ?? join(homedir(), ".cache", "harness", "procedural"));
const extension = proceduralExtension({
  store,
  settings: values.settings === undefined ? loadProceduralSettings() : loadProceduralSettings(values.settings),
  ...(values.preset === undefined ? {} : { preset: values.preset }),
  clock: { now: () => Date.now() },
});
const optional = (key: string, value: unknown) => (value === undefined ? {} : { [key]: value });
const input = {
  graph,
  ...(command === "export" ? { ...optional("format", values.format), ...optional("revision", values.revision), ...(values["no-overlay"] ? { overlay: false } : {}) } : {}),
  ...(command === "import" && file !== undefined ? { document: JSON.parse(readFileSync(file, "utf8")) as unknown } : {}),
  ...(command === "revert" ? optional("to", values.to) : {}),
};
try {
  const result = (await extension.operations![command]!(input)) as { status?: string; text?: string };
  if (command === "export" && result.status === "ok") {
    if (values.out === undefined) process.stdout.write(result.text!);
    else writeFileSync(values.out, result.text!);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  process.exitCode = ["missing", "invalid", "refused", "unavailable"].includes(result.status ?? "") ? 1 : 0;
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
