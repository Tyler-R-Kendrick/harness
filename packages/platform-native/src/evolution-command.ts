import { getRandomValues } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { gateway } from "@ai-sdk/gateway";
import type { Experimental_EvaluationModel as EvaluationModel, LanguageModel } from "ai";
import { z } from "zod";
import type { Entropy } from "@harness/core";
import { Evolution, judgeCritic, modelProposer, StateSchema } from "@harness/evolution";
import type { Documents, EvolutionPorts, LedgerRecord, Settings } from "@harness/evolution";
import { CognitiveError } from "@harness/cognitive";
import type { Ensemble } from "@harness/cognitive";
import { gatewayEvaluationModel } from "@harness/models";
import { loadEvolutionSettings } from "./catalog-files.ts";
import { buildNativeEnsemble } from "./cognitive-host.ts";
import type { NativeEnsembleOptions } from "./cognitive-host.ts";
import { buildSplit, buildSurface, commandEvaluator, documentPath, isTextDocument, loadEvolutionConfig, readDocuments } from "./evolution-config.ts";
import type { LoadedConfig } from "./evolution-config.ts";
import { replaceFiles } from "./atomic-files.ts";
import type { FileOps } from "./atomic-files.ts";
import { FileStorage } from "./file-storage.ts";
import { withStateLock } from "./state-lock.ts";

export const USAGE =
  "usage: harness-evolution <command> --config <evolution.json> [--state <file>] [--settings <file>]\n" +
  "  start [--force]                       measure the base harness and begin a run (a run in progress is kept unless --force)\n" +
  "  round --model <gateway id> [<critic>]  one round\n" +
  "  run --model <gateway id> [<critic>] [--max-rounds <n>]\n" +
  "                                        rounds until the run is done (starts one if there is none; run again to resume)\n" +
  "  <critic> is --critic-model <gateway id> (an AI Gateway judge), or\n" +
  "           --critic ensemble [--model-cache <dir>] [--llama-server <path>]\n" +
  "                                        (the judge the native host's ensemble reaches, built as `harness --cognitive` builds it;\n" +
  "                                         the cache is --model-cache, else $HARNESS_MODEL_CACHE, else ~/.cache/harness/models,\n" +
  "                                         and llama-server is --llama-server, else $LLAMA_SERVER)\n" +
  "                                        with neither, proposals are screened by the leakage checks alone\n" +
  "  status [--last <n>]                   the round, the incumbent's score, its mechanisms and the last records\n" +
  "  documents [--write [--force]]         compare the incumbent's documents with their files; --write replaces the files\n" +
  "                                        that still hold what the run started from (--force: whatever they hold)\n";

/** Where the command writes: stdout carries results, stderr errors. */
export interface EvolutionIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** What the host provides, each replaceable (tests provide their own; the CLI provides none). */
export interface EvolutionDeps {
  /** The proposer's model by gateway id; by default the AI Gateway's. */
  readonly languageModel?: (id: string) => LanguageModel;
  /** The critic's judge by gateway id; by default the AI Gateway's. */
  readonly evaluationModel?: (id: string) => EvaluationModel;
  /** The native host's ensemble, for `--critic ensemble`; by default the cognitive core `harness --cognitive` builds. */
  readonly ensemble?: (options: NativeEnsembleOptions) => { readonly ensemble: Ensemble; close(): Promise<void> };
  /** Runs the harness on tasks; by default the configured evaluator command. */
  readonly evaluate?: EvolutionPorts["evaluate"];
  /** The file operations `documents --write` replaces files with; by default the file system's (tests inject failures). */
  readonly files?: Partial<FileOps>;
  /** Randomness; by default the host's (as the daemon's). */
  readonly entropy?: Entropy;
}

/** The run's file: what the evolution saves, and what the host binds it to. */
const RunSchema = z.strictObject({
  format: z.literal("harness.evolution-run/v1"),
  /** The documents the run started from: what a file must still hold for the run to replace it. */
  base: z.record(z.string(), z.json()),
  /** The tasks the run measured, so a changed task set cannot silently resume a run measured on another. */
  tasks: z.strictObject({ evolve: z.array(z.string()), holdout: z.array(z.string()) }),
  evolution: z.unknown(),
});
type Run = z.output<typeof RunSchema>;

class Usage extends Error {}

/** Where the round's critic comes from: an AI Gateway judge by id, or the native host's ensemble. */
type Critic = { readonly kind: "model"; readonly id: string } | { readonly kind: "ensemble"; readonly cacheDir: string; readonly llamaServer?: string };

const nonEmpty = (value: string | undefined) => (value === undefined || value === "" ? undefined : value);
const optional = <K extends string>(key: K, value: string | undefined) => (value === undefined ? {} : ({ [key]: value } as { [P in K]: string }));

const COMMANDS = ["start", "round", "run", "status", "documents"];
const OPTIONS = {
  config: { type: "string" },
  state: { type: "string" },
  settings: { type: "string" },
  model: { type: "string" },
  "critic-model": { type: "string" },
  critic: { type: "string" },
  "model-cache": { type: "string" },
  "llama-server": { type: "string" },
  "max-rounds": { type: "string" },
  last: { type: "string" },
  force: { type: "boolean", default: false },
  write: { type: "boolean", default: false },
} as const;

const count = (option: string, value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Usage(`--${option} takes a positive whole number, not "${value}"`);
  return Number(value);
};

const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(4)}`;

function line(r: LedgerRecord): string {
  const kind = r.kind === "prune" ? "prune " : "change";
  const m = r.measured;
  const measured = m === undefined ? "" : `  gain ${signed(m.gain)} [${signed(m.lower)}, ${signed(m.upper)}] ${m.verdict}`;
  return `  ${r.round}${r.candidate} ${kind} ${r.outcome}${measured}: ${r.reason}\n`;
}

/**
 * `harness-evolution`: drives `@harness/evolution` on the native host (ADR 0014). Answers
 * the exit code: 0 done, 1 failed (a failed round leaves the state file as it was; run
 * the command again to resume), 2 misused.
 */
export async function evolutionCommand(argv: readonly string[], io: EvolutionIo, deps: EvolutionDeps = {}): Promise<number> {
  try {
    const { values, positionals } = parse(argv);
    const [command] = positionals;
    if (command === undefined || !COMMANDS.includes(command) || positionals.length > 1) throw new Usage("");
    // An empty value is a mistake (an unset shell variable), never "not given".
    for (const [option, { type }] of Object.entries(OPTIONS)) {
      const value = (values as Record<string, unknown>)[option];
      if (type === "string" && value === "") throw new Usage(`--${option} needs a value, not an empty string`);
    }
    if (values.config === undefined) throw new Usage("--config is required");
    const needsModel = command === "round" || command === "run";
    if (needsModel && values.model === undefined) throw new Usage(`${command} needs --model: the proposer's model, a gateway id`);
    if (values["critic-model"] !== undefined && !needsModel) throw new Usage("--critic-model is for round and run");
    if (values.critic !== undefined && !needsModel) throw new Usage("--critic is for round and run");
    if (values.critic !== undefined && values.critic !== "ensemble") throw new Usage(`--critic takes "ensemble", not "${values.critic}"`);
    if (values.critic !== undefined && values["critic-model"] !== undefined) throw new Usage("--critic and --critic-model are alternatives: give one, the ensemble's judge or a gateway model");
    for (const option of ["model-cache", "llama-server"] as const) if (values[option] !== undefined && values.critic === undefined) throw new Usage(`--${option} is for --critic ensemble`);
    if (values.write && command !== "documents") throw new Usage("--write is for documents");
    if (values.force && !(command === "start" || (command === "documents" && values.write))) throw new Usage("--force is for start and documents --write");
    if (values.last !== undefined && command !== "status") throw new Usage("--last is for status");
    if (values["max-rounds"] !== undefined && command !== "run") throw new Usage("--max-rounds is for run");
    const critic: Critic | undefined =
      values.critic !== undefined
        ? {
            kind: "ensemble",
            cacheDir: values["model-cache"] ?? nonEmpty(process.env["HARNESS_MODEL_CACHE"]) ?? join(homedir(), ".cache", "harness", "models"),
            ...optional("llamaServer", values["llama-server"] ?? nonEmpty(process.env["LLAMA_SERVER"])),
          }
        : values["critic-model"] === undefined
          ? undefined
          : { kind: "model", id: values["critic-model"] };
    const last = count("last", values.last, 5);
    const maxRounds = count("max-rounds", values["max-rounds"], Infinity);

    const loaded = loadEvolutionConfig(values.config);
    const settings = loadEvolutionSettings(values.settings ?? (loaded.config.settings === undefined ? undefined : resolve(loaded.dir, loaded.config.settings)));
    const statePath = values.state ?? (loaded.config.state === undefined ? `${resolve(values.config).replace(/\.json$/, "")}.state.json` : resolve(loaded.dir, loaded.config.state));
    const host = new Host({ io, deps, loaded, settings, storage: new FileStorage(statePath), statePath });

    // What writes the state (or the files a run's state decides) holds the state's lock; reading needs none.
    const locked = <T>(work: () => Promise<T>) => withStateLock(statePath, work);
    switch (command) {
      case "start":
        await locked(() => host.start(values.force));
        break;
      case "round":
        await locked(() => host.rounds(values.model!, critic, 1, "round"));
        break;
      case "run":
        await locked(() => host.rounds(values.model!, critic, maxRounds, "run"));
        break;
      case "status":
        await host.status(last);
        break;
      default:
        await (values.write ? locked(() => host.documents(true, values.force)) : host.documents(false, values.force));
    }
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      io.stderr(`${e.message ? `${e.message}\n` : ""}${USAGE}`);
      return 2;
    }
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function parse(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS });
  } catch (e) {
    throw new Usage((e as Error).message);
  }
}

class Host {
  readonly #io: EvolutionIo;
  readonly #deps: EvolutionDeps;
  readonly #loaded: LoadedConfig;
  readonly #settings: Settings;
  readonly #storage: FileStorage;
  readonly #statePath: string;

  constructor(o: { io: EvolutionIo; deps: EvolutionDeps; loaded: LoadedConfig; settings: Settings; storage: FileStorage; statePath: string }) {
    this.#io = o.io;
    this.#deps = o.deps;
    this.#loaded = o.loaded;
    this.#settings = o.settings;
    this.#storage = o.storage;
    this.#statePath = o.statePath;
  }

  get #split() {
    return buildSplit(this.#loaded);
  }

  get #tasks(): Run["tasks"] {
    const { evolve, holdout } = this.#split;
    return { evolve: evolve.map((t) => t.id), holdout: (holdout ?? []).map((t) => t.id) };
  }

  get #evaluate(): EvolutionPorts["evaluate"] {
    return this.#deps.evaluate ?? commandEvaluator(this.#loaded);
  }

  get #entropy(): Entropy {
    return this.#deps.entropy ?? { bytes: (n) => getRandomValues(new Uint8Array(n)) };
  }

  #say(line: string) {
    this.#io.stdout(`${line}\n`);
  }

  /** The run in the state file, if there is one, bound to the tasks it was measured on. */
  async #load(): Promise<{ run: Run; evolution: Evolution } | undefined> {
    const saved = await this.#storage.load();
    if (saved === undefined) return undefined;
    const parsed = RunSchema.safeParse(saved);
    if (!parsed.success) throw new Error(`${this.#statePath} is not an evolution run\n${z.prettifyError(parsed.error)}`);
    const run = parsed.data;
    const now = this.#tasks;
    if (!isDeepStrictEqual(run.tasks, now)) throw new Error(`the tasks in the config are not the tasks ${this.#statePath} was measured on; use another --state, or start again with --force`);
    return { run, evolution: new Evolution({ surface: buildSurface(this.#loaded), settings: this.#settings, split: this.#split, saved: run.evolution }) };
  }

  async #save(run: Run, evolution: Evolution) {
    await this.#storage.save({ ...run, evolution: evolution.save() } satisfies Run);
  }

  async start(force: boolean): Promise<void> {
    if ((await this.#storage.load()) !== undefined && !force) throw new Error(`${this.#statePath} holds a run: \`run\` continues it, \`start --force\` begins again`);
    const documents = readDocuments(this.#loaded);
    const { evolve, holdout } = this.#split;
    this.#say(`measuring the base harness: ${evolve.length} evolve tasks${holdout ? ` and ${holdout.length} holdout tasks` : ""}, ${this.#settings.trials} trials each`);
    const evolution = await Evolution.start({ surface: buildSurface(this.#loaded), settings: this.#settings, split: this.#split, documents, ports: { evaluate: this.#evaluate, entropy: this.#entropy } });
    await this.#save({ format: "harness.evolution-run/v1", base: JSON.parse(JSON.stringify(documents)) as Run["base"], tasks: this.#tasks, evolution: undefined }, evolution);
    const state = StateSchema.parse(evolution.save());
    this.#say(`base score ${state.base.score.toFixed(4)}${state.base.cost === undefined ? "" : `, ${Math.round(state.base.cost)} tokens a trial`}${state.holdout?.incumbent ? `; on the holdout ${state.holdout.incumbent.score.toFixed(4)}` : ""}`);
    this.#say(`run started in ${this.#statePath}: ${this.#settings.rounds} rounds`);
  }

  /**
   * The judge the critic screens with, and what to close after the run. An ensemble judge is
   * resolved now, so that a critic that was asked for and cannot be had fails the command
   * before any round is spent, never running without it.
   */
  async #critic(critic: Critic): Promise<{ model: EvaluationModel; close(): Promise<void> }> {
    if (critic.kind === "model") return { model: (this.#deps.evaluationModel ?? gatewayEvaluationModel)(critic.id), close: async () => {} };
    const { ensemble, close } = (this.#deps.ensemble ?? buildNativeEnsemble)({ cacheDir: critic.cacheDir, ...optional("llamaServer", critic.llamaServer) });
    try {
      await ensemble.resolve("judgment", "judge");
    } catch (e) {
      await close();
      if (!(e instanceof CognitiveError)) throw e;
      const reasons = ensemble.members().flatMap((m) => (m.descriptor.tasks.includes("judgment") && m.reason ? [`${m.id}: ${m.reason}`] : []));
      throw new Error(`--critic ensemble: no judge could be reached${reasons.length ? `: ${reasons.join("; ")}` : ""}`);
    }
    return { model: ensemble.evaluationModel(), close };
  }

  /** Rounds, up to `limit`, each saved as it completes. */
  async rounds(model: string, critic: Critic | undefined, limit: number, command: "round" | "run"): Promise<void> {
    let loaded = await this.#load();
    if (loaded === undefined) {
      if (command === "round") throw new Error(`no run in ${this.#statePath}: \`start\` one first`);
      await this.start(false);
      loaded = (await this.#load())!;
    }
    const { run, evolution } = loaded;
    if (evolution.done) {
      if (command === "round") throw new Error(`the run is over: ${this.#settings.rounds} rounds`);
      this.#say(`the run is over: ${evolution.completed} of ${this.#settings.rounds} rounds`);
      return;
    }
    const judge = critic === undefined ? undefined : await this.#critic(critic);
    try {
      const ports: EvolutionPorts = {
        evaluate: this.#evaluate,
        propose: modelProposer((this.#deps.languageModel ?? ((id) => gateway(id)))(model), this.#settings.proposer),
        ...(judge === undefined ? {} : { critic: judgeCritic(judge.model, this.#settings.critic) }),
        entropy: this.#entropy,
      };
      for (let n = 0; n < limit && !evolution.done; n++) {
        const at = evolution.completed;
        let report;
        try {
          report = await evolution.round(ports);
        } catch (e) {
          throw new Error(`round ${at} failed: ${e instanceof Error ? e.message : String(e)}\nthe run is unchanged at ${at} of ${this.#settings.rounds} rounds; run the command again to resume`);
        }
        await this.#save(run, evolution);
        this.#say(`round ${report.round + 1} of ${this.#settings.rounds}: ${report.accepted === undefined ? "nothing accepted" : `accepted ${report.accepted}`} (edit budget ${report.budget}${report.stalled ? ", stalled: exploring" : ""}${report.level === undefined ? "" : `, test level ${report.level.toFixed(5)}`})`);
        for (const r of report.records) this.#io.stdout(line(r));
      }
    } finally {
      await judge?.close();
    }
    this.#say(evolution.done ? `the run is over: ${this.#settings.rounds} rounds; \`documents\` compares the incumbent's documents with their files` : `${evolution.completed} of ${this.#settings.rounds} rounds done`);
  }

  async status(last: number): Promise<void> {
    const loaded = await this.#load();
    if (loaded === undefined) throw new Error(`no run in ${this.#statePath}: \`start\` one first`);
    const { evolution } = loaded;
    const state = StateSchema.parse(evolution.save());
    this.#say(`run ${this.#statePath}: round ${evolution.completed} of ${this.#settings.rounds}${evolution.done ? " (over)" : ""}`);
    this.#say(`base score ${state.base.score.toFixed(4)}; incumbent ${(evolution.trajectory.at(-1) ?? state.base.score).toFixed(4)} (${signed((evolution.trajectory.at(-1) ?? state.base.score) - state.base.score)})`);
    if (state.holdout) this.#say(`holdout: ${state.holdout.state.budget} of ${this.#settings.holdout.budget} overfitting answers left after ${state.holdout.state.queries} queries`);
    this.#say(`mechanisms: ${evolution.mechanisms.length}`);
    for (const m of evolution.mechanisms) this.#say(`  ${m.id} (round ${m.round}, lower bound ${signed(m.lower)}${m.entangled ? ", entangled" : ""}) [${m.components.join(", ")}]: ${m.hypothesis}`);
    const records = evolution.records.slice(-last);
    this.#say(`last ${records.length} records:`);
    for (const r of records) this.#io.stdout(line(r));
  }

  async documents(write: boolean, force: boolean): Promise<void> {
    const loaded = await this.#load();
    if (loaded === undefined) throw new Error(`no run in ${this.#statePath}: \`start\` one first`);
    const incumbent: Documents = loaded.evolution.documents;
    const { base } = loaded.run;
    const files = readDocuments(this.#loaded);
    const names = Object.keys(incumbent);
    const same = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
    // What a write would replace, and of that, what is no longer what the run started from.
    const pending = names.filter((n) => !same(files[n], incumbent[n]));
    const diverged = pending.filter((n) => !same(files[n], base[n]));
    for (const n of names) {
      const status = !pending.includes(n) ? (same(incumbent[n], base[n]) ? "unchanged" : "the file holds the incumbent's") : diverged.includes(n) ? "differs, and the file is not what the run started from" : "differs: the incumbent's would replace the file";
      this.#say(`${n} (${documentPath(this.#loaded, n)}): ${status}`);
    }
    if (!write) {
      this.#say(pending.length ? "nothing was written; --write replaces the files that differ" : "nothing to write");
      return;
    }
    if (diverged.length && !force) throw new Error(`nothing was written: ${diverged.map((n) => documentPath(this.#loaded, n)).join(", ")} changed since the run started; --force replaces ${diverged.length === 1 ? "it" : "them"} anyway`);
    // JSON is written as the run's file format; text is written exactly as the run holds it. All of the files or none (see replaceFiles).
    await replaceFiles(
      pending.map((n) => ({ path: documentPath(this.#loaded, n), content: isTextDocument(this.#loaded, n) ? String(incumbent[n]) : `${JSON.stringify(incumbent[n], null, 2)}\n` })),
      this.#deps.files,
    );
    for (const n of pending) this.#say(`wrote ${documentPath(this.#loaded, n)}`);
    if (pending.length === 0) this.#say("nothing to write");
  }
}
