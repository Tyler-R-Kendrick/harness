import type { SnapshotStorage } from "@harness/core";
import type { Ensemble } from "@harness/cognitive";
import { proceduralExtension, SnapshotProceduralStore } from "@harness/procedural";
import type { ProceduralExtensionOptions, ProceduralStore, Settings } from "@harness/procedural";

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
