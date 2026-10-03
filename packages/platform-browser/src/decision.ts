import type { Ensemble } from "@harness/cognitive";
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
  parseCalibration,
  publishOn,
  startPlugin,
} from "@harness/decision";
import type { Authority, CalibrationBook, DecisionLayer, LayerDispatch, LayerLifecycleState, LayerSettings, Member, Policy, PluginRuntimeLike, RunningPlugin } from "@harness/decision";
import { IndexedDbDecisionLog } from "./decision-idb.ts";
import { IndexedDbStorage } from "./indexeddb-storage.ts";

export interface BrowserDecisionOptions {
  /** The cognitive core: its judgment models are the layer's member, and the `decision.*` operations are installed on it. */
  readonly ensemble: Ensemble;
  /** The browser host's runtime (`BrowserHost.runtime`): the plugin connects through it, and decisions are published on its hook bus. */
  readonly runtime: PluginRuntimeLike;
  /** The thresholds and modes (`data/policy.json`, parsed with `parsePolicy`). */
  readonly policy: Policy;
  /** The layer's settings (the other data files, parsed: `parseLayerSettings`). */
  readonly settings: LayerSettings;
  /** The permission authority (nothing permitted, nothing forbidden when absent). */
  readonly authority?: Authority;
  /** The calibration to start from when none is stored (the book `calibrate` last installed is stored). */
  readonly calibration?: CalibrationBook;
  /** The database's name (default `harness-decision`): records live in it, and calibration and learned state in `<name>-state`. */
  readonly name?: string;
  /** The IndexedDB to use (default the context's). */
  readonly factory?: IDBFactory;
  /** Keep at most this many records (see `IndexedDbDecisionLog`). */
  readonly maxRecords?: number;
  /** Replaces the ensemble as the layer's members. */
  readonly members?: readonly Member[];
  /** Replaces the verifier chosen from the ensemble; `false` for none. */
  readonly judge?: Member | false;
  /** How often the plugin takes what is new from the hook bus (default 500 ms). */
  readonly tickMs?: number;
  /** Also ask the `attention` fork how urgent each inbox item is. */
  readonly assess?: boolean;
  /** Told of every problem that does not stop the layer (a save that failed, an event that could not be handled); default the console's. */
  readonly log?: (message: string) => void;
  readonly clock?: Clock;
  readonly entropy?: Entropy;
}

export interface BrowserDecision {
  readonly layer: DecisionLayer;
  /** Handles what is on the hook bus now; resolves when it is empty. */
  pump(): Promise<number>;
  /** The dispatch fork as a session agent's step planner (see `layerDispatch`). */
  dispatch<Model>(tiers: { readonly small?: Model; readonly large?: Model }): LayerDispatch<Model>;
  /** Resolves when every save of calibration and learned state asked for so far has landed or failed (and been logged). */
  settled(): Promise<void>;
  /** Stops the plugin: it handles no more events and its connection is hung up. */
  stop(): Promise<void>;
  /** Stops the plugin, waits for the saves, and closes the databases. */
  close(): Promise<void>;
}

const DEFAULT_NAME = "harness-decision";
const DEFAULT_TICK_MS = 500;

/**
 * The decision layer in the browser host, as the native host has it (`buildNativeDecision`):
 * records in IndexedDB (an `IndexedDbDecisionLog`), the calibration book, the learned rules
 * and the criteria archive each stored under a key of the `<name>-state` database (saved
 * after every change, one save at a time) and read back when the layer is made. The
 * `decision.*` operations are installed on the ensemble, and the plugin is connected to
 * the running daemon as an ordinary peer on the hook bus, pumped on a timer. The plugin
 * only reads and annotates: it never answers a permission request.
 */
export async function browserDecision(options: BrowserDecisionOptions): Promise<BrowserDecision> {
  const { ensemble, runtime, factory } = options;
  const name = options.name ?? DEFAULT_NAME;
  const log = options.log ?? ((message: string) => console.error(message));
  const problem = (what: string) => (error: unknown) => log(`decision: ${what}: ${errorText(error)}`);
  const stateName = `${name}-state`;
  const state = (key: string) => new IndexedDbStorage({ name: stateName, key, ...(factory === undefined ? {} : { factory }) });
  const records = new IndexedDbDecisionLog({ name, ...(factory === undefined ? {} : { factory }), ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }) });
  const stores = { calibration: state("calibration"), rules: state("rules"), archive: state("archive") };
  const closeAll = () => Promise.all([records.close(), ...Object.values(stores).map((s) => s.close())]).then(() => undefined);

  let layer: DecisionLayer;
  const saves = {
    calibration: dialogueSaves(stores.calibration, problem("cannot save the calibration")),
    rules: dialogueSaves(stores.rules, problem("cannot save the learned rules")),
    archive: dialogueSaves(stores.archive, problem("cannot save the criteria archive")),
  };
  const settled = async () => {
    await saves.calibration.settled();
    await saves.rules.settled();
    await saves.archive.settled();
  };
  try {
    const [book, rules, archive] = await Promise.all([stores.calibration.load(), stores.rules.load(), stores.archive.load()]);
    const judge = options.judge === false ? undefined : (options.judge ?? ensembleVerifier(ensemble));
    layer = createDecisionLayer({
      log: records,
      clock: options.clock ?? { now: () => Date.now() },
      entropy: options.entropy ?? { bytes: (length) => crypto.getRandomValues(new Uint8Array(length)) },
      policy: options.policy,
      settings: options.settings,
      ...(options.authority === undefined ? {} : { authority: options.authority }),
      calibration: book === undefined ? (options.calibration ?? { entries: [] }) : parseCalibration(book),
      onCalibration: (installed) => saves.calibration.persist(() => installed),
      members: options.members ?? [ensembleMember(ensemble)],
      ...(judge === undefined ? {} : { judge }),
      publish: publishOn(runtime),
      ...(rules === undefined ? {} : { lifecycle: rules as LayerLifecycleState }),
      ...(archive === undefined ? {} : { archive }),
      onLifecycle: (learned) => saves.rules.persist(() => learned),
      onArchive: (snapshot) => saves.archive.persist(() => snapshot),
    });
  } catch (e) {
    await closeAll();
    // What was stored is the state the layer was refused.
    throw new DecisionError("invalid", `cannot use the decision state stored in ${stateName}: ${errorText(e)}`);
  }

  const uninstall = ensemble.install(decisionExtension(layer, { ensemble }));
  let running: RunningPlugin;
  try {
    running = await startPlugin({
      layer,
      runtime,
      tickMs: options.tickMs ?? DEFAULT_TICK_MS,
      every: (tick, ms) => {
        const timer = setInterval(tick, ms);
        return () => clearInterval(timer);
      },
      onError: (where, error) => problem(where)(error),
      ...(options.assess === undefined ? {} : { assess: options.assess }),
    });
  } catch (e) {
    // The layer is not running: its operations are withdrawn and its databases released.
    uninstall();
    await closeAll();
    throw e;
  }
  return {
    layer,
    pump: () => running.pump(),
    dispatch: (tiers) => layerDispatch({ layer, tiers, onError: problem("dispatch") }),
    settled,
    stop: () => running.stop(),
    async close() {
      await running.stop();
      // The operations go before the databases do: none may be served from a closed one.
      uninstall();
      await settled();
      await closeAll();
    },
  };
}
