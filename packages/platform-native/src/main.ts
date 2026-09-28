#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { gateway } from "@ai-sdk/gateway";
import { compilePack, parseGraph, parseSaeRows } from "@harness/behavior";
import { AgentWorker, EchoWorker, rememberTurns, sessionAgent } from "@harness/workers";
import { workflowTools } from "@harness/workflows";
import type { Worker } from "@harness/workers";
import { modelReflector } from "@harness/procedural";
import type { GraphId } from "@harness/procedural";
import { buildNativeEnsemble } from "./cognitive-host.ts";
import { loadProceduralPolicy, loadProceduralResolver, loadProceduralSettings } from "./catalog-files.ts";
import { FileStorage } from "./file-storage.ts";
import { harnessAdapter, harnessWorker, parseHarnessSpec, parseSandboxSpec, sandboxProvider } from "./harness-host.ts";
import { webSocketToken } from "./ws-token.ts";
import { NodeHost } from "./node-host.ts";
import { hostAuthorizer, nativeDream, nativeLiveLearner, nativeProceduralStep, proceduralStore, snapshotSessions } from "./procedural-host.ts";

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
    procedural: { type: "string" },
    "procedural-settings": { type: "string" },
    "procedural-resolver": { type: "string" },
    "procedural-policy": { type: "string" },
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
      "               [--procedural <dir> [--procedural-settings <settings.json>] [--procedural-resolver <resolver.json>] [--procedural-policy <policy.json>]]\n",
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

// Procedural graphs keep one store in their directory: sessions are guided by the graph the
// resolver names, and the cognitive core serves the operations as `procedural.*`, under the policy.
const principal = userInfo().username;
const proceduralSettings = values.procedural === undefined ? undefined : loadProceduralSettings(values["procedural-settings"]);
const proceduralPolicy = values["procedural-policy"] === undefined ? undefined : loadProceduralPolicy(values["procedural-policy"]);
// The live learner and dream start with the daemon (they read its hook events and session logs); `procedural.feedback` and `procedural.dream` reach them then.
// The host opens the store once: the cognitive core's operations, the step hook, the learner and dream share it.
const live: { learner?: ReturnType<typeof nativeLiveLearner>; dream?: ReturnType<typeof nativeDream> } = {};
const proceduralFiles = values.procedural === undefined ? undefined : proceduralStore(values.procedural);
const cognitive =
  values.cognitive || values.worker === "ensemble"
    ? buildNativeEnsemble({
        cacheDir: values["model-cache"] ?? join(homedir(), ".cache", "harness", "models"),
        allowHosted: !values["no-hosted"],
        ...(values["llama-server"] === undefined ? {} : { llamaServer: values["llama-server"] }),
        ...(behavior ? { behavior } : {}),
        ...(memoryFile ? { memory: { ...(saved === undefined ? {} : { saved }), persist: (s: unknown) => void memoryFile.save(s) } } : {}),
        ...(values.workflows === undefined ? {} : { workflows: { dir: values.workflows } }),
        ...(values.procedural === undefined ? {} : {
              procedural: {
                dir: values.procedural,
                store: proceduralFiles!,
                settings: proceduralSettings!,
                authorize: hostAuthorizer(proceduralPolicy, principal),
                feedback: async (session: string, turn: string, score: number) => live.learner?.learner.feedback(session, turn, score),
                dream: async (graph: GraphId) => live.dream?.(graph),
              },
            }),
        ...(learningFile ? { learning: { ...(learned === undefined ? {} : { saved: learned }), persist: (s: unknown) => void learningFile.save(s) } } : {}),
      })
    : undefined;
const procedural = proceduralFiles && { store: proceduralFiles, settings: proceduralSettings! };
// The generator dream refines with and live reflection (when a preset turns it on) reflects with:
// the ensemble's reasoning model, or else the gateway model.
const generator = procedural && (cognitive?.ensemble.languageModel("reasoning") ?? gateway(values.model));
// Agent workers are guided by their session's own model; a harness is guided once per turn, by the ensemble's chat model or the gateway model.
const step =
  procedural &&
  nativeProceduralStep({
    ...procedural,
    resolver: loadProceduralResolver(values["procedural-resolver"]),
    principal,
    ...(proceduralPolicy === undefined ? {} : { policy: proceduralPolicy }),
    ...(values.harness === undefined ? {} : { model: cognitive?.ensemble.languageModel("chat") ?? gateway(values.model) }),
  });
const instructions = values.system === undefined ? {} : { instructions: values.system };
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
        ...(step ? { step } : {}),
      });
// The model worker runs an AI SDK agent on a gateway model; the ensemble worker runs one
// on the ensemble (the steered kernel with a behavior pack), with memory and learning.
const worker: Worker = harness
  ? harness.worker
  : values.worker === "model"
    ? new AgentWorker({ agent: sessionAgent({ model: gateway(values.model), ...instructions, ...(step ? { step } : {}) }) })
    : values.worker === "ensemble"
      ? new AgentWorker({
          agent: sessionAgent({
            model: cognitive!.ensemble.languageModel(behavior ? "steered-chat" : "chat"),
            vision: cognitive!.ensemble.languageModel("vision-qa"),
            ...instructions,
            ...(step ? { step } : {}),
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

const host = await NodeHost.start({
  worker,
  identity: { principal, kind: "human" },
  ...(cognitive ? { cognitive: cognitive.ensemble } : {}),
  ...(values.state === undefined ? {} : { statePath: values.state }),
});

if (procedural && generator) {
  live.learner = nativeLiveLearner({ runtime: host.runtime, ...procedural, reflect: modelReflector({ model: generator, settings: procedural.settings }), log: (message) => void process.stderr.write(`${message}\n`) });
  // Dream refines with the generator, on trajectories from the daemon's session logs.
  live.dream = nativeDream({ ...procedural, model: generator, sessions: async () => snapshotSessions(host.daemon.snapshot()) });
}

const shutdown = async () => {
  live.learner?.close();
  await host.close();
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
