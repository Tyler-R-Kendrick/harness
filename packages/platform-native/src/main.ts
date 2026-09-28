#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gateway } from "@ai-sdk/gateway";
import { wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";
import { compilePack, parseGraph, parseSaeRows } from "@harness/behavior";
import { AgentWorker, dialogueMiddleware, DialogueWorker, EchoWorker, rememberTurns, sessionAgent } from "@harness/workers";
import { askModel, workflowTools } from "@harness/workflows";
import type { Worker } from "@harness/workers";
import { approvalInbox, exclusiveDream, modelReflector } from "@harness/procedural";
import type { ApprovalNotice, GraphId, PlanNotice, PlanRunner } from "@harness/procedural";
import { buildDialogue, buildNativeEnsemble, dialogueFlows } from "./cognitive-host.ts";
import { loadProceduralComposition, loadProceduralPolicy, loadProceduralResolver, loadProceduralSettings, loadTaskSuite } from "./catalog-files.ts";
import { Ensemble } from "@harness/cognitive";
import { dialogueExtension, dialogueSaves } from "@harness/dialogue";
import { documentImporter } from "@harness/dialogue-standards";
import { conversationsDir, fileConversations, FileStorage } from "./file-storage.ts";
import { harnessAdapter, harnessWorker, parseHarnessSpec, parseSandboxSpec, sandboxProvider } from "./harness-host.ts";
import { webSocketToken } from "./ws-token.ts";
import { NodeHost } from "./node-host.ts";
import {
  daemonSessions,
  describePlanRun,
  hookNotifier,
  hostAuthorizer,
  nativeComposition,
  nativeDream,
  nativeDreamSchedule,
  nativeLiveLearner,
  nativePlanRunner,
  nativeProceduralStep,
  nativeStepEvictions,
  nativeTaskEvaluator,
  proceduralStore,
} from "./procedural-host.ts";
import { lockStore } from "./store-lock.ts";

const { values } = parseArgs({
  options: {
    stdio: { type: "boolean", default: false },
    socket: { type: "string" },
    state: { type: "string" },
    conversations: { type: "string" },
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
    "procedural-composition": { type: "string" },
    "procedural-eval": { type: "string" },
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
    "usage: harness (--stdio | --socket <path> | --ws <port> [--ws-token-file <file>] [--ws-origin <origin>]...) [--state <file>] [--conversations <dir>]\n" +
      "               [--worker echo|model|ensemble|harness] [--model <gateway id>]\n" +
      "               [--harness claude-code|codex|acp:<package>@<version>:<executable> [--harness-state <file>]\n" +
      "                 [--sandbox host|docker:<image> [--sandbox-setup <command>] [--sandbox-env <NAME>]...] [--sandboxes <dir>]]\n" +
      "               [--cognitive [--llama-server <path>] [--model-cache <dir>] [--no-hosted]\n" +
      "                            [--behavior <graph.json> --sae-rows <rows.json>] [--memory <file> [--learning <file>]] [--workflows <dir>]\n" +
      "                            [--consult <gateway id>]]\n" +
      "               [--procedural <dir> [--procedural-settings <settings.json>] [--procedural-resolver <resolver.json>] [--procedural-policy <policy.json>]\n" +
      "                                 [--procedural-eval <tasks.json>] [--procedural-composition <composition.json>]]\n" +
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

// Dream's evaluator: a user's task suite, run on the session model guided by each candidate graph.
if (values["procedural-eval"] !== undefined && values.procedural === undefined) {
  process.stderr.write("--procedural-eval needs --procedural: the task suite scores that directory's graphs when they dream\n");
  process.exit(2);
}
let taskSuite: ReturnType<typeof loadTaskSuite> | undefined;
try {
  taskSuite = values["procedural-eval"] === undefined ? undefined : loadTaskSuite(values["procedural-eval"]);
} catch (e) {
  process.stderr.write(`--procedural-eval ${values["procedural-eval"]}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
if (taskSuite?.scorer === "judge" && !values.cognitive && values.worker !== "ensemble") {
  process.stderr.write("the task suite's judge scorer needs --cognitive: the catalog's judge scores the answers\n");
  process.exit(2);
}
if (taskSuite?.tools !== undefined && taskSuite.tools.length > 0 && (values.workflows === undefined || (!values.cognitive && values.worker !== "ensemble"))) {
  process.stderr.write("the task suite names tools, and this host offers only its workflow library's (--cognitive --workflows <dir>)\n");
  process.exit(2);
}

// Procedural graphs keep one store in their directory: sessions are guided by the graph the
// resolver names, and the cognitive core serves the operations as `procedural.*`, under the policy.
const principal = userInfo().username;
const proceduralSettings = values.procedural === undefined ? undefined : loadProceduralSettings(values["procedural-settings"]);
const proceduralPolicy = values["procedural-policy"] === undefined ? undefined : loadProceduralPolicy(values["procedural-policy"]);
// The live learner and dream start with the daemon (they read its hook events and session logs); `procedural.feedback` and `procedural.dream` reach them then.
// The approvals inbox announces proposals and decisions on the daemon's hook bus, once it is up.
// The host opens the store once: the cognitive core's operations, the step hook, the learner and dream share it.
// Plan runs (`procedural.run`) start with the daemon too: the runner needs the session model and tools, made below.
const live: {
  learner?: ReturnType<typeof nativeLiveLearner>;
  dream?: ReturnType<typeof nativeDream>;
  schedule?: ReturnType<typeof nativeDreamSchedule>;
  plans?: PlanRunner;
  notify?: (notice: ApprovalNotice | PlanNotice) => void;
} = {};
const notify = (notice: ApprovalNotice | PlanNotice) => live.notify?.(notice);
// One process owns a store file: the daemon holds the directory's lock while it runs, and
// refuses to start while another process (another daemon, or harness-procedural) holds it.
// A CLI that finds it held sends its operations to this daemon's socket instead.
const proceduralLock = values.procedural === undefined ? undefined : await lockStore(values.procedural, "harness");
if (proceduralLock?.status === "held") {
  const { holder, pid } = proceduralLock.owner;
  process.stderr.write(`the procedural store in ${values.procedural} is in use by ${holder} (pid ${pid}); stop it first\n`);
  process.exit(1);
}
const storeLock = proceduralLock?.lock;
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
                notify,
                // Set below, before the daemon serves anything.
                plans: { run: (graph, plan) => live.plans!.run(graph, plan) },
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
// A resolver rule that routes asks the ensemble's tool router; without the cognitive core such a session has no graph.
const step =
  procedural &&
  nativeProceduralStep({
    ...procedural,
    resolver: loadProceduralResolver(values["procedural-resolver"]),
    principal,
    ...(proceduralPolicy === undefined ? {} : { policy: proceduralPolicy }),
    ...(values.harness === undefined ? {} : { model: cognitive?.ensemble.languageModel("chat") ?? gateway(values.model) }),
    ...(cognitive ? { router: cognitive.ensemble.languageModel("tool-calling", "router") } : {}),
  });
// Composition (agent workers): dream compiles well-trodden paths into workflows staged in the procedural
// directory (never the shared --workflows library), with the session tools as its catalog, and each session
// is offered its tools plus exactly the workflows its pinned core binds. The ensemble worker's tools are the
// shared library's workflows; the model worker has none of its own.
const composition =
  step && (values.worker === "model" || values.worker === "ensemble")
    ? nativeComposition({
        dir: values.procedural!,
        settings: loadProceduralComposition(values["procedural-composition"]),
        step,
        ask: askModel(cognitive?.ensemble.languageModel() ?? gateway(values.model)),
        base: async () => (values.worker === "ensemble" && cognitive?.workflowHost ? workflowTools(cognitive.workflowHost) : {}),
        ...(values.workflows === undefined ? {} : { shared: values.workflows }),
      })
    : undefined;
// Plans run on the session model (the ensemble's chat model, or else the gateway model), their tasks calling the
// session tools plus the workflows the graph's head binds. Runs under way are kept in the procedural directory
// (plan-runs.json), and the daemon resumes any that a stopped daemon left once it is up.
if (procedural && cognitive) {
  const workflowBase = cognitive.workflowHost ? () => workflowTools(cognitive.workflowHost!) : () => ({});
  live.plans = nativePlanRunner({
    dir: values.procedural!,
    ...procedural,
    model: cognitive.ensemble.languageModel("chat"),
    tools: (context) => (composition ? composition.planTools(context.view?.core) : workflowBase()),
    notify,
  });
}
const instructions = values.system === undefined ? {} : { instructions: values.system };
// Agent workers keep each session's conversation (a file each) beside the daemon's state, so
// a restarted daemon's sessions continue where they stopped (`--conversations` puts them elsewhere).
const conversationsPath = conversationsDir(values);
const conversations = conversationsPath === undefined ? {} : { conversations: fileConversations(conversationsPath) };
// A scripted dialogue in front of the session model (ADR 0012): scripts answer what they
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
    onEvent: (event) => void running.host?.runtime.publish(event),
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
        ...(step ? { step } : {}),
      });
// The model worker runs an AI SDK agent on a gateway model; the ensemble worker runs one
// on the ensemble (the steered kernel with a behavior pack), with memory and learning.
const sessions: Worker = harness
  ? harness.worker
  : values.worker === "model"
    ? new AgentWorker({ agent: sessionAgent({ model: scripted(gateway(values.model)), ...instructions, ...(step ? { step } : {}), ...(composition ? { tools: composition.tools } : {}) }), ...conversations })
    : values.worker === "ensemble"
      ? new AgentWorker({
          agent: sessionAgent({
            model: scripted(cognitive!.ensemble.languageModel(behavior ? "steered-chat" : "chat")),
            vision: cognitive!.ensemble.languageModel("vision-qa"),
            ...instructions,
            ...(step ? { step } : {}),
            ...(cognitive!.memory ? { memory: cognitive!.memory } : {}),
            ...(cognitive!.learning ? { learning: cognitive!.learning } : {}),
            // A larger hosted model's notes on each request, as reference for the local kernel.
            ...(values.consult === undefined ? {} : { consult: gateway(values.consult) }),
            // The workflow library's workflows are durable tools, looked up each turn as learning adds to them
            // (with procedural graphs, plus the workflows the session's pinned core binds).
            ...(composition ? { tools: composition.tools } : cognitive!.workflowHost ? { tools: () => workflowTools(cognitive!.workflowHost!) } : {}),
          }),
          ...(cognitive!.memory ? { onTurn: rememberTurns(cognitive!.memory) } : {}),
          // Plugins' behavior events (`_harness/behavior/event`) go to the session's behavior state.
          ...(behavior ? { onEvent: (sessionId: string, name: string) => cognitive!.raiseBehavior(sessionId, name) } : {}),
          ...conversations,
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
  identity: { principal, kind: "human" },
  ...(ensemble ? { cognitive: ensemble } : {}),
  ...(values.state === undefined ? {} : { statePath: values.state }),
});
running.host = host;

if (procedural) live.notify = hookNotifier(host.runtime);
if (procedural && generator) {
  live.learner = nativeLiveLearner({ runtime: host.runtime, ...procedural, reflect: modelReflector({ model: generator, settings: procedural.settings }), log: (message) => void process.stderr.write(`${message}\n`) });
  // Dream refines with the generator, on trajectories from the daemon's session logs; one dream per graph at a time,
  // whether `procedural.dream` or the preset's schedule (checked on the runtime's ticks) starts it. No one can be
  // asked for approval outside a session's turn: candidates that need it wait in the approvals inbox
  // (`procedural.approvals`, `procedural.approve`, `procedural.decline`).
  // With a task suite, dream gates on it: the session model solves its tasks, guided by each candidate, and the catalog's judge scores them when the suite asks.
  const evaluator =
    taskSuite &&
    nativeTaskEvaluator({
      suite: taskSuite,
      settings: procedural.settings,
      model: cognitive?.ensemble.languageModel("chat") ?? gateway(values.model),
      ...(cognitive ? { judge: async () => (await cognitive.ensemble.resolve("judgment", "judge")).port } : {}),
      ...(cognitive?.workflowHost ? { tools: () => workflowTools(cognitive.workflowHost!) } : {}),
    });
  const evaluation = evaluator ? { evaluator, ...(taskSuite?.description === undefined ? {} : { task: taskSuite.description }) } : {};
  // With composition, a dream ends with a composition round over the session tools, which are its tool catalog.
  const composing = composition ? { composer: composition.composer, tools: composition.catalog } : {};
  live.dream = exclusiveDream(nativeDream({ ...procedural, ...evaluation, ...composing, model: generator, sessions: async () => daemonSessions(host.daemon), inbox: approvalInbox(notify) }));
  live.schedule = nativeDreamSchedule({ runtime: host.runtime, ...procedural, dream: live.dream, log: (message) => void process.stderr.write(`${message}\n`) });
}

// Plan runs a stopped daemon left are resumed, one after another, each end logged (and announced on the hook bus).
if (live.plans) {
  void live.plans
    .resume()
    .then((outcomes) => outcomes.forEach((outcome) => void process.stderr.write(`${describePlanRun(outcome)}\n`)))
    .catch((e: unknown) => void process.stderr.write(`procedural: resuming plan runs failed: ${e instanceof Error ? e.message : String(e)}\n`));
}

// The step hook forgets each session the daemon detaches (its pinned view and guidance cache).
const evictions = step && nativeStepEvictions({ runtime: host.runtime, step, log: (message) => void process.stderr.write(`${message}\n`) });

const shutdown = async () => {
  // Learning under way (a drafter's answer among it) gets the grace (--dialogue-grace) to land in the
  // book while the host still runs, so what it publishes on the hook bus is saved with the state.
  if (dialogue) await Promise.race([dialogue.idle(), new Promise((r) => setTimeout(r, dialogueGrace).unref())]);
  delete running.host;
  evictions?.close();
  live.learner?.close();
  live.schedule?.close();
  await host.close();
  await dialogueSaved?.settled();
  await harness?.close();
  await cognitive?.close();
  await storeLock?.release();
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
  // harness-procedural reaches the store through this socket while the daemon holds it, when
  // the daemon serves `procedural.*` (its cognitive core has the extension); otherwise it refuses.
  if (cognitive) await storeLock?.advertise(resolve(values.socket));
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
