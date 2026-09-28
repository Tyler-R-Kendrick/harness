#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gateway } from "@ai-sdk/gateway";
import { proceduralExtension } from "@harness/procedural";
import { loadProceduralSettings } from "./catalog-files.ts";
import { buildNativeEnsemble } from "./cognitive-host.ts";
import { FileStorage } from "./file-storage.ts";
import { nativeDream, proceduralStore, snapshotSessions, terminalApprover } from "./procedural-host.ts";

// harness-procedural <history|export|import|revert|dream> <graph> [options]
// Works on the procedural store in --procedural <dir> (the daemon's), through the same
// operations the `procedural` extension serves. Run it while no daemon holds that store:
// one process owns a store file.
const USAGE =
  "usage: harness-procedural history <graph>\n" +
  "       harness-procedural export <graph> [--format json|mermaid] [--revision <id>] [--no-overlay] [--out <file>]\n" +
  "       harness-procedural import <graph> [<graph.json>]   (without a file: the scratch skeleton)\n" +
  "       harness-procedural revert <graph> [--to <revision>]\n" +
  "       harness-procedural dream <graph> [--model <gateway id> | --model-cache <dir> [--llama-server <path>] [--no-hosted]] [--state <daemon state file>]\n" +
  "         (refines with the gateway model, or else the ensemble's reasoning model; trajectories from the\n" +
  "          daemon's saved session logs; asks for approval on a terminal)\n" +
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
    model: { type: "string" },
    state: { type: "string" },
    "model-cache": { type: "string" },
    "llama-server": { type: "string" },
    "no-hosted": { type: "boolean", default: false },
  },
});
const [command = "", graph, file] = positionals;
const COMMANDS = ["history", "export", "import", "revert", "dream"];
if (!COMMANDS.includes(command) || graph === undefined || (file !== undefined && command !== "import")) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const store = proceduralStore(values.procedural ?? join(homedir(), ".cache", "harness", "procedural"));
const settings = values.settings === undefined ? loadProceduralSettings() : loadProceduralSettings(values.settings);
const preset = values.preset === undefined ? {} : { preset: values.preset };
// Dream refines with the --model gateway model, or else the ensemble's reasoning model (which
// loads only when the refiner is asked). Its trajectories come from the daemon's saved session
// logs when --state names them, and on a terminal a candidate that needs approval is asked about.
const cognitive =
  command === "dream" && values.model === undefined
    ? buildNativeEnsemble({
        cacheDir: values["model-cache"] ?? join(homedir(), ".cache", "harness", "models"),
        allowHosted: !values["no-hosted"],
        ...(values["llama-server"] === undefined ? {} : { llamaServer: values["llama-server"] }),
      })
    : undefined;
const model = values.model === undefined ? cognitive?.ensemble.languageModel("reasoning") : gateway(values.model);
const state = values.state;
const dream =
  command !== "dream" || model === undefined
    ? undefined
    : nativeDream({
        store,
        settings,
        ...preset,
        model,
        sessions: async () => snapshotSessions(state === undefined ? undefined : await new FileStorage(state).load()),
        holder: "harness-procedural",
        ...(process.stdin.isTTY ? { approver: terminalApprover(process.stdin, process.stderr) } : {}),
      });
const extension = proceduralExtension({ store, settings, ...preset, clock: { now: () => Date.now() }, ...(dream === undefined ? {} : { dream }) });

const optional = (key: string, value: unknown) => (value === undefined ? {} : { [key]: value });
const input = {
  graph,
  ...(command === "export" ? { ...optional("format", values.format), ...optional("revision", values.revision), ...(values["no-overlay"] ? { overlay: false } : {}) } : {}),
  ...(command === "import" && file !== undefined ? { document: JSON.parse(readFileSync(file, "utf8")) as unknown } : {}),
  ...(command === "revert" ? optional("to", values.to) : {}),
};
try {
  const result = (await extension.operations![command]!(input)) as { status?: string; text?: string; result?: { status?: string } };
  if (command === "export" && result.status === "ok") {
    if (values.out === undefined) process.stdout.write(result.text!);
    else writeFileSync(values.out, result.text!);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  // A dream that could not run (another holds the lease, no head, the lease lost) is a result the caller handles too.
  const handled = ["missing", "invalid", "refused", "unavailable"].includes(result.status ?? "") || (command === "dream" && result.result?.status !== "done");
  process.exitCode = handled ? 1 : 0;
} catch (e) {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
} finally {
  await cognitive?.close();
}
