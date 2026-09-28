#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gateway } from "@ai-sdk/gateway";
import { approvalInbox, proceduralExtension } from "@harness/procedural";
import { askModel } from "@harness/workflows";
import { loadProceduralComposition, loadProceduralSettings, loadTaskSuite } from "./catalog-files.ts";
import { buildNativeEnsemble } from "./cognitive-host.ts";
import { FileStorage } from "./file-storage.ts";
import { invokeDaemon } from "./daemon-link.ts";
import { nativeComposition, nativeDream, nativePlanRunner, nativeTaskEvaluator, proceduralStore, snapshotSessions, terminalApprover } from "./procedural-host.ts";
import { lockStore } from "./store-lock.ts";

// harness-procedural <history|export|import|revert|dream|approvals> <graph> [options]
// harness-procedural <approve|decline> <graph> <candidate> [options]
// harness-procedural plan <graph> <from> <to> [--run] [options]
// Works on the procedural store in --procedural <dir> (the daemon's), through the same
// operations the `procedural` extension serves. One process owns a store file: this CLI
// takes the directory's lock and opens the store itself, or, when a daemon holds the
// lock and listens on a socket, sends the operation to that daemon.
const USAGE =
  "usage: harness-procedural history <graph>\n" +
  "       harness-procedural export <graph> [--format json|mermaid] [--revision <id>] [--no-overlay] [--out <file>]\n" +
  "       harness-procedural import <graph> [<graph.json>]   (without a file: the scratch skeleton)\n" +
  "       harness-procedural revert <graph> [--to <revision>]\n" +
  "       harness-procedural dream <graph> [--model <gateway id> | --model-cache <dir> [--llama-server <path>] [--no-hosted]] [--state <daemon state file>]\n" +
  "                                [--procedural-eval <tasks.json>]\n" +
  "         (refines with the gateway model, or else the ensemble's reasoning model; trajectories from the\n" +
  "          daemon's saved session logs; asks for approval on a terminal, and otherwise leaves the\n" +
  "          candidate in the approvals inbox; gates on the task suite, solved by the gateway model or\n" +
  "          else the ensemble's chat model, and judged by the catalog's judge)\n" +
  "       harness-procedural approvals <graph>                (the candidates waiting for approval)\n" +
  "       harness-procedural approve <graph> <candidate>      (commit it on the head, if its gates pass there)\n" +
  "       harness-procedural decline <graph> <candidate>\n" +
  "       harness-procedural plan <graph> <from> <to> [--run [--model <gateway id> | --model-cache <dir> [--llama-server <path>] [--no-hosted]]]\n" +
  "         (the plan between two nodes of the graph's head and overlay; with --run, runs it: each task on the gateway\n" +
  "          model or else the ensemble's chat model, calling the workflows the head binds, as this CLI has no session\n" +
  "          tools; the run is kept in the directory while it runs, and a daemon started there resumes one left behind)\n" +
  "  options: [--procedural <dir>] [--settings <settings.json>] [--preset <name>]\n" +
  "  (when a daemon holds <dir> and serves procedural operations with --socket and --cognitive, the command runs in that daemon, with its settings and models)\n";

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
    "procedural-eval": { type: "string" },
    run: { type: "boolean", default: false },
  },
});
// The second positional is the graph; the third is import's file, for approve and decline the candidate's revision id,
// and for plan the node it starts from, with the node it goes to fourth.
const [command = "", graph, file, to] = positionals;
const COMMANDS = ["history", "export", "import", "revert", "dream", "approvals", "approve", "decline", "plan"];
const decides = command === "approve" || command === "decline";
const plans = command === "plan";
const arity = plans ? positionals.length === 4 : positionals.length <= 3 && (decides ? file !== undefined : file === undefined || command === "import");
if (!COMMANDS.includes(command) || graph === undefined || !arity || (values.run && !plans)) {
  process.stderr.write(USAGE);
  process.exit(2);
}

// The task suite dream gates on: the CLI has no workflow library to offer tools from, and judges only with the ensemble.
let taskSuite: ReturnType<typeof loadTaskSuite> | undefined;
try {
  taskSuite = values["procedural-eval"] === undefined || command !== "dream" ? undefined : loadTaskSuite(values["procedural-eval"]);
} catch (e) {
  process.stderr.write(`--procedural-eval ${values["procedural-eval"]}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
if (taskSuite?.tools !== undefined && taskSuite.tools.length > 0) {
  process.stderr.write("the task suite names tools, and harness-procedural offers none: run the dream in the daemon (--cognitive --workflows <dir>)\n");
  process.exit(2);
}
if (taskSuite?.scorer === "judge" && values.model !== undefined) {
  process.stderr.write("the task suite's judge scorer needs the catalog's judge: leave out --model to use the ensemble\n");
  process.exit(2);
}

const dir = values.procedural ?? join(homedir(), ".cache", "harness", "procedural");
const optional = (key: string, value: unknown) => (value === undefined ? {} : { [key]: value });
// `plan --run` is the `run` operation on the plan between the two nodes.
const operation = plans && values.run ? "run" : command;
const input = decides
  ? { graph, candidate: file }
  : plans
    ? { graph, from: file, to }
    : {
      graph,
      ...(command === "export" ? { ...optional("format", values.format), ...optional("revision", values.revision), ...(values["no-overlay"] ? { overlay: false } : {}) } : {}),
      ...(command === "import" && file !== undefined ? { document: JSON.parse(readFileSync(file, "utf8")) as unknown } : {}),
      ...(command === "revert" ? optional("to", values.to) : {}),
    };

type Result = { status?: string; text?: string; result?: { status?: string } };

/** Print a result; one the caller handles (a dream that could not run included) exits 1. */
function report(result: Result): void {
  if (command === "export" && result.status === "ok") {
    if (values.out === undefined) process.stdout.write(result.text!);
    else writeFileSync(values.out, result.text!);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  // A dream that could not run (another holds the lease, no head, the lease lost), or a plan run that failed, is a result the caller handles too.
  const handled = ["missing", "invalid", "refused", "unavailable"].includes(result.status ?? "") || (command === "dream" && result.result?.status !== "done") || (operation === "run" && result.status === "failed");
  process.exitCode = handled ? 1 : 0;
}

function fail(e: unknown): void {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}

// One process owns a store file. With the lock, this CLI opens the store itself; when a
// daemon holds it and serves ACP on a socket, the operation goes to that daemon (its
// `procedural.*` operations, under its policy and with its own models and settings).
const lock = await lockStore(dir, "harness-procedural");
if (lock.status === "held") {
  const { holder, pid, socket } = lock.owner;
  if (socket === undefined) {
    // Another run of this CLI finishes on its own; a daemon serves the operations only with a socket and a cognitive core.
    const advice = holder === "harness-procedural" ? "; wait for it to finish" : ", which serves no procedural operations on a socket: stop it, or run it with --socket and --cognitive";
    process.stderr.write(`the procedural store in ${dir} is in use by ${holder} (pid ${pid})${advice}\n`);
    process.exit(1);
  }
  const local = ["settings", "preset", "model", "model-cache", "llama-server", "state", "procedural-eval"].filter((name) => values[name as keyof typeof values] !== undefined);
  if (values["no-hosted"]) local.push("no-hosted");
  if (local.length > 0) process.stderr.write(`${holder} (pid ${pid}) holds ${dir}: sending ${command} to it on ${socket}, which runs it with its own settings and models (ignoring --${local.join(", --")})\n`);
  try {
    report((await invokeDaemon(socket, `procedural.${operation}`, input)) as Result);
  } catch (e) {
    fail(e);
  }
} else {
  try {
    await runHere();
  } finally {
    await lock.lock.release();
  }
}

/** Run the operation on the store in the directory, which this process holds the lock on. */
async function runHere(): Promise<void> {
  const store = proceduralStore(dir);
  const settings = values.settings === undefined ? loadProceduralSettings() : loadProceduralSettings(values.settings);
  const preset = values.preset === undefined ? {} : { preset: values.preset };
  // Dream refines with the --model gateway model, or else the ensemble's reasoning model (which
  // loads only when the refiner is asked). Its trajectories come from the daemon's saved session
  // logs when --state names them, and on a terminal a candidate that needs approval is asked about.
  // A plan run's tasks run on the --model gateway model, or else the ensemble's chat model.
  const cognitive =
    (command === "dream" || operation === "run") && values.model === undefined
      ? buildNativeEnsemble({
          cacheDir: values["model-cache"] ?? join(homedir(), ".cache", "harness", "models"),
          allowHosted: !values["no-hosted"],
          ...(values["llama-server"] === undefined ? {} : { llamaServer: values["llama-server"] }),
        })
      : undefined;
  const model = values.model === undefined ? cognitive?.ensemble.languageModel("reasoning") : gateway(values.model);
  const state = values.state;
  const evaluator =
    taskSuite &&
    model &&
    nativeTaskEvaluator({
      suite: taskSuite,
      settings,
      ...preset,
      model: values.model === undefined ? cognitive!.ensemble.languageModel("chat") : gateway(values.model),
      ...(cognitive === undefined ? {} : { judge: async () => (await cognitive.ensemble.resolve("judgment", "judge")).port }),
    });
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
          ...(evaluator ? { evaluator, ...(taskSuite?.description === undefined ? {} : { task: taskSuite.description }) } : {}),
          // Without a terminal, a candidate that needs approval waits in the inbox (`approvals`, `approve`, `decline`).
          ...(process.stdin.isTTY
            ? { approver: terminalApprover(process.stdin, process.stderr) }
            : { inbox: approvalInbox(({ payload }) => void process.stderr.write(`candidate ${payload.candidate} of graph ${payload.graph} waits for approval\n`)) }),
        });
  // A plan run calls the workflows the graph's head binds, staged in the directory: this CLI has no session tools.
  // It is kept in the directory while it runs; a daemon started there resumes one this CLI left behind.
  const runner = () => {
    const tasks = values.model === undefined ? cognitive!.ensemble.languageModel("chat") : gateway(values.model);
    const staged = nativeComposition({ dir, settings: loadProceduralComposition(), step: { core: async () => undefined }, ask: askModel(tasks) });
    return nativePlanRunner({ dir, store, settings, model: tasks, tools: (context) => staged.planTools(context.view?.core) });
  };
  const extension = proceduralExtension({ store, settings, ...preset, clock: { now: () => Date.now() }, ...(dream === undefined ? {} : { dream }), ...(operation === "run" ? { plans: runner() } : {}) });
  try {
    report((await extension.operations![operation]!(input)) as Result);
  } catch (e) {
    fail(e);
  } finally {
    await cognitive?.close();
  }
}
