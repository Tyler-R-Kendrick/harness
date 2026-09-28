import type { SnapshotStorage } from "@harness/core";
import type { Ensemble } from "@harness/cognitive";
import { composition, proceduralExtension, SnapshotProceduralStore, staging } from "@harness/procedural";
import type { CompositionSettings, HostComposition, ProceduralExtensionOptions, ProceduralStepHook, ProceduralStore, Settings } from "@harness/procedural";
import { askModel, quickjsCodeMode } from "@harness/workflows";
import type { CodeMode } from "@harness/workflows";
import type { ToolSet } from "ai";
import { IndexedDbWorkflows } from "./workflows.ts";

/**
 * Procedural graphs for the browser host's ensemble: `procedural.*` over a store kept in
 * a `SnapshotStorage` (an `IndexedDbStorage` under its own key), with the page's clock.
 * The settings come from the page, which bundles procedural's data file and parses it
 * (`parseSettings`). Returns the store, to share with anything else that reads graphs: one
 * owner per storage. `notify` hears the approvals inbox's notices (a page publishes them
 * where it likes, such as its runtime's hook bus).
 */
export function browserProcedural(
  ensemble: Ensemble,
  options: { readonly storage: SnapshotStorage; readonly settings: Settings } & Pick<ProceduralExtensionOptions, "preset" | "authorize" | "dream" | "feedback" | "notify">,
): ProceduralStore {
  const { storage, ...rest } = options;
  const store = new SnapshotProceduralStore(storage);
  ensemble.install(proceduralExtension({ store, clock: { now: () => Date.now() }, ...rest }));
  return store;
}

/** The IndexedDB database dream stages its workflows in, unless the page names another. */
const STAGING = "harness-procedural-staging";
/** The shared workflow library's database (`IndexedDbWorkflows`' default). */
const SHARED = "harness-workflows";

/**
 * Composition in the browser (plan §7.6), as the native host does it: dream stages the
 * workflows it compiles in an IndexedDB database of its own (`name`, by default
 * `harness-procedural-staging`), never the shared workflow library's (`shared`, by default
 * `harness-workflows`, which may not be the same database), and staged workflows run on
 * QuickJS with the ensemble's model answering their questions. The page gives its
 * sessions `tools` (`sessionAgent({ tools })`, with the step hook it guides them by) and
 * its dream `composer` and `catalog` (`runDream`'s composer and tool catalog).
 */
export function browserComposition(
  ensemble: Ensemble,
  options: {
    readonly settings: CompositionSettings;
    readonly step: Pick<ProceduralStepHook, "core">;
    /** The page's session tools, the same for every session. */
    readonly base?: () => ToolSet | Promise<ToolSet>;
    readonly name?: string;
    readonly shared?: string;
    readonly factory?: IDBFactory;
    readonly codeMode?: CodeMode;
  },
): HostComposition {
  const { settings, step, base, name = STAGING, shared = SHARED, factory } = options;
  if (name === shared) throw new Error(`the shared workflow library (${shared}) cannot be procedural's staging library`);
  const files = new IndexedDbWorkflows({ name, ...(factory === undefined ? {} : { factory }) });
  const s = staging({ files, codeMode: options.codeMode ?? quickjsCodeMode(), ask: askModel(ensemble.languageModel()) });
  return composition({ staging: s, settings, step, ...(base === undefined ? {} : { base }) });
}
