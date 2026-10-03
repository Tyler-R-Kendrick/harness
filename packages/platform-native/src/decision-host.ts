import { getRandomValues } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Ensemble, ModelDescriptor } from "@harness/cognitive";
import type { Clock, Entropy } from "@harness/core";
import { dialogueSaves } from "@harness/dialogue";
import {
  createDecisionLayer,
  DecisionError,
  decisionExtension,
  errorText,
  ensembleMember,
  ensembleVerifier,
  layerDispatch,
  parseLayerSettings,
  publishOn,
  startPlugin,
} from "@harness/decision";
import type { DecisionEvent, DecisionLayer, LayerDispatch, LayerLifecycleState, LayerSettings, Member, PluginRuntimeLike, RunningPlugin } from "@harness/decision";
import { decisionFiles } from "./decision-files.ts";
import type { DecisionFiles } from "./decision-files.ts";
import { FileStorage } from "./file-storage.ts";

const require = createRequire(import.meta.url);

/** The settings files, by the key `parseLayerSettings` reads them under. */
const SETTINGS_FILES = { attention: "attention", stuck: "stuck", dispatch: "dispatch", lifecycle: "lifecycle", evolve: "evolve", permission: "permission-questions" } as const;

/** The file in `<dir>/settings` when there is one (a tweaked copy), else the file shipped in `@harness/decision`. */
function settingsFile(dir: string | undefined, name: string): string {
  const own = dir === undefined ? undefined : join(dir, "settings", `${name}.json`);
  return own !== undefined && existsSync(own) ? own : require.resolve(`@harness/decision/data/${name}.json`);
}

/**
 * Read and parse the layer's settings (the attention, stuck, dispatch, lifecycle, evolve
 * and permission-question files): the files shipped in `@harness/decision`, each replaced
 * by `<dir>/settings/<name>.json` when the directory has one. An error names the file.
 */
export function loadDecisionSettings(dir?: string): LayerSettings {
  const raw: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(SETTINGS_FILES)) {
    const file = settingsFile(dir, name);
    try {
      raw[key] = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new DecisionError("invalid", `${file}: ${(e as Error).message}`);
    }
  }
  try {
    return parseLayerSettings(raw as unknown as Parameters<typeof parseLayerSettings>[0]);
  } catch (e) {
    // The parse names the settings; the files they were read from are the ones this directory (or the package) holds.
    throw new DecisionError("invalid", `${(e as Error).message}\n(read from ${Object.values(SETTINGS_FILES).map((name) => settingsFile(dir, name)).join(", ")})`);
  }
}

// ---- opening a decision directory as a layer ---------------------------------------------------------------------

/** The file the records are kept in (`decisionFiles` opens it). */
const LOG_FILE = "decisions.jsonl";
/** The file the learned rules and their evidence are kept in, beside the log. */
export const RULES_FILE = "learned-rules.json";
/** The file the criteria versions an evolution accepted are kept in. */
export const ARCHIVE_FILE = "criteria-archive.json";

export interface OpenDecisionOptions {
  /** The decision directory: records, policy, authority, calibration, learned rules and criteria. */
  readonly dir: string;
  /** In preference order; none is a layer that cannot ask a model (every decision ends at a rule or a person). */
  readonly members?: readonly Member[];
  readonly judge?: Member;
  /** Where `decision.made` goes (the hook bus, once a host has one). */
  readonly publish?: (event: DecisionEvent) => void;
  /** Told of every problem that does not stop the layer: a line of the log that could not be read, a save that failed. */
  readonly log?: (message: string) => void;
  readonly settings?: LayerSettings;
  /** Keep at most this many records (see `FileDecisionLog`). */
  readonly maxRecords?: number;
  readonly clock?: Clock;
  readonly entropy?: Entropy;
}

export interface OpenedDecision {
  readonly layer: DecisionLayer;
  readonly files: DecisionFiles;
  /** Resolves when every write asked for so far (records, learned rules, criteria) has landed or failed (and been logged). */
  settled(): Promise<void>;
}

/** How often the plugin takes what is new from the hook bus unless told otherwise. */
const DEFAULT_TICK_MS = 500;

const systemClock: Clock = { now: () => Date.now() };
const systemEntropy: Entropy = { bytes: (length) => getRandomValues(new Uint8Array(length)) };

/**
 * The decision layer on a directory's files. Records are appended to `decisions.jsonl`; the
 * calibration book is written back to `calibration.json` whenever one is installed; the
 * learned rules (and their lifecycle) go to `learned-rules.json` and the criteria archive to
 * `criteria-archive.json`, each written atomically and loaded when the layer opens. A file
 * that is not valid stops the layer from opening, with the file named.
 */
export async function openDecision(options: OpenDecisionOptions): Promise<OpenedDecision> {
  const log = options.log ?? (() => {});
  const problem = (what: string) => (error: unknown) => log(`decision: ${what}: ${errorText(error)}`);
  const logFile = join(options.dir, LOG_FILE);
  const files = await decisionFiles(options.dir, {
    ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
    onError: (p) => log(`decision: ${logFile} line ${p.line}: ${p.message}${p.torn ? " (cut off the file)" : ""}`),
  });
  const rules = new FileStorage(join(options.dir, RULES_FILE));
  const archive = new FileStorage(join(options.dir, ARCHIVE_FILE));
  const [lifecycle, criteria] = await Promise.all([rules.load(), archive.load()]);
  const ruleSaves = dialogueSaves(rules, problem(`cannot save ${RULES_FILE}`));
  const archiveSaves = dialogueSaves(archive, problem(`cannot save ${ARCHIVE_FILE}`));
  const settings = options.settings ?? loadDecisionSettings(options.dir);
  let layer: DecisionLayer;
  try {
    layer = createDecisionLayer({
      log: files.log,
      clock: options.clock ?? systemClock,
      entropy: options.entropy ?? systemEntropy,
      policy: files.policy,
      settings,
      authority: files.authority,
      calibration: files.calibration,
      // A book that cannot be saved is a calibration that does not survive a restart, not one that stops the layer.
      onCalibration: (book) => files.saveCalibration(book).catch(problem("cannot save calibration.json")),
      members: options.members ?? [],
      ...(options.judge === undefined ? {} : { judge: options.judge }),
      ...(options.publish === undefined ? {} : { publish: options.publish }),
      ...(lifecycle === undefined ? {} : { lifecycle: lifecycle as LayerLifecycleState }),
      ...(criteria === undefined ? {} : { archive: criteria }),
      onLifecycle: (state) => ruleSaves.persist(() => state),
      onArchive: (snapshot) => archiveSaves.persist(() => snapshot),
    });
  } catch (e) {
    // What the layer refuses at this point is the learned state it was given.
    throw new DecisionError("invalid", `${join(options.dir, RULES_FILE)} or ${join(options.dir, ARCHIVE_FILE)}: ${(e as Error).message}`);
  }
  return {
    layer,
    files,
    settled: async () => {
      await files.log.settled();
      await ruleSaves.settled();
      await archiveSaves.settled();
    },
  };
}

// ---- the layer beside a running daemon -------------------------------------------------------------------------------

/** What of a running host the layer needs (`DaemonRuntime` has it). */
export type NativeRuntimeLike = PluginRuntimeLike;

export interface NativeDecisionOptions extends Omit<OpenDecisionOptions, "members" | "judge" | "publish" | "log"> {
  /** Told of every problem that does not stop the layer: a line of the log that could not be read, a save that failed, an event that could not be handled. */
  readonly log: (message: string) => void;
  /** The cognitive core: its judgment models are the layer's member, `decision.*` operations are installed on it. */
  readonly ensemble: Ensemble;
  /** Replaces the ensemble as the layer's members (tests; a host with models of its own). */
  readonly members?: readonly Member[];
  /** Replaces the verifier chosen from the ensemble; `false` for none. */
  readonly judge?: Member | false;
  /** How often the plugin takes what is new from the hook bus (default 500 ms). */
  readonly tickMs?: number;
  /** Also ask the `attention` fork how urgent each inbox item is. */
  readonly assess?: boolean;
}

export interface NativeDecision extends OpenedDecision {
  /** Connects the plugin to the running daemon as a peer, subscribes, and starts handling events (once the host is up). */
  attach(runtime: NativeRuntimeLike): Promise<void>;
  /** Takes what is on the hook bus now and handles it; resolves when the bus is empty. */
  pump(): Promise<number>;
  /** The dispatch fork as the session agent's step planner (see `layerDispatch`). */
  dispatch<Model>(tiers: { readonly small?: Model; readonly large?: Model }): LayerDispatch<Model>;
  /** Stops handling events and hangs up the plugin's connection. Records still being written are awaited by `settled`. */
  stop(): Promise<void>;
}

/**
 * The decision layer for the native host (`--decision <dir>`). It opens the directory,
 * asks the ensemble's judgment models, installs the `decision.*` operations on the
 * ensemble (before the host starts, so the daemon offers them), and, once `attach` is
 * given the running host, connects the plugin to the daemon as an ordinary peer on the hook
 * bus. The plugin only reads and annotates: it never answers a permission request.
 */
export async function buildNativeDecision(options: NativeDecisionOptions): Promise<NativeDecision> {
  const { ensemble, members, judge: judgeOption, tickMs, assess, ...open } = options;
  const { log } = options;
  let publish: ((event: DecisionEvent) => void) | undefined;
  const judge = judgeOption === false ? undefined : (judgeOption ?? ensembleVerifier(ensemble));
  const opened = await openDecision({
    ...open,
    members: members ?? [ensembleMember(ensemble)],
    ...(judge === undefined ? {} : { judge }),
    publish: (event) => publish?.(event),
  });
  const { layer } = opened;
  ensemble.install(decisionExtension(layer, { ensemble }));

  let running: RunningPlugin | undefined;

  return {
    ...opened,
    async attach(runtime) {
      publish = publishOn(runtime);
      running = await startPlugin({
        layer,
        runtime,
        tickMs: tickMs ?? DEFAULT_TICK_MS,
        every: (tick, ms) => {
          const timer = setInterval(tick, ms);
          timer.unref();
          return () => clearInterval(timer);
        },
        onError: (where, error) => log(`decision: ${where}: ${errorText(error)}`),
        ...(assess === undefined ? {} : { assess }),
      });
    },
    pump: async () => (await running?.pump()) ?? 0,
    dispatch: (tiers) => layerDispatch({ layer, tiers, onError: (error) => log(`decision: dispatch: ${errorText(error)}`) }),
    stop: async () => running?.stop(),
  };
}

// ---- dispatch tiers --------------------------------------------------------------------------------------------------

/**
 * The small tier of a session's dispatch: the best local generator for chat, or nothing
 * when there is none (a hosted model is not a cheaper tier than the session's own, which
 * the dispatch cannot tell from here). Only local generators are ever called, however
 * well a hosted one ranks, so the session's task text stays on this machine.
 */
export function localChatTier(ensemble: Pick<Ensemble, "candidates" | "languageModel">): ReturnType<Ensemble["languageModel"]> | undefined {
  const isLocalGenerator = (d: ModelDescriptor) => d.locality === "local" && d.ports.includes("generator");
  return ensemble.candidates("chat").some((c) => isLocalGenerator(c.descriptor)) ? ensemble.languageModel("chat", "generator", isLocalGenerator) : undefined;
}
