/**
 * Saves of a dialogue's book to storage, one at a time, each made when it starts (so it
 * holds the latest state): changes while a save is under way make one more save, not one
 * each. A failed save is reported to `onError`; the next change saves again.
 */
export function dialogueSaves(storage: { save(saved: unknown): Promise<void> }, onError: (error: unknown) => void) {
  let saving = Promise.resolve();
  let next: (() => unknown) | undefined;
  return {
    persist(snapshot: () => unknown): void {
      const queued = next !== undefined;
      next = snapshot;
      if (queued) return;
      saving = saving.then(() => {
        const save = next!;
        next = undefined;
        return storage.save(save());
      }).catch(onError);
    },
    /** Resolves when every save asked for so far has been made (or has failed). */
    settled: (): Promise<void> => saving,
  };
}
