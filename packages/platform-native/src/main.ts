#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gateway } from "@ai-sdk/gateway";
import { wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";
import { compilePack, parseGraph, parseSaeRows } from "@harness/behavior";
import { AgentWorker, dialogueMiddleware, DialogueWorker, EchoWorker, rememberTurns, sessionAgent } from "@harness/workers";
import { askModel, workflowTools } from "@harness/workflows";
import type { Worker } from "@harness/workers";
import { buildDialogue, buildNativeEnsemble, dialogueFlows } from "./cognitive-host.ts";
import { Ensemble } from "@harness/cognitive";
import { dialogueExtension, dialogueSaves } from "@harness/dialogue";
import { documentImporter } from "@harness/dialogue-standards";
import { FileStorage } from "./file-storage.ts";
import { harnessAdapter, harnessWorker, parseHarnessSpec, parseSandboxSpec, sandboxProvider } from "./harness-host.ts";
import { webSocketToken } from "./ws-token.ts";
import { NodeHost } from "./node-host.ts";

const { values } = parseArgs({
  options: {
    stdio: { type: "boolean", default: false },
    socket: { type: "string" },
    state: { type: "string" },
    worker: { type: "string", default: "echo" },
    model: { type: "string", default: "openai/gpt-oss-20b" },
    system: { type: "string" },
    cognitive: { type: "boolean", default: false },
    "llama-server": { type: "string" },
    "model-cache": { type: "string" },
    "no-hosted": { type: "boolean", default: false },
    behavior: { type: "string" },
    "sae-rows": { type: "string" },
    memory: { type: "string" },
    learning: { type: "string" },
    workflows: { type: "string" },
    dialogue: { type: "string" },
    "dialogue-flows": { type: "string" },
    "dialogue-grace": { type: "string", default: "5000" },
    harness: { type: "string" },
    consult: { type: "string" },
    "harness-state": { type: "string" },
    sandboxes: { type: "string" },
    sandbox: { type: "string", default: "host" },
    ws: { type: "string" },
    "ws-token-file": { type: "string" },
    "ws-origin": { type: "string", multiple: true },
    "sandbox-setup": { type: "string" },
    "sandbox-env": { type: "string", multiple: true },
  },
});

if (!values.stdio && values.socket === undefined && values.ws === undefined) {
  process.stderr.write(
    "usage: harness (--stdio | --socket <path> | --ws <port> [--ws-token-file <file>] [--ws-origin <origin>]...) [--state <file>] [--worker echo|model|ensemble|harness] [--model <gateway id>]\n" +
      "               [--harness claude-code|codex|acp:<package>@<version>:<executable> [--harness-state <file>]\n" +
      "                 [--sandbox host|docker:<image> [--sandbox-setup <command>] [--sandbox-env <NAME>]...] [--sandboxes <dir>]]\n" +
      "               [--cognitive [--llama-server <path>] [--model-cache <dir>] [--no-hosted]\n" +
      "                            [--behavior <graph.json> --sae-rows <rows.json>] [--memory <file> [--learning <file>]] [--workflows <dir>]\n" +
      "                            [--consult <gateway id>]]\n" +
      "               [--dialogue <file> [--dialogue-flows <dir>] [--dialogue-grace <ms>]]\n",
  );
  process.exit(2);
}

if ((values.behavior === undefined) !== (values["sae-rows"] === undefined)) {
  process.stderr.write("--behavior and --sae-rows go together: a graph names SAE features, the rows file carries them\n");
  process.exit(2);
}
// The steerable kernel's behavior graph, compiled against the SAE rows it names.
const behavior =
  values.behavior === undefined
    ? undefined
    : compilePack(parseGraph(JSON.parse(readFileSync(values.behavior, "utf8"))), parseSaeRows(readFileSync(values["sae-rows"]!, "utf8")));

if (values.learning !== undefined && values.memory === undefined) {
  process.stderr.write("--learning needs --memory: lessons are found by meaning in memory\n");
  process.exit(2);
}
// Memory and learning are extensions of the cognitive core, each persisted to its own file.
const memoryFile = values.memory === undefined ? undefined : new FileStorage(values.memory);
const saved = await memoryFile?.load();
const learningFile = values.learning === undefined ? undefined : new FileStorage(values.learning);
const learned = await learningFile?.load();

const cognitive =
  values.cognitive || values.worker === "ensemble"
    ? buildNativeEnsemble({
        cacheDir: values["model-cache"] ?? join(homedir(), ".cache", "harness", "models"),
        allowHosted: !values["no-hosted"],
        ...(values["llama-server"] === undefined ? {} : { llamaServer: values["llama-server"] }),
        ...(behavior ? { behavior } : {}),
        ...(memoryFile ? { memory: { ...(saved === undefined ? {} : { saved }), persist: (s: unknown) => void memoryFile.save(s) } } : {}),
        ...(values.workflows === undefined ? {} : { workflows: { dir: values.workflows } }),
        ...(learningFile ? { learning: { ...(learned === undefined ? {} : { saved: learned }), persist: (s: unknown) => void learningFile.save(s) } } : {}),
      })
    : undefined;
const instructions = values.system === undefined ? {} : { instructions: values.system };
// A scripted dialogue in front of the session model (ADR 0011): scripts answer what they
// can, the model the rest, and scripts are built from the model's answers. Saved to its file.
// Its flows are durable workflows: the workflow library's (--workflows), else files in
// --dialogue-flows (by default next to the book), with their run journals.
// At shutdown, learning under way gets --dialogue-grace milliseconds to land in the book.
const dialogueGrace = Number(values["dialogue-grace"]);
// setTimeout takes at most 2^31 - 1 milliseconds (and takes a longer delay as 1).
if (!/^\d+$/.test(values["dialogue-grace"]) || dialogueGrace > 2_147_483_647) {
  process.stderr.write("--dialogue-grace is a whole number of milliseconds, at most 2147483647\n");
  process.exit(2);
}
const dialogueFile = values.dialogue === undefined ? undefined : new FileStorage(values.dialogue);
const flows =
  values.dialogue === undefined
    ? undefined
    : (cognitive?.workflowHost ??
      dialogueFlows({ dir: values["dialogue-flows"] ?? `${values.dialogue}.flows`, ask: askModel(cognitive ? cognitive.ensemble.languageModel() : gateway(values.model)) }));
const book = await dialogueFile?.load();
// A model the dialogue could not use, or a save that failed, is logged; the model answers the step instead.
const dialogueError = (e: unknown) => void process.stderr.write(`dialogue: ${e instanceof Error ? e.message : String(e)}\n`);
const dialogueSaved = dialogueFile && dialogueSaves(dialogueFile, dialogueError);
// The host the dialogue's events go to, once it is running.
const running: { host?: NodeHost } = {};
const dialogue =
  dialogueSaved &&
  buildDialogue({
    ...(cognitive ? { ensemble: cognitive.ensemble, embeddings: cognitive.memory !== undefined } : { drafter: gateway(values.model) }),
    ...(book === undefined ? {} : { book }),
    ...(flows ? { flows } : {}),
    persist: dialogueSaved.persist,
    onError: dialogueError,
    // What happens to the book (scripts built, promoted, retired; documents put) goes to plugins on the hook bus.
    onEvent: (event) => running.host?.runtime.publish(event),
  });
const scripted = (model: Exclude<LanguageModel, string>) => (dialogue ? wrapLanguageModel({ model, middleware: dialogueMiddleware(dialogue) }) : model);
if ((values.worker === "harness") !== (values.harness !== undefined)) {
  process.stderr.write("--worker harness and --harness go together: the harness names the agent that runs sessions\n");
  process.exit(2);
}
// The harness worker runs each session on an AI SDK harness (Claude Code, Codex, an ACP
// agent), in a sandbox of its own (this machine's, or a Docker container each); parked
// sessions resume after a restart. `--sandbox-env` passes this process's variables in.
const harness =
  values.harness === undefined
    ? undefined
    : harnessWorker({
        harness: harnessAdapter(parseHarnessSpec(values.harness)),
        sandbox: sandboxProvider(parseSandboxSpec(values.sandbox), {
          root: values.sandboxes ?? join(homedir(), ".cache", "harness", "sandboxes"),
          ...(values["sandbox-setup"] === undefined ? {} : { setup: values["sandbox-setup"] }),
          env: Object.fromEntries((values["sandbox-env"] ?? []).flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]!]]))),
        }),
        stateFile: values["harness-state"] ?? join(homedir(), ".cache", "harness", "harness-sessions.json"),
        ...instructions,
      });
// The model worker runs an AI SDK agent on a gateway model; the ensemble worker runs one
// on the ensemble (the steered kernel with a behavior pack), with memory and learning.
const sessions: Worker = harness
  ? harness.worker
  : values.worker === "model"
    ? new AgentWorker({ agent: sessionAgent({ model: scripted(gateway(values.model)), ...instructions }) })
    : values.worker === "ensemble"
      ? new AgentWorker({
          agent: sessionAgent({
            model: scripted(cognitive!.ensemble.languageModel(behavior ? "steered-chat" : "chat")),
            vision: cognitive!.ensemble.languageModel("vision-qa"),
            ...instructions,
            ...(cognitive!.memory ? { memory: cognitive!.memory } : {}),
            ...(cognitive!.learning ? { learning: cognitive!.learning } : {}),
            // A larger hosted model's notes on each request, as reference for the local kernel.
            ...(values.consult === undefined ? {} : { consult: gateway(values.consult) }),
            // The workflow library's workflows are durable tools, looked up each turn as learning adds to them.
            ...(cognitive!.workflowHost ? { tools: () => workflowTools(cognitive!.workflowHost!) } : {}),
          }),
          ...(cognitive!.memory ? { onTurn: rememberTurns(cognitive!.memory) } : {}),
          // Plugins' behavior events (`_harness/behavior/event`) go to the session's behavior state.
          ...(behavior ? { onEvent: (sessionId: string, name: string) => cognitive!.raiseBehavior(sessionId, name) } : {}),
        })
      : new EchoWorker();
// With the model and ensemble workers the dialogue sits in front of the model (it can
// constrain a template's holes); with the others, whose models it cannot reach (an external
// harness, the echo worker), in front of the worker.
const worker: Worker = dialogue && (harness || (values.worker !== "model" && values.worker !== "ensemble")) ? new DialogueWorker(sessions, dialogue, { handoff: values.worker !== "echo" }) : sessions;

// The dialogue is managed over ACP as the `dialogue` cognitive extension (status, list, get, put,
// feedback, import), on the ensemble when there is one, else on an ensemble of its own.
const ensemble = cognitive?.ensemble ?? (dialogue ? new Ensemble({ platform: "native" }) : undefined);
if (dialogue) ensemble!.install(dialogueExtension({ dialogue, importer: documentImporter(flows!.library) }));
const host = await NodeHost.start({
  worker,
  identity: { principal: userInfo().username, kind: "human" },
  ...(ensemble ? { cognitive: ensemble } : {}),
  ...(values.state === undefined ? {} : { statePath: values.state }),
});
running.host = host;

const shutdown = async () => {
  // Learning under way (a drafter's answer among it) gets the grace (--dialogue-grace) to land in the
  // book while the host still runs, so what it publishes on the hook bus is saved with the state.
  if (dialogue) await Promise.race([dialogue.idle(), new Promise((r) => setTimeout(r, dialogueGrace).unref())]);
  delete running.host;
  await host.close();
  await dialogueSaved?.settled();
  await harness?.close();
  await cognitive?.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

if (values.stdio) {
  // Editors launch ACP agents as child processes; stdout carries protocol frames only.
  host.attach(process.stdin, process.stdout, () => {});
  process.stdin.on("end", () => void shutdown());
}
if (values.socket !== undefined) {
  await host.listen(values.socket);
  process.stderr.write(`harness listening on ${values.socket}\n`);
}
if (values.ws !== undefined) {
  const port = Number(values.ws);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`--ws takes a port number (0 for any free one), not "${values.ws}"\n`);
    process.exit(2);
  }
  // Clients on this machine read the token from its file; browser pages need their origin allowed.
  const tokenFile = values["ws-token-file"] ?? join(homedir(), ".cache", "harness", "ws-token");
  const { url } = await host.listenWebSocket({ port, token: await webSocketToken(tokenFile), origins: values["ws-origin"] ?? [] });
  process.stderr.write(`harness listening on ${url} (token in ${tokenFile})\n`);
}
